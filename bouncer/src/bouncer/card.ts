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
import { topicOf } from "./topics.js";
import { doorCoverage, splCoverage, qualify, type Coverage } from "./coverage.js";

export interface CardOptions {
  /**
   * The lead the page is showing, passed in rather than recomputed.
   *
   * It is built in the site from the slip, and a card that writes its own
   * version of the same sentence is two sentences that can disagree about
   * one token. One of them would then be wrong on somebody's timeline.
   */
  lead?: string;
  repoUrl: string;
  ticker: string;
  mascotSvg: string;
  /** Where a reader can run the same check themselves. Printed as the call to action. */
  checkUrl?: string;
}

/** The page's palette, so a shared card and the page it came from are the same object. */
export const CARD_COLORS = {
  ink: "#07090a",
  panel: "#0b0e10",
  panel2: "#0f1315",
  line: "#1a2220",
  brass: "#e8b84b",
  rope: "#c0122e",
  text: "#eef3f1",
  muted: "#cfd6d3",
  stop: "#ff6b5e",
  watch: "#e8b84b",
  ok: "#7fd6a9",
  info: "#7d9aa8",
  dim: "#6d7a76",
  dimmer: "#4e5a57",
};

/** The one word, from the loudest note. Same rule as the page, kept here so the two cannot drift. */
export function cardVerdict(notes: DoorNote[]): { word: string; kind: "stop" | "watch" | "clear"; color: string; line: string } {
  const c = CARD_COLORS;
  const stop = notes.filter((n) => n.level === "stop").length;
  const watch = notes.filter((n) => n.level === "watch").length;
  if (stop) return { word: "STOP", kind: "stop", color: c.stop, line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright` };
  if (watch) return { word: "WATCH", kind: "watch", color: c.watch, line: `${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy` };
  return { word: "CLEAR", kind: "clear", color: c.ok, line: "nothing in what was read stands out" };
}

/**
 * Four tiles: the questions a buyer asks before any other.
 *
 * Each carries the sub-line the page's tile carries, because a figure
 * with no unit beside it — "4", "2/3", "45%" — is a number somebody has
 * to guess the meaning of, and a card is read by people who did not run
 * the check themselves.
 */
type Fact = { label: string; value: string; bad: boolean; note?: string };

function facts(slip: DoorSlip): Fact[] {
  const o = slip.open;
  const out: Fact[] = [];
  if (o) {
    const owner = o.ownerUnread ? "UNREAD" : o.owner === null ? "NONE" : o.owner.renounced ? "RENOUNCED" : "HAS KEYS";
    out.push({
      label: "OWNER",
      value: owner,
      bad: Boolean(o.owner && !o.owner.renounced),
      note: o.ownerUnread ? "owner() would not answer" : o.owner === null ? "no owner() in the code" : o.owner.renounced ? "nobody can call owner-only code" : shortAddress(o.owner.address),
    });
    const kinds = o.powers.filter((p) => p.kind !== "exempt" && p.kind !== "sweep");
    const names = [...new Set(kinds.map((p) => p.kind))];
    out.push({ label: "CODE CAN", value: String(kinds.length), bad: kinds.length > 0, note: names.length ? names.join(", ") : "nothing owner-only found" });
    const sells = o.probes.filter((p) => p.target === "pool");
    const ok = sells.filter((p) => p.status === "ok").length;
    const sale = !sells.length ? "NOT RUN" : sells.every((p) => p.status === "ok") ? "ALL PASS" : sells.some((p) => p.status === "reverts") ? `${ok}/${sells.length}` : "UNREAD";
    // "SALE INTO POOL" with the value ALL PASS reads as "you can sell this",
    // and it is not what was simulated. What was simulated is a plain
    // transfer to the pool's address: the first step of a sale, and the step
    // traps break. A real sale goes through a router that pulls the tokens
    // with transferFrom and then calls swap, and a token can allow the one
    // and revert the other. The label now says which of the two this is.
    out.push({
      label: "TRANSFER TO POOL",
      value: sale,
      bad: sells.some((p) => p.status === "reverts"),
      note: !sells.length ? "not simulated" : `${sells.length} wallet${sells.length === 1 ? "" : "s"} · not a router swap`,
    });
    const top = o.holders?.top10WalletsBps ?? null;
    out.push({
      label: "TOP 10 WALLETS",
      value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`,
      bad: top !== null && top >= 5_000,
      note: o.holders?.count ? `of supply · ${o.holders.count} holders` : "explorer not reachable",
    });
  } else if (slip.rules) {
    out.push({ label: "TRADE FEE", value: formatBps(slip.rules.totalTradeBps), bad: slip.rules.totalTradeBps >= 1_000, note: "on every buy and sell" });
    out.push({ label: "CREATOR TAX", value: formatBps(slip.rules.creatorTaxBps), bad: slip.rules.creatorTaxBps >= 500, note: "of the fee, to the creator" });
    out.push({ label: "DEV HOLDS", value: `${(slip.rules.deployerShareBps / 100).toFixed(1)}%`, bad: slip.rules.deployerShareBps >= 2_000, note: "of supply" });
    out.push({ label: "BUYBACK", value: slip.rules.buybackEnabled ? "VESTS" : "NONE", bad: slip.rules.buybackEnabled, note: slip.rules.buybackEnabled ? "bought back, not burned" : "no buyback in the rules" });
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
  /** The page's own lead sentence, so the card and the slip open with the same words. */
  lead?: string;
  /** `note` is the sub-line under the figure, the same one the page's tiles carry. */
  facts: { label: string; value: string; bad: boolean; note?: string }[];
  /**
   * How complete the reading was.
   *
   * The card is the artefact that travels. A page that overstates itself
   * is read by one person; a card that does is pasted into a group chat
   * and forwarded, and the reader three hops down has no way back to the
   * caveats. So whatever the page had to admit, the card admits in the
   * same words and at the same size.
   */
  coverage?: Coverage;
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
      lead: options.lead,
      address: slip.subject,
      stamp: slip.stamp,
      notes: slip.notes,
      facts: facts(slip),
      coverage: doorCoverage(slip),
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
      // The range the reading covered, not the slot it started at. See
      // SplSlip.at for why those differ on this chain.
      at: slip.at.span && slip.at.span.spread > 4 ? `slots ${slip.at.span.first}-${slip.at.span.last}` : `slot ${slip.at.span?.last ?? slip.at.slot}`,
      timestamp: slip.at.timestamp,
      ticker: clip(slip.metadata?.symbol || shortAddress(slip.subject), 12),
      lead: options.lead,
      name: clip(slip.metadata?.name || slip.whatItIs || "no name on chain", 34),
      address: slip.subject,
      stamp: slip.stamp,
      notes: slip.notes as DoorNote[],
      facts: [
        { label: "FREEZE YOU", value: m?.freezeAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.freezeAuthority), note: m?.freezeAuthority ? "a freeze authority is set" : m ? "no freeze authority" : "the mint would not answer" },
        { label: "PRINT MORE", value: m?.mintAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.mintAuthority), note: m?.mintAuthority ? "a mint authority is set" : m ? "supply is fixed" : "the mint would not answer" },
        {
          label: "TAX PER TRANSFER",
          value: fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : m ? "0%" : "UNREAD",
          bad: fee?.kind === "transfer-fee" && fee.feeBps >= 500,
          note: fee?.kind === "transfer-fee" ? "taken on every transfer" : m ? "no transfer fee extension" : "the mint would not answer",
        },
        { label: "TOP 10 HOLDERS", value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`, bad: top !== null && top >= 5_000, note: top === null ? "the holder list did not answer" : "of supply" },
      ],
      coverage: splCoverage(slip),
    },
    options,
  );
}

/**
 * The line under the address: what this reading covered, or the standing
 * disclaimer when it covered everything.
 *
 * It replaces "read at one block · nothing here is scored, predicted or
 * advised" rather than sitting beside it, because the card has one line
 * there and the more urgent of the two claims wins. A reading with a hole
 * in it needs to say so more than it needs to repeat that it gives no
 * advice — and the second half of that promise was overstated anyway on a
 * chain whose sections are read at slots of their own.
 */
function coverageFoot(cov: Coverage | undefined): string {
  if (!cov || cov.state === "complete") return "read from the chain · nothing here is scored, predicted or advised";
  const names = cov.gaps.map((g) => g.label).join(", ");
  return clip(`${cov.read} of ${cov.asked} checks answered · unread: ${names}`, 74);
}

function renderCard(model: CardModel, options: CardOptions): string {
  const c = CARD_COLORS;
  const v0 = cardVerdict(model.notes);
  const cov = model.coverage;
  // Same rule as the page, from the same function: CLEAR is a claim about
  // what was looked at, so a decisive gap takes it away. STOP and WATCH
  // are claims about findings and keep their word.
  const qualified = cov ? qualify(v0.kind, cov) : v0.kind;
  const v =
    qualified === "incomplete"
      ? { ...v0, word: "INCOMPLETE", color: c.info, line: "Nothing stood out in what was read, and part of it was not read." }
      : v0;

  // Loudest first, and never more than three: a card nobody finishes is a
  // card that said nothing.
  const rank: Record<NoteLevel, number> = { stop: 0, watch: 1, info: 2 };
  const shown = [...model.notes].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 3);
  const levelColor = (l: NoteLevel): string => (l === "stop" ? c.stop : l === "watch" ? c.watch : c.info);

  // The same rows the page has, in the same order, at the same widths.
  //
  // A card in one visual language and a page in another is two products;
  // somebody who clicks through from the card has to work out that they
  // are looking at the same thing. Cells, hairlines, right angles, one
  // mono face — no rounded panels, no drop shadow, no stroked pills.
  const ROWS = { bar: 44, subject: 104, verdict: 288, head: 320, facts: 408, foot: 560 };
  const L = 40;
  const R = 1160;
  const line = (y: number): string => `<line x1="0" y1="${y}" x2="1200" y2="${y}" stroke="${c.line}"/>`;

  const cols = model.facts.length;
  const colW = (R - L) / cols;
  const factCells = model.facts
    .map((f, i) => {
      const x = L + i * colW;
      const long = f.value.length > 9;
      return `${i ? `<line x1="${x}" y1="${ROWS.head}" x2="${x}" y2="${ROWS.facts}" stroke="${c.line}"/>` : ""}
      <text x="${x + 16}" y="${ROWS.head - 11}" font-size="12" letter-spacing="2.2" fill="${c.dimmer}">${esc(f.label)}</text>
      <text x="${x + 16}" y="${ROWS.head + 44}" font-size="${long ? 24 : 32}" font-weight="700" fill="${f.bad ? c.stop : c.text}">${esc(f.value)}</text>
      <text x="${x + 16}" y="${ROWS.head + 70}" font-size="13" fill="${c.dim}">${esc(clip(f.note ?? "", Math.floor(colW / 7.6)))}</text>`;
    })
    .join("");

  const rowH = Math.floor((ROWS.foot - ROWS.facts) / Math.max(1, shown.length));
  const noteRows = shown
    .map((n, i) => {
      const top = ROWS.facts + i * rowH;
      const mid = top + rowH / 2 + 6;
      return `${i ? line(top) : ""}
      <line x1="150" y1="${top}" x2="150" y2="${top + rowH}" stroke="${c.line}"/>
      <text x="${L}" y="${mid}" font-size="13" letter-spacing="1.6" fill="${levelColor(n.level)}">${n.level.toUpperCase()}</text>
      <text x="170" y="${mid}" font-size="17" fill="${n.level === "info" ? c.muted : c.text}">${esc(clip(n.text, 98))}</text>`;
    })
    .join("");

  const stamp = model.stamp;
  const stampColor = stamp === "ON THE LIST" ? c.ok : stamp === "NOT A LAUNCH" ? c.watch : c.stop;
  const stampW = stamp.length * 8.4 + 22;
  // Split the same way the page splits it. The card used to print one
  // total across findings AND the things that went unread, which is a
  // number nobody can arrive at by reading the card — the three lines
  // below it are findings, and what could not be read is a different
  // claim that deserves saying out loud rather than being added in.
  // One tally here, the coverage line owns the other. The cell used to
  // read "9 findings · 2 unread" directly above "3 of 4 checks answered",
  // and those count different things — notes against checks — so a reader
  // is left reconciling two numbers nobody told them were different.
  const found = model.notes.filter((n) => topicOf(n.code) !== "unread").length;
  const counts = `${found} finding${found === 1 ? "" : "s"}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <defs>
    <pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="12" height="12" fill="${c.panel}"/>
      <rect width="6" height="12" fill="${c.panel2}"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="${c.panel}"/>
  <rect width="1200" height="2" fill="${c.rope}"/>

  <g transform="translate(14 10) scale(0.66)">${options.mascotSvg}</g>
  <text x="56" y="${ROWS.bar - 15}" font-size="15" font-weight="700" letter-spacing="5" fill="${c.text}">BOUNCER</text>
  <line x1="168" y1="2" x2="168" y2="${ROWS.bar}" stroke="${c.line}"/>
  <text x="186" y="${ROWS.bar - 15}" font-size="14" fill="${c.dim}">read-only · no key · no signer</text>
  <text x="${R}" y="${ROWS.bar - 15}" text-anchor="end" font-size="14" fill="${c.dim}">${esc(model.chain)} · ${esc(model.at)}${model.timestamp ? ` · ${esc(isoUtc(model.timestamp))}` : ""}</text>
  ${line(ROWS.bar)}

  <text x="${L}" y="${ROWS.subject - 22}" font-size="26" font-weight="700" letter-spacing="1.5" fill="${c.text}">${esc(model.ticker)}</text>
  <text x="${L + model.ticker.length * 17 + 22}" y="${ROWS.subject - 22}" font-size="17" fill="${c.dim}">${esc(model.name)}</text>
  <g transform="translate(${R - stampW} ${ROWS.subject - 42})">
    <rect x="0" y="0" width="${stampW}" height="26" fill="none" stroke="${stampColor}"/>
    <text x="${stampW / 2}" y="18" text-anchor="middle" font-size="12" letter-spacing="2" fill="${stampColor}">${esc(stamp)}</text>
  </g>
  ${line(ROWS.subject)}

  <rect x="0" y="${ROWS.subject}" width="340" height="${ROWS.verdict - ROWS.subject}" fill="url(#hatch)"/>
  <line x1="340" y1="${ROWS.subject}" x2="340" y2="${ROWS.verdict}" stroke="${c.line}"/>
  <text x="${L}" y="${ROWS.subject + 34}" font-size="13" letter-spacing="3.4" fill="${c.dimmer}">VERDICT</text>
  <text x="${L}" y="${ROWS.subject + 110}" font-size="${v.word.length > 6 ? 34 : 64}" font-weight="700" fill="${v.color}">${v.word}</text>
  <text x="${L}" y="${ROWS.subject + 145}" font-size="14" fill="${c.dim}">${esc(counts)}</text>
  <text x="380" y="${ROWS.subject + 44}" font-size="21" fill="${c.text}">${esc(clip(model.lead || v.line, 62))}</text>
  ${model.lead ? `<text x="380" y="${ROWS.subject + 74}" font-size="17" fill="${c.dim}">${esc(clip(v.line, 74))}</text>` : ""}
  <text x="380" y="${ROWS.subject + 118}" font-size="15" fill="${c.dimmer}">${esc(model.address)}</text>
  <text x="380" y="${ROWS.subject + 144}" font-size="14" fill="${cov && cov.state !== "complete" ? c.info : c.dimmer}">${esc(coverageFoot(cov))}</text>
  ${line(ROWS.verdict)}
  ${line(ROWS.head)}
  ${factCells}
  ${line(ROWS.facts)}
  ${noteRows}
  ${line(ROWS.foot)}

  <text x="${L}" y="${ROWS.foot + 44}" font-size="15" fill="${c.brass}">${esc(options.checkUrl ?? options.repoUrl)}</text>
  <text x="${R}" y="${ROWS.foot + 44}" text-anchor="end" font-size="15" fill="${c.dim}">check it yourself before you buy</text>
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
