/**
 * WHAT WOULD *MY* SIZE GET OUT?
 *
 * The slip answers "can this be sold" and "what is it worth". It did not
 * answer the question somebody actually holds in their head, which is
 * whether THEIR bag can leave — and those are different questions the
 * moment a position is large next to the pool. A token with a healthy
 * price and $4,000 of liquidity is not a token you can exit $10,000 from,
 * and the price tells you nothing about which case you are in.
 *
 * Two decisions run through this whole file.
 *
 * PRICED FROM THE RESERVES ALREADY IN HAND, never from a new read. The
 * reserves came back at a block or a slot the slip names; the pool
 * arithmetic on them is deterministic, so a size typed into the box is
 * answered instantly, offline, and — this is the part that matters — at
 * the SAME moment as every other number on the page. A calculator that
 * fetched fresh reserves would quietly be quoting a different block from
 * the holder list above it, and nobody would see the seam.
 *
 * NO VENUE MEANS NO ANSWER. Every path here either produces a quote or
 * says, in a sentence, why it cannot. It must never fall through to zero:
 * "you would get 0" is a statement about the token, and "BOUNCER could not
 * find a pool to price against" is a statement about the reading, and
 * printing the first when the second is true is the failure this project
 * exists to avoid.
 */
import { curveAmountOut } from "../chain/pons.js";
import { quoteCurveSale, quotePoolSale, type SolanaMarket, type SolanaPool } from "../chain/solanaPools.js";
import type { MarketPool } from "../chain/market.js";
import type { DoorSlip } from "./door.js";
import type { SplSlip } from "./spl.js";

export interface SizeQuote {
  /** What was asked for, in the token's own units. */
  tokensIn: bigint;
  /** What comes back, in the quote asset's units, after the venue's fee and any creator tax. */
  out: bigint;
  quoteSymbol: string;
  quoteDecimals: number;
  /** The venue this was priced against, named the way the slip names it. */
  venue: string;
  /**
   * What the sale actually realises against the price before it, in bps.
   * 10 000 is "you got the screen price"; 7 000 means thirty per cent of
   * the value went to slippage, fees and tax on the way out.
   */
  realisedBps: number;
  /** True when the sale would take essentially everything the pool holds. */
  drainsPool: boolean;
  /**
   * What share of the pool's token side this position IS. Above roughly a
   * third, the arithmetic stops being a quote and starts being a story
   * about what the pool looks like afterwards.
   */
  shareOfPoolBps: number;
}

export type SizeAnswer = { ok: true; quote: SizeQuote } | { ok: false; why: string };

/** The deepest pool a constant-product formula is actually valid for. */
function priceableEvmPool(pools: MarketPool[] | null): MarketPool | null {
  if (!pools) return null;
  // A concentrated pool keeps its liquidity in ranges, so its vault
  // balances are not what a trade moves through — pricing off them
  // overstates the exit, in the direction that costs somebody money.
  const flat = pools.filter(
    (p) => (p.kind === "v2" || p.kind === "solidly") && !p.stable && (p.tokenReserve ?? 0n) > 0n && (p.quoteReserve ?? 0n) > 0n,
  );
  flat.sort((a, b) => (b.quoteReserve! > a.quoteReserve! ? 1 : b.quoteReserve! < a.quoteReserve! ? -1 : 0));
  return flat[0] ?? null;
}

function priceableSolanaPool(market: SolanaMarket): SolanaPool | null {
  const flat = market.pools.filter((p) => !p.concentrated && p.tokenReserve > 0n && p.quoteReserve > 0n);
  flat.sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
  return flat[0] ?? null;
}

function shaped(tokensIn: bigint, out: bigint, spotOut: bigint, tokenReserve: bigint, quoteReserve: bigint, rest: Pick<SizeQuote, "quoteSymbol" | "quoteDecimals" | "venue">): SizeQuote {
  return {
    ...rest,
    tokensIn,
    out,
    realisedBps: spotOut === 0n ? 0 : Number((out * 10_000n) / spotOut),
    // 99% of the quote side is the practical definition of draining: the
    // formula is asymptotic, so it never returns the last unit and a
    // strict comparison would never fire.
    drainsPool: quoteReserve > 0n && out * 100n >= quoteReserve * 99n,
    shareOfPoolBps: tokenReserve > 0n ? Number((tokensIn * 10_000n) / tokenReserve) : 0,
  };
}

