/**
 * WHAT DID THIS CHECK ACTUALLY COVER?
 *
 * An outside audit pasted BONK on Solana. The holder list came back 403 and
 * the pools never loaded — and the page said, in the calm voice it uses for
 * a token it has read all the way through, that nothing stood out. Both
 * halves were true on their own. Together they were a lie: "nothing stood
 * out" is a claim about what was LOOKED AT, and two of the things that
 * decide whether you can get your money back had not been.
 *
 * The slip already knew. `skipped` carried both refusals, each with its
 * reason, and each became an INFO note in a strip at the bottom that a
 * reader opens last if at all. A gap filed as a footnote under a reassuring
 * headline is worse than no check, because the headline is what gets
 * screenshotted.
 *
 * So this module turns "what failed" into "what was covered", which is a
 * different question and the one a reader is actually asking:
 *
 *   - Every check BOUNCER means to run is listed BEFORE it runs, so a
 *     section that never started is as visible as one that failed. A list
 *     built from failures can only ever show failures.
 *   - Each check says which question it answers, so a gap can be put beside
 *     the finding it should have sat next to, not in a pile of its own.
 *   - A gap that could have changed the verdict is marked as such, and the
 *     verdict is not allowed to sound finished while one is open.
 *
 * It lives in the core, next to topics.ts and for the same reason: the CLI,
 * the site, the extension, the share card and the MCP server all state how
 * complete a reading is, and a completeness rule that only the website knows
 * is a completeness rule the other four will contradict.
 */
import type { Topic } from "./topics.js";
import type { DoorSlip } from "./door.js";
import type { SplSlip } from "./spl.js";

/**
 * Four states, and the distinction between the middle two is the whole point.
 *
 *   read         asked and answered. The finding, or the absence of one, is real.
 *   unread       asked and did not answer. A server refused, timed out, or broke.
 *   unsupported  not asked, because this chain or this endpoint cannot answer it.
 *   n/a          not asked, because the question does not apply to this token.
 *
 * `unread` is a hole in THIS reading and a reason to try again. `unsupported`
 * is a hole in the tool and retrying will not fill it — telling a reader to
 * retry something that can never work is how a tool teaches people to ignore
 * its retry button. `n/a` is not a hole at all: there is no launch record for
 * a token that was not launched on a launchpad, and printing that as a gap
 * would bury the two real ones under five that never mattered.
 */
export type CheckState = "read" | "unread" | "unsupported" | "n/a";

export interface Check {
  /** Stable id, so a retry can name what it is retrying. */
  id: string;
  /** What it is, in the words a reader would use. Never a function name. */
  label: string;
  /** Which of the five questions this check feeds. */
  topic: Topic;
  state: CheckState;
  /** Why it did not answer. Present for `unread` and `unsupported`, absent otherwise. */
  reason?: string;
  /**
   * Could the missing answer have changed the verdict?
   *
   * Not every gap is load-bearing. Not knowing the dev's history is worth
   * saying and does not make "can you sell this" any less answered. Not
   * knowing whether there is a pool makes the exit question blank, and a
   * blank exit question under the word CLEAR is the exact failure that
   * produced this file.
   */
  decisive: boolean;
}

export type Completeness = "complete" | "partial" | "thin";

export interface Coverage {
  checks: Check[];
  /** Everything `unread` or `unsupported`, in the order the checks are listed. */
  gaps: Check[];
  /** The gaps that could have moved the verdict. A non-empty list forbids a clean-sounding headline. */
  decisiveGaps: Check[];
  /** How many of the checks that COULD answer did. `n/a` is out of both halves. */
  read: number;
  asked: number;
  /**
   * complete  everything that applies was read.
   *   partial  something is missing, but nothing that decides the verdict.
   *     thin  a question the verdict rests on went unanswered.
   */
  state: Completeness;
  /** One sentence, ready to print beside the verdict. */
  line: string;
  /** True when at least one gap is worth pressing a button over. */
  retryable: boolean;
}

/** The reason a section gave, cleaned up enough to show a reader. */
function reasonOf(skipped: { section: string; reason: string }[], ...sections: string[]): string | null {
  for (const s of skipped) {
    if (sections.some((name) => s.section.toLowerCase() === name.toLowerCase())) return s.reason;
  }
  return null;
}

/**
 * A refusal, in one phrase, with the fact a reader needs: is this THEIR
 * problem, is it temporary, is it worth pressing again.
 *
 * The raw strings are node errors. "Non-200 response: 403" tells somebody
 * who already knows what an RPC is roughly what happened and tells everybody
 * else nothing at all, and this whole file exists because the people it is
 * for are the second group.
 */
