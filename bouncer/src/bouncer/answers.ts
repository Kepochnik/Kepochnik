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
import { GraduationPhase } from "../chain/pons.js";
import { formatBps, formatMoney, formatUnits, plural, shortAddress } from "../format.js";
import type { DoorNote, DoorSlip } from "./door.js";
import { powerKinds, sellProbes, POWER_VERB } from "./openDoor.js";
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
  /**
   * The answer, in words somebody who has never read a contract can act on.
   *
   * This used to be the metric — "4 switches", "2 of 3 wallets" — which is
   * short and says nothing. Four switches to do what? Three wallets out of
   * which three? The whole point of this tool is to translate, and compressing
   * is not translating. So the sentence is the answer and the metric moved to
   * `figure`, where it supports rather than substitutes.
   */
  value: string;
  tone: Tone;
  /** The number, for the scan down the right-hand edge. Null when there is none worth showing. */
  figure: string | null;
  /** Things worth seeing as objects rather than counting: switch names, extensions. */
  chips: { text: string; tone: Tone }[];
  /**
   * The answer as a picture, when the data makes one: which share of the
   * supply sits where, which simulated wallets could sell. Segments in basis
   * points; they need not add to 10 000, and what is left is drawn as the rest.
   */
  bar: { label: string; bps: number; tone: Tone }[] | null;
  /** One more line of context, shown when the row is opened. */
  detail: string | null;
  /** The findings behind this row, worst first. What opens when it is tapped. */
  notes: DoorNote[];
}

/** An answer with nothing but words: the common case. */
function plain(topic: Topic, value: string, tone: Tone, detail: string | null, notes: DoorNote[], figure: string | null = null): Answer {
  return { topic, question: SHORT_QUESTION[topic], value, tone, figure, chips: [], bar: null, detail, notes };
}

/** "a, b and c" — a list somebody reads rather than parses. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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

/**
 * A share of the whole supply, written the way a person would say it.
 *
 * Both exit readers quote a REFERENCE POSITION of 1% of supply and then take
 * shares of that, so a quote's own `shareBps` of 1000 is ten percent of one
 * percent — a tenth of a percent of the supply. Saying "10% of the supply"
 * over that figure overstates it a hundredfold, which on the one row that is
 * about money is the worst place in the tool to be wrong.
 */
function shareOfSupply(quoteShareBps: number, positionBpsOfSupply = 100): string {
  const bps = (quoteShareBps * positionBpsOfSupply) / 10_000;
  if (bps >= 100) return `${(bps / 100).toFixed(0)}%`;
  if (bps >= 10) return `${(bps / 100).toFixed(1)}%`;
  return `${(bps / 100).toFixed(2)}%`;
}

/** Is it the token you meant? */
function idAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "id");
  const meta = slip.id.meta;
  const t = (v: string, d: string | null, f: string | null = null) => plain("id", v, toneOf(mine), d, mine, f);
  if (!meta) return { ...t("Not a token you can hold", slip.known ?? "this address does not answer the ERC-20 views"), tone: toneOf(mine, "stop") };
  if (mine.some((n) => n.code === "lookalike-impostor")) {
    // A red row reading "Ordinary token" is a row whose colour and words
    // disagree. When the lookalike read found an older token with this
    // ticker, that IS the answer to "is this the right one".
    return t("No — another token used this ticker first", "the factory decides which is real, not the name; the older one is listed inside", "lookalike");
  }
  // `v1` before `registered`: a V1 token is registered too — the door reads it
  // from the older factory — so asking `registered` first called every V1
  // launch a V2 one.
  if (slip.id.v1) return t("Yes — a real Pons V1 launch", "the older factory's own record names this token", "V1");
  if (slip.id.registered) return t(`Yes — a real ${slip.chain.launchpad ?? "launchpad"} launch`, "the factory's own record names this token, which is the whole genuineness test", "on the list");
  return t(
    `An ordinary token, not from ${slip.chain.launchpad ?? "a launchpad"}`,
    "that is what most tokens are; it means the checks below are read off its own code rather than a factory record",
    "no record",
  );
}

/**
 * Can they take it from you?
 *
 * The count of switches is the figure; the ANSWER is what those switches let
 * somebody do, in verbs. "4 switches" is a number a reader has to go and look
 * up. "The owner can print more, freeze every transfer and block wallets from
 * selling" is a thing they can act on.
 *
 * `exempt` and `sweep` stay out of the count for the same reason the receipt
 * leaves them out: they are housekeeping on most tokens and would put a "2" on
 * a contract with nothing dangerous in it.
 */
function keepAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "keep");
  const o = slip.open;
  if (o?.surfaceFrom === "implementation-unreadable") {
    return plain("keep", "Unknown — the code that runs could not be read", "unknown", "this is a proxy and the implementation it points at would not load, so its switches are unknown rather than absent", mine, "unreadable");
  }
  if (!o) {
    const r = slip.rules;
    if (!r) return plain("keep", "Not read", "unknown", "the house rules read did not run", mine);
    const c = slip.cover;
    if (c?.status === "open") {
      return plain("keep", `Yes, on a buy — the door tax is on for ${c.secondsLeft} more seconds`, "warn", `a buy right now pays up to ${formatBps(c.terms.startBps)} of its money to the creator, falling to nothing over ${c.terms.seconds} s. Selling is not taxed by it.`, mine, `${c.secondsLeft}s`);
    }
    const moved = r.creatorFeeRecipientChanges.length;
    const flips = r.buybackChanges.length;
    const did = [
      moved ? `moved where the tax goes ${moved === 1 ? "once" : `${moved} times`}` : null,
      flips ? `switched buyback ${flips === 1 ? "once" : `${flips} times`}` : null,
    ].filter((x): x is string => Boolean(x));
    return {
      ...plain(
        "keep",
        did.length ? `The creator has ${listOf(did)}` : "No — the factory sets the rules, not the creator",
        toneOf(mine),
        did.length ? "the factory records every such change, and these are all of them since launch" : `every trade pays ${formatBps(r.totalTradeBps)} and the creator cannot change it`,
        mine,
        did.length ? `${moved + flips} change${moved + flips === 1 ? "" : "s"}` : "no changes",
      ),
    };
  }
  const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
  const renounced = o.owner?.renounced === true;
  const who = o.ownerUnread
    ? "the owner() view is in the code but the chain would not answer it"
    : o.owner === null
      ? "there is no owner() function, so no single address is named"
      : renounced
        ? "ownership is renounced, so nobody can call an owner-only function"
        : `${shortAddress(o.owner.address)}${o.owner.isContract ? ", a contract," : ""} still owns it`;
  const value = !kinds.length
    ? "No — the code has no switch for it"
    : renounced
      ? `The switches are there, but ownership is renounced`
      // Two verbs and a count, not three and a clause. The row has one line
      // and a phone has 390 pixels of it; a sentence that wraps to three is
      // back to being a paragraph.
      : `Yes — whoever owns it can ${listOf(kinds.slice(0, 2).map((k) => POWER_VERB[k]))}${kinds.length > 2 ? ` +${kinds.length - 2} more` : ""}`;
  return {
    ...plain("keep", value, toneOf(mine), `${who}. Which of these is guarded, and by whom, is not readable from bytecode.`, mine, kinds.length ? `${kinds.length} switch${kinds.length === 1 ? "" : "es"}` : "none"),
    chips: kinds.map((k) => ({ text: k, tone: renounced ? ("unknown" as Tone) : ("warn" as Tone) })),
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
    const e = slip.exit;
    // Where it trades decides the answer: a closed curve with no pool yet takes
    // nothing, and a graduated token is sold into its pool at the pool's fee —
    // one fee figure, the one the exit calculator applies, not three.
    if (e?.venue === "closed" || r.phase === GraduationPhase.Swept) {
      return plain("sell", "Not right now — the curve is closed and the pool does not exist yet", toneOf(mine, "warn"), "the launch was swept; nothing trades until the factory seeds the pool", mine, "closed");
    }
    if (e?.venue === "pool") {
      const total = e.feeBps + e.creatorTaxBps;
      return plain("sell", "Yes — the Uniswap pool takes sells at any size", toneOf(mine), `a sale pays ${formatBps(total)}: ${formatBps(e.feeBps)} pool fee and ${formatBps(e.creatorTaxBps)} creator tax on the ETH side`, mine, formatBps(total));
    }
    return plain("sell", "Yes — the curve takes sells at any size", toneOf(mine), `a sale pays ${formatBps(r.totalTradeBps)}: ${formatBps(r.curveFeeBps)} protocol fee and ${formatBps(r.creatorTaxBps)} creator tax`, mine, formatBps(r.totalTradeBps));
  }
  const probes = o ? sellProbes(o) : [];
  const ran = probes.filter((p) => p.status !== "unread");
  // Unreadable code is checked first: it is not code without a transfer
  // function, it is code nobody could look at, and saying the first when the
  // truth is the second is the "could not read" shown as "none".
  if (o?.surfaceFrom === "implementation-unreadable") {
    return plain("sell", "Unknown — the code that runs could not be read", "unknown", "this is a proxy and the implementation it points at would not load, so no sale was simulated", mine, "unreadable");
  }
  if (o && !o.transferFunction) {
    return plain("sell", "No transfer function is in the code", toneOf(mine, "unknown"), "so no sale could be simulated; whatever this contract is, it is not a plain ERC-20", mine);
  }
  if (!ran.length) {
    const why = o?.probesPending ? "the simulation has not run yet" : (o?.probesSkipped ?? "no sale was simulated");
    return plain("sell", "Not checked", "unknown", why, mine);
  }
  const ok = ran.filter((p) => p.status === "ok").length;
  const reason = ran.find((p) => p.status === "reverts")?.reason;
  // Two segments, not one per wallet. One-per-wallet drew a legend of three
  // truncated addresses under a three-part bar, which is noise: the thing
  // being shown is the proportion that could sell, and nobody needs to know
  // which anonymous holder was which to read it.
  const blocked = ran.length - ok;
  const bar = (
    [
      { label: `${ok} could sell`, bps: Math.round((10_000 * ok) / ran.length), tone: "ok" as Tone },
      { label: `${blocked} refused`, bps: Math.round((10_000 * blocked) / ran.length), tone: "stop" as Tone },
    ] as { label: string; bps: number; tone: Tone }[]
  ).filter((x) => x.bps > 0);
  const figure = `${ok}/${ran.length}`;
  if (ok === ran.length) {
    return { ...plain("sell", "Yes — every wallet we tried could sell", toneOf(mine), `simulated with eth_call at this block, nothing signed. A tax on the sale, a cap on its size, or a rule flipped tomorrow would not show up here.`, mine, figure), bar };
  }
  if (ok === 0) {
    return { ...plain("sell", "No — every wallet we tried was refused", "stop", `the chain gave the reason${reason ? ` "${reason}"` : ""}. A token that takes your money and will not let it out looks exactly like this.`, mine, figure), bar };
  }
  return {
    ...plain("sell", `Not everyone — ${ran.length - ok} of the ${ran.length} wallets we tried is blocked`, toneOf(mine), `the rest go through${reason ? `; the blocked one was refused with "${reason}"` : ""}. A blacklist, or a lock on chosen wallets, looks like this.`, mine, figure),
    bar,
  };
}

