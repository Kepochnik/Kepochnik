/**
 * The diploma is a transcript of one graduation: the block the curve was
 * swept into a locked Uniswap V4 pool, and what happened on the curve
 * before that. Every field is read from the chain; the seal carries the
 * blocks so anyone can re-run the tool and get the same paper.
 */
import { formatBps, formatUnits, isoUtc, shortAddress } from "../format.js";
import type { Receipt } from "../receipt.js";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER } from "../chain/pons.js";
import type { Transcript } from "./transcript.js";
import { transcriptSummary } from "./transcript.js";

export interface DiplomaFacts {
  name: string;
  symbol: string;
  token: string;
  deployer: string;
  pairToken: string; // 0x0 for ETH
  pairSymbol: string; // "ETH" or the stock / ERC-20 symbol
  pairDecimals: number;
  graduationBlock: number; // block of PoolGraduated (pool seeded)
  graduationTimestamp: number;
  sweepBlock: number | null; // block of LaunchSwept (curve drained); the moment the curve ended
  launchBlock: number | null;
  launchTimestamp: number | null;
  quoteRaised: bigint; // pair-token amount seeded into the pool
  tokensToPool: bigint;
  tokenDecimals: number;
  positionId: bigint | null; // null for the legacy PoolGraduated shape
  poolId: string | null;
  creatorTaxBps: bigint;
  buybackEnabled: boolean;
  observedAtBlock: number;
  transcript: Transcript | null; // null when the launch block is outside the window
}

/** 4663 typed on a phone keypad spells HOOD. It goes on every seal. */
export const SEAL = `chain ${ROBINHOOD_CHAIN_ID} · H-O-O-D on a keypad`;

export function classOf(timestamp: number): string {
  return isoUtc(timestamp).slice(0, 10);
}

export function diplomaReceipt(facts: DiplomaFacts): Receipt {
  const t = facts.transcript;
  const q = (v: bigint) => `${formatUnits(v, facts.pairDecimals)} ${facts.pairSymbol}`;
  return {
    title: `DIPLOMA · $${facts.symbol}`,
    subtitle: `class of ${classOf(facts.graduationTimestamp)} · Pons V2 on Robinhood Chain`,
    sections: [
      {
        title: "this certifies that",
        rows: [
          { label: "token", value: `${facts.name} ($${facts.symbol})` },
          { label: "contract", value: facts.token },
          { label: "deployer", value: facts.deployer },
        ],
      },
      {
        title: "graduated",
        rows: [
          { label: "pool seeded", value: facts.graduationBlock, note: isoUtc(facts.graduationTimestamp) },
          { label: "curve swept", value: facts.sweepBlock, note: facts.sweepBlock === null ? "no LaunchSwept in window" : undefined },
          { label: "launched", value: facts.launchBlock, note: facts.launchTimestamp === null ? "outside the window; widen --hours" : isoUtc(facts.launchTimestamp) },
          { label: "raised", value: q(facts.quoteRaised), note: "seeded into the locked pool" },
          { label: "supply to pool", value: formatUnits(facts.tokensToPool, facts.tokenDecimals, 0) },
          { label: "v4 position", value: facts.positionId === null ? (facts.poolId ?? null) : `#${facts.positionId}`, note: "permanently locked" },
        ],
      },
      {
        title: "transcript",
        rows: t
          ? [
              { label: "time to graduate", value: `${t.secondsToGraduate} s`, note: `${t.launchBlock} → ${t.sweepBlock}` },
              { label: "buyers", value: t.buyers, note: `${t.buys} buys, ${t.sells} sells` },
              { label: "quote in / out", value: `${q(t.totalQuoteIn)} / ${q(t.totalQuoteOut)}` },
              { label: "dev funded", value: `${(t.devShareBps / 100).toFixed(1)}%`, note: q(t.devQuoteIn) },
              { label: "first minute", value: `${(t.firstMinuteShareBps / 100).toFixed(1)}%`, note: "of quote in, bought within 60 s of launch" },
              { label: "first buyers", value: t.roster.slice(0, 5).map((r) => `#${r.ordinal} ${shortAddress(r.address)}${r.isDeployer ? " (dev)" : ""}`).join("  ") || "none" },
            ]
          : [{ label: "transcript", value: null, note: "launch block not in window; re-run with --hours" }],
      },
      {
        title: "terms",
        rows: [
          { label: "creator tax", value: formatBps(facts.creatorTaxBps) },
          { label: "buyback vault", value: facts.buybackEnabled ? "enabled (5-year vest back to creator and protocol)" : "disabled" },
        ],
      },
      {
        title: "seal",
        rows: [
          { label: "read at block", value: facts.observedAtBlock },
          { label: "seal", value: SEAL },
          { label: "explorer", value: `${ROBINHOOD_EXPLORER}/token/${facts.token}` },
        ],
      },
    ],
    footnotes: [
      "A diploma is a transcript of a past event. It is not a rating, not a prediction and not a buy signal.",
      "No key. No signer. No transaction path. Re-run at the blocks above to reproduce every number.",
    ],
    meta: { token: facts.token, block: facts.graduationBlock, sweepBlock: facts.sweepBlock, launchBlock: facts.launchBlock },
  };
}

