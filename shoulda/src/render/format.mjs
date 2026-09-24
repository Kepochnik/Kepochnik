export function usd(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
}

export function signedUsd(n) {
  return (n >= 0 ? '+' : '') + usd(n);
}

export function pct(ratio) {
  const v = (ratio - 1) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(v > -10 && v < 10 ? 1 : 0)}%`;
}

export function shortAddress(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}
