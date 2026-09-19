/**
 * THE MARKET: where an ordinary token trades, and what a sale would pay.
 *
 * A launchpad token has a curve with published arithmetic. Everything else has
 * pools, and three shapes cover almost all of them: Uniswap V3 and its forks
 * (concentrated liquidity, priced from sqrtPriceX96 and the liquidity in the
 * current tick), Uniswap V2 and its forks (constant product, priced exactly
 * from two reserves), and Solidly forks such as Aerodrome (constant product for
 * volatile pairs, a different invariant for stable ones, which is not priced
 * here and says so).
 *
 * Every quote is a quote from the pool, not a promise about a trade. It does
 * not include the token's own transfer tax, does not cross ticks on a V3 pool,
 * and is a snapshot of one block. Each of those is stated on the slip rather
 * than buried here.
 */
import { decodeOutputs, encodeCall, type FunctionAbi, type Hex } from "./abi.js";
import { DEFAULT_V3_FEE_TIERS, type DexTable } from "./chains.js";
import { ERC20_FUNCTIONS, ZERO_ADDRESS } from "./pons.js";
import type { RpcClient } from "./rpc.js";
import { readV4Pools } from "./v4.js";

const Q96 = 2n ** 96n;

const FACTORY_FUNCTIONS = {
  getPool: { name: "getPool", inputs: ["address", "address", "uint24"], outputs: ["address"] },
  getPair: { name: "getPair", inputs: ["address", "address"], outputs: ["address"] },
  getPoolStable: { name: "getPool", inputs: ["address", "address", "bool"], outputs: ["address"] },
} as const satisfies Record<string, FunctionAbi>;

