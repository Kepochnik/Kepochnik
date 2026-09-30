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
import { formatPrice, formatUnits } from "../format.js";

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
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(seconds / 3_600);
  if (h < 48) return `${h} h ${Math.round((seconds - h * 3_600) / 60)} m`;
  return `${Math.floor(seconds / 86_400)} d`;
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

export function marketFacts(slip: DoorSlip): MarketFacts {
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

  facts.push(
    spot !== null
      ? { label: "Price", value: formatPrice(spot, quote.decimals), note: `${quote.symbol} per token · ${where}`, source: "chain" }
      : { label: "Price", value: null, note: quote.symbol, source: "chain", why: slip.exit?.venue === "closed" ? "swept, and the pool does not exist yet" : o?.pools === null ? "the pool read did not finish" : "no pool could be priced" },
  );

  const supply = meta?.totalSupply ?? null;
  facts.push(
    spot !== null && supply
      ? { label: "Market cap", value: `${formatUnits((spot * supply) / 10n ** BigInt(decimals), quote.decimals, 2)} ${quote.symbol}`, note: "price × supply", source: "derived" }
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
          value: `${formatUnits(liquid, quote.decimals, 2)} ${quote.symbol}`,
          note: `real, in the curve · ${(fill.bps / 100).toFixed(0)}% to graduation`,
          source: "chain",
          warn: liquid < 10n ** BigInt(quote.decimals),
        }
      : !found && exit?.venue === "pool"
        ? { label: "Liquidity", value: null, note: quote.symbol, source: "chain", why: "a V4 pool keeps its funds in the PoolManager with every other pool, so its depth is not a balance anyone can read" }
        : liquid !== null
      ? {
          label: "Liquidity",
          value: `${formatUnits(liquid, quote.decimals, 2)} ${quote.symbol}`,
          note: (o?.pools ?? []).length > 1 ? `deepest of ${(o?.pools ?? []).length} pools` : "one pool",
          source: "chain",
          // A pool holding less than the price of a decent sale is not a
          // market, and the figure should say so before somebody buys into it.
          warn: liquid < 10n ** BigInt(quote.decimals),
        }
      : { label: "Liquidity", value: null, note: quote.symbol, source: "chain", why: o?.pools === null ? "the pool read did not finish" : "no pool was found" },
  );

  facts.push(
    supply ? { label: "Supply", value: grouped(supply, decimals), note: `${decimals} decimals`, source: "chain" } : { label: "Supply", value: null, note: "tokens", source: "chain", why: "totalSupply did not answer" },
  );

  const holders = o?.holders?.count ?? null;
  facts.push(
    holders !== null
      ? { label: "Holders", value: holders.toLocaleString("en-US"), note: o?.holders?.transfers ? `${o.holders.transfers.toLocaleString("en-US")} transfers` : "from the explorer", source: "explorer" }
      : { label: "Holders", value: null, note: "wallets", source: "explorer", why: "the explorer's holder list did not answer" },
  );

  const born = o?.deployer?.createdAt ?? null;
  const age = born === null ? null : Math.max(0, slip.at.timestamp - born);
  facts.push(
    age !== null
      ? {
          label: "Age",
          value: shortAge(age),
          note: o?.activity?.lastTransferAt ? `last transfer ${shortAge(Math.max(0, slip.at.timestamp - o.activity.lastTransferAt))} ago` : "since deployment",
          source: "chain",
          // Under a day old is the single most reliable predictor of the kind
          // of token this tool exists for.
          warn: age < 86_400,
        }
      : { label: "Age", value: null, note: "since deployment", source: "chain", why: "the deployment could not be dated" },
  );

  const v = o?.explorer?.volume24hUsd ?? null;
  facts.push(
    v !== null
      ? { label: "Volume 24h", value: `$${Math.round(v).toLocaleString("en-US")}`, note: "the explorer's feed", source: "explorer" }
      : { label: "Volume 24h", value: null, note: "the explorer's feed", source: "explorer", why: o?.explorer ? "the explorer does not report volume for this token" : "the explorer could not be read" },
  );

  return { facts, pool, spot, quoteSymbol: quote.symbol, quoteDecimals: quote.decimals };
}
