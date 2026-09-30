/**
 * THE TAPE: every buy and every sell, newest first.
 *
 * The watch (watch.ts) follows the people worth following — the deployer, the
 * crew — and says nothing about anybody else. That is the right answer to
 * "has the dev moved" and the wrong answer to "what is happening right now",
 * which is the question somebody staring at a token actually has. This reads
 * the trades themselves, whoever made them.
 *
 * Two places a trade can be read, and both are the trade itself rather than
 * an index's summary of it:
 *
 *   curve   a launchpad token before graduation. CurveBuy and CurveSell name
 *           the buyer and the seller outright, and carry the quote, the fee
 *           and the creator's tax. Nothing here is inferred.
 *   pool    a graduated or ordinary token. The pool's Swap log carries both
 *           amounts, so the size and the realised price are exact — but the
 *           address on the log is where the tokens went, which is a router at
 *           least as often as a person. `walletExact` says which it is, so a
 *           page can print "buyer" only where the chain used that word.
 *
 * What it will not do is merge the two into one feed. A token mid-graduation
 * trades in both places and a tape that stitched them would silently double
 * a trade that touched both; the caller picks a source and the tape says
 * which one it read.
 */
import type { MarketPool } from "../chain/market.js";
import { CURVE_EVENTS } from "../chain/pons.js";
import { swapShape } from "../chain/priceSeries.js";
import type { RpcClient } from "../chain/rpc.js";
import { readTapeAdaptive } from "../chain/tape.js";

export type TradeSide = "buy" | "sell";

export interface Trade {
  block: number;
  logIndex: number;
  tx: string;
  side: TradeSide;
  /** Who took the other side: the buyer or seller on a curve, where the tokens went or came from on a pool. */
  wallet: string;
  /** True when the chain named this wallet as the trader. False when it is a swap's recipient, which may be a router. */
  walletExact: boolean;
  tokens: bigint;
  quote: bigint;
  /** Basis points of total supply this trade moved, or null when the supply is unknown. */
  shareBps: number | null;
  /** Quote paid for one whole token on this trade — realised, not marginal. Null when either leg was zero. */
  price: bigint | null;
  /** Curve only: the trading fee and the creator's tax, both in quote units. */
  feeQuote?: bigint;
  taxQuote?: bigint;
}

export interface TradeTape {
  trades: Trade[];
  source: "curve" | "pool";
  /** The launchpad's name, or the DEX the pool belongs to. */
  venue: string;
  /** The curve or the pool the trades were read from. */
  address: string;
  fromBlock: number;
  toBlock: number;
  /** How many trades the window held before the limit cut it. */
  total: number;
  /** Buys and sells in the window, counted before the limit. */
  buys: number;
  sells: number;
  /** Quote that went in and came out over the window. */
  boughtQuote: bigint;
  soldQuote: bigint;
  /** Why there is no tape, when there is none. Null when the read worked. */
  unread: string | null;
}

export type TradeSource =
  | { kind: "curve"; curve: string; venue: string }
  | { kind: "pool"; pool: MarketPool };

export interface TradeOptions {
  fromBlock: number;
  toBlock: number;
  /** Total supply, for the share column. Omit when it could not be read. */
  supply?: bigint;
  /** The token's decimals, so the realised price is per whole token. Default 18. */
  tokenDecimals?: number;
  /** Most trades to keep, newest first. Default 60. */
  limit?: number;
  chunkSize?: number;
}

/**
 * Reads a window of trades. Never throws: a refused log walk comes back as
 * `unread` with the reason, because a tape that silently shows nothing and a
 * token nobody is trading look identical on screen and are not the same fact.
 */
