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

/** Three significant figures, trailing zeros dropped: 3.2, 12.4, 123. */
function sig3(n: number): string {
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * A dollar total the way a trading screen writes it: $3.2M, $12.4K, $950,
 * $9.52. Compact on purpose — a market cap is compared, not audited, and the
 * exact figure in the quote coin sits beside it in parentheses.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(value);
  if (n >= 1e9) return `${sign}$${sig3(n / 1e9)}B`;
  if (n >= 1e6) return `${sign}$${sig3(n / 1e6)}M`;
  if (n >= 1e3) return `${sign}$${sig3(n / 1e3)}K`;
  if (n >= 1) return `${sign}$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `${sign}$${n.toFixed(2) === "0.00" ? "<0.01" : n.toFixed(2)}`;
}

/**
 * A per-token dollar price, with the same zero-collapsing as formatPrice:
 * $0.0₅2134 is five zeros after the point. Four significant digits.
 */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1) return value >= 1_000 ? formatUsd(value) : `$${value.toFixed(value >= 100 ? 2 : 4).replace(/\.?0+$/, "")}`;
  const zeros = Math.floor(-Math.log10(value));
  // Four significant digits after the zeros, trailing zeros dropped.
  const digits = String(Math.round(value * 10 ** (zeros + 4))).slice(0, 4).replace(/0+$/, "") || "0";
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
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sig3(n / 1e6)}M`;
  if (abs >= 1e4) return `${sig3(n / 1e3)}K`;
  if (abs >= 100) return Math.round(n).toLocaleString("en-US");
  if (abs >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  if (abs === 0) return "0";
  // Below one coin: four significant digits, so 0.0042 does not become 0.
  const zeros = Math.floor(-Math.log10(abs));
  return n.toFixed(Math.min(decimals, zeros + 3)).replace(/0+$/, "").replace(/\.$/, "");
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