/** What `tokensIn` of this EVM token would fetch, at the block the slip was read. */
export function evmExitFor(slip: DoorSlip, tokensIn: bigint): SizeAnswer {
  if (tokensIn <= 0n) return { ok: false, why: "enter a position size" };
  const native = slip.chain.native;

  // A launch still on its curve, or one graduated into the launchpad's own
  // pool: the exit door already read the reserves and both levies.
  const exit = slip.exit;
  if (exit && exit.venue !== "closed" && exit.reserves.token > 0n && exit.reserves.quote > 0n) {
    const gross = curveAmountOut(tokensIn, exit.reserves.token, exit.reserves.quote, 0n);
    const out = gross - (gross * exit.feeBps) / 10_000n - (gross * exit.creatorTaxBps) / 10_000n;
    const spotOut = (tokensIn * exit.spot) / 10n ** 18n;
    return {
      ok: true,
      quote: shaped(tokensIn, out, spotOut, exit.reserves.token, exit.reserves.quote, {
        quoteSymbol: native.symbol,
        quoteDecimals: native.decimals,
        venue: exit.venue === "curve" ? "the bonding curve" : "the launch pool",
      }),
    };
  }

  const pool = priceableEvmPool(slip.open?.pools ?? null);
  if (pool) {
    const tokenReserve = pool.tokenReserve!;
    const quoteReserve = pool.quoteReserve!;
    const out = curveAmountOut(tokensIn, tokenReserve, quoteReserve, BigInt(pool.feeBps));
    const spotOut = (tokensIn * quoteReserve) / tokenReserve;
    return {
      ok: true,
      quote: shaped(tokensIn, out, spotOut, tokenReserve, quoteReserve, {
        quoteSymbol: slip.chain.native.symbol,
        quoteDecimals: 18,
        venue: `${pool.dex} (${pool.kind})`,
      }),
    };
  }

  // Everything below is a reason, never a zero.
  const pools = slip.open?.pools;
  if (pools === null || pools === undefined) return { ok: false, why: "the pools could not be read on this chain, so there is nothing to price a sale against" };
  if (!pools.length) return { ok: false, why: "no pool was found for this token, so there is nowhere for a sale of any size to go" };
  if (pools.every((p) => p.kind === "v3" || p.kind === "v4")) {
    return {
      ok: false,
      why: "the only pools here keep their liquidity in ranges (Uniswap V3/V4), and their balances are not what a trade moves through — pricing a sale off them would overstate what you get, in the direction that costs you money",
    };
  }
  return { ok: false, why: "the pools that were found have no readable balances, so a sale cannot be priced" };
}

/** The same question on Solana. */
export function splExitFor(slip: SplSlip, tokensIn: bigint): SizeAnswer {
  if (tokensIn <= 0n) return { ok: false, why: "enter a position size" };
  const market = slip.market;
  if (!market) return { ok: false, why: "the market section did not run, so there is nothing to price a sale against" };
  if (market.unread) return { ok: false, why: `the venue search could not finish (${market.unread}), so an empty pool list here proves nothing` };

  const curve = market.curve;
  if (curve && !curve.complete) {
    const out = quoteCurveSale(curve, tokensIn);
    // The curve's virtual reserves are what its own arithmetic uses.
    const spotOut = curve.virtualTokens > 0n ? (tokensIn * curve.virtualSol) / curve.virtualTokens : 0n;
    return {
      ok: true,
      quote: shaped(tokensIn, out, spotOut, curve.virtualTokens, curve.realSol, {
        quoteSymbol: "SOL",
        quoteDecimals: 9,
        venue: "the pump.fun bonding curve",
      }),
    };
  }

  const pool = priceableSolanaPool(market);
  if (!pool) {
    if (!market.pools.length) return { ok: false, why: "no pool against SOL or USDC turned up, so there is nowhere for a sale of any size to go" };
    return { ok: false, why: "every pool found here is concentrated, and its vault balances are not what a trade moves through — pricing a sale off them would overstate what you get" };
  }
  const out = quotePoolSale(pool, tokensIn);
  const spotOut = (tokensIn * pool.quoteReserve) / pool.tokenReserve;
  return {
    ok: true,
    quote: shaped(tokensIn, out, spotOut, pool.tokenReserve, pool.quoteReserve, {
      quoteSymbol: pool.quoteSymbol,
      quoteDecimals: pool.quoteDecimals,
      venue: pool.name,
    }),
  };
}

/**
 * What the number means, in a sentence, before anybody has to work it out.
 *
 * A quote on its own invites the reading "so I get 0.8 ETH" and stops
 * there. The thing worth knowing is almost never the figure — it is how
 * much of the figure the exit itself eats, and whether the position is
 * simply too big for the pool it would have to leave through.
 */
export function readSizeQuote(q: SizeQuote): { level: "stop" | "watch" | "info"; text: string } {
  const lost = 10_000 - q.realisedBps;
  const pct = (bps: number) => `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`;
  if (q.drainsPool) {
    return {
      level: "stop",
      text: `A sale this size takes essentially everything ${q.venue} holds. Past that point the arithmetic stops being a quote: there would be no meaningful market left to sell the last of it into, and anybody selling ahead of you makes your share smaller.`,
    };
  }
  if (q.shareOfPoolBps >= 3_333) {
    return {
      level: "stop",
      text: `This position is ${pct(q.shareOfPoolBps)} of the token side of ${q.venue}. A holding that large next to its own pool cannot leave at anything near the screen price, whatever the price says.`,
    };
  }
  if (lost >= 2_000) {
    return {
      level: "stop",
      text: `Selling this size into ${q.venue} realises ${pct(q.realisedBps)} of the screen price — ${pct(lost)} of it goes to slippage, fees and tax on the way out.`,
    };
  }
  if (lost >= 500) {
    return {
      level: "watch",
      text: `Selling this size into ${q.venue} costs ${pct(lost)} against the screen price, in slippage and fees.`,
    };
  }
  return {
    level: "info",
    text: `Selling this size into ${q.venue} realises ${pct(q.realisedBps)} of the screen price. The pool is deep enough that a position this size is not what moves it.`,
  };
}
