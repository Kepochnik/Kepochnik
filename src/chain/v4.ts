/**
 * Uniswap V4 pools for an ordinary token.
 *
 * V4 has no factory to ask. Every pool on a chain lives inside one singleton
 * PoolManager, identified by the hash of its key — the two currencies, the
 * fee, the tick spacing and the hook contract. There is no getPool(a, b, fee)
 * to call, and guessing at fee and tick spacing would miss every pool with a
 * hook, which on V4 is most of the interesting ones.
 *
 * So the pools are found the only exact way: the PoolManager announces each
 * one with an Initialize log carrying the whole key, and both currencies are
 * indexed, so the chain itself can filter to the token in question. Two log
 * reads, then the pool's price and liquidity out of PoolManager storage.
 *
 * The address of the PoolManager is not written down here. On a chain with a
 * launchpad the factory answers poolManager() on chain, which is exact; on a
 * chain without one this is simply not read, and the slip says so. An address
 * recalled rather than checked is how a reader ends up reporting the state of
 * the wrong contract with total confidence.
 */
import { encodeCall, encodeWord, type FunctionAbi, type EventAbi, type Hex } from "./abi.js";
import { keccak256Hex } from "./keccak.js";
import type { MarketPool } from "./market.js";
import type { RpcClient } from "./rpc.js";
import { addressTopic, readTapeAdaptive } from "./tape.js";

/** Where PoolManager keeps its pools mapping. */
const POOLS_SLOT = 6n;

const EXTSLOAD: FunctionAbi = { name: "extsload", inputs: ["bytes32"], outputs: ["bytes32"] };

export const V4_EVENTS = {
  Initialize: {
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface V4Options {
  fromBlock: number;
  toBlock: number;
  chunkSize?: number;
  /** At most this many pools are read; the rest are counted and reported. */
  maxPools?: number;
  /** Most log requests each of the two Initialize scans may spend. */
  maxRequests?: number;
  /** Wall-clock budget for the Initialize scan, in milliseconds. */
  budgetMs?: number;
}

/** A V4 pool as the market code understands it, plus what only V4 has. */
export interface V4Pool extends MarketPool {
  kind: "v4";
  poolId: Hex;
  /** The hook contract, or the zero address. A hook can change what a swap costs. */
  hooks: string;
  tickSpacing: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Every V4 pool pairing `token` with `quote`, with its price and liquidity.
 *
 * Both currencies are indexed on Initialize, so the token is filtered on
 * either side by the node rather than by us reading everything back.
 */
export async function readV4Pools(rpc: RpcClient, token: string, quote: string, poolManager: string, options: V4Options): Promise<V4Pool[]> {
  const lower = token.toLowerCase();
  const quoteLower = quote.toLowerCase();
  const window = { address: poolManager, events: [V4_EVENTS.Initialize], fromBlock: options.fromBlock, toBlock: options.toBlock };
  // A singleton holding every pool on the chain is the busiest contract there
  // is, so the same budget applies here as to the mint history: without one,
  // a wide window on Base costs minutes and finishes nothing.
  const chunking = { minChunk: 1, startChunk: options.chunkSize ?? 5_000, maxChunk: 200_000, maxRequests: options.maxRequests ?? 20, budgetMs: options.budgetMs ?? 15_000 };

  // The token can be either currency, so ask for both sides.
  const [asCurrency0, asCurrency1] = await Promise.all([
    readTapeAdaptive(rpc, { ...window, topics: [addressTopic(lower)] }, chunking),
    readTapeAdaptive(rpc, { ...window, topics: [null, addressTopic(lower)] }, chunking),
  ]);

  const found = new Map<string, { poolId: Hex; fee: number; tickSpacing: number; hooks: string; tokenIsCurrency0: boolean }>();
  for (const log of [...asCurrency0.logs, ...asCurrency1.logs]) {
    const currency0 = String(log.args.currency0).toLowerCase();
    const currency1 = String(log.args.currency1).toLowerCase();
    const tokenIsCurrency0 = currency0 === lower;
    const other = tokenIsCurrency0 ? currency1 : currency0;
    if (other !== quoteLower) continue; // a pair against something else is not priced here
    const poolId = String(log.args.id) as Hex;
    if (found.has(poolId)) continue;
    found.set(poolId, {
      poolId,
      fee: Number(log.args.fee as bigint),
      tickSpacing: Number(log.args.tickSpacing as bigint),
      hooks: String(log.args.hooks).toLowerCase(),
      tokenIsCurrency0,
    });
  }
  if (!found.size) return [];

  const keys = [...found.values()].slice(0, options.maxPools ?? 16);
  // slot0 is at the pool's state slot; liquidity three words along.
  const calls: { to: string; data: Hex }[] = [];
  for (const key of keys) {
    const stateSlot = keccak256Hex(hexToBytes(`0x${key.poolId.slice(2)}${encodeWord("uint256", POOLS_SLOT)}`));
    const liquiditySlot: Hex = `0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`;
    calls.push({ to: poolManager, data: encodeCall(EXTSLOAD, [stateSlot]) });
    calls.push({ to: poolManager, data: encodeCall(EXTSLOAD, [liquiditySlot]) });
  }
  const raws = await rpc.callBatchSettled(calls, options.toBlock);

  const pools: V4Pool[] = [];
  keys.forEach((key, i) => {
    const slot0Raw = raws[i * 2];
    const liquidityRaw = raws[i * 2 + 1];
    if (slot0Raw instanceof Error || liquidityRaw instanceof Error) return;
    let sqrtPriceX96: bigint;
    let liquidity: bigint;
    try {
      // extsload returns one raw word. Reading it as a number straight off the
      // return data is what the launchpad's own V4 reader does; running it
      // through the bytes32 decoder hands back a hex string, and masking a
      // string silently is not a mistake worth leaving available.
      sqrtPriceX96 = BigInt(slot0Raw) & ((1n << 160n) - 1n);
      liquidity = BigInt(liquidityRaw) & ((1n << 128n) - 1n);
    } catch {
      return;
    }
    if (sqrtPriceX96 === 0n) return; // never initialised, or the slot moved
    pools.push({
      dex: key.hooks === ZERO ? "Uniswap V4" : "Uniswap V4 (hooked)",
      kind: "v4",
      address: poolManager,
      poolId: key.poolId,
      hooks: key.hooks,
      tickSpacing: key.tickSpacing,
      feeBps: key.fee / 100,
      tokenIsToken0: key.tokenIsCurrency0,
      // V4 holds every pool's funds in one contract, so a balance of the
      // PoolManager is not this pool's reserves. Leaving these null is the
      // truthful answer; the price and liquidity below are what a swap uses.
      tokenReserve: null,
      quoteReserve: null,
      sqrtPriceX96,
      liquidity,
    });
  });
  return pools;
}

/** What a V4 pool's hook means for a reader, in one sentence. */
export function hookNote(pool: V4Pool): string | null {
  if (pool.hooks === ZERO) return null;
  return `This V4 pool runs a hook (${pool.hooks}): code that executes on every swap and can charge its own fee, restrict who may trade, or refuse the swap outright. The quote above is the pool's arithmetic and does not include whatever the hook does.`;
}
