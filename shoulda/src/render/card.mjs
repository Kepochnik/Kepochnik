// The share card: 1200 x 675, the size X shows uncropped. Plain SVG, no fonts
// to load, no dependencies; any browser turns it into a PNG.

import { grampsRects } from './gramps.mjs';
import { escapeXml as x, pct, shortAddress, signedUsd, usd } from './format.mjs';

const W = 1200;
const H = 675;
const C = {
  bg: '#0e100c',
  panel: '#171a14',
  text: '#f4f1e8',
  muted: '#9d9f92',
  lime: '#c6f432',
  loss: '#ff5a4e',
  eth: '#8a8f99',
};
const MONO = `'JetBrains Mono','SF Mono',Menlo,Consolas,monospace`;

export function card(receipt) {
  const { result, verdict, bench, wallet } = receipt;
  const { totals } = result;
  const lost = totals.memes < totals.index;

  const rows = [
    { label: 'Your memes', value: totals.memes, color: lost ? C.loss : C.lime },
    { label: 'Just held ETH', value: totals.eth, color: C.eth },
    { label: `Just bought ${bench}`, value: totals.index, color: lost ? C.lime : C.eth },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);
  const barX = 360;
  const barMax = 560;

  const bars = rows
    .map((r, i) => {
      const y = 330 + i * 70;
      const w = Math.max(4, (r.value / max) * barMax);
      return `
      <text x="64" y="${y + 30}" fill="${C.muted}" font-size="26">${x(r.label)}</text>
      <rect x="${barX}" y="${y + 6}" width="${w}" height="34" rx="4" fill="${r.color}"/>
      <text x="${barX + w + 16}" y="${y + 32}" fill="${C.text}" font-size="28" font-weight="700">${x(usd(r.value))}</text>`;
    })
    .join('');

  const stats = [
    `${result.apes} apes`,
    `${result.coins} coins`,
    result.rugged ? `${result.rugged} went to zero` : null,
    `${usd(totals.spent)} in`,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const gap = result.ratio == null ? '' : `${signedUsd(result.gap)} vs ${bench} (${pct(result.ratio)})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="20" fill="${C.panel}"/>
  <text x="64" y="92" fill="${C.lime}" font-size="24" font-weight="700" letter-spacing="4">SHOULDA</text>
  <text x="206" y="92" fill="${C.muted}" font-size="22">${x(shortAddress(wallet))} · Robinhood Chain</text>
  <text x="64" y="186" fill="${C.text}" font-size="${titleSize(verdict.title)}" font-weight="800">${x(verdict.title)}</text>
  <text x="64" y="236" fill="${C.muted}" font-size="24">${x(verdict.line)}</text>
  <text x="64" y="290" fill="${lost ? C.loss : C.lime}" font-size="26" font-weight="700">${x(gap)}</text>
  ${bars}
  <text x="64" y="590" fill="${C.muted}" font-size="22">${x(stats)}</text>
  <text x="64" y="626" fill="${C.muted}" font-size="18" opacity="0.7">every dollar you aped, replayed into ${x(bench)} at the Chainlink price that day · read-only</text>
  <g shape-rendering="crispEdges">${grampsRects(10, 860, 34)}</g>
</svg>
`;
}

/** Largest size up to 64px that keeps the title clear of Gramps (mono glyphs are ~0.6em wide). */
function titleSize(title) {
  return Math.min(64, Math.floor(800 / (title.length * 0.6)));
}