/** What would you get out? The number is read off the pool, not modelled. */
function exitAnswer(slip: DoorSlip, notes: DoorNote[], quoteUsd: number | null = null): Answer {
  const mine = notesFor(notes, "exit");
  const e = slip.exit;
  // The row's number is how much of the quoted value a sale keeps — the
  // figure the sentence does not already say. It used to repeat the amount
  // the sentence had just given.
  if (e && e.quotes.length) {
    const q = e.quotes.find((x) => x.shareBps === 1_000) ?? e.quotes[0];
    const quote = slip.rules?.quote ?? slip.chain.native;
    const amount = formatMoney(q.net, quote.decimals, quote.symbol, quoteUsd);
    return plain(
      "exit",
      `Selling ${shareOfSupply(q.shareBps)} of the supply pays ${amount}`,
      toneOf(mine),
      `sold on the ${e.venue} after fees at this block, that is ${(q.realisedBps / 100).toFixed(1)}% of what the quoted price says it is worth; the gap is what your own sale does to the price. Sized as ${(q.shareBps / 100).toFixed(0)}% of a reference position of 1% of the supply.`,
      mine,
      `${(q.realisedBps / 100).toFixed(1)}% kept`,
    );
  }
  const m = slip.open?.market;
  if (m?.best && m.quotes.length) {
    const q = m.quotes[0];
    const quote = slip.chain.native;
    const amount = formatMoney(q.out, quote.decimals, quote.symbol, quoteUsd);
    return plain(
      "exit",
      `Selling ${shareOfSupply(q.shareBps)} of the supply pays ${amount}`,
      toneOf(mine),
      `priced against the ${m.best.dex} pool's own reserves at this block, that is ${(q.realisedBps / 100).toFixed(1)}% of the quoted price. The token's own transfer tax, if it has one, is not included. Sized as ${(q.shareBps / 100).toFixed(0)}% of a reference position of 1% of the supply.`,
      mine,
      `${(q.realisedBps / 100).toFixed(1)}% kept`,
    );
  }
  if (slip.open?.pools === null) {
    return plain("exit", "Not checked — the pool read did not finish", "unknown", "so nothing can be said about getting out; this is worth one retry", mine);
  }
  if (slip.open && (slip.open.pools ?? []).length === 0) {
    return plain("exit", "Nowhere to sell it that this can see", toneOf(mine), "no pool on this chain's known DEX factories. It may trade on a venue this does not read, against another pair, or not at all.", mine, "no pool");
  }
  return plain("exit", "A pool exists but nothing in it could be priced", "unknown", "the reserves did not come back, so a sale cannot be quoted", mine);
}

