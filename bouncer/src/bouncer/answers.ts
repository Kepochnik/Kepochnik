/**
 * FIVE QUESTIONS, FIVE SHORT ANSWERS.
 *
 * The page used to say everything twice. A wall of thirteen findings in
 * prose at the top, then eight accordions named by question underneath —
 * and the findings already carried the topic as a tag, so the reader was
 * being handed both halves of a join and left to do it themselves. Nothing
 * on the page answered the question a buyer actually arrives with, which is
 * not "what are the thirteen findings" but "can they take it, can I sell,
 * what would I get".
 *
 * So the top of the page is now five rows, one per question, each carrying
 * an answer short enough to read at a glance. Tap a row and the evidence for
 * that question opens under it: the findings, the numbers, the reads. The
 * long sentence that used to be the headline becomes the detail, which is
 * where it was always useful.
 *
 * The answers live here, in the core, for the same reason topics.ts and
 * coverage.ts do: the site, the share card, the terminal and the MCP server
 * all state them, and a summary only the website knows how to compute is a
 * summary the other three will contradict.
 *
 * Rules this file holds to:
 *
 *   - Every value is read, never estimated. "2 of 3 wallets" is a count of
 *     simulations that ran; it is not a score.
 *   - A read that did not answer produces `unknown`, never a cheerful
 *     default. "No switches found" and "the code could not be read" are
 *     opposite answers and must never share a row.
 *   - The tone is the loudest note on that question, so the colour a reader
 *     scans agrees with the findings they open.
 */
import { formatBps, formatUnits, shortAddress } from "../format.js";
import type { DoorNote, DoorSlip } from "./door.js";
import { powerKinds, sellProbes, type OpenDoor } from "./openDoor.js";
import type { SplSlip } from "./spl.js";
import { TOPIC_ORDER, topicOf, type Topic } from "./topics.js";

/**
 * How a row reads at a glance.
 *
 *   ok       answered, and the answer is the harmless one
 *   warn     answered, and it is worth reading before buying
 *   stop     answered, and it can cost you money outright
 *   unknown  not answered. Never the same as ok.
 */
export type Tone = "ok" | "warn" | "stop" | "unknown";

export interface Answer {
  topic: Topic;
  /** The question, in the words a reader would use. Short enough for a row. */
  question: string;
  /** The answer, short enough to read at a glance. Two or three words. */
  value: string;
  tone: Tone;
  /** One more line of context, or null when the value says it all. */
  detail: string | null;
  /** The findings behind this row, worst first. What opens when it is tapped. */
  notes: DoorNote[];
}

/** The five, in the order a reader asks them. `unread` is not one of them. */
export const ANSWER_TOPICS: Topic[] = TOPIC_ORDER.filter((t) => t !== "unread");

/** Short forms, for a row rather than a heading. */
export const SHORT_QUESTION: Record<Topic, string> = {
  id: "Is this the right token?",
  keep: "Can they take it from you?",
  sell: "Can you sell it right now?",
  exit: "What would you get out?",
  room: "Who else is inside?",
  unread: "What could not be read",
};

const RANK: Record<DoorNote["level"], number> = { stop: 0, watch: 1, info: 2 };

/** The findings for one question, worst first. */
function notesFor(notes: DoorNote[], topic: Topic): DoorNote[] {
  return notes.filter((n) => topicOf(n.code) === topic).sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** The loudest level among them, as a tone. Nothing loud is not the same as nothing read. */
function toneOf(notes: DoorNote[], fallback: Tone = "ok"): Tone {
  if (notes.some((n) => n.level === "stop")) return "stop";
  if (notes.some((n) => n.level === "watch")) return "warn";
  return fallback;
}

/** Is it the token you meant? */
function idAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "id");
  const meta = slip.id.meta;
  let value: string;
  let detail: string | null;
  if (!meta) {
    value = "Not a token";
    detail = slip.known ?? "this address does not answer the ERC-20 views";
  } else if (slip.id.v1) {
    // Before `registered`, not after it. A V1 token is registered too — the
    // door reads it from the older factory — so asking `registered` first
    // announced every V1 launch as a V2 one.
    value = "Real Pons V1 launch";
    detail = "the older factory's record names this token";
  } else if (slip.id.registered) {
    value = `Real ${slip.chain.launchpad ?? "launchpad"} launch`;
    detail = "the factory's own record names this token";
  } else if (mine.some((n) => n.code === "lookalike-impostor")) {
    // A red row reading "Ordinary token" is a row whose colour and words
    // disagree. When the lookalike read found an older token with this
    // ticker, that IS the answer to "is this the right one".
    value = "Wrong one";
    detail = "another token with this ticker launched first";
  } else {
    value = "Ordinary token";
    detail = slip.chain.launchpad ? `no ${slip.chain.launchpad} record; checked as any ERC-20` : "checked as any ERC-20";
  }
  return { topic: "id", question: SHORT_QUESTION.id, value, tone: toneOf(mine), detail, notes: mine };
}

