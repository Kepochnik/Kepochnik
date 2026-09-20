/**
 * What question does this note answer?
 *
 * A slip used to be a flat list of things to know, ordered by how loud each
 * one was. That is the right order for one note and the wrong shape for
 * twenty: a reader does not want "everything at level STOP", they want the
 * answer to a question they already have, and they have the questions in a
 * fixed order. Is this even the token I meant? Can they take it away from me?
 * Can I sell it at all? What would I actually get? Who else is in here?
 *
 * The mapping lives in the core rather than in the site, because the CLI, the
 * site, the extension and the MCP server all render the same notes, and a
 * grouping that only one of them knows about is a grouping that drifts.
 *
 * `unread` is deliberately last and deliberately its own group. It is the
 * part of the slip this project exists for: what BOUNCER could not read is
 * never folded in among findings, because a gap is not a clean bill.
 */
export type Topic = "id" | "keep" | "sell" | "exit" | "room" | "unread";

export const TOPIC_ORDER: Topic[] = ["id", "keep", "sell", "exit", "room", "unread"];

/** The question each group answers, in the words a reader would use. */
export const TOPIC_QUESTION: Record<Topic, string> = {
  id: "Is this the token you meant?",
  keep: "Can they take it from you?",
  sell: "Can you sell it right now?",
  exit: "What would you actually get out?",
  room: "Who is already inside?",
  unread: "What BOUNCER could not read",
};

/** One line under the heading, for a reader who has never done this before. */
export const TOPIC_BLURB: Record<Topic, string> = {
  id: "Whether the address is the contract behind the ticker, or something wearing its name.",
  keep: "Powers in the code and hands on the liquidity: who can still change the rules or walk off with the pool.",
  sell: "Whether a transfer goes through at all today, and what it costs when it does.",
  exit: "Where it trades and what a sale of your size would really pay, at this block.",
  room: "Who holds the supply, who launched it, and whether the early buyers knew each other.",
  unread: "Reads that did not answer. A gap here is not a clean result; it is a question still open.",
};

/**
 * Note code to question. Every code the tool can emit is listed, because a
 * code that falls through to a default lands in whichever group the default
 * names and nobody notices it is in the wrong one — a test asserts the table
 * covers them all.
 */
const TOPIC_OF: Record<string, Topic> = {
  // ---- is this the token you meant
  "claimed-factory": "id",
  "curve-input": "id",
  deployed: "id",
  "known-address": "id",
  "launch-older": "id",
  "lookalike-impostor": "id",
  "lookalike-later": "id",
  "lookalike-shared-ticker": "id",
  lookalikes: "id",
  "no-account": "id",
  "not-a-mint": "id",
  "not-erc20": "id",
  "not-a-token": "id",
  "meta-unread": "id",
  "not-registered": "id",
  spl: "id",
  "v1-launch": "id",
  graduated: "id",
  "v1-not-graduated": "id",
  "swept-no-pool": "id",

  // ---- can they take it from you
  burned: "keep",
  "buyback-vests": "keep",
  code: "keep",
  "fee-recipient-moved": "keep",
  "freeze-authority": "keep",
  "liquidity-free": "keep",
  "liquidity-held": "keep",
  "liquidity-partial": "keep",
  "liquidity-partly-free": "keep",
  "metadata-frozen": "keep",
  "metadata-mutable": "keep",
  "mint-authority": "keep",
  "mint-close": "keep",
  "no-freeze": "keep",
  "no-mint": "keep",
  "no-powers": "keep",
  "permanent-delegate": "keep",
  powers: "keep",
  "sol-liquidity-free": "keep",
  "sol-liquidity-held": "keep",
  "sol-liquidity-partly-free": "keep",
  "terms-retuned": "keep",

  // ---- can you sell it right now
  "cover-closed": "sell",
  "cover-open": "sell",
  "frozen-by-default": "sell",
  "high-tax": "sell",
  "interest-bearing": "sell",
  "non-transferable": "sell",
  pausable: "sell",
  paused: "sell",
  "trading-closed": "sell",
  "transfer-fee": "sell",
  "transfer-hook": "sell",
  "v1-caps": "sell",
  "v4-hook": "sell",
  "extension-unknown": "sell",

  // ---- what would you actually get out
  active: "exit",
  concentrated: "exit",
  "exit-closed": "exit",
  "exit-thin": "exit",
  "graduated-no-pool": "exit",
  "no-pool": "exit",
  "no-venue": "exit",
  "on-the-curve": "exit",
  pools: "exit",
  "pools-empty": "exit",
  price: "exit",
  quiet: "exit",
  "sale-price": "exit",
  "venue-unidentified": "exit",
  "venues-read": "exit",

  // ---- who is already inside
  "bundled-blocks": "room",
  "crew-clean": "room",
  "crew-creator": "room",
  "deployer-holds": "room",
  "dev-first": "room",
  "dev-funded": "room",
  "dev-graduated": "room",
  "dev-holds": "room",
  "dev-repeat": "room",
  "dev-serial": "room",
  "delegated-wallet": "room",
  "in-contracts": "room",
  "no-holders": "room",
  "one-crew": "room",
  "owner-holds": "room",
  "room-wide": "room",
  spread: "room",

  // ---- what could not be read
  "explorer-scam": "unread",
  "explorer-unread": "unread",
  // A cached reading is not a missing one, but it belongs in the same strip:
  // this is where the page says how sure it is of what it just told you.
  "explorer-age": "unread",
  "liquidity-unread": "unread",
  "no-metadata": "unread",
  "no-probe": "unread",
  "shares-unknown": "unread",
  skipped: "unread",
  "sol-liquidity-unread": "unread",
  "surface-unreadable": "unread",
  unverified: "unread",
};

/**
 * Which question a note answers. An unlisted code lands under "what could not
 * be read", which is the harmless place for it: worst case a real finding is
 * shown among the caveats, which is noticed; the reverse — a caveat shown as
 * a finding — is not.
 */
export function topicOf(code: string): Topic {
  return TOPIC_OF[code] ?? "unread";
}

/** Every code the table knows, so a test can hold it against the ones the notes emit. */
export function mappedCodes(): string[] {
  return Object.keys(TOPIC_OF);
}