/** One-line version for the watch tape. */
export function diplomaLine(facts: DiplomaFacts): string {
  const raised = `${formatUnits(facts.quoteRaised, facts.pairDecimals)} ${facts.pairSymbol}`;
  const tail = facts.transcript ? transcriptSummary(facts.transcript) : "transcript: launch outside window";
  return `🎓 $${facts.symbol} · block ${facts.graduationBlock} · raised ${raised} · ${tail} · ${shortAddress(facts.token)}`;
}

/** A holder stub: proof that an address was buyer #k on the curve before it graduated. */
export function holderStub(facts: DiplomaFacts, address: string): Receipt {
  const t = facts.transcript;
  const entry = t?.roster.find((r) => r.address === address.toLowerCase());
  return {
    title: `HOLDER STUB · $${facts.symbol}`,
    subtitle: entry ? `buyer #${entry.ordinal} of ${t!.buyers} · class of ${classOf(facts.graduationTimestamp)}` : `not on the curve roster · class of ${classOf(facts.graduationTimestamp)}`,
    sections: [
      {
        title: "holder",
        rows: [
          { label: "address", value: address.toLowerCase() },
          { label: "ordinal", value: entry ? `#${entry.ordinal} of ${t!.buyers}` : null, note: entry ? "order of first buy on the curve" : t ? "no CurveBuy from this address before the sweep" : "transcript unavailable" },
          { label: "first buy", value: entry ? entry.firstBlock : null },
          { label: "spent on curve", value: entry ? `${formatUnits(entry.quoteIn, facts.pairDecimals)} ${facts.pairSymbol}` : null, note: entry ? `${entry.buys} buy${entry.buys === 1 ? "" : "s"}` : undefined },
          { label: "role", value: entry?.isDeployer ? "deployer" : "buyer" },
        ],
      },
      {
        title: "graduation",
        rows: [
          { label: "token", value: `${facts.name} ($${facts.symbol})` },
          { label: "pool seeded", value: facts.graduationBlock },
          { label: "seal", value: SEAL },
        ],
      },
    ],
    footnotes: ["A stub proves an address bought on the curve before the sweep. It says nothing about what it holds now."],
    meta: { token: facts.token, address: address.toLowerCase(), ordinal: entry?.ordinal ?? null },
  };
}

// ---------------------------------------------------------------------------
// SVG card (1200x630): cream paper, navy ink, gold seal. No dependencies.
// ---------------------------------------------------------------------------

export interface DiplomaCardOptions {
  repoUrl?: string;
  ticker?: string; // the mark, e.g. "$DIPLOMA"
  mascotSvg?: string; // inline <svg> body of the mascot, 32-unit grid
}