/**
 * Can they take it from you?
 *
 * The count is of switches the code carries, not of switches somebody can
 * pull: who may call a function is not readable from bytecode, and this row
 * must not imply otherwise. `exempt` and `sweep` are left out of the count
 * for the same reason the receipt leaves them out — they are housekeeping on
 * most tokens and would put a "2" on a contract with nothing dangerous in it.
 */
function keepAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "keep");
  const o = slip.open;
  if (o?.surfaceFrom === "implementation-unreadable") {
    return { topic: "keep", question: SHORT_QUESTION.keep, value: "Unreadable", tone: "unknown", detail: "this is a proxy and the code it points at would not load", notes: mine };
  }
  if (!o) {
    // A launchpad token has no bytecode surface to read: the same contract is
    // deployed for every launch, and what the creator can still change is
    // named by the factory's own events. Those are the switches here.
    const r = slip.rules;
    if (!r) return { topic: "keep", question: SHORT_QUESTION.keep, value: "Not read", tone: "unknown", detail: "the house rules read did not run", notes: mine };
    const moved = r.creatorFeeRecipientChanges.length;
    const flips = r.buybackChanges.length;
    // Only what actually changed gets a sentence. The first version printed
    // "1 change" over a detail reading "moved the tax recipient 0 times",
    // which is a row arguing with itself.
    const did = [
      moved ? `moved the tax recipient ${moved === 1 ? "once" : `${moved} times`}` : null,
      flips ? `flipped buyback ${flips === 1 ? "once" : `${flips} times`}` : null,
    ].filter((x): x is string => Boolean(x));
    const changed = moved + flips;
    return {
      topic: "keep",
      question: SHORT_QUESTION.keep,
      value: changed ? `${changed} change${changed === 1 ? "" : "s"} since launch` : "Factory rules",
      tone: toneOf(mine),
      detail: did.length
        ? `the creator has ${did.join(" and ")}`
        : `every trade pays ${formatBps(r.totalTradeBps)}, set by the factory, and the creator has changed nothing since launch`,
      notes: mine,
    };
  }
  const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
  const who = o.ownerUnread
    ? "owner() did not answer"
    : o.owner === null
      ? "no owner function in the code"
      : o.owner.renounced
        ? "ownership is renounced"
        : `owner ${shortAddress(o.owner.address)}${o.owner.isContract ? " (a contract)" : ""} has not renounced`;
  return {
    topic: "keep",
    question: SHORT_QUESTION.keep,
    value: kinds.length ? `${kinds.length} switch${kinds.length === 1 ? "" : "es"}` : "No switches",
    tone: toneOf(mine),
    detail: kinds.length ? `${kinds.join(", ")} · ${who}` : `no mint, pause, blacklist, fee or trading switch is in the code · ${who}`,
    notes: mine,
  };
}

/** Can you sell it right now? Counted from simulations that actually ran. */
function sellAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "sell");
  const o = slip.open;
  if (!o && slip.rules) {
    // No bytecode probe is run on a launchpad token and none is needed: the
    // curve takes sells by construction, and what a seller actually needs to
    // know is what it costs and whether the door tax is still on.
    const r = slip.rules;
    const c = slip.cover;
    if (c?.status === "open") {
      return { topic: "sell", question: SHORT_QUESTION.sell, value: `Wait ${c.secondsLeft}s`, tone: "warn", detail: `the door tax is still on: a buy right now pays up to ${formatBps(c.terms.startBps)} to the creator`, notes: mine };
    }
    return {
      topic: "sell",
      question: SHORT_QUESTION.sell,
      value: `Yes, ${formatBps(r.totalTradeBps)} fee`,
      tone: toneOf(mine),
      detail: r.phase === 0 ? "on the curve, which takes sells at any size" : "in the graduated pool",
      notes: mine,
    };
  }
  const probes = o ? sellProbes(o) : [];
  const ran = probes.filter((p) => p.status !== "unread");
  if (o && !o.transferFunction) {
    // Tone from the notes, not asserted here. On a V1 launch the core files
    // this as an INFO — the factory record already establishes what the token
    // is — and a row shouting STOP over a calm finding is a row whose colour
    // argues with the evidence it opens.
    return { topic: "sell", question: SHORT_QUESTION.sell, value: "No transfer function", tone: toneOf(mine, "unknown"), detail: "no transfer(address,uint256) is in the code, so no sale could be simulated", notes: mine };
  }
  if (!ran.length) {
    const why = o?.probesPending ? "the simulation has not run yet" : (o?.probesSkipped ?? "no sale was simulated");
    return { topic: "sell", question: SHORT_QUESTION.sell, value: "Not checked", tone: "unknown", detail: why, notes: mine };
  }
  const ok = ran.filter((p) => p.status === "ok").length;
  const reason = ran.find((p) => p.status === "reverts")?.reason;
  if (ok === ran.length) {
    return { topic: "sell", question: SHORT_QUESTION.sell, value: "Yes", tone: toneOf(mine), detail: `a sale into the pool goes through for all ${ran.length} wallet${ran.length === 1 ? "" : "s"} tried, simulated at this block`, notes: mine };
  }
  if (ok === 0) {
    return { topic: "sell", question: SHORT_QUESTION.sell, value: "No", tone: "stop", detail: `every wallet tried is refused${reason ? ` ("${reason}")` : ""}`, notes: mine };
  }
  return {
    topic: "sell",
    question: SHORT_QUESTION.sell,
    value: `${ok} of ${ran.length} wallets`,
    tone: toneOf(mine, "warn"),
    detail: `the rest are refused${reason ? ` ("${reason}")` : ""} — a blacklist looks like this`,
    notes: mine,
  };
}

