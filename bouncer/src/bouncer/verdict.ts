/**
 * THE ONE WORD, IN ONE PLACE.
 *
 * Four copies of this rule had accumulated, one per surface that needed a
 * word at the top:
 *
 *   site/src/app.ts  verdictOf(), for the slip
 *   site/src/app.ts  again, inline, for the "Why this verdict" panel
 *   card.ts          cardVerdict(), for the share image
 *   changes.ts       verdictWordOf(), for the stored snapshot
 *
 * Three of them agreed by luck. The fourth did not: the snapshot's copy
 * applied no completeness rule at all, so a reading the page headlined
 * INCOMPLETE was stored as CLEAR — and "Checked before" then printed "read
 * CLEAR 3 days ago" for a verdict the page had never given. A tool whose
 * whole argument is that a confident word must be earned cannot have its own
 * history contradict the page that produced it.
 *
 * And a fifth surface had no copy and therefore no word: the MCP server
 * handed an agent fourteen notes and a coverage object and left the
 * aggregation to it, which means an agent's answer and the website's answer
 * about the same token were free to differ. That is the failure this whole
 * pass exists to remove.
 *
 * So the rule lives here, next to coverage.ts, and every surface reads it.
 */
import { qualify, type Coverage } from "./coverage.js";
import type { DoorNote } from "./door.js";

export type VerdictKind = "stop" | "watch" | "clear" | "reading" | "incomplete";

export interface Verdict {
  word: "STOP" | "WATCH" | "CLEAR" | "READING" | "INCOMPLETE";
  kind: VerdictKind;
  /** The sentence under the word, on a surface with room for one. */
  line: string;
  /** The same thing for a share card, which has one line and no full stop. */
  short: string;
  /** How many findings made it. Zero of both is what CLEAR means. */
  stop: number;
  watch: number;
}

/** Which renders carry a verdict. The first one deliberately does not. */
export type VerdictStage = "opening" | "fast" | "done";

/**
 * The loudest note wins; nothing loud means nothing was found, which is not
 * the same as safe. Then completeness has its say.
 *
 * On the opening render there is no word yet. The page has the code and the
 * keys by then, and that is worth putting on screen a second early — but a
 * verdict read off half the evidence is a verdict that changes while you are
 * reading it, and a STOP that turns into a CLEAR teaches a reader to ignore
 * the next one.
 */
export function readVerdict(notes: DoorNote[], coverage?: Coverage | null, stage: VerdictStage = "done"): Verdict {
  if (stage === "opening") {
    return {
      word: "READING",
      kind: "reading",
      line: "What the code can do and who holds the keys is below. The rest is still being read; there is no verdict until it is in.",
      short: "still reading",
      stop: 0,
      watch: 0,
    };
  }
  const stop = notes.filter((n) => n.level === "stop").length;
  const watch = notes.filter((n) => n.level === "watch").length;
  const base: Verdict & { kind: "stop" | "watch" | "clear" } = stop
    ? {
        word: "STOP",
        kind: "stop",
        line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright.`,
        short: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright`,
        stop,
        watch,
      }
    : watch
      ? {
          word: "WATCH",
          kind: "watch",
          line: `Nothing outright dangerous, ${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy.`,
          short: `${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy`,
          stop,
          watch,
        }
      : {
          word: "CLEAR",
          kind: "clear",
          line: "Nothing in what was read stands out. That is not a promise about the price.",
          short: "nothing in what was read stands out",
          stop,
          watch,
        };

  if (!coverage) return base;
  const kind = qualify(base.kind, coverage);

  // Only CLEAR can be qualified away, and the replacement has to explain
  // itself in the same breath: a reader who meets a word they have not seen
  // before, with no reason attached, reads it as a worse STOP.
  if (kind === "incomplete") {
    return {
      ...base,
      word: "INCOMPLETE",
      kind,
      line: `Nothing stood out in what was read — but ${coverage.line.replace(/^./, (c) => c.toLowerCase())} Until that is filled in, this is not a clean result.`,
      short: "nothing stood out in what was read, and part of it was not read",
    };
  }

  // A STOP or a WATCH keeps its word and its count. What it must not keep is
  // the impression that the count is the whole list.
  if (coverage.state === "thin") {
    // Sentence case, because this lands after a full stop. It read
    // "…can cost you money outright. a simulated sale could not be read",
    // which is the kind of seam that makes a reader trust the next sentence
    // slightly less without being able to say why.
    const said = coverage.line.replace(/^./, (c) => c.toUpperCase());
    return { ...base, kind, line: `${base.line} ${said} There may be more.` };
  }
  return { ...base, kind };
}
