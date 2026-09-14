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