/** What would you get out? The number is read off the pool, not modelled. */
function exitAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "exit");
  const e = slip.exit;
  if (e && e.quotes.length) {
    const q = e.quotes.find((x) => x.shareBps === 1_000) ?? e.quotes[0];
    const quote = slip.rules?.quote ?? slip.chain.native;
    return {
      topic: "exit",
      question: SHORT_QUESTION.exit,
      value: `${formatUnits(q.net, quote.decimals, 4)} ${quote.symbol}`,
      tone: toneOf(mine),
      detail: `for ${(q.shareBps / 100).toFixed(0)}% of the position, on ${e.venue} · ${(q.realisedBps / 100).toFixed(1)}% of spot`,
      notes: mine,
    };
  }
  const m = slip.open?.market;
  if (m?.best && m.quotes.length) {
    // The pools are paired against the chain's wrapped native coin, which is
    // what `readMarket` was handed as the quote symbol and what every figure
    // in `quotes` is denominated in.
    const q = m.quotes[0];
    const quote = slip.chain.native;
    return {
      topic: "exit",
      question: SHORT_QUESTION.exit,
      value: `${formatUnits(q.out, quote.decimals, 4)} ${quote.symbol}`,
      tone: toneOf(mine),
      detail: `for ${(q.shareBps / 100).toFixed(0)}% of the position on ${m.best.dex} · ${(q.realisedBps / 100).toFixed(1)}% of spot`,
      notes: mine,
    };
  }
  if (slip.open?.pools === null) {
    return { topic: "exit", question: SHORT_QUESTION.exit, value: "Not checked", tone: "unknown", detail: "the pool read did not finish, so nothing can be said about selling", notes: mine };
  }
  if (slip.open && (slip.open.pools ?? []).length === 0) {
    return { topic: "exit", question: SHORT_QUESTION.exit, value: "No pool", tone: toneOf(mine), detail: "no pool was found on this chain's DEX table; it may trade somewhere this does not read", notes: mine };
  }
  return { topic: "exit", question: SHORT_QUESTION.exit, value: "Not priced", tone: "unknown", detail: "a pool was found but nothing in it could be priced", notes: mine };
}

/** Who else is inside? The one number that decides how much of the float is somebody else's. */
function roomAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "room");
  const h = slip.open?.holders;
  const top = h?.top10WalletsBps ?? null;
  if (top !== null) {
    return {
      topic: "room",
      question: SHORT_QUESTION.room,
      value: `Top 10 hold ${(top / 100).toFixed(0)}%`,
      tone: toneOf(mine),
      detail: h?.count ? `of supply · ${h.count} holders${slip.open?.deployer?.bps ? `, the deployer holds ${(slip.open.deployer.bps / 100).toFixed(1)}%` : ""}` : "of supply, over the page the explorer returned",
      notes: mine,
    };
  }
  const room = slip.room;
  if (room && room.buys > 0) {
    return {
      topic: "room",
      question: SHORT_QUESTION.room,
      value: `${room.buyers} buyers`,
      tone: toneOf(mine),
      detail: `the creator's own wallets funded ${(room.devShareBps / 100).toFixed(0)}% of everything bought`,
      notes: mine,
    };
  }
  return { topic: "room", question: SHORT_QUESTION.room, value: "Not read", tone: "unknown", detail: "the holder list did not answer", notes: mine };
}

