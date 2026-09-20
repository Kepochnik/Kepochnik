/**
 * The slip as a 1200×630 card somebody can paste into a chat.
 *
 * The old one was built for a launchpad launch — cover charge, house rules,
 * dev report — so an ordinary token got a card with three blank rows, and
 * none of them carried the one thing the page leads with: the verdict. A
 * card is read in the second before somebody scrolls past it, and it has to
 * answer "is this safe to buy" in that second or it is decoration.
 *
 * So: the word, the ticker, the four facts that decide it, and the loudest
 * findings underneath. Self-contained SVG with no fetched fonts, so it
 * renders the same in a browser, a chat preview and a screenshot.
 */
import { formatBps } from "../format.js";
import { isoUtc, shortAddress } from "../format.js";
import type { DoorSlip } from "./door.js";
import type { DoorNote, NoteLevel } from "./door.js";
import type { SplSlip } from "./spl.js";

export interface CardOptions {
  repoUrl: string;
  ticker: string;
  mascotSvg: string;
  /** Where a reader can run the same check themselves. Printed as the call to action. */
  checkUrl?: string;
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
  ok: "#39d98a",
  info: "#7f8ea3",
  dim: "#5e5a66",
};

/** The one word, from the loudest note. Same rule as the page, kept here so the two cannot drift. */
export function cardVerdict(notes: DoorNote[]): { word: string; color: string; line: string } {
  const c = CARD_COLORS;
  const stop = notes.filter((n) => n.level === "stop").length;
  const watch = notes.filter((n) => n.level === "watch").length;
  if (stop) return { word: "STOP", color: c.stop, line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright` };
  if (watch) return { word: "WATCH", color: c.watch, line: `${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy` };
  return { word: "CLEAR", color: c.ok, line: "nothing in what was read stands out" };
}

/** Four tiles: the questions a buyer asks before any other. */
function facts(slip: DoorSlip): { label: string; value: string; bad: boolean }[] {
  const o = slip.open;
  const out: { label: string; value: string; bad: boolean }[] = [];
  if (o) {
    const owner = o.ownerUnread ? "UNREAD" : o.owner === null ? "NONE" : o.owner.renounced ? "RENOUNCED" : shortAddress(o.owner.address).toUpperCase();
    out.push({ label: "OWNER", value: owner, bad: Boolean(o.owner && !o.owner.renounced) });
    const powers = o.powers.filter((p) => p.kind !== "exempt" && p.kind !== "sweep").length;
    out.push({ label: "CODE CAN", value: String(powers), bad: powers > 0 });
    const sells = o.probes.filter((p) => p.target === "pool");
    const sale = !sells.length ? "NOT RUN" : sells.every((p) => p.status === "ok") ? "GOES THROUGH" : sells.some((p) => p.status === "reverts") ? "REVERTS" : "UNREAD";
    out.push({ label: "SALE INTO POOL", value: sale, bad: sale === "REVERTS" });
    const top = o.holders?.top10WalletsBps ?? null;
    out.push({ label: "TOP 10 WALLETS", value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`, bad: top !== null && top >= 5_000 });
  } else if (slip.rules) {
    out.push({ label: "TRADE FEE", value: formatBps(slip.rules.totalTradeBps), bad: slip.rules.totalTradeBps >= 1_000 });
    out.push({ label: "CREATOR TAX", value: formatBps(slip.rules.creatorTaxBps), bad: slip.rules.creatorTaxBps >= 500 });
    out.push({ label: "DEV HOLDS", value: `${(slip.rules.deployerShareBps / 100).toFixed(1)}%`, bad: slip.rules.deployerShareBps >= 2_000 });
    out.push({ label: "BUYBACK", value: slip.rules.buybackEnabled ? "VESTS" : "NONE", bad: slip.rules.buybackEnabled });
  }
  return out.slice(0, 4);
}

/**
 * What a card needs, from whichever kind of slip it came from.
 *
 * Solana has mints and slots where the EVM has contracts and blocks, and
 * the questions a buyer asks are the same either way. One renderer, two
 * small adapters — a second copy of the layout would be a second place for
 * it to drift.
 */
export interface CardModel {
  chain: string;
  /** "block 1234" or "slot 1234": the reader should know which chain's clock this is. */
  at: string;
  timestamp: number | null;
  ticker: string;
  name: string;
  address: string;
  stamp: string;
  notes: DoorNote[];
  facts: { label: string; value: string; bad: boolean }[];
}

export function doorCard(slip: DoorSlip, options: CardOptions): string {
  const meta = slip.id.meta;
  return renderCard(
    {
      chain: slip.chain.name,
      at: `block ${slip.at.block}`,
      timestamp: slip.at.timestamp,
      ticker: meta ? clip(meta.symbol, 12) : shortAddress(slip.subject),
      name: meta ? clip(meta.name, 34) : slip.known ? "known contract" : "no name on chain",
      address: slip.subject,
      stamp: slip.stamp,
      notes: slip.notes,
      facts: facts(slip),
    },
    options,
  );
}