export async function readTrades(rpc: RpcClient, source: TradeSource, options: TradeOptions): Promise<TradeTape> {
  const base: TradeTape = {
    trades: [],
    source: source.kind,
    venue: source.kind === "curve" ? source.venue : source.pool.dex,
    address: (source.kind === "curve" ? source.curve : source.pool.address).toLowerCase(),
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    total: 0,
    buys: 0,
    sells: 0,
    boughtQuote: 0n,
    soldQuote: 0n,
    unread: null,
  };
  const shape = source.kind === "curve" ? null : swapShape(source.pool);
  if (source.kind === "pool" && !shape) {
    return { ...base, unread: source.pool.kind === "v4" ? "a V4 pool without its id cannot be told apart from the rest of the PoolManager" : `a ${source.pool.kind} pool's swaps are not read here` };
  }

  let logs;
  try {
    const tape = await readTapeAdaptive(
      rpc,
      {
        address: base.address,
        events: source.kind === "curve" ? [CURVE_EVENTS.CurveBuy, CURVE_EVENTS.CurveSell] : [shape!.event],
        topics: shape?.topics ?? [],
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
      },
      { minChunk: 1, startChunk: options.chunkSize ?? 2_000, maxChunk: 20_000 },
    );
    logs = tape.logs;
  } catch (error) {
    return { ...base, unread: error instanceof Error ? error.message : String(error) };
  }

  const supply = options.supply ?? 0n;
  const one = 10n ** BigInt(options.tokenDecimals ?? 18);
  const trades: Trade[] = [];
  for (const log of logs) {
    const trade = source.kind === "curve" ? fromCurve(log) : fromSwap(log, source.pool, shape!.sqrt, shape!.traderSide);
    if (!trade) continue;
    trade.shareBps = supply > 0n ? Number((trade.tokens * 10_000n) / supply) : null;
    // What this trade actually paid per whole token. Not the marginal price
    // the pool would quote next — the one this trade got, which is the number
    // that tells you whether a big sell ate the book.
    trade.price = trade.quote > 0n ? (trade.quote * one) / trade.tokens : null;
    trades.push(trade);
  }

  for (const t of trades) {
    if (t.side === "buy") {
      base.buys++;
      base.boughtQuote += t.quote;
    } else {
      base.sells++;
      base.soldQuote += t.quote;
    }
  }
  // Newest first: a tape is read from the top, and the chain hands them over
  // oldest first.
  trades.reverse();
  return { ...base, trades: trades.slice(0, options.limit ?? 60), total: trades.length };
}

/** A curve trade, where the chain names the trader outright. */
function fromCurve(log: { name: string; blockNumber: number; logIndex: number; transactionHash: string; args: Record<string, unknown> }): Trade | null {
  const buy = log.name === "CurveBuy";
  const tokens = (buy ? log.args.tokensOut : log.args.tokensIn) as bigint;
  const quote = (buy ? log.args.quoteIn : log.args.quoteOut) as bigint;
  if (tokens <= 0n) return null;
  return {
    block: log.blockNumber,
    logIndex: log.logIndex,
    tx: log.transactionHash,
    side: buy ? "buy" : "sell",
    // The recipient is where the tokens actually landed, which on a curve is
    // the buyer unless they deliberately sent them elsewhere. Both are named
    // by the event; this is the one that says who holds them now.
    wallet: String(buy ? log.args.recipient : log.args.seller).toLowerCase(),
    walletExact: true,
    tokens,
    quote,
    shareBps: null,
    price: null,
    feeQuote: log.args.fee as bigint,
    taxQuote: log.args.tax as bigint,
  };
}

/** A pool swap, where the amounts are exact and the address is only where the tokens went. */
function fromSwap(
  log: { blockNumber: number; logIndex: number; transactionHash: string; args: Record<string, unknown> },
  pool: MarketPool,
  signed: boolean,
  traderSide: boolean,
): Trade | null {
  if (signed) {
    // V3: positive means that token went INTO the pool. V4: the amounts are
    // the trader's balance change, so negative is what the trader paid in.
    const tokenAmount = (pool.tokenIsToken0 ? log.args.amount0 : log.args.amount1) as bigint;
    const quoteAmount = (pool.tokenIsToken0 ? log.args.amount1 : log.args.amount0) as bigint;
    const tokens = tokenAmount < 0n ? -tokenAmount : tokenAmount;
    const quote = quoteAmount < 0n ? -quoteAmount : quoteAmount;
    if (tokens <= 0n || quote <= 0n) return null;
    const intoPool = traderSide ? tokenAmount < 0n : tokenAmount > 0n;
    return {
      block: log.blockNumber,
      logIndex: log.logIndex,
      tx: log.transactionHash,
      side: intoPool ? "sell" : "buy",
      // V4 names only the caller — the router that unlocked the manager —
      // so on V4 this is the router, and walletExact stays false.
      wallet: String(traderSide ? log.args.sender : log.args.recipient).toLowerCase(),
      walletExact: false,
      tokens,
      quote,
      shareBps: null,
      price: null,
    };
  }
  const a0In = log.args.amount0In as bigint;
  const a1In = log.args.amount1In as bigint;
  const a0Out = log.args.amount0Out as bigint;
  const a1Out = log.args.amount1Out as bigint;
  const tokenIn = pool.tokenIsToken0 ? a0In : a1In;
  const tokenOut = pool.tokenIsToken0 ? a0Out : a1Out;
  const quoteIn = pool.tokenIsToken0 ? a1In : a0In;
  const quoteOut = pool.tokenIsToken0 ? a1Out : a0Out;
  const tokens = tokenIn > 0n ? tokenIn : tokenOut;
  const quote = quoteIn > 0n ? quoteIn : quoteOut;
  if (tokens <= 0n || quote <= 0n) return null;
  return {
    block: log.blockNumber,
    logIndex: log.logIndex,
    tx: log.transactionHash,
    side: tokenIn > 0n ? "sell" : "buy",
    wallet: String(log.args.to).toLowerCase(),
    walletExact: false,
    tokens,
    quote,
    shareBps: null,
    price: null,
  };
}
