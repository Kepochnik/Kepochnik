/** Human formatting for bigint chain values. No floating point until the last step. */

export function formatUnits(value: bigint, decimals: number, maxFraction = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  let fractionText = fraction.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const wholeText = groupThousands(whole.toString());
  const text = fractionText ? `${wholeText}.${fractionText}` : wholeText;
  return negative ? `-${text}` : text;
}

export function formatCompact(value: bigint, decimals: number): string {
  const units = Number(value / 10n ** BigInt(Math.max(decimals - 6, 0))) / 10 ** Math.min(decimals, 6);
  const abs = Math.abs(units);
  if (abs >= 1e9) return `${(units / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(units / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(units / 1e3).toFixed(1)}K`;
  return units.toFixed(abs < 1 ? 4 : 2);
}

export function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = bps % 100n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

export function formatPercent(numerator: bigint, denominator: bigint, digits = 1): string {
  if (denominator === 0n) return "n/a";
  const scaled = (numerator * 10n ** BigInt(digits + 2)) / denominator;
  const whole = scaled / 10n ** BigInt(digits);
  const fraction = scaled % 10n ** BigInt(digits);
  return digits === 0 ? `${whole}%` : `${whole}.${fraction.toString().padStart(digits, "0")}%`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatAgo(fromUnix: number, nowUnix: number): string {
  const seconds = Math.max(0, nowUnix - fromUnix);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (s && !d && !h) parts.push(`${s}s`);
  return parts.join(" ");
}

export function isoUtc(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(".000Z", "Z");
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A token price the way a trading screen writes it.
 *
 * A fresh launch costs 0.0000000133 of a coin, and ten zeros is a number a
 * reader has to count before they can compare it with anything. Past four
 * leading zeros they collapse into a subscript count of them — 0.0₇133 — the notation
 * DexScreener and every terminal after it taught people to read. Four
 * significant digits after the zeros; plain text, so it is safe anywhere a
 * string goes.
 */
export function formatPrice(value: bigint, decimals: number): string {
  if (value <= 0n) return "0";
  const base = 10n ** BigInt(decimals);
  if (value >= base) return formatUnits(value, decimals, value >= 1_000n * base ? 2 : 4);
  const fraction = value.toString().padStart(decimals, "0");
  const zeros = fraction.match(/^0*/)![0].length;
  const digits = fraction.slice(zeros, zeros + 4).replace(/0+$/, "") || "0";
  if (zeros < 4) return `0.${"0".repeat(zeros)}${digits}`;
  const count = String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
  return `0.0${count}${digits}`;
}

/**
 * Three significant figures, trailing zeros dropped from the FRACTION only:
 * 3.2, 12.4, 120. It used to strip zeros from whole numbers too, so $120K
 * printed as $12K and $200K as $2K — a figure off by an order of magnitude.
 */
function sig3(n: number): string {
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  const text = n.toFixed(digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

const STEPS: [number, string][] = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * 1.2K, 3.4M, 5B, for a non-negative number at or above `from`; null below.
 * Rounding can carry across a unit — 999.6K rounds to "1000K" — so the
 * rounded text is checked and moved up a unit when it gets there.
 */
function compact(n: number, from = 1e3): string | null {
  for (let i = 0; i < STEPS.length; i++) {
    const [size, suffix] = STEPS[i];
    if (n < size || n < from) continue;
    const text = sig3(n / size);
    if (Number(text) >= 1000 && i > 0) return `${sig3(n / STEPS[i - 1][0])}${STEPS[i - 1][1]}`;
    return `${text}${suffix}`;
  }
  return null;
}

/** The minus sign a reader sees, not the hyphen a keyboard makes. */
const MINUS = "\u2212";

/**
 * A dollar total the way a trading screen writes it: $3.2M, $12.4K, $950,
 * $9.52. Compact on purpose — a market cap is compared, not audited, and the
 * exact figure in the quote coin sits beside it in parentheses.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? MINUS : "";
  const n = Math.abs(value);
  // Whole dollars from ten up: "$99.21" beside "$124" in a column reads as
  // two different kinds of number. Cents only where they are most of it.
  // The unit is chosen on the rounded figure, so 999.6 is "$1K", not "$1000".
  const whole = Math.round(n);
  const big = compact(whole >= 1000 ? Math.max(n, 1000) : n);
  if (big) return `${sign}$${big}`;
  if (n >= 9.995) return `${sign}$${whole}`;
  if (n >= 1) return `${sign}$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `${sign}$${n.toFixed(2) === "0.00" ? "<0.01" : n.toFixed(2)}`;
}

/**
 * A per-token dollar price, with the same zero-collapsing as formatPrice:
 * $0.0₅2134 is five zeros after the point. Four significant digits.
 *
 * The zeros and the digits come from one rounded representation. Counting
 * zeros with a logarithm and the digits separately was off by one at exact
 * powers of ten — $0.1 printed as $0.01.
 */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1) {
    if (value >= 1_000) return formatUsd(value);
    const text = value.toFixed(value >= 100 ? 2 : 4);
    return `$${text.replace(/\.?0+$/, "")}`;
  }
  const [mantissa, exponent] = value.toExponential(3).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0";
  if (zeros < 0) return `$${Number(mantissa).toString()}`;
  if (zeros < 4) return `$0.${"0".repeat(zeros)}${digits}`;
  const count = String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
  return `$0.0${count}${digits}`;
}

/**
 * An amount of the quote coin, short: 20, 3.1, 0.8, 0.0042, 1.2K. For the
 * parentheses after a dollar figure and for the tape's columns — never the
 * eighteen-decimal tail of a raw balance.
 */
export function formatCoin(value: bigint, decimals: number): string {
  const n = Number(value) / 10 ** decimals;
  if (!Number.isFinite(n)) return formatUnits(value, decimals, 2);
  const sign = n < 0 ? MINUS : "";
  const abs = Math.abs(n);
  const big = compact(abs, 1e4);
  if (big) return `${sign}${big}`;
  if (abs >= 100) return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
  if (abs >= 1) return `${sign}${abs.toFixed(2).replace(/\.?0+$/, "")}`;
  if (abs === 0) return "0";
  // Below one coin: four significant digits, so 0.0042 does not become 0.
  const zeros = Math.floor(-Math.log10(abs));
  return `${sign}${abs.toFixed(Math.min(decimals, zeros + 3)).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Dollar value of an amount of the quote coin, or null without a price. */
export function usdOf(amount: bigint, decimals: number, usdPerCoin: number | null): number | null {
  if (usdPerCoin === null || !Number.isFinite(usdPerCoin) || usdPerCoin <= 0) return null;
  return (Number(amount) / 10 ** decimals) * usdPerCoin;
}

/**
 * "$3.2M (20 ETH)" — the dollar figure first, because that is the unit people
 * compare in, and the coin amount it came from in parentheses, because that
 * is the unit the chain actually holds. Coin only when there is no dollar
 * price: a dollar figure is printed from a read price or not at all.
 */
export function formatMoney(amount: bigint, decimals: number, symbol: string, usdPerCoin: number | null): string {
  const usd = usdOf(amount, decimals, usdPerCoin);
  const coin = `${formatCoin(amount, decimals)} ${symbol}`;
  return usd === null ? coin : `${formatUsd(usd)} (${coin})`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A moment as a reader writes it: "15 Sep 2026, 00:00 UTC". The ISO form
 * (2026-09-15T00:00:00Z) is for machines and for the JSON; on a page it is a
 * string to decode, and the T and the Z are the parts nobody reads.
 */
export function humanUtc(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "1 buy", "3 buys": a count with its noun, never "1 buyers". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