/**
 * Who else is inside?
 *
 * The share of the supply that is somebody else's is the one number here, and
 * it reads better as a picture than as a percentage: a bar showing what the
 * ten largest wallets hold next to what sits in pools, what is burned, and
 * what is left for everybody else.
 */
function roomAnswer(slip: DoorSlip, notes: DoorNote[]): Answer {
  const mine = notesFor(notes, "room");
  const h = slip.open?.holders;
  const top = h?.top10WalletsBps ?? null;
  if (top !== null) {
    const dev = slip.open?.deployer?.bps ?? null;
    const contracts = h?.contractsBps ?? 0;
    const burned = h?.burnedBps ?? 0;
    const rest = Math.max(0, 10_000 - top - contracts - burned);
    const value =
      dev !== null && dev >= 1_000
        ? `The deployer alone holds ${(dev / 100).toFixed(0)}% of everything`
        : `The ten largest wallets hold ${(top / 100).toFixed(0)}% between them`;
    return {
      ...plain(
        "room",
        value,
        toneOf(mine),
        `${h?.count ? `${h.count} holders in all. ` : ""}Contracts — pools, lockers, the token itself — hold ${(contracts / 100).toFixed(0)}%, and ${(burned / 100).toFixed(0)}% is burned. Shares are computed over the page the explorer returned.`,
        mine,
        `${(top / 100).toFixed(0)}%`,
      ),
      bar: (
        [
          { label: "top 10 wallets", bps: top, tone: (top >= 5_000 ? "stop" : top >= 3_000 ? "warn" : "ok") as Tone },
          { label: "in contracts", bps: contracts, tone: "unknown" as Tone },
          { label: "burned", bps: burned, tone: "ok" as Tone },
          { label: "everybody else", bps: rest, tone: "ok" as Tone },
        ] as { label: string; bps: number; tone: Tone }[]
      ).filter((x) => x.bps > 0),
    };
  }
  const room = slip.room;
  if (room && room.buys > 0) {
    return plain(
      "room",
      room.devShareBps >= 2_000 ? `The creator's own wallets funded ${(room.devShareBps / 100).toFixed(0)}% of every buy` : `${plural(room.buyers, "wallet has", "wallets have")} bought since launch`,
      toneOf(mine),
      `${plural(room.buys, "buy")} and ${plural(room.sells, "sell")} on the curve so far`,
      mine,
      plural(room.buyers, "buyer"),
    );
  }
  return plain("room", "Not read — the holder list did not answer", "unknown", "who holds the supply is one of the two questions that decide whether you can get out, and it is open", mine);
}