const POOL_FUNCTIONS = {
  token0: { name: "token0", inputs: [], outputs: ["address"] },
  token1: { name: "token1", inputs: [], outputs: ["address"] },
  slot0: { name: "slot0", inputs: [], outputs: ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"] },
  liquidity: { name: "liquidity", inputs: [], outputs: ["uint128"] },
  fee: { name: "fee", inputs: [], outputs: ["uint24"] },
  getReserves: { name: "getReserves", inputs: [], outputs: ["uint112", "uint112", "uint32"] },
  getReservesWide: { name: "getReserves", inputs: [], outputs: ["uint256", "uint256", "uint256"] },
  stable: { name: "stable", inputs: [], outputs: ["bool"] },
} as const satisfies Record<string, FunctionAbi>;

/**
  * "v4" is priced with the same arithmetic as "v3" — both are a square-root
  * price and an in-range liquidity — but it is a separate kind because a V4
  * pool lives inside a singleton and can carry a hook, neither of which is
  * true of the others.
  */
export type PoolKind = "v3" | "v4" | "v2" | "solidly" | "unknown";

export interface MarketPool {
  dex: string;
  kind: PoolKind;
  address: string;
  /** Swap fee in basis points: a 1% pool is 100, a 0.3% pool is 30. Divide by 100 to print a percentage. */
  feeBps: number;
  /** True when the subject token sorts first in the pair, which decides the direction of every formula. */
  tokenIsToken0: boolean;
  /** The pool's balances, read as ERC-20 balances; null when a balance call failed. */
  tokenReserve: bigint | null;
  quoteReserve: bigint | null;
  /** V3 only: the price and the liquidity in the current tick. */
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  /** Solidly only: a stable pool uses a different invariant and is not priced here. */
  stable?: boolean;
  /** V4 only: the pool's key hash inside the singleton. */
  poolId?: string;
  /** V4 only: the hook contract, or the zero address. Code that runs on every swap. */
  hooks?: string;
  /** V4 only. */
  tickSpacing?: number;
}

export interface MarketQuote {
  shareBps: number;
  tokensIn: bigint;
  /** Quote-asset units out, before the token's own transfer tax. */
  out: bigint;
  /** What the sale realises against the marginal price, in bps. 10 000 means no impact. */
  realisedBps: number;
  /** True when a V3 quote would move the price far enough that liquidity outside the current tick decides the real answer. */
  beyondTick: boolean;
}

export interface Market {
  pools: MarketPool[];
  /** The pool a sale would use: the deepest one that can be priced. */
  best: MarketPool | null;
  /** Quote-asset units per one whole token at the marginal price, or null when nothing could be priced. */
  spot: bigint | null;
  quotes: MarketQuote[];
  /** What the numbers above do and do not include, in one sentence. */
  note: string;
}

/**
 * Finds every pool the chain's DEX table can point at, pairing the token with
 * the wrapped native coin. One batch asks the factories, a second reads each
 * pool's state. A factory that answers garbage is skipped rather than taking
 * the others down with it.
 */
export interface PoolsOptions {
  /** A resolved Uniswap V4 singleton. V4 has no factory to ask, so it is found by log instead. */
  v4PoolManager?: string;
  /** How far back to look for V4 Initialize logs. */
  v4FromBlock?: number;
  /**
   * Contracts that hold a lot of this token, to be asked whether they are
   * pools. This is how a DEX that is not in the chain's table gets found —
   * see `discoverPools`. Each candidate costs two calls in one batch.
   */
  candidates?: { address: string; name?: string | null }[];
}

/**
 * A DEX table is a list of factories somebody wrote down, which means every
 * chain has venues it does not cover — on a new chain, most of them. Ramses on
 * Robinhood Chain was the case that made this necessary: real pools, real
 * liquidity, invisible to the tool because nobody had typed the factory
 * address in.
 *
 * Guessing the factory address would be the wrong fix: a wrong guess is
 * either nothing or, worse, somebody else's contract. So the pool is found
 * from the other end. A pool holds the token — that is what a pool is — so it
 * is among the token's largest holders, and the explorer already lists those.
 * Ask each contract among them for `token0()` and `token1()`. A pool for this
 * pair answers with exactly our two addresses. Nothing else does, whatever it
 * is called.
 *
 * What this cannot do is name the DEX. It reports whatever name the caller
 * passes through (the explorer's verified contract name, when there is one)
 * and otherwise says the venue is unidentified, which is the truth.
 */
export async function discoverPools(
  rpc: RpcClient,
  token: string,
  quote: string,
  candidates: { address: string; name?: string | null }[],
  block: number,
  known: Set<string> = new Set(),
): Promise<MarketPool[]> {
  const subject = token.toLowerCase();
  const weth = quote.toLowerCase();
  const ask = candidates.filter((c) => {
    const a = c.address.toLowerCase();
    return a !== subject && a !== weth && !known.has(a);
  });
  if (!ask.length) return [];

  const calls = ask.flatMap((c) => [
    { to: c.address, data: encodeCall(POOL_FUNCTIONS.token0, []) },
    { to: c.address, data: encodeCall(POOL_FUNCTIONS.token1, []) },
  ]);
  let raws: (Hex | Error)[];
  try {
    // Settled: most candidates are not pools, and a candidate that reverts is
    // the expected case rather than a failure of the search.
    raws = await rpc.callBatchSettled(calls, block);
  } catch {
    return [];
  }

  const found: MarketPool[] = [];
  ask.forEach((candidate, i) => {
    const zero = raws[i * 2];
    const one = raws[i * 2 + 1];
    if (zero instanceof Error || one instanceof Error || zero === undefined || one === undefined) return;
    let token0: string;
    let token1: string;
    try {
      [token0] = decodeOutputs(POOL_FUNCTIONS.token0, zero) as [string];
      [token1] = decodeOutputs(POOL_FUNCTIONS.token1, one) as [string];
    } catch {
      return; // not a pool; it just happened to have those selectors
    }
    const pair = [token0.toLowerCase(), token1.toLowerCase()];
    // Both sides must match. A contract that answers token0() with our token
    // and token1() with something else is a pool for a different pair, and
    // pricing this token against it would be arithmetic on the wrong market.
    if (!(pair.includes(subject) && pair.includes(weth))) return;
    found.push({
      // "unknown" until the pool says otherwise, below. Defaulting to V2 here
      // would mean a concentrated pool got priced by constant product over its
      // raw balances, which overstates a sale worst on the large one.
      dex: candidate.name || "an unidentified venue",
      kind: "unknown",
      address: candidate.address.toLowerCase(),
      feeBps: 30,
      tokenIsToken0: pair[0] === subject,
      tokenReserve: null,
      quoteReserve: null,
    });
  });
  if (!found.length) return [];
  await classify(rpc, found, block);
  await hydrate(rpc, token, { weth: quote } as DexTable, found, block);
  return found;
}

/**
 * What shape is this pool? Asked, not assumed. Each pool is offered the three
 * questions only one family answers: a V3-style pool has a `slot0()`, a
 * Solidly pool has a `stable()`, a V2 pool has `getReserves()` and neither of
 * the others. A pool that answers none of them stays "unknown" and is never
 * priced — its reserves are still worth showing, because a venue nobody can
 * price is still a venue somebody can sell into.
 */
async function classify(rpc: RpcClient, pools: MarketPool[], block: number): Promise<void> {
  const calls = pools.flatMap((p) => [
    { to: p.address, data: encodeCall(POOL_FUNCTIONS.slot0, []) },
    { to: p.address, data: encodeCall(POOL_FUNCTIONS.stable, []) },
    { to: p.address, data: encodeCall(POOL_FUNCTIONS.getReserves, []) },
    { to: p.address, data: encodeCall(POOL_FUNCTIONS.fee, []) },
  ]);
  let raws: (Hex | Error)[];
  try {
    raws = await rpc.callBatchSettled(calls, block);
  } catch {
    return; // every pool stays unknown, which is the safe direction
  }
  pools.forEach((pool, i) => {
    const [slot0, stable, reserves, fee] = raws.slice(i * 4, i * 4 + 4);
    const ok = (raw: Hex | Error | undefined): raw is Hex => typeof raw === "string" && raw.length > 2;
    if (ok(slot0)) {
      pool.kind = "v3";
      if (ok(fee)) {
        try {
          pool.feeBps = Number(decodeOutputs(POOL_FUNCTIONS.fee, fee)[0] as bigint) / 100;
        } catch {
          // the default stands; hydrate reads it again anyway
        }
      }
      return;
    }
    if (ok(stable)) {
      try {
        pool.kind = "solidly";
        pool.stable = decodeOutputs(POOL_FUNCTIONS.stable, stable)[0] as boolean;
        pool.feeBps = pool.stable ? 5 : 30;
        return;
      } catch {
        // fall through: it had the selector but not the shape
      }
    }
    if (ok(reserves)) pool.kind = "v2";
  });
}

export async function readPools(rpc: RpcClient, token: string, dex: DexTable, block: number, tokenDecimals = 18, options: PoolsOptions = {}): Promise<MarketPool[]> {
  const asks: { dex: string; kind: PoolKind; feeBps: number; stable?: boolean }[] = [];
  const calls: { to: string; data: Hex }[] = [];
  for (const f of dex.v3Factories ?? []) {
    for (const fee of f.feeTiers ?? DEFAULT_V3_FEE_TIERS) {
      asks.push({ dex: f.name, kind: "v3", feeBps: fee / 100 });
      calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS.getPool, [token, dex.weth, BigInt(fee)]) });
    }
  }
  for (const f of dex.v2Factories ?? []) {
    asks.push({ dex: f.name, kind: "v2", feeBps: 30 });
    calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS.getPair, [token, dex.weth]) });
  }
  for (const f of dex.solidlyFactories ?? []) {
    for (const stable of [false, true]) {
      asks.push({ dex: f.name, kind: "solidly", feeBps: stable ? 5 : 30, stable });
      calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS.getPoolStable, [token, dex.weth, stable]) });
    }
  }
  // V4 has no factory call; its pools are announced by log. Started here so the
  // two searches overlap rather than queue.
  const v4 =
    options.v4PoolManager && options.v4FromBlock !== undefined
      ? readV4Pools(rpc, token, dex.weth, options.v4PoolManager, { fromBlock: Math.max(0, options.v4FromBlock), toBlock: block }).catch(() => [] as MarketPool[])
      : Promise.resolve([] as MarketPool[]);

  if (!calls.length) {
    const only = await v4;
    const extra = options.candidates?.length ? await discoverPools(rpc, token, dex.weth, options.candidates, block, new Set(only.map((p) => p.address))).catch(() => []) : [];
    return [...only, ...extra].sort(byDepth);
  }

  const raws = await rpc.callBatch(calls, block);
  const found: MarketPool[] = [];
  const seen = new Set<string>();
  raws.forEach((raw, i) => {
    try {
      const [address] = decodeOutputs(FACTORY_FUNCTIONS.getPool, raw) as [string];
      if (!address || address === ZERO_ADDRESS || seen.has(address)) return;
      seen.add(address);
      found.push({ ...asks[i], address, tokenIsToken0: false, tokenReserve: null, quoteReserve: null });
    } catch {
      // not a factory of this shape; the others are unaffected
    }
  });
  const v4Pools = await v4;
  if (found.length) await hydrate(rpc, token, dex, found, block);
  const all = [...found, ...v4Pools];

  // Last: the venues nobody wrote down. Only after the factories have had
  // their say, so a pool already found is not asked about twice, and only
  // when the caller supplied candidates — this costs a batch.
  if (options.candidates?.length) {
    const known = new Set(all.map((p) => p.address));
    const extra = await discoverPools(rpc, token, dex.weth, options.candidates, block, known).catch(() => []);
    all.push(...extra);
  }
  return all.sort(byDepth);
}