/** The same card for a Solana mint: the questions that matter there are its own. */
export function splCard(slip: SplSlip, options: CardOptions): string {
  const m = slip.mint;
  const fee = m?.extensions.find((e) => e.kind === "transfer-fee");
  const top = slip.holders?.top10Bps ?? null;
  return renderCard(
    {
      chain: slip.chain.name,
      at: `slot ${slip.at.slot}`,
      timestamp: slip.at.timestamp,
      ticker: clip(slip.metadata?.symbol || shortAddress(slip.subject), 12),
      name: clip(slip.metadata?.name || slip.whatItIs || "no name on chain", 34),
      address: slip.subject,
      stamp: slip.stamp,
      notes: slip.notes as DoorNote[],
      facts: [
        { label: "CAN THEY FREEZE YOU", value: m?.freezeAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.freezeAuthority) },
        { label: "CAN THEY PRINT MORE", value: m?.mintAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.mintAuthority) },
        {
          label: "TAX PER TRANSFER",
          value: fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : m ? "0%" : "UNREAD",
          bad: fee?.kind === "transfer-fee" && fee.feeBps >= 500,
        },
        { label: "TOP 10 HOLDERS", value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`, bad: top !== null && top >= 5_000 },
      ],
    },
    options,
  );
}

function renderCard(model: CardModel, options: CardOptions): string {
  const c = CARD_COLORS;
  const v = cardVerdict(model.notes);
  const ticker = model.ticker;
  const name = model.name;

  // Loudest first, and never more than three: a card nobody finishes is a
  // card that said nothing.
  const rank: Record<NoteLevel, number> = { stop: 0, watch: 1, info: 2 };
  const shown = [...model.notes].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 3);

  const tiles = model.facts
    .map((f, i) => {
      const x = 60 + i * 272;
      return `<g>
      <rect x="${x}" y="344" width="252" height="96" rx="12" fill="${c.ink}" stroke="${c.line}"/>
      <text x="${x + 18}" y="374" font-size="12" letter-spacing="2" fill="${c.muted}">${esc(f.label)}</text>
      <text x="${x + 18}" y="416" font-size="${f.value.length > 11 ? 21 : 29}" font-weight="700" fill="${f.bad ? c.stop : c.text}">${esc(f.value)}</text>
    </g>`;
    })
    .join("");

  const noteRows = shown
    .map((n, i) => {
      const y = 496 + i * 32;
      const color = n.level === "stop" ? c.stop : n.level === "watch" ? c.watch : c.info;
      return `<circle cx="66" cy="${y - 5}" r="5" fill="${color}"/><text x="86" y="${y}" font-size="17" fill="${n.level === "info" ? c.muted : c.text}">${esc(clip(n.text, 96))}</text>`;
    })
    .join("");

  const stamp = model.stamp;
  const stampColor = stamp === "ON THE LIST" ? c.brass : stamp === "NOT A LAUNCH" ? c.muted : c.stop;
  const stampWidth = stamp.length * 9.5 + 26;

  // A grid, not offsets computed from the length of the verdict word. The
  // first version placed the ticker at `60 + word.length * 52` and the
  // stamp under it, which put "NOT A LAUNCH" straight through the sentence
  // beside "WATCH". Rows own their vertical space and nothing is positioned
  // relative to text whose width nobody measured.
  //
  // Identity comes first, above the verdict, because the question a reader
  // asks of a shared card is "which token is this" before "is it safe".
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <rect width="1200" height="630" fill="${c.ink}"/>
  <rect x="24" y="24" width="1152" height="582" rx="20" fill="${c.panel}" stroke="${c.line}"/>
  <rect x="24" y="24" width="1152" height="5" rx="2.5" fill="${v.color}"/>

  <g transform="translate(56 50) scale(1.05)">${options.mascotSvg}</g>
  <text x="112" y="70" font-size="22" font-weight="700" letter-spacing="6" fill="${c.brass}">BOUNCER</text>
  <text x="112" y="92" font-size="13" fill="${c.dim}">read-only · no key · no signer</text>
  <text x="1144" y="70" text-anchor="end" font-size="15" fill="${c.muted}">${esc(model.chain)} · ${esc(model.at)}</text>
  <text x="1144" y="92" text-anchor="end" font-size="13" fill="${c.dim}">${model.timestamp ? esc(isoUtc(model.timestamp)) : ""}</text>
  <line x1="56" y1="116" x2="1144" y2="116" stroke="${c.line}"/>

  <text x="60" y="168" font-size="42" font-weight="800" fill="${c.text}">${esc(ticker)}</text>
  <text x="60" y="200" font-size="20" fill="${c.muted}">${esc(name)}</text>
  <g transform="translate(${1144 - stampWidth} 142)">
    <rect x="0" y="0" width="${stampWidth}" height="30" rx="15" fill="none" stroke="${stampColor}"/>
    <text x="${stampWidth / 2}" y="20" text-anchor="middle" font-size="13" font-weight="700" letter-spacing="2" fill="${stampColor}">${esc(stamp)}</text>
  </g>
  <text x="1144" y="200" text-anchor="end" font-size="15" fill="${c.dim}">${esc(model.address)}</text>

  <text x="60" y="296" font-size="76" font-weight="800" letter-spacing="1" fill="${v.color}">${v.word}</text>
  <text x="${60 + v.word.length * 46 + 34}" y="284" font-size="20" fill="${c.text}">${esc(v.line)}</text>
  <text x="${60 + v.word.length * 46 + 34}" y="310" font-size="15" fill="${c.dim}">read at one block · nothing here is advice</text>

  ${tiles}

  <line x1="60" y1="470" x2="1140" y2="470" stroke="${c.line}"/>
  ${noteRows}

  <text x="60" y="588" font-size="15" fill="${c.muted}">${esc(options.checkUrl ?? options.repoUrl)}</text>
  <text x="1144" y="588" text-anchor="end" font-size="15" fill="${c.dim}">check it yourself before you buy · ${esc(options.ticker)}</text>
</svg>
`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  // Back up to a word boundary when there is one near the end. A sentence
  // sliced through the middle of a word reads as a rendering fault rather
  // than as a sentence that was too long.
  return `${(space > max - 18 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
