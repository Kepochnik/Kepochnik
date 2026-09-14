/**
 * Block-pinned reads of one Pons V2 launch. Every number in a snapshot comes
 * from the same block, so a receipt never mixes two moments in time.
 */
import { decodeOutputs, encodeCall, normalizeAddress, type Hex } from "./abi.js";
import {
  CURVE_FUNCTIONS,
  ERC20_FUNCTIONS,
  FACTORY_FUNCTIONS,
  GraduationPhase,
  PONS_V2_FACTORY,
  decodeLaunchedToken,
  type LaunchedToken,
} from "./pons.js";
import type { RpcClient } from "./rpc.js";

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

export interface CurveState {
  quoteReserve: bigint; // virtual + real pricing reserve
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  phantomQuote: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  readyToGraduate: boolean;
  graduated: boolean;
  quoteFeeBalance: bigint;
  creatorTaxBalance: bigint;
  buybackQuoteBalance: bigint;
  isNativeQuote: boolean;
}

export interface LaunchSnapshot {
  chainId: number;
  block: { number: number; timestamp: number };
  launch: LaunchedToken;
  token: TokenMeta;
  curve: CurveState | null; // null once the curve has been swept
  deployerBalance: bigint;
  curveTokenBalance: bigint;
}

export class NotAPonsLaunch extends Error {
  constructor(readonly address: string) {
    super(`${address} is not a Pons V2 launch on this factory`);
    this.name = "NotAPonsLaunch";
  }
}

export class PonsReader {
  constructor(
    private readonly rpc: RpcClient,
    private readonly factory: string = PONS_V2_FACTORY,
  ) {}

  /** Factory launch record, or throws NotAPonsLaunch. */
  async launchedToken(token: string, blockNumber: number): Promise<LaunchedToken> {
    const address = normalizeAddress(token);
    const [raw] = await this.rpc.callBatch(
      [{ to: this.factory, data: encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [address]) }],
      blockNumber,
    );
    const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, raw));
    if (!record.exists) throw new NotAPonsLaunch(address);
    return record;
  }

  /** Everything a receipt needs, pinned to `blockNumber` (defaults to the latest block). */
  async snapshot(token: string, blockNumber?: number): Promise<LaunchSnapshot> {
    await this.rpc.assertChain();
    const chainId = await this.rpc.chainId();
    const pinned = blockNumber ?? (await this.rpc.blockNumber());
    const header = await this.rpc.getBlock(pinned);
    const launch = await this.launchedToken(token, pinned);

    const tokenCalls = [
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) },
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [launch.deployer]) },
      { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [launch.curve]) },
    ];
    const curveOrder = [
      CURVE_FUNCTIONS.getReserves,
      CURVE_FUNCTIONS.realQuoteReserve,
      CURVE_FUNCTIONS.graduationThreshold,
      CURVE_FUNCTIONS.phantomQuote,
      CURVE_FUNCTIONS.feeBps,
      CURVE_FUNCTIONS.creatorTaxBps,
      CURVE_FUNCTIONS.readyToGraduate,
      CURVE_FUNCTIONS.graduated,
      CURVE_FUNCTIONS.quoteFeeBalance,
      CURVE_FUNCTIONS.creatorTaxBalance,
      CURVE_FUNCTIONS.buybackQuoteBalance,
      CURVE_FUNCTIONS.isNativeQuote,
    ];
    const onCurve = launch.phase === GraduationPhase.NotGraduated;
    const curveCalls = onCurve ? curveOrder.map((fn) => ({ to: launch.curve, data: encodeCall(fn, []) })) : [];

    const results = await this.rpc.callBatch([...tokenCalls, ...curveCalls], pinned);
    const [name] = decodeOutputs(ERC20_FUNCTIONS.name, results[0]) as [string];
    const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, results[1]) as [string];
    const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, results[2]) as [bigint];
    const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, results[3]) as [bigint];
    const [deployerBalance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, results[4]) as [bigint];
    const [curveTokenBalance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, results[5]) as [bigint];

    let curve: CurveState | null = null;
    if (onCurve) {
      const out = curveOrder.map((fn, index) => decodeOutputs(fn, results[tokenCalls.length + index]));
      curve = {
        quoteReserve: out[0][0] as bigint,
        tokenReserve: out[0][1] as bigint,
        realQuoteReserve: out[1][0] as bigint,
        graduationThreshold: out[2][0] as bigint,
        phantomQuote: out[3][0] as bigint,
        feeBps: out[4][0] as bigint,
        creatorTaxBps: out[5][0] as bigint,
        readyToGraduate: out[6][0] as boolean,
        graduated: out[7][0] as boolean,
        quoteFeeBalance: out[8][0] as bigint,
        creatorTaxBalance: out[9][0] as bigint,
        buybackQuoteBalance: out[10][0] as bigint,
        isNativeQuote: out[11][0] as boolean,
      };
    }

    return {
      chainId,
      block: { number: header.number, timestamp: header.timestamp },
      launch,
      token: { name, symbol, decimals: Number(decimals), totalSupply },
      curve,
      deployerBalance,
      curveTokenBalance,
    };
  }
}

/** Encode a single view call; exported for fixtures and tests. */
export function viewCall(to: string, data: Hex): { to: string; data: Hex } {
  return { to: normalizeAddress(to), data };
}

/** Symbol and decimals of any ERC-20 (used for stock-token quote assets). */
export async function readTokenMeta(rpc: RpcClient, address: string, blockNumber: number): Promise<{ symbol: string; decimals: number }> {
  const [symbolRaw, decimalsRaw] = await rpc.callBatch(
    [
      { to: address, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
      { to: address, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
    ],
    blockNumber,
  );
  const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, symbolRaw) as [string];
  const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, decimalsRaw) as [bigint];
  return { symbol, decimals: Number(decimals) };
}