/** Reads each pool's direction, reserves and, for a V3 pool, its price and liquidity. */
async function hydrate(rpc: RpcClient, token: string, dex: DexTable, pools: MarketPool[], block: number): Promise<void> {
  const calls: { to: string; data: Hex }[] = [];
  const plan: { pool: MarketPool; field: string }[] = [];
  const want = (pool: MarketPool, field: string, to: string, data: Hex) => {
    plan.push({ pool, field });
    calls.push({ to, data });
  };
  for (const p of pools) {
    want(p, "token0", p.address, encodeCall(POOL_FUNCTIONS.token0, []));
    want(p, "tokenReserve", token, encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]));
    want(p, "quoteReserve", dex.weth, encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]));
    if (p.kind === "v3") {
      want(p, "slot0", p.address, encodeCall(POOL_FUNCTIONS.slot0, []));
      want(p, "liquidity", p.address, encodeCall(POOL_FUNCTIONS.liquidity, []));
      want(p, "fee", p.address, encodeCall(POOL_FUNCTIONS.fee, []));
    }
  }
  let raws: (Hex | Error)[];
  try {
    // Settled, not all-or-nothing: a pool without a slot0() must not cost the
    // others their reserves, and a pool that is not a V3 pool at all is common.
    raws = await rpc.callBatchSettled(calls, block);
  } catch {
    return; // the pools exist; their state is simply unread
  }
  plan.forEach(({ pool, field }, i) => {
    const raw = raws[i];
    if (raw instanceof Error) return;
    try {
      if (field === "token0") pool.tokenIsToken0 = (decodeOutputs(POOL_FUNCTIONS.token0, raw)[0] as string).toLowerCase() === token.toLowerCase();
      else if (field === "tokenReserve") pool.tokenReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] as bigint;
      else if (field === "quoteReserve") pool.quoteReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] as bigint;
      else if (field === "slot0") pool.sqrtPriceX96 = decodeOutputs(POOL_FUNCTIONS.slot0, raw)[0] as bigint;
      else if (field === "liquidity") pool.liquidity = decodeOutputs(POOL_FUNCTIONS.liquidity, raw)[0] as bigint;
      else if (field === "fee") pool.feeBps = Number(decodeOutputs(POOL_FUNCTIONS.fee, raw)[0] as bigint) / 100;
    } catch {
      // one unread field must not discard the pool it belongs to
    }
  });
}

