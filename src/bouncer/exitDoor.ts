/**
 * EXIT DOOR: what a position is worth if it walks out right now. On the
 * curve this is the curve's own sell arithmetic (PonsV2BondingCurveMath,
 * then fee and creator tax on the quote leg), read from reserves at one
 * block. Once graduated, the pool is a full-range Uniswap V4 position whose
 * virtual reserves follow from its liquidity and price, read straight out
 * of the PoolManager's storage with extsload; the swap is priced on those
 * reserves with the hook fee and the creator tax. A pool quote is an
 * estimate (the hook's live policy, not the launch snapshot); the slip says so.
 */
import { decodeOutputs, encodeCall, encodeWord, type FunctionAbi, type Hex } from "../chain/abi.js";
import { keccak256Hex } from "../chain/keccak.js";
import { CURVE_FUNCTIONS, FACTORY_FUNCTIONS, GraduationPhase, HOOK_FUNCTIONS, ZERO_ADDRESS, curveAmountOut, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";

export interface ExitQuote {
  shareBps: number;
  tokensIn: bigint;
  gross: bigint;
  fee: bigint;
  tax: bigint;
  net: bigint;
  /** Net quote per token sold divided by the marginal price before the sale, in bps (10 000 = no impact). */
  realisedBps: number;
}

export interface ExitDoor {
  venue: "curve" | "pool" | "closed";
  /** Token amount the quotes are for (a holder's balance or a reference size). */
  position: bigint;
  reserves: { token: bigint; quote: bigint };
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** Marginal price in quote wei per whole token (18 decimals assumed for the launch token). */
  spot: bigint;
  quotes: ExitQuote[];
  note: string;
}

export interface PoolState {
  poolId: Hex;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tokenIsCurrency0: boolean;
}

const POOLS_SLOT = 6n;
const Q96 = 2n ** 96n;

export function poolIdFor(token: string, pairToken: string, fee: bigint, tickSpacing: bigint, hooks: string): { poolId: Hex; tokenIsCurrency0: boolean } {
  const a = BigInt(token);
  const b = BigInt(pairToken);
  const tokenIsCurrency0 = a < b;
  const [c0, c1] = tokenIsCurrency0 ? [token, pairToken] : [pairToken, token];
  const encoded = `0x${encodeWord("address", c0)}${encodeWord("address", c1)}${encodeWord("uint24", fee)}${encodeWord("int24", tickSpacing)}${encodeWord("address", hooks)}`;
  return { poolId: keccak256Hex(hexToBytes(encoded)), tokenIsCurrency0 };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Reads slot0 and liquidity of a V4 pool through PoolManager.extsload. */
export async function readPoolState(rpc: RpcClient, poolManager: string, launch: LaunchedToken, hooks: string, block: number): Promise<PoolState> {
  const { poolId, tokenIsCurrency0 } = poolIdFor(launch.token, launch.pairToken, launch.poolFee, launch.tickSpacing, hooks);
  const stateSlot = keccak256Hex(hexToBytes(`0x${poolId.slice(2)}${encodeWord("uint256", POOLS_SLOT)}`));
  const liquiditySlot: Hex = `0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`;
  const [slot0Raw, liquidityRaw] = await rpc.callBatch(
    [
      { to: poolManager, data: encodeCall(POOL_MANAGER_EXTSLOAD, [stateSlot]) },
      { to: poolManager, data: encodeCall(POOL_MANAGER_EXTSLOAD, [liquiditySlot]) },
    ],
    block,
  );
  const slot0 = BigInt(slot0Raw);
  const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
  const liquidity = BigInt(liquidityRaw) & ((1n << 128n) - 1n);
  return { poolId, sqrtPriceX96, liquidity, tokenIsCurrency0 };
}

const POOL_MANAGER_EXTSLOAD: FunctionAbi = { name: "extsload", inputs: ["bytes32"], outputs: ["bytes32"] };

/** Virtual full-range reserves from liquidity and price: x = L·2^96/√P, y = L·√P/2^96. */
export function fullRangeReserves(state: PoolState): { token: bigint; quote: bigint } {
  if (state.sqrtPriceX96 === 0n || state.liquidity === 0n) return { token: 0n, quote: 0n };
  const amount0 = (state.liquidity * Q96) / state.sqrtPriceX96;
  const amount1 = (state.liquidity * state.sqrtPriceX96) / Q96;
  return state.tokenIsCurrency0 ? { token: amount0, quote: amount1 } : { token: amount1, quote: amount0 };
}

export function quoteExit(position: bigint, reserves: { token: bigint; quote: bigint }, feeBps: bigint, creatorTaxBps: bigint, shares: number[] = [1_000, 2_500, 5_000, 10_000]): ExitQuote[] {
  const spot = reserves.token === 0n ? 0n : (reserves.quote * 10n ** 18n) / reserves.token;
  return shares.map((shareBps) => {
    const tokensIn = (position * BigInt(shareBps)) / 10_000n;
    const gross = curveAmountOut(tokensIn, reserves.token, reserves.quote, 0n);
    const fee = (gross * feeBps) / 10_000n;
    const tax = (gross * creatorTaxBps) / 10_000n;
    const net = gross - fee - tax;
    const atSpot = (tokensIn * spot) / 10n ** 18n;
    return { shareBps, tokensIn, gross, fee, tax, net, realisedBps: atSpot === 0n ? 0 : Number((net * 10_000n) / atSpot) };
  });
}

export interface ExitDoorOptions {
  position: bigint;
  block: number;
  factory: string;
}

export async function readExitDoor(rpc: RpcClient, launch: LaunchedToken, options: ExitDoorOptions): Promise<ExitDoor> {
  if (launch.phase === GraduationPhase.NotGraduated) {
    const [reservesRaw, feeRaw, readyRaw] = await rpc.callBatch(
      [
        { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.getReserves, []) },
        { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.feeBps, []) },
        { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.readyToGraduate, []) },
      ],
      options.block,
    );
    const [quote, token] = decodeOutputs(CURVE_FUNCTIONS.getReserves, reservesRaw) as [bigint, bigint];
    const [feeBps] = decodeOutputs(CURVE_FUNCTIONS.feeBps, feeRaw) as [bigint];
    const [ready] = decodeOutputs(CURVE_FUNCTIONS.readyToGraduate, readyRaw) as [boolean];
    const reserves = { token, quote };
    const quotes = quoteExit(options.position, reserves, feeBps, launch.creatorTaxBps);
    return {
      venue: ready ? "closed" : "curve",
      position: options.position,
      reserves,
      feeBps,
      creatorTaxBps: launch.creatorTaxBps,
      spot: token === 0n ? 0n : (quote * 10n ** 18n) / token,
      quotes,
      note: ready
        ? "The curve is full and waiting for graduate(); sells revert until the pool exists. Anyone can call graduate()."
        : "Priced with the curve's own sell arithmetic on reserves at this block: constant product, then protocol fee and creator tax on the quote leg.",
    };
  }
  if (launch.phase === GraduationPhase.Swept) {
    return { venue: "closed", position: options.position, reserves: { token: 0n, quote: 0n }, feeBps: 0n, creatorTaxBps: launch.creatorTaxBps, spot: 0n, quotes: [], note: "Swept, pool not created yet: nothing trades until the factory seeds the pool." };
  }
  const [pmRaw, hookRaw] = await rpc.callBatch(
    [
      { to: options.factory, data: encodeCall(FACTORY_FUNCTIONS.poolManager, []) },
      { to: options.factory, data: encodeCall(FACTORY_FUNCTIONS.memeHook, []) },
    ],
    options.block,
  );
  const [poolManager] = decodeOutputs(FACTORY_FUNCTIONS.poolManager, pmRaw) as [string];
  const [hook] = decodeOutputs(FACTORY_FUNCTIONS.memeHook, hookRaw) as [string];
  const state = await readPoolState(rpc, poolManager, launch, hook, options.block);
  const reserves = fullRangeReserves(state);
  let hookFeeBps = 0n;
  try {
    const [policyRaw] = await rpc.callBatch([{ to: hook, data: encodeCall(HOOK_FUNCTIONS.currentFeePolicy, []) }], options.block);
    hookFeeBps = decodeOutputs(HOOK_FUNCTIONS.currentFeePolicy, policyRaw)[3] as bigint;
  } catch {
    hookFeeBps = 0n;
  }
  const quotes = quoteExit(options.position, reserves, hookFeeBps, launch.creatorTaxBps);
  return {
    venue: "pool",
    position: options.position,
    reserves,
    feeBps: hookFeeBps,
    creatorTaxBps: launch.creatorTaxBps,
    spot: reserves.token === 0n ? 0n : (reserves.quote * 10n ** 18n) / reserves.token,
    quotes,
    note: `Estimate on the graduated pool: full-range liquidity and price read from PoolManager storage at this block, hook fee ${Number(hookFeeBps) / 100}% (live policy) and creator tax on the quote leg. Other LPs and concentrated positions, if any, are not modelled.`,
  };
}

export { ZERO_ADDRESS };
