/**
 * THE FIGURES A BUYER LOOKS FOR FIRST.
 *
 * Price, what the whole thing is worth, how much is in the pool, how many
 * hold it, how old it is. None of this is new information — every one of
 * these was already somewhere on a slip, most of them inside a section
 * somebody had to open — and that is exactly why the page read as empty to
 * anybody used to a chart site. A token page without these numbers looks
 * broken no matter how good its typography is.
 *
 * Nothing here is computed from anything but what the chain and the explorer
 * already answered, and each figure says where it came from:
 *
 *   chain     read off the pool's own state at this block
 *   explorer  the indexer's feed, which can be stale or absent
 *   derived   arithmetic on the two above, stated as such
 *
 * A figure that could not be read is `null` with a reason, never a zero. A
 * market cap of 0 and a market cap nobody could compute look identical on a
 * page and mean opposite things.
 */
import { depth, spotPrice, type MarketPool } from "../chain/market.js";
import type { DoorSlip } from "./door.js";
import { formatCoin, formatMoney, formatPrice, formatUsd, formatUsdPrice } from "../format.js";

export type FactSource = "chain" | "explorer" | "derived";

export interface Fact {
  /** Short label for the strip. */
  label: string;
  /** The value, formatted for a person. Null when it could not be read. */
  value: string | null;
  /** The unit or the one-line note under it. */
  note: string;
  source: FactSource;
  /** Why it is missing, when it is. */
  why?: string;
  /** True when the figure is worth colouring: a thin pool, a very new token. */
  warn?: boolean;
}

/** A number with thousands separators, which is how a person reads a supply. */
function grouped(value: bigint, decimals: number): string {
  const whole = value / 10n ** BigInt(decimals);
  return whole.toLocaleString("en-US");
}