/**
 * How much quote asset stands behind this pool, for ranking them.
 *
 * A V4 pool keeps its funds in the singleton, so it has no balance of its own
 * to read and ordering by one would always put it last, however deep it is.
 * Its in-range liquidity converts to the same units — L·√P/2^96 is the quote
 * side of that liquidity — which is comparable enough to sort by. It is NOT
 * written into quoteReserve: that field means a balance somebody read, and a
 * derived number does not belong in it.
 */
export function depth(pool: MarketPool): bigint {
  if (pool.quoteReserve !== null) return pool.quoteReserve;
  const sqrt = pool.sqrtPriceX96 ?? 0n;
  const liquidity = pool.liquidity ?? 0n;
  if (sqrt <= 0n || liquidity <= 0n) return -1n;
  return pool.tokenIsToken0 ? (liquidity * sqrt) / Q96 : (liquidity * Q96) / sqrt;
}

const byDepth = (a: MarketPool, b: MarketPool): number => {
  const x = depth(a);
  const y = depth(b);
  return y > x ? 1 : y < x ? -1 : 0;
};

/** Whether this pool holds enough state to price a sale. */
export function canPrice(pool: MarketPool): boolean {
  // A pool found by discovery that answered none of the shape probes. Its
  // reserves are real and are shown; what its invariant does with them is not
  // known, and constant product is a guess that would be wrong in exactly the
  // direction that flatters the sale.
  if (pool.kind === "unknown") return false;
  if (pool.kind === "v3" || pool.kind === "v4") return (pool.sqrtPriceX96 ?? 0n) > 0n && (pool.liquidity ?? 0n) > 0n;
  if (pool.kind === "solidly" && pool.stable) return false;
  return (pool.tokenReserve ?? 0n) > 0n && (pool.quoteReserve ?? 0n) > 0n;
}