/** The five rows for an EVM token. */
/** The five answers. `quoteUsd` (dollars per quote coin, read by the caller) only changes how money is written. */
export function doorAnswers(slip: DoorSlip, options: { quoteUsd?: number | null } = {}): Answer[] {
  return [idAnswer(slip, slip.notes), keepAnswer(slip, slip.notes), sellAnswer(slip, slip.notes), exitAnswer(slip, slip.notes, options.quoteUsd ?? null), roomAnswer(slip, slip.notes)];
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
  const id: Answer = plain(
    "id",
    m
      ? slip.metadata
        ? `${slip.metadata.name} — ${slip.metadata.isMutable ? "and the name can still be changed" : "and the name is frozen"}`
        : "A mint with no metadata account"
      : "Not a mint you can hold",
    m ? toneOf(idNotes) : toneOf(idNotes, "stop"),
    m
      ? m.token2022
        ? "a Token-2022 mint, which is the program where fees, hooks and permanent delegates live"
        : "a classic SPL mint, which has no extensions and therefore no hidden transfer rules"
      : (slip.whatItIs ?? "this address is not an SPL mint"),
    idNotes,
    m ? (m.token2022 ? "Token-2022" : "SPL") : null,
  );

  const keepNotes = notesFor(notes, "keep");
  const keys = m
    ? [
        m.mintAuthority ? { text: "mint", what: "print more" } : null,
        m.freezeAuthority ? { text: "freeze", what: "freeze what you hold" } : null,
        ext("permanent-delegate") ? { text: "delegate", what: "move your tokens without asking" } : null,
      ].filter((x): x is { text: string; what: string } => Boolean(x))
    : [];
  const keep: Answer = {
    ...plain(
      "keep",
      !m ? "Not read" : keys.length ? `Yes — someone can still ${listOf(keys.map((k) => k.what))}` : "No — nobody can print more or freeze you",
      !m ? "unknown" : toneOf(keepNotes),
      !m
        ? "there is no mint account to read"
        : keys.length
          ? "these are fields on the mint account itself, which makes them the most certain answers on this chain"
          : "the mint and freeze authorities are both unset, and neither can be set again",
      keepNotes,
      !m ? null : keys.length ? `${keys.length} key${keys.length === 1 ? "" : "s"}` : "none",
    ),
    chips: keys.map((k) => ({ text: k.text, tone: "warn" as Tone })),
  };

  const sellNotes = notesFor(notes, "sell");
  const fee = ext("transfer-fee");
  const sell: Answer = plain(
    "sell",
    !m
      ? "Not read"
      : ext("non-transferable")
        ? "No — the token program refuses every transfer"
        : fee?.kind === "transfer-fee"
          ? `Yes, but every transfer is taxed ${(fee.feeBps / 100).toFixed(2)}%`
          : m.freezeAuthority
            ? "Yes — unless your account gets frozen first"
            : "Yes — the token program puts no rule in the way",
    !m ? "unknown" : toneOf(sellNotes),
    !m
      ? "there is no mint account to read"
      : "on Solana this is enforced by the token program itself rather than by the token's own code, so it is read rather than simulated",
    sellNotes,
    !m ? null : fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : ext("non-transferable") ? "blocked" : "free",
  );

  const exitNotes = notesFor(notes, "exit");
  const market = slip.market;
  const pool = market?.pools.filter((p) => p.quoteReserve > 0n).sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : -1))[0];
  // `market: null` is a read that never ran, `market.unread` is one that was
  // refused, and an empty `pools` is one that finished and found nothing. Only
  // the third is "no pool" — painting the first two green would be the same
  // mistake, in miniature, that this module exists to stop.
  const exitUnread = !market ? "the venue read did not run" : market.unread;
  const depth = pool ? `${formatUnits(pool.quoteReserve, pool.quoteDecimals, 2)} ${pool.quoteSymbol}` : null;
  const exit: Answer = plain(
    "exit",
    exitUnread ? "Not checked" : depth ? `The deepest pool holds ${depth}` : "Nowhere to sell it that this can see",
    exitUnread ? "unknown" : toneOf(exitNotes),
    exitUnread
      ? `${exitUnread} — an empty answer from a refused search proves nothing`
      : depth
        ? `${market?.pools.length} venue${market?.pools.length === 1 ? "" : "s"} found in all; what you would actually get for your own size is in the calculator inside`
        : "no venue answered. It may trade somewhere this does not read.",
    exitNotes,
    depth,
  );

  const roomNotes = notesFor(notes, "room");
  const top = slip.holders?.top10Bps ?? null;
  const room: Answer = {
    ...plain(
      "room",
      top === null ? "Not read — the node refused the holder list" : `The ten largest accounts hold ${(top / 100).toFixed(0)}% between them`,
      top === null ? "unknown" : toneOf(roomNotes),
      top === null
        ? "free Solana endpoints limit this read to paying keys. An empty answer from a refused search proves nothing."
        : `behind them are ${slip.holders?.distinctOwners ?? "an unknown number of"} distinct wallets — one owner can hold many accounts, so accounts overstate how spread out a token is`,
      roomNotes,
      top === null ? null : `${(top / 100).toFixed(0)}%`,
    ),
    bar:
      top === null
        ? null
        : [
            { label: "top 10 accounts", bps: top, tone: (top >= 5_000 ? "stop" : top >= 3_000 ? "warn" : "ok") as Tone },
            { label: "everybody else", bps: Math.max(0, 10_000 - top), tone: "ok" as Tone },
          ],
  };

  return [id, keep, sell, exit, room];
}
