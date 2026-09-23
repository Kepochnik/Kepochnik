/**
 * WHAT CHANGED SINCE YOU LAST LOOKED?
 *
 * A slip is a photograph. It says what is true at one block, and it says
 * it just as calmly whether the token has sat still for a month or the
 * owner took the mint authority back twenty minutes ago. Those are
 * completely different situations for whoever is holding it, and nothing
 * on the page told them apart.
 *
 * This is the smallest honest version of the difference: a snapshot of a
 * reading, kept in the reader's own browser, and a comparison against the
 * next one. Not history — history would need a server, and a server would
 * need somebody's tokens to be somebody's business. Just: here is what
 * you saw last time, here is what is different now.
 *
 * Three rules, and each of them is a way the easy version lies.
 *
 * ONE: a gap is not a change. If the holder list was refused this time, the
 * top-ten share did not "drop to unknown" — nothing happened to it, we
 * simply could not see. Every comparison here refuses to fire when either
 * side is unknown, because "the dev dumped" and "the explorer was down"
 * must never look the same.
 *
 * TWO: it says when, and it says whose. "Nothing changed" is worth very
 * little if the last look was in March, so every answer carries the age of
 * the thing it is comparing against, and the page prints it.
 *
 * THREE: appearing and disappearing are not symmetrical. A new STOP is the
 * loudest thing this tool can say. A STOP that went away is worth saying
 * too, and worth saying carefully — a freeze authority that is gone is
 * good news, and a finding that vanished because the section did not run
 * this time is not news at all. The second case is what rule one exists to
 * catch.
 */
import type { DoorNote } from "./door.js";
import type { DoorSlip } from "./door.js";
import type { SplSlip } from "./spl.js";
import { topicOf } from "./topics.js";
import { doorCoverage, splCoverage } from "./coverage.js";

/**
 * What is kept between visits. Deliberately small and deliberately flat:
 * it goes in localStorage, it has to survive a version of this tool that
 * has not been written yet, and anything structural in here is a thing
 * that breaks silently when the shape moves.
 */
export interface Snapshot {
  /** Schema version. An older one is discarded rather than guessed at. */
  v: 1;
  chain: string;
  address: string;
  /** Unix seconds, from the reader's own clock — this is "when I looked". */
  at: number;
  /** The chain's own clock at the reading: block number or slot. */
  height: number;
  verdict: string;
  stamp: string;
  symbol: string;
  /** Every note code that was on the slip, with its level. The backbone of the diff. */
  codes: { code: string; level: DoorNote["level"] }[];
  /**
   * The handful of numbers worth watching move. `null` means it was not
   * readable, which is why every one of them is nullable and why nothing
   * here ever treats null as a value.
   */
  facts: {
    owner: string | null;
    canMint: boolean | null;
    canFreeze: boolean | null;
    taxBps: number | null;
    top10Bps: number | null;
    /** The quote side of the deepest pool, in its own units, as a string — bigint does not survive JSON. */
    poolQuote: string | null;
  };
  /** Whether that reading was complete, so an incomplete one is not compared as if it were. */
  coverage: "complete" | "partial" | "thin";
}

export type ChangeLevel = "stop" | "watch" | "info";

export interface Change {
  level: ChangeLevel;
  /** Stable id for the kind of change, so the page can group or style them. */
  kind: string;
  text: string;
}

export interface Diff {
  /** Seconds between the two readings, by the reader's clock. */
  ageSeconds: number;
  changes: Change[];
  /**
   * True when nothing moved AND both readings were complete enough for
   * that to mean something. A quiet diff off two half-read slips is not
   * "nothing changed", it is "nothing that was read twice changed".
   */
  confident: boolean;
}

function verdictWordOf(notes: DoorNote[]): string {
  if (notes.some((n) => n.level === "stop")) return "STOP";
  if (notes.some((n) => n.level === "watch")) return "WATCH";
  return "CLEAR";
}