const PAPER = "#f3eedc";
const INK = "#1b2a6b";
const GOLD = "#c9962b";
const MUTED = "#6d6a5c";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function diplomaSvg(facts: DiplomaFacts, options: DiplomaCardOptions = {}): string {
  const t = facts.transcript;
  const raised = `${formatUnits(facts.quoteRaised, facts.pairDecimals)} ${facts.pairSymbol}`;
  const when = isoUtc(facts.graduationTimestamp).replace("T", " ").replace("Z", " UTC");
  const repo = options.repoUrl ?? "";
  const mark = options.ticker ?? "";
  const mascot = options.mascotSvg ?? "";
  const line1 = `graduated at block ${facts.graduationBlock} · raised ${raised}`;
  const line2 = t ? transcriptSummary(t) : "transcript: launch block outside the window";
  const dots = confettiDots(facts.graduationBlock);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="grain" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="${PAPER}"/><circle cx="3" cy="3" r="0.5" fill="#e6dfc6"/></pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#grain)"/>
  <rect x="28" y="28" width="1144" height="574" fill="none" stroke="${INK}" stroke-width="3"/>
  <rect x="40" y="40" width="1120" height="550" fill="none" stroke="${GOLD}" stroke-width="1.5"/>
  ${dots}
  <text x="600" y="108" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="20" letter-spacing="6" fill="${MUTED}">PONS V2 · ROBINHOOD CHAIN · TRANSCRIPT</text>
  <text x="600" y="172" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="58" font-weight="bold" fill="${INK}">DIPLOMA</text>
  <text x="600" y="216" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="22" fill="${MUTED}">this certifies that</text>
  <text x="600" y="286" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="bold" fill="${INK}">$${esc(facts.symbol)}</text>
  <text x="600" y="322" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="17" fill="${MUTED}">${esc(facts.token)}</text>
  <text x="600" y="378" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="24" fill="${INK}">${esc(line1)}</text>
  <text x="600" y="416" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="24" fill="${INK}">${esc(line2)}</text>
  <text x="600" y="452" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="19" fill="${MUTED}">${esc(when)} · class of ${classOf(facts.graduationTimestamp)} · creator tax ${esc(formatBps(facts.creatorTaxBps))}</text>
  <g transform="translate(150 470)">
    <circle cx="0" cy="0" r="54" fill="${GOLD}"/>
    <circle cx="0" cy="0" r="44" fill="none" stroke="${PAPER}" stroke-width="2"/>
    <text x="0" y="-6" text-anchor="middle" font-family="Georgia, serif" font-size="14" font-weight="bold" fill="${PAPER}">CHAIN</text>
    <text x="0" y="16" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="bold" fill="${PAPER}">4663</text>
    <text x="0" y="34" text-anchor="middle" font-family="Georgia, serif" font-size="10" fill="${PAPER}">H·O·O·D</text>
  </g>
  <g transform="translate(1010 448) scale(3.6)">${mascot}</g>
  <line x1="420" y1="520" x2="780" y2="520" stroke="${INK}" stroke-width="1"/>
  <text x="600" y="545" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="16" fill="${MUTED}">a transcript, not a cheer.</text>
  <text x="600" y="578" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="15" fill="${MUTED}">${esc(mark)}${mark && repo ? " · " : ""}${esc(repo)}${repo ? " · " : ""}read at block ${facts.observedAtBlock}</text>
</svg>
`;
}

function confettiDots(seed: number): string {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const out: string[] = [];
  for (let i = 0; i < 70; i++) {
    const x = 60 + next() * 1080;
    const y = 60 + next() * 510;
    const size = 5 + next() * 6;
    const fill = next() < 0.5 ? GOLD : INK;
    const rotate = Math.floor(next() * 90);
    out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${(size * 0.6).toFixed(1)}" fill="${fill}" opacity="0.28" transform="rotate(${rotate} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
  }
  return out.join("\n  ");
}