/**
 * Marginal price: quote-asset units for one whole token, before any fee.
 * On a V3 pool it follows from sqrtPriceX96; on a constant-product pool it is
 * the ratio of the reserves.
 */
export function spotPrice(pool: MarketPool, tokenDecimals: number): bigint | null {
  const one = 10n ** BigInt(tokenDecimals);
  if (pool.kind === "v3" || pool.kind === "v4") {
    const sqrt = pool.sqrtPriceX96 ?? 0n;
    if (sqrt <= 0n) return null;
    // price of token1 per token0 is (sqrtP / 2^96)^2.
    return pool.tokenIsToken0 ? (sqrt * sqrt * one) / (Q96 * Q96) : (Q96 * Q96 * one) / (sqrt * sqrt);
  }
  const t = pool.tokenReserve ?? 0n;
  const q = pool.quoteReserve ?? 0n;
  if (t <= 0n || q <= 0n) return null;
  return (q * one) / t;
}

/**
 * What selling `tokensIn` into this pool pays, in quote-asset units.
 *
 * Constant product is exact. V3 is exact inside the current tick and
 * optimistic beyond it, because the liquidity in the next tick range is not
 * read; `beyondTick` marks a quote that leaves the range, and the slip says
 * the real answer needs the ticks nobody read.
 */