export function plainReason(reason: string): string {
  const r = reason.toLowerCase();
  if (/\b403\b|forbidden/.test(r)) return "the public node refused the request (403) — these limit the heavier reads to paying keys";
  if (/\b429\b|rate.?limit/.test(r)) return "the public node is rate-limiting (429) — too many reads from this address just now";
  if (/timed? ?out|deadline|did not answer/.test(r)) return "the node did not answer in time";
  if (/method not found|-32601|unsupported method/.test(r)) return "this node does not offer the method the check needs";
  if (/\b5\d\d\b|internal error/.test(r)) return "the node returned a server error";
  if (/fetch failed|network|econn|socket/.test(r)) return "the request never reached the node";
  return reason;
}

/** A gap that retrying could fix. An unsupported method is not one. */
function worthRetrying(c: Check): boolean {
  return c.state === "unread";
}

function summarise(checks: Check[]): Coverage {
  const gaps = checks.filter((c) => c.state === "unread" || c.state === "unsupported");
  const decisiveGaps = gaps.filter((c) => c.decisive);
  const asked = checks.filter((c) => c.state !== "n/a").length;
  const read = checks.filter((c) => c.state === "read").length;
  const state: Completeness = decisiveGaps.length ? "thin" : gaps.length ? "partial" : "complete";
  const names = (list: Check[]) =>
    list.length === 1
      ? list[0].label
      : `${list.slice(0, -1).map((c) => c.label).join(", ")} and ${list[list.length - 1].label}`;
  const line =
    state === "complete"
      ? `All ${asked} checks answered.`
      : state === "thin"
        ? `${names(decisiveGaps)} could not be read, so this reading cannot tell you ${decisiveGaps.some((c) => c.topic === "sell" || c.topic === "exit") ? "whether you could get back out" : "the whole story"}.`
        : `${read} of ${asked} checks answered; ${names(gaps)} did not.`;
  return { checks, gaps, decisiveGaps, read, asked, state, line, retryable: gaps.some(worthRetrying) };
}

/**
 * What a Solana reading covered.
 *
 * The decisive three are the authorities, the holders and the market, and
 * they are decisive for different reasons. The authorities say whether the
 * mint can print more or freeze your account, which is the one thing on this
 * chain that takes everything at once. The market says whether there is
 * anywhere to sell. The holders say whether the float is real or whether
 * four accounts are the whole supply — the audit's own case, where losing it
 * silently left "nothing stands out" standing over an unread book.
 */
export function splCoverage(slip: SplSlip): Coverage {
  const s = slip.skipped;
  const mint = slip.mint;
  const checks: Check[] = [];
  checks.push({ id: "mint", label: "the mint account", topic: "id", state: mint ? "read" : "unread", reason: mint ? undefined : "the address is not an SPL mint", decisive: true });
  if (!mint) return summarise(checks);
  const metaReason = reasonOf(s, "metadata");
  checks.push({
    id: "metadata",
    label: "the name and symbol",
    topic: "id",
    state: slip.metadata ? "read" : metaReason ? "unread" : "n/a",
    reason: metaReason ? plainReason(metaReason) : slip.metadata ? undefined : "this mint publishes no on-chain metadata",
    // A token with no name is odd and worth a note; it does not make the
    // authorities or the pool any less known.
    decisive: false,
  });
  // Authorities come off the mint account itself. If that parsed, they are known.
  checks.push({ id: "authorities", label: "the mint and freeze authorities", topic: "keep", state: "read", decisive: true });
  checks.push({ id: "extensions", label: "the Token-2022 extensions", topic: "sell", state: "read", decisive: true });
  const holdReason = reasonOf(s, "holders");
  checks.push({
    id: "holders",
    label: "who holds it",
    topic: "room",
    state: slip.holders ? "read" : holdReason ? "unread" : "n/a",
    reason: holdReason ? plainReason(holdReason) : undefined,
    decisive: true,
  });
  const ownerReason = reasonOf(s, "holder owners");
  if (ownerReason) {
    checks.push({ id: "holder-owners", label: "the wallets behind the top accounts", topic: "room", state: "unread", reason: plainReason(ownerReason), decisive: false });
  }
  // Two ways this one goes missing, and the second is the one that fooled
  // the audit. The section can throw, which lands in `skipped` like any
  // other. Or it can RETURN, with an empty pool list, because every read
  // it needed was refused — and an empty pool list renders as "no venue",
  // which is an answer, and a calm one. `market.unread` is the market read
  // saying which of the two happened, in a field rather than in prose.
  const marketReason = reasonOf(s, "market", "pools") ?? slip.market?.unread ?? null;
  checks.push({
    id: "market",
    label: "where it trades",
    topic: "exit",
    state: slip.market && !slip.market.unread ? "read" : marketReason ? "unread" : "n/a",
    reason: marketReason ? plainReason(marketReason) : undefined,
    decisive: true,
  });
  // Solana has no sale simulation in BOUNCER, and saying so is not optional:
  // a reader comparing this slip to an EVM one would otherwise assume the
  // sale went through here too.
  checks.push({
    id: "sale-probe",
    label: "a simulated sale",
    topic: "sell",
    state: "unsupported",
    reason: "BOUNCER does not simulate Solana transactions; the extension flags below are what it can say about transfers",
    decisive: false,
  });
  return summarise(checks);
}