export function snapshotOfDoor(slip: DoorSlip): Snapshot {
  const o = slip.open;
  const pool = (slip.open?.pools ?? []).filter((p) => (p.quoteReserve ?? 0n) > 0n).sort((a, b) => (b.quoteReserve! > a.quoteReserve! ? 1 : -1))[0];
  return {
    v: 1,
    chain: slip.chain.key,
    address: slip.subject.toLowerCase(),
    at: Math.floor(Date.now() / 1000),
    height: slip.at.block,
    verdict: verdictWordOf(slip.notes),
    stamp: slip.stamp,
    symbol: slip.id.meta?.symbol ?? "",
    codes: slip.notes.map((n) => ({ code: n.code, level: n.level })),
    facts: {
      owner: o?.ownerUnread ? null : (o?.owner?.address ?? null),
      canMint: o ? o.powers.some((p) => p.kind === "mint") : null,
      canFreeze: o ? o.powers.some((p) => p.kind === "pause" || p.kind === "blacklist") : null,
      // What a sale actually pays on the way out: the venue's fee plus
      // the creator's cut. Null off a launch, because an ordinary ERC-20
      // has no single number here and inventing a zero would report "the
      // tax went up" the first time a real one became readable.
      taxBps: slip.exit ? Number(slip.exit.feeBps + slip.exit.creatorTaxBps) : null,
      top10Bps: o?.holders?.top10WalletsBps ?? null,
      poolQuote: pool?.quoteReserve != null ? String(pool.quoteReserve) : null,
    },
    coverage: doorCoverage(slip).state,
  };
}

export function snapshotOfSpl(slip: SplSlip): Snapshot {
  const fee = slip.mint?.extensions.find((e) => e.kind === "transfer-fee");
  const pool = slip.market?.pools.filter((p) => p.quoteReserve > 0n).sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : -1))[0];
  return {
    v: 1,
    chain: slip.chain.key,
    // base58 is case-sensitive: lower-casing a mint makes it another account.
    address: slip.subject,
    at: Math.floor(Date.now() / 1000),
    height: slip.at.span?.last ?? slip.at.slot,
    verdict: verdictWordOf(slip.notes),
    stamp: slip.stamp,
    symbol: slip.metadata?.symbol ?? "",
    codes: slip.notes.map((n) => ({ code: n.code, level: n.level })),
    facts: {
      owner: null,
      canMint: slip.mint ? slip.mint.mintAuthority !== null : null,
      canFreeze: slip.mint ? slip.mint.freezeAuthority !== null : null,
      taxBps: fee?.kind === "transfer-fee" ? fee.feeBps : slip.mint ? 0 : null,
      top10Bps: slip.holders?.top10Bps ?? null,
      poolQuote: pool ? String(pool.quoteReserve) : null,
    },
    coverage: splCoverage(slip).state,
  };
}

/** A percentage move that is worth a line, rather than noise in the last digit. */
function movedBy(before: bigint, after: bigint): number {
  if (before === 0n) return after === 0n ? 0 : 100;
  const delta = after > before ? after - before : before - after;
  return Number((delta * 100n) / before);
}

const LEVEL_RANK: Record<DoorNote["level"], number> = { stop: 0, watch: 1, info: 2 };