export function quoteSale(pool: MarketPool, tokensIn: bigint): { out: bigint; beyondTick: boolean } | null {
  if (tokensIn <= 0n || !canPrice(pool)) return null;
  const feeBps = BigInt(Math.round(pool.feeBps));
  const afterFee = (tokensIn * (10_000n - feeBps)) / 10_000n;
  if (afterFee <= 0n) return { out: 0n, beyondTick: false };

  // V4 is concentrated like V3 and, unlike every other kind here, keeps its
  // funds in a singleton — so it has no reserves of its own to multiply. It
  // must take the branch below, not this one.
  if (pool.kind !== "v3" && pool.kind !== "v4") {
    const t = pool.tokenReserve ?? 0n;
    const q = pool.quoteReserve ?? 0n;
    // x * y = k, with the fee already taken off the input.
    const out = (afterFee * q) / (t + afterFee);
    return { out: out > q ? q : out, beyondTick: false };
  }

  const sqrt = pool.sqrtPriceX96!;
  const L = pool.liquidity!;
  if (pool.tokenIsToken0) {
    // Selling token0 pushes the price down: sqrtNext = L * sqrt / (L + dx * sqrt / Q96)
    const denominator = L * Q96 + afterFee * sqrt;
    if (denominator <= 0n) return null;
    const sqrtNext = (L * Q96 * sqrt) / denominator;
    const out = (L * (sqrt - sqrtNext)) / Q96;
    return { out, beyondTick: sqrtNext * 2n < sqrt };
  }
  // Selling token1 pushes the price up: sqrtNext = sqrt + dy * Q96 / L
  const sqrtNext = sqrt + (afterFee * Q96) / L;
  if (sqrtNext <= sqrt) return { out: 0n, beyondTick: false };
  const out = (L * Q96 * (sqrtNext - sqrt)) / (sqrtNext * sqrt);
  return { out, beyondTick: sqrtNext > sqrt * 2n };
}

/**
 * Prices a position walking out of the deepest pool that can be priced, at
 * four sizes, the way the launchpad exit door does for a curve.
 */
export function readMarket(pools: MarketPool[], position: bigint, tokenDecimals: number, quoteSymbol: string): Market {
  const priceable = pools.filter(canPrice);
  const best = priceable[0] ?? null;
  if (!best) {
    return {
      pools,
      best: null,
      spot: null,
      quotes: [],
      note: pools.length
        ? `A pool exists but nothing in it could be priced: ${pools.every((p) => p.stable) ? "a Solidly stable pool uses an invariant this does not model" : "its reserves or price did not read"}.`
        : `No ${quoteSymbol} pool on the chain's known DEX factories. It may trade on another venue, against another pair, or not at all.`,
    };
  }
  const spot = spotPrice(best, tokenDecimals);
  const one = 10n ** BigInt(tokenDecimals);
  const quotes: MarketQuote[] = [];
  for (const shareBps of [1_000, 2_500, 5_000, 10_000]) {
    const tokensIn = (position * BigInt(shareBps)) / 10_000n;
    const priced = quoteSale(best, tokensIn);
    if (!priced || tokensIn <= 0n) continue;
    const reference = spot !== null ? (spot * tokensIn) / one : 0n;
    quotes.push({
      shareBps,
      tokensIn,
      out: priced.out,
      realisedBps: reference > 0n ? Number((priced.out * 10_000n) / reference) : 0,
      beyondTick: priced.beyondTick,
    });
  }
  const crosses = quotes.some((q) => q.beyondTick);
  return {
    pools,
    best,
    spot,
    quotes,
    note:
      `Priced on the ${best.dex} ${best.kind === "v3" ? "V3" : best.kind === "v4" ? "V4" : best.kind === "v2" ? "V2" : best.kind === "solidly" ? "Solidly" : "unidentified"} pool at ${(best.feeBps / 100).toFixed(2)}% fee, from its state at this block. ` +
      (best.kind === "v3" || best.kind === "v4"
        ? `Concentrated liquidity: exact inside the current tick${crosses ? ", and the larger sizes leave it, so the real answer depends on ticks this does not read" : ""}. `
        : "Constant product, so the arithmetic is exact for the pool. ") +
      `The token's own transfer tax, if it has one, is not included, and nothing here is a promise about a trade.`,
  };
}