/** What an EVM reading covered. */
export function doorCoverage(slip: DoorSlip): Coverage {
  const s = slip.skipped;
  const checks: Check[] = [];
  const isToken = !slip.id.token.code.empty;
  checks.push({ id: "code", label: "the contract code", topic: "id", state: "read", decisive: true });
  if (!isToken) return summarise(checks);
  const launchReason = reasonOf(s, "launch record");
  checks.push({
    id: "launch",
    label: "the launch record",
    topic: "id",
    // No launchpad on this chain is not a failed read, it is a question
    // that does not apply — and it is the one that used to print on every
    // ordinary token as though something had gone wrong.
    state: slip.id.launch ? "read" : launchReason ? (/not published|no launchpad/i.test(launchReason) ? "n/a" : "unread") : "n/a",
    reason: launchReason && !/not published|no launchpad/i.test(launchReason) ? plainReason(launchReason) : undefined,
    decisive: false,
  });
  const rulesReason = reasonOf(s, "house rules", "open door");
  const knowsPowers = Boolean(slip.rules || slip.open);
  checks.push({
    id: "powers",
    label: "what the contract can do",
    topic: "keep",
    // There is no "n/a" here: every token has powers or the absence of
    // them, so not knowing is always a hole. A read that produced neither
    // a rules block nor an open-door block and left no reason behind is
    // still a hole, and it says so rather than defaulting to read.
    state: knowsPowers ? "read" : "unread",
    reason: knowsPowers ? undefined : plainReason(rulesReason ?? "the powers read did not run"),
    decisive: true,
  });
  const probes = slip.open?.probes ?? null;
  checks.push({
    id: "sale-probe",
    label: "a simulated sale",
    topic: "sell",
    state: probes && probes.length ? "read" : slip.open?.probesSkipped ? "unread" : "n/a",
    reason: slip.open?.probesSkipped ? plainReason(String(slip.open.probesSkipped)) : undefined,
    decisive: true,
  });
  const exitReason = reasonOf(s, "exit door");
  checks.push({
    id: "market",
    label: "where it trades",
    topic: "exit",
    state: slip.exit ? "read" : exitReason ? "unread" : "n/a",
    reason: exitReason ? plainReason(exitReason) : undefined,
    decisive: true,
  });
  const roomReason = reasonOf(s, "the room");
  checks.push({
    id: "holders",
    label: "who holds it",
    topic: "room",
    state: slip.room ? "read" : roomReason ? "unread" : "n/a",
    reason: roomReason ? plainReason(roomReason) : undefined,
    decisive: true,
  });
  const devReason = reasonOf(s, "dev report card");
  checks.push({
    id: "dev",
    label: "the deployer's history",
    topic: "room",
    state: slip.dev ? "read" : devReason ? "unread" : "n/a",
    reason: devReason ? plainReason(devReason) : undefined,
    decisive: false,
  });
  const lookReason = reasonOf(s, "lookalikes");
  checks.push({
    id: "lookalikes",
    label: "tokens sharing the ticker",
    topic: "id",
    state: slip.lookalikes ? "read" : lookReason ? "unread" : "n/a",
    reason: lookReason ? plainReason(lookReason) : undefined,
    decisive: false,
  });
  return summarise(checks);
}

/**
 * The word at the top, once completeness has had its say.
 *
 * The rule is narrow on purpose. A STOP stands: a danger that WAS found is
 * still found, and a missing pool read does not make a freeze authority go
 * away. A WATCH stands too, for the same reason — it already tells a reader
 * to look closer.
 *
 * CLEAR is the only one that is a claim about coverage rather than about
 * findings. "Nothing stands out" means "I looked and saw nothing", and with a
 * decisive check unread the first half is false. So CLEAR becomes INCOMPLETE:
 * not an accusation against the token, a statement about the reading.
 */
export function qualify(kind: "stop" | "watch" | "clear" | "reading", coverage: Coverage): "stop" | "watch" | "clear" | "reading" | "incomplete" {
  if (kind === "clear" && coverage.state === "thin") return "incomplete";
  return kind;
}
