/**
 * THE PRICE, FROM THE POOL'S OWN SWAPS.
 *
 * Every chart on every token site is an index's opinion: somebody else's
 * server aggregated somebody else's trades and told you a number. This one is
 * the pool's own Swap log, read the same way as everything else on a slip —
 * so the line under the price is the same kind of fact as the line saying who
 * can freeze your tokens, and it can be checked against the chain by hand.
 *
 * Two shapes of swap carry a price:
 *
 *   V3 / V4   the event carries `sqrtPriceX96` AFTER the swap, so each log is
 *             a price with no arithmetic across logs at all. This is exact.
 *   V2        the event carries the four amounts, so the price of that one
 *             trade is what went out over what went in. It is the realised
 *             price of a real trade, which is not the same as the marginal
 *             price and is the better number to draw anyway.
 *
 * What it deliberately does NOT do is fill gaps. An hour with no swaps is an
 * hour with no point, not a flat line drawn between two real ones: a chart
 * that invents the quiet is a chart that hides exactly the thing worth seeing
 * on a token nobody is trading.
 */
import type { EventAbi } from "./abi.js";
import type { MarketPool } from "./market.js";
import type { RpcClient } from "./rpc.js";
import { readTapeAdaptive } from "./tape.js";

/** Uniswap V3 and its ports: the swap carries the price that followed it. */
export const V3_SWAP: EventAbi = {
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
};

/** Uniswap V2 and its ports: four amounts, one realised price. */
export const V2_SWAP: EventAbi = {
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "amount0In", type: "uint256", indexed: false },
    { name: "amount1In", type: "uint256", indexed: false },
    { name: "amount0Out", type: "uint256", indexed: false },
    { name: "amount1Out", type: "uint256", indexed: false },
    { name: "to", type: "address", indexed: true },
  ],
};

/**
 * Uniswap V4: every pool lives inside one PoolManager, so the swap names its
 * pool by id rather than by the address that emitted it.
 *
 * Two things differ from V3 and both are traps. The signature is not V3's,
 * so a V3 filter on the PoolManager matches nothing at all — which reads
 * exactly like a token nobody traded. And the amounts are the SWAPPER's
 * balance change, not the pool's: negative is what the trader paid in. V3
 * is the other way round. Reading one with the other's sign convention turns
 * every buy into a sell.
 *
 * Checked against v4-core, because the interface says the opposite: the
 * natspec on IPoolManager.Swap calls amount0 "the delta of the currency0
 * balance of the pool", but PoolManager emits `delta.amount0()` from
 * Pool.swap — the same delta it then books to msg.sender — and for an exact-
 * input swap Pool.swap builds that leg as `amountSpecified - remaining`,
 * which is negative. Do not "fix" this against the comment.
 */
export const V4_SWAP: EventAbi = {
  name: "Swap",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
};

/** Which Swap a pool emits, where to ask for it, and whether its amounts are the pool's side or the trader's. */
export function swapShape(pool: MarketPool): { event: EventAbi; topics: (string | null)[]; traderSide: boolean; sqrt: boolean } | null {
  if (pool.kind === "v4") {
    // Without the id there is no way to tell this pool's swaps from every
    // other pool in the singleton, and reading them all would be worse than
    // reading none.
    if (!pool.poolId) return null;
    return { event: V4_SWAP, topics: [pool.poolId.toLowerCase()], traderSide: true, sqrt: true };
  }
  if (pool.kind === "v3") return { event: V3_SWAP, topics: [], traderSide: false, sqrt: true };
  if (pool.kind === "v2" || pool.kind === "solidly") return { event: V2_SWAP, topics: [], traderSide: false, sqrt: false };
  return null;
}

const Q96 = 1n << 96n;

export interface PricePoint {
  block: number;
  /** Quote-asset units for one whole token, at that swap. */
  price: bigint;
  /** True when the trade moved tokens INTO the pool, i.e. somebody sold. */
  sell: boolean;
}

export interface PriceSeries {
  points: PricePoint[];
  /** The pool the line was read from. */
  venue: string;
  poolAddress: string;
  fromBlock: number;
  toBlock: number;
  /** How many swaps the window held, before thinning for the drawing. */
  swaps: number;
  /** Why there is no line, when there is none. Null when the read worked. */
  unread: string | null;
}

export interface PriceSeriesOptions {
  fromBlock: number;
  toBlock: number;
  tokenDecimals: number;
  /** Most points to keep; the walk thins evenly rather than cutting the start off. */
  maxPoints?: number;
  chunkSize?: number;
}