/** The five rows for an EVM token. */
export function doorAnswers(slip: DoorSlip): Answer[] {
  return [idAnswer(slip, slip.notes), keepAnswer(slip, slip.notes), sellAnswer(slip, slip.notes), exitAnswer(slip, slip.notes), roomAnswer(slip, slip.notes)];
}

/**
 * The same five for a Solana mint.
 *
 * Different reads, same questions. On this chain the answers to "can they
 * take it" are fields on the mint account rather than guesses about code,
 * which makes them the most certain answers BOUNCER gives anywhere — and
 * "can you sell" is mostly about what the token program itself enforces.
 */
export function splAnswers(slip: SplSlip): Answer[] {
  const notes = slip.notes;
  const m = slip.mint;
  const ext = (kind: string) => m?.extensions.find((e) => e.kind === kind) ?? null;

  const idNotes = notesFor(notes, "id");
  const id: Answer = {
    topic: "id",
    question: SHORT_QUESTION.id,
    value: m ? (m.token2022 ? "Token-2022 mint" : "SPL mint") : "Not a mint",
    tone: toneOf(idNotes),
    detail: m
      ? slip.metadata
        ? `${slip.metadata.name} (${slip.metadata.symbol})${slip.metadata.isMutable ? " · the name can still be changed" : " · the name is frozen"}`
        : "no metadata account was found"
      : (slip.whatItIs ?? "this address is not an SPL mint"),
    notes: idNotes,
  };

  const keepNotes = notesFor(notes, "keep");
  const keys = m ? [m.mintAuthority ? "mint" : null, m.freezeAuthority ? "freeze" : null, ext("permanent-delegate") ? "permanent delegate" : null].filter(Boolean) : [];
  const keep: Answer = {
    topic: "keep",
    question: SHORT_QUESTION.keep,
    value: !m ? "Not read" : keys.length ? `${keys.length} authorit${keys.length === 1 ? "y" : "ies"}` : "No authorities",
    tone: !m ? "unknown" : toneOf(keepNotes),
    detail: !m ? "there is no mint account to read" : keys.length ? `${keys.join(", ")} still set` : "nobody can print more or freeze what you hold",
    notes: keepNotes,
  };

  const sellNotes = notesFor(notes, "sell");
  const fee = ext("transfer-fee");
  const sell: Answer = {
    topic: "sell",
    question: SHORT_QUESTION.sell,
    value: !m ? "Not read" : ext("non-transferable") ? "No" : fee?.kind === "transfer-fee" ? `Yes, ${(fee.feeBps / 100).toFixed(2)}% fee` : "Yes",
    tone: !m ? "unknown" : toneOf(sellNotes),
    detail: !m
      ? "there is no mint account to read"
      : ext("non-transferable")
        ? "the token program itself refuses every transfer"
        : m.freezeAuthority
          ? "unless the freeze authority freezes your account first"
          : "the token program puts no rule in the way",
    notes: sellNotes,
  };

  const exitNotes = notesFor(notes, "exit");
  const market = slip.market;
  const pool = market?.pools.filter((p) => p.quoteReserve > 0n).sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : -1))[0];
  // `market: null` is a read that never ran, `market.unread` is one that was
  // refused, and an empty `pools` is one that finished and found nothing.
  // Only the third is "no pool found" — the first two are unknown, and
  // painting them green as "no pool" is the same mistake, in miniature, that
  // this whole module exists to stop: unreachable is not empty.
  const exitUnread = !market ? "the venue read did not run" : market.unread;
  const exit: Answer = {
    topic: "exit",
    question: SHORT_QUESTION.exit,
    value: exitUnread ? "Not checked" : pool ? `${formatUnits(pool.quoteReserve, pool.quoteDecimals, 2)} ${pool.quoteSymbol} pool` : "No pool found",
    tone: exitUnread ? "unknown" : toneOf(exitNotes),
    detail: exitUnread
      ? exitUnread
      : pool
        ? `the deepest venue found · ${market?.pools.length} in all`
        : "no venue answered; it may trade somewhere this does not read",
    notes: exitNotes,
  };

  const roomNotes = notesFor(notes, "room");
  const top = slip.holders?.top10Bps ?? null;
  const room: Answer = {
    topic: "room",
    question: SHORT_QUESTION.room,
    value: top === null ? "Not read" : `Top 10 hold ${(top / 100).toFixed(0)}%`,
    tone: top === null ? "unknown" : toneOf(roomNotes),
    detail: top === null ? "the node refused the largest-accounts read" : `of supply · ${slip.holders?.distinctOwners ?? "an unknown number of"} distinct wallets behind the largest accounts`,
    notes: roomNotes,
  };

  return [id, keep, sell, exit, room];
}