/** "1 h 23 m", "3 d", "48 s" — the coarsest unit that still says something. */
export function shortAge(seconds: number): string {
  // One way of writing an age everywhere — the feed, the tape, the figures:
  // 9s, 4m, 1h 7m, 3d. Floored, never rounded, so "59m" is not shown as
  // "1h" in one place and "59 m" in another.
  const t = Math.max(0, Math.floor(seconds));
  if (t < 60) return `${t}s`;
  if (t < 3_600) return `${Math.floor(t / 60)}m`;
  if (t < 172_800) {
    const h = Math.floor(t / 3_600);
    const m = Math.floor((t % 3_600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(t / 86_400)}d`;
}

/**
 * The deepest pool that can be priced, which is the one a sale would use and
 * therefore the one whose numbers mean anything.
 */
function deepest(pools: MarketPool[] | null | undefined): MarketPool | null {
  if (!pools || !pools.length) return null;
  return [...pools].sort((a, b) => (depth(b) > depth(a) ? 1 : depth(b) < depth(a) ? -1 : 0))[0] ?? null;
}

export interface MarketFacts {
  facts: Fact[];
  /** The pool the price came from, for the chart to read the same one. */
  pool: MarketPool | null;
  /** Quote-asset units for one whole token, or null. */
  spot: bigint | null;
  quoteSymbol: string;
  quoteDecimals: number;
  /** Dollars per whole quote coin, from the explorer, or null — and then no dollar figure anywhere. */
  quoteUsd: number | null;
}

export interface MarketFactsOptions {
  /**
   * Dollars per whole quote coin. From the explorer (the chain has no dollar
   * price), or null. A coin that IS a dollar stablecoin is not assumed to be
   * worth exactly one: without a read price there is no dollar figure.
   */
  quoteUsd?: number | null;
}

/**
 * The graduated pool of a launchpad token, as the market code understands a pool.
 *
 * The open-door pool search is never run for a launch — the factory already
 * says where it trades — so without this every graduated launch had no pool
 * on the slip at all, and the tape under it said "BOUNCER found no pool",
 * which was simply untrue.
 */
export function launchPool(slip: DoorSlip): MarketPool | null {
  const p = slip.exit?.venue === "pool" ? slip.exit.pool : undefined;
  if (!p) return null;
  return {
    dex: p.hooks === "0x0000000000000000000000000000000000000000" ? "Uniswap V4" : "Uniswap V4 (hooked)",
    kind: "v4",
    address: p.manager,
    poolId: p.poolId,
    hooks: p.hooks,
    // uint24 hundredths of a basis point.
    feeBps: Number(p.feePpm) / 100,
    tokenIsToken0: p.tokenIsCurrency0,
    // One contract holds every V4 pool's funds; a balance of it is not this pool.
    tokenReserve: null,
    quoteReserve: null,
  };
}

export function marketFacts(slip: DoorSlip, options: MarketFactsOptions = {}): MarketFacts {
  const quoteUsd = options.quoteUsd !== undefined && options.quoteUsd !== null && options.quoteUsd > 0 ? options.quoteUsd : null;
  const o = slip.open;
  const meta = slip.id.meta;
  const quote = slip.rules?.quote ?? slip.chain.native;
  const decimals = meta?.decimals ?? 18;
  const found = deepest(o?.pools);
  const pool = found ?? launchPool(slip);
  // A launch is priced where it trades: on the curve before graduation, on
  // its V4 pool after. The exit door already read both, at this block, with
  // the launchpad's own arithmetic. Its spot is per whole 18-decimal token,
  // so it is only used when the token really has 18.
  const exit = slip.exit && slip.exit.venue !== "closed" && slip.exit.spot > 0n && decimals === 18 ? slip.exit : null;
  const spot = found ? spotPrice(found, decimals) : exit ? exit.spot : null;
  const where = found ? "from the pool" : exit?.venue === "curve" ? "from the curve" : exit ? "from the V4 pool" : "";
  const facts: Fact[] = [];
  // A Pons V1 launch has a pool — its own record names the pairing — but not
  // one on the DEX factories this reads. "No pool" would contradict the V1
  // rules printed on the same page.
  const v1 = slip.id.v1;
  const v1Why = v1
    ? `its Pons V1 pool (paired with ${formatMoney(v1.status.pairedPrincipal, v1.quote.decimals, v1.quote.symbol, quoteUsd)}) is not priced here`
    : "";

  facts.push(
    spot !== null
      ? quoteUsd !== null
        ? { label: "Price", value: formatUsdPrice((Number(spot) / 10 ** quote.decimals) * quoteUsd), note: `${formatPrice(spot, quote.decimals)} ${quote.symbol} · ${where}`, source: "chain" }
        : { label: "Price", value: formatPrice(spot, quote.decimals), note: `${quote.symbol} per token · ${where}`, source: "chain" }
      : { label: "Price", value: null, note: quote.symbol, source: "chain", why: slip.exit?.venue === "closed" ? "swept, and the pool does not exist yet" : o?.pools === null ? "the pool read did not finish" : slip.id.v1 ? v1Why : "no pool could be priced" },
  );

  const supply = meta?.totalSupply ?? null;
  facts.push(
    spot !== null && supply
      ? { label: "Market cap", value: formatMoney((spot * supply) / 10n ** BigInt(decimals), quote.decimals, quote.symbol, quoteUsd), note: `spot at block ${slip.at.block} × supply`, source: "derived" }
      : { label: "Market cap", value: null, note: "price × supply", source: "derived", why: spot === null ? "no price to multiply" : "the supply could not be read" },
  );

  // On a curve the depth is the real quote the curve holds — not the pricing
  // reserve, which carries a virtual amount nobody can sell into.
  const fill = !found && exit?.venue === "curve" ? slip.rules?.fill ?? null : null;
  const liquid = found?.quoteReserve ?? fill?.real ?? null;
  facts.push(
    fill && liquid !== null
      ? {
          label: "Liquidity",
          value: formatMoney(liquid, quote.decimals, quote.symbol, quoteUsd),
          note: `real, in the curve · ${(fill.bps / 100).toFixed(0)}% to graduation`,
          source: "chain",
          warn: liquid < 10n ** BigInt(quote.decimals),
        }
      : !found && exit?.venue === "pool"
        ? { label: "Liquidity", value: null, note: quote.symbol, source: "chain", why: "a V4 pool keeps its funds in the PoolManager with every other pool, so its depth is not a balance anyone can read" }
        : liquid !== null
      ? {
          label: "Liquidity",
          value: formatMoney(liquid, quote.decimals, quote.symbol, quoteUsd),
          note: (o?.pools ?? []).length > 1 ? `deepest of ${(o?.pools ?? []).length} pools` : "one pool",
          source: "chain",
          // A pool holding less than the price of a decent sale is not a
          // market, and the figure should say so before somebody buys into it.
          warn: liquid < 10n ** BigInt(quote.decimals),
        }
      : { label: "Liquidity", value: null, note: quote.symbol, source: "chain", why: o?.pools === null ? "the pool read did not finish" : slip.id.v1 ? v1Why : "no pool was found" },
  );

  facts.push(
    supply ? { label: "Supply", value: formatCoin(supply, decimals), note: `${grouped(supply, decimals)} · ${decimals} decimals`, source: "chain" } : { label: "Supply", value: null, note: "tokens", source: "chain", why: "totalSupply did not answer" },
  );

  // A launch never runs the explorer holder read — the open door is for
  // ordinary tokens — so "the explorer did not answer" was a failure claimed
  // for a question nobody asked. What a launch HAS read is who bought on its
  // curve, and that is said as what it is: buyers, not holders.
  // What the deployer still holds, on the first screen: the dev wallet at a
  // glance is half of what a trader checks, and it sat in a folded answer.
  const devBps = slip.rules ? slip.rules.deployerShareBps : (o?.deployer?.bps ?? null);
  if (slip.rules || o) {
    facts.push(
      devBps !== null
        ? { label: "Dev holds", value: `${(devBps / 100).toFixed(devBps < 1_000 ? 1 : 0)}%`, note: `of supply · the deployer's wallet at block ${slip.at.block}`, source: "chain", warn: devBps >= 2_000 }
        : { label: "Dev holds", value: null, note: "of supply", source: "chain", why: o?.deployer ? "the deployer's balance did not read" : "the deployer could not be found" },
    );
  }

  const holders = o?.holders?.count ?? null;
  const room = !o ? slip.room : null;
  facts.push(
    holders !== null
      ? { label: "Holders", value: holders.toLocaleString("en-US"), note: o?.holders?.transfers ? `${o.holders.transfers.toLocaleString("en-US")} transfers` : "from the explorer", source: "explorer" }
      : room
        ? { label: "Buyers", value: room.buyers.toLocaleString("en-US"), note: `${room.buys} buy${room.buys === 1 ? "" : "s"}, ${room.sells} sell${room.sells === 1 ? "" : "s"} on the curve · not a holder list`, source: "chain" }
        : { label: "Holders", value: null, note: "wallets", source: "explorer", why: o ? "the explorer's holder list did not answer" : "not read for a launch" },
  );

  // A launch's age is its launch block's time, which the door-tax read has
  // already fetched; an ordinary token's is its deployment, from the explorer.
  const launchedAt = !o ? slip.cover?.launch.timestamp ?? null : null;
  const born = o?.deployer?.createdAt ?? launchedAt;
  const age = born === null ? null : Math.max(0, slip.at.timestamp - born);
  facts.push(
    age !== null
      ? {
          label: "Age",
          value: shortAge(age),
          note: o?.activity?.lastTransferAt ? `last transfer ${shortAge(Math.max(0, slip.at.timestamp - o.activity.lastTransferAt))} ago` : launchedAt !== null ? `launched at block ${slip.cover!.launch.block}` : "since deployment",
          source: "chain",
          // Under a day old is the single most reliable predictor of the kind
          // of token this tool exists for.
          warn: age < 86_400,
        }
      : { label: "Age", value: null, note: "since deployment", source: "chain", why: o ? "the deployment could not be dated" : "the launch block's time was not read" },
  );

  // For a launch the page's own tape is the volume, over the window the reader
  // picked; the page fills it in when the tape has read. The explorer's 24 h
  // figure is only for tokens the explorer indexes.
  const v = o?.explorer?.volume24hUsd ?? null;
  facts.push(
    v !== null
      ? { label: "Volume 24h", value: formatUsd(v), note: "the explorer's feed", source: "explorer" }
      : { label: "Volume 24h", value: null, note: "the explorer's feed", source: "explorer", why: !o ? "read from the tape below once it opens" : o.explorer ? "the explorer does not report volume for this token" : "the explorer could not be read" },
  );

  return { facts, pool, spot, quoteSymbol: quote.symbol, quoteDecimals: quote.decimals, quoteUsd };
}