/**
 * The price of one whole token after a V3 swap.
 *
 * `sqrtPriceX96` is √(token1/token0) in Q64.96, so squaring it gives token1
 * per token0. Which of the two is the token being checked decides whether the
 * ratio is used or inverted — the same rule `spotPrice` follows, and the same
 * trap: inverting the wrong way produces a number that looks like a price and
 * is the reciprocal of one.
 */
function priceFromSqrt(sqrt: bigint, tokenIsToken0: boolean, one: bigint): bigint | null {
  if (sqrt <= 0n) return null;
  return tokenIsToken0 ? (sqrt * sqrt * one) / (Q96 * Q96) : (Q96 * Q96 * one) / (sqrt * sqrt);
}

/**
 * Reads the deepest pool's swaps over a window and returns a price line.
 *
 * Never throws: a refused or unsupported read comes back as `unread` with the
 * reason, because a chart that silently flatlines is worse than one that says
 * the log could not be walked.
 */
export async function readPriceSeries(rpc: RpcClient, pool: MarketPool, options: PriceSeriesOptions): Promise<PriceSeries> {
  const base: PriceSeries = {
    points: [],
    venue: pool.dex,
    poolAddress: pool.address,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    swaps: 0,
    unread: null,
  };
  const shape = swapShape(pool);
  if (!shape) return { ...base, unread: pool.kind === "v4" ? "a V4 pool without its id cannot be told apart from the rest of the PoolManager" : `a ${pool.kind} pool's swaps are not read here` };

  const one = 10n ** BigInt(options.tokenDecimals);
  let logs;
  try {
    const tape = await readTapeAdaptive(
      rpc,
      { address: pool.address.toLowerCase(), events: [shape.event], topics: shape.topics, fromBlock: options.fromBlock, toBlock: options.toBlock },
      { minChunk: 1, startChunk: options.chunkSize ?? 2_000, maxChunk: 20_000 },
    );
    logs = tape.logs;
  } catch (error) {
    return { ...base, unread: error instanceof Error ? error.message : String(error) };
  }

  const points: PricePoint[] = [];
  for (const log of logs) {
    if (shape.sqrt) {
      const price = priceFromSqrt(log.args.sqrtPriceX96 as bigint, pool.tokenIsToken0, one);
      if (price === null || price === 0n) continue;
      // V3: positive is what went INTO the pool. V4: negative is what the
      // trader paid, which is the same direction with the other sign.
      const amount = (pool.tokenIsToken0 ? log.args.amount0 : log.args.amount1) as bigint;
      points.push({ block: log.blockNumber, price, sell: shape.traderSide ? amount < 0n : amount > 0n });
      continue;
    }
    const a0In = log.args.amount0In as bigint;
    const a1In = log.args.amount1In as bigint;
    const a0Out = log.args.amount0Out as bigint;
    const a1Out = log.args.amount1Out as bigint;
    const tokenIn = pool.tokenIsToken0 ? a0In : a1In;
    const tokenOut = pool.tokenIsToken0 ? a0Out : a1Out;
    const quoteIn = pool.tokenIsToken0 ? a1In : a0In;
    const quoteOut = pool.tokenIsToken0 ? a1Out : a0Out;
    // One side of each leg is zero on a real swap. A trade with tokens on both
    // sides, or neither, is not one this can price.
    const tokens = tokenIn > 0n ? tokenIn : tokenOut;
    const quote = quoteIn > 0n ? quoteIn : quoteOut;
    if (tokens <= 0n || quote <= 0n) continue;
    points.push({ block: log.blockNumber, price: (quote * one) / tokens, sell: tokenIn > 0n });
  }

  return { ...base, points: thin(points, options.maxPoints ?? 120), swaps: points.length };
}

/**
 * Keeps at most `max` points, evenly spread, and always the first and last.
 *
 * Dropping the tail would move "now" backwards, and dropping the head would
 * start the line in the middle of the window — both make the drawing say
 * something about a period it did not read.
 */
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Highest and lowest in the line, for an axis that is read rather than guessed. */
export function seriesRange(series: PriceSeries): { low: bigint; high: bigint } | null {
  if (!series.points.length) return null;
  let low = series.points[0].price;
  let high = low;
  for (const p of series.points) {
    if (p.price < low) low = p.price;
    if (p.price > high) high = p.price;
  }
  return { low, high };
}

/**
 * The move across the window, in basis points, or null when there is nothing
 * to compare. Two points at the same price is a real zero; one point is not a
 * change at all and says so.
 */
export function seriesChangeBps(series: PriceSeries): number | null {
  if (series.points.length < 2) return null;
  const first = series.points[0].price;
  const last = series.points[series.points.length - 1].price;
  if (first <= 0n) return null;
  return Number(((last - first) * 10_000n) / first);
}