/**
 * What is different, in the order somebody should read it.
 *
 * `codeText` maps a code to the sentence the current slip used for it, so
 * a new finding is described in the words the page is already using rather
 * than in a second vocabulary invented here.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot, codeText: (code: string) => string | null): Diff {
  const changes: Change[] = [];
  const was = new Map(before.codes.map((c) => [c.code, c.level]));
  const now = new Map(after.codes.map((c) => [c.code, c.level]));

  // Both readings have to have actually looked, or an appearing finding is
  // just a section that ran this time and not last.
  const bothLooked = before.coverage !== "thin" && after.coverage !== "thin";

  for (const [code, level] of now) {
    if (was.has(code)) continue;
    if (level === "info" && topicOf(code) === "unread") continue; // a gap is not news
    const text = codeText(code);
    changes.push({
      level: level === "stop" ? "stop" : level === "watch" ? "watch" : "info",
      kind: `new:${code}`,
      text: `New since your last check: ${text ?? code}`,
    });
  }
  for (const [code, level] of was) {
    if (now.has(code)) continue;
    if (level === "info") continue; // an info that stopped applying is not worth a line
    if (!bothLooked) continue; // it may simply not have been checked this time
    changes.push({
      level: "info",
      kind: `gone:${code}`,
      text: `Gone since your last check: something that was flagged as ${level.toUpperCase()} is no longer on the slip.`,
    });
  }

  // The verdict itself, loudest of all when it got worse.
  if (before.verdict !== after.verdict) {
    const worse = ["CLEAR", "WATCH", "STOP"].indexOf(after.verdict) > ["CLEAR", "WATCH", "STOP"].indexOf(before.verdict);
    changes.push({
      level: worse ? "stop" : "info",
      kind: "verdict",
      text: worse
        ? `This was ${before.verdict} when you last checked it. It is ${after.verdict} now.`
        : `This was ${before.verdict} when you last checked it and is ${after.verdict} now.`,
    });
  }

  // The facts. Every one of these refuses to fire when either side is
  // unknown — see rule one at the top of this file.
  const b = before.facts;
  const a = after.facts;
  if (b.owner !== null && a.owner !== null && b.owner !== a.owner) {
    changes.push({ level: "stop", kind: "owner", text: `The owner changed: it was ${b.owner}, it is ${a.owner} now.` });
  }
  if (b.canMint === false && a.canMint === true) {
    changes.push({ level: "stop", kind: "mint", text: "A mint power appeared that was not there when you last checked: more of this token can be created." });
  }
  if (b.canFreeze === false && a.canFreeze === true) {
    changes.push({ level: "stop", kind: "freeze", text: "A power to stop holders selling appeared that was not there when you last checked." });
  }
  if (b.taxBps !== null && a.taxBps !== null && a.taxBps > b.taxBps) {
    changes.push({ level: "stop", kind: "tax", text: `The tax on a trade went up: ${(b.taxBps / 100).toFixed(2)}% when you last checked, ${(a.taxBps / 100).toFixed(2)}% now.` });
  }
  if (b.taxBps !== null && a.taxBps !== null && a.taxBps < b.taxBps) {
    changes.push({ level: "info", kind: "tax-down", text: `The tax on a trade went down: ${(b.taxBps / 100).toFixed(2)}% to ${(a.taxBps / 100).toFixed(2)}%.` });
  }
  if (b.poolQuote !== null && a.poolQuote !== null) {
    const bq = BigInt(b.poolQuote);
    const aq = BigInt(a.poolQuote);
    const moved = movedBy(bq, aq);
    if (aq < bq && moved >= 25) {
      changes.push({
        level: moved >= 60 ? "stop" : "watch",
        kind: "liquidity",
        // Deliberately not "the liquidity was pulled": a pool shrinks when
        // somebody withdraws AND when the price moves, and this cannot
        // tell those apart from balances alone.
        text: `The deepest pool is ${moved}% smaller than when you last checked. That can be a withdrawal or a price move; the balances alone do not say which.`,
      });
    }
  }
  if (b.top10Bps !== null && a.top10Bps !== null && a.top10Bps - b.top10Bps >= 500) {
    changes.push({ level: "watch", kind: "concentration", text: `The top ten wallets hold more than they did: ${(b.top10Bps / 100).toFixed(1)}% then, ${(a.top10Bps / 100).toFixed(1)}% now.` });
  }

  changes.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level]);
  return {
    ageSeconds: Math.max(0, after.at - before.at),
    changes,
    confident: changes.length === 0 && bothLooked,
  };
}
