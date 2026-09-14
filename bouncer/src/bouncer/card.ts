/**
 * The slip as a 1200×630 card: black door, red rope, brass type, the
 * gorilla at the right. Self-contained SVG (no fonts fetched), so it
 * renders the same everywhere and can be posted as an image.
 */
import { GraduationPhase, PHASE_LABEL } from "../chain/pons.js";
import { formatBps, isoUtc, shortAddress } from "../format.js";
import { coverChargeLine } from "./coverCharge.js";
import { devReportLine } from "./devReport.js";
import type { DoorSlip } from "./door.js";

export interface CardOptions {
  repoUrl: string;
  ticker: string;
  mascotSvg: string;
}

export const CARD_COLORS = {
  ink: "#0b0b0f",
  panel: "#15151c",
  line: "#2a2a35",
  brass: "#d4a017",
  rope: "#c8102e",
  text: "#f2efe6",
  muted: "#8f8f9c",
  stop: "#ff4d5e",
  watch: "#e8b323",
  info: "#7f8ea3",
  dim: "#5e5a66",
};

export function doorCard(slip: DoorSlip, options: CardOptions): string {
  const c = CARD_COLORS;
  const meta = slip.id.meta;
  const title = meta ? esc(meta.symbol) : shortAddress(slip.subject);
  const sub = meta ? esc(meta.name) : "unregistered contract";
  const stampColor = slip.stamp === "ON THE LIST" ? c.brass : c.stop;
  const lines: string[] = [];
  const idBits = [slip.id.registered ? "factory record" : "no factory record", slip.id.token.code.empty ? "no code" : `${slip.id.token.code.bytes} bytes`];
  if (slip.id.token.proxyImplementation || slip.id.token.code.minimalProxyTarget) idBits.push("proxy");
  if (slip.id.token.code.opcodes.selfdestruct) idBits.push("SELFDESTRUCT");
  if (slip.id.token.code.opcodes.delegatecall) idBits.push("DELEGATECALL");
  if (idBits.length === 2 && !slip.id.token.code.empty) idBits.push("no SELFDESTRUCT, no DELEGATECALL, no proxy");
  lines.push(["ID CHECK", idBits.join(" · ")].join("  "));
  if (slip.cover) lines.push(["COVER CHARGE", coverChargeLine(slip.cover)].join("  "));
  if (slip.rules) {
    lines.push(["HOUSE RULES", `${formatBps(slip.rules.totalTradeBps)} per curve trade · creator ${formatBps(slip.rules.creatorTaxBps)} · ${slip.rules.buybackEnabled ? "buyback vests, no burn" : "no buyback"} · ${slip.rules.quote.symbol}`].join("  "));
    lines.push(["PHASE", `${PHASE_LABEL[slip.rules.phase]}${slip.rules.fill ? ` · ${(slip.rules.fill.bps / 100).toFixed(1)}% full` : ""} · dev holds ${(slip.rules.deployerShareBps / 100).toFixed(1)}%`].join("  "));
  }
  if (slip.dev) lines.push(["DEV REPORT CARD", devReportLine(slip.dev)].join("  "));
  const notes = slip.notes.slice(0, 4);

  const noteRows = notes
    .map((n, i) => {
      const y = 396 + i * 38;
      const color = n.level === "stop" ? c.stop : n.level === "watch" ? c.watch : c.info;
      return `<circle cx="72" cy="${y - 6}" r="6" fill="${color}"/><text x="92" y="${y}" font-size="18" fill="${c.text}">${esc(clip(n.text, 74))}</text>`;
    })
    .join("");
  const factRows = lines
    .map((l, i) => {
      const [label, value] = l.split("  ");
      const y = 214 + i * 36;
      return `<text x="60" y="${y}" font-size="15" font-weight="700" letter-spacing="2" fill="${c.brass}">${esc(label)}</text><text x="270" y="${y}" font-size="19" fill="${c.text}">${esc(clip(value, 70))}</text>`;
    })
    .join("");
  const _phaseUnused: GraduationPhase | null = slip.rules?.phase ?? null;
  void _phaseUnused;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <rect width="1200" height="630" fill="${c.ink}"/>
  <rect x="40" y="40" width="1120" height="550" rx="18" fill="${c.panel}" stroke="${c.line}"/>
  <rect x="40" y="40" width="1120" height="6" fill="${c.rope}"/>
  <text x="60" y="96" font-size="22" font-weight="700" letter-spacing="6" fill="${c.brass}">BOUNCER</text>
  <text x="60" y="122" font-size="15" fill="${c.muted}">read-only door check · Pons V2 · Robinhood Chain 4663 · block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}</text>
  <text x="60" y="176" font-size="44" font-weight="700" fill="${c.text}">${title}</text>
  <text x="${60 + Math.min(title.length, 14) * 27 + 24}" y="176" font-size="20" fill="${c.muted}">${sub}</text>
  ${factRows}
  <line x1="60" y1="340" x2="900" y2="340" stroke="${c.line}"/>
  <text x="60" y="366" font-size="13" font-weight="700" letter-spacing="3" fill="${c.muted}">DOOR NOTES</text>
  ${noteRows}
  <g transform="translate(880 150) rotate(-8)">
    <rect x="0" y="0" width="270" height="64" rx="8" fill="none" stroke="${stampColor}" stroke-width="4"/>
    <text x="135" y="42" text-anchor="middle" font-size="${slip.stamp.length > 12 ? 22 : 26}" font-weight="800" letter-spacing="3" fill="${stampColor}">${slip.stamp}</text>
  </g>
  <g transform="translate(964 330) scale(5.5)">${options.mascotSvg}</g>
  <text x="60" y="562" font-size="14" fill="${c.muted}">${esc(slip.subject)}</text>
  <text x="1140" y="540" text-anchor="end" font-size="13" fill="${c.dim}">no key · no signer · no transaction path</text>
  <text x="1140" y="562" text-anchor="end" font-size="14" fill="${c.muted}">${esc(options.repoUrl)} · ${esc(options.ticker)}</text>
</svg>
`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
