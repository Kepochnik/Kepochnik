/**
 * WHAT CAN BE WATCHED, AND WHAT A WATCH IS BLIND TO.
 *
 * "Watch for changes" shipped on the website for launchpad tokens only. That
 * is the small half of the question a real user arrives with. Somebody who
 * pastes BRETT or TOSHI on Base is looking at an ordinary ERC-20 that no
 * launchpad made, gets a verdict, and then wants the one thing a verdict
 * cannot give: to be told if the deployer heads for the exit tomorrow. The
 * section did not appear at all for that token — not refused, not explained,
 * simply absent, which reads as "nothing to watch here" rather than "the
 * website only wired this up for one kind of token".
 *
 * The core could already do it. tokenWatch.ts follows any token's own
 * Transfer log and names a transfer into a pool a sale, which is exactly the
 * event that matters. It needed the pool addresses and the wallets worth
 * reporting at any size, and a door slip already carries both. So this module
 * is the decision — which watcher fits this token, with which inputs — kept
 * in the core next to coverage.ts and for the same reason: the CLI, the site
 * and the bot all answer "can this be watched", and a rule only the website
 * knows is a rule the other two will contradict.
 *
 * Two things it refuses to leave implicit:
 *
 *   `blind`  — what the watch cannot tell apart on THIS token. No pool list
 *              means a sale reads as an ordinary move. That is not a detail
 *              to discover later from a mislabelled event.
 *   a refusal — when nothing can be followed, the reason is returned so the
 *              surface can print it. An absent section teaches a reader that
 *              there was nothing to find.
 */
import type { DoorSlip } from "./door.js";
import type { SplSlip } from "./spl.js";

/**
 * Which tape a tick reads.
 *
 *   launch  the launchpad's own events: the dev selling on the curve, the tax
 *           recipient moving, buyback flipping, the sweep, graduation. Richer,
 *           and only a registered launch has them.
 *   tape    the token's own Transfer log plus the pool addresses. Works on any
 *           ERC-20 ever deployed, and says less: a move is a move, a transfer
 *           into a pool is a sale, and no event carries a price.
 */
export type WatchMode = "launch" | "tape";

export interface WatchPlan {
  mode: WatchMode;
  /** What a tick would report, in the words a reader would use. */
  watching: string[];
  /** What this watch cannot tell apart on this token, and why. Empty when nothing is missing. */
  blind: string[];
  /**
   * Wallets reported however small the move: the deployer, the owner, a crew.
   * Used by the transfer tape, which has no other way to know which small
   * move matters.
   */
  wallets: string[];
  /**
   * Same-funded wallets whose exits are reported as ONE event.
   *
   * Kept apart from `wallets` on purpose. The launch watcher treats this list
   * as a group and says "the crew is leaving" when several of them sell in
   * one window; putting the deployer in it would file the deployer's own sale
   * under a group exit that never happened.
   */
  crew: string[];
  /** Pool addresses, so a transfer into one can be called a sale. */
  pools: string[];
  /** Total supply for the share-of-supply column; 0n when it could not be read. */
  supply: bigint;
  decimals: number;
  /** Smallest move worth a line, in basis points of supply. */
  minShareBps: number;
}

export type WatchOffer = { ok: true; plan: WatchPlan } | { ok: false; why: string };

/** Lower-cased, de-duplicated, with the empty and the zero address dropped. */
function wallets(...addresses: (string | null | undefined)[]): string[] {
  const zero = "0x0000000000000000000000000000000000000000";
  const out = new Set<string>();
  for (const a of addresses) {
    if (!a) continue;
    const key = a.toLowerCase();
    if (key === zero) continue;
    out.add(key);
  }
  return [...out];
}

/**
 * The launch watcher when there is a launch, the transfer tape otherwise.
 *
 * A Pons V1 token is deliberately on the tape side: it has a launch record
 * but none of the V2 curve events the launch watcher reads, so offering the
 * richer watcher would poll for events that can never fire and report quiet
 * for ever.
 */
export function doorWatch(slip: DoorSlip): WatchOffer {
  const crew = slip.crew?.crews.flatMap((c) => c.wallets) ?? [];

  if (slip.id.registered && slip.id.launch && !slip.id.v1) {
    return {
      ok: true,
      plan: {
        mode: "launch",
        watching: [
          "the dev selling on the curve or moving tokens out",
          "the tax recipient changing",
          "buyback switching on or off",
          "the curve being swept or graduating",
          ...(crew.length ? [`${crew.length} grouped wallets leaving together`] : []),
        ],
        blind: crew.length ? [] : ["no group of same-funded wallets was found, so there is no group exit to report"],
        wallets: wallets(slip.id.launch.deployer, ...crew),
        crew: wallets(...crew),
        pools: [],
        supply: slip.id.meta?.totalSupply ?? 0n,
        decimals: slip.id.meta?.decimals ?? 18,
        minShareBps: 25,
      },
    };
  }

  if (!slip.id.meta) {
    return { ok: false, why: "this address did not read as a token, so it has no transfer log to follow" };
  }

  const o = slip.open;
  const pools = (o?.pools ?? []).map((p) => p.address.toLowerCase());
  const owner = o?.owner && !o.owner.renounced ? o.owner.address : null;
  const watched = wallets(o?.deployer?.address, owner, ...crew);

  const blind: string[] = [];
  // `pools: null` is a refused read and `pools: []` is a finished one that
  // found nothing. Both leave the watch unable to call a sale a sale, and
  // only the first is worth retrying — so they get different sentences.
  if (o?.pools === null) blind.push("the pool list could not be read, so a sale into a pool will read as an ordinary move");
  else if (!pools.length) blind.push("no pool was found, so there is nothing for a sale to be sold into yet");
  if (!slip.id.meta.totalSupply) blind.push("total supply could not be read, so moves have no share-of-supply column and every move is reported");
  if (!watched.length) blind.push("neither a deployer nor an owner was found, so no wallet is reported below the size threshold");

  return {
    ok: true,
    plan: {
      mode: "tape",
      watching: [
        pools.length ? "tokens going into a pool, which is a sale" : "tokens moving out of a wallet",
        ...(pools.length ? ["tokens coming out of a pool, which is a purchase"] : []),
        "minting and burning",
        ...(watched.length ? [`every move by ${watched.length === 1 ? "the wallet" : `the ${watched.length} wallets`} that deployed or controls this token, however small`] : []),
      ],
      blind,
      wallets: watched,
      crew: wallets(...crew),
      pools,
      supply: slip.id.meta.totalSupply ?? 0n,
      decimals: slip.id.meta.decimals ?? 18,
      minShareBps: 25,
    },
  };
}

/**
 * Solana, refused with the reason.
 *
 * There is no cheap equivalent of an EVM log filter here. Following one
 * mint's transfers means walking signatures for every token account of that
 * mint, which the public endpoints already refuse for a single holder list —
 * the read that produced coverage.ts. Claiming a watch that would 403 on its
 * first tick is worse than saying so: the reader would take silence for calm.
 */
export function splWatch(_slip: SplSlip): WatchOffer {
  return {
    ok: false,
    why: "Solana has no log filter to follow, so watching a mint means re-reading every token account each tick — the same read the public endpoints refuse. Re-check the token instead; the page shows what changed since your last look.",
  };
}

export interface Lag {
  /** How long the gap should have been. */
  plannedMs: number;
  /** How long it actually was. */
  actualMs: number;
  /** True once the gap is more than twice what was promised. */
  late: boolean;
  /** The sentence to print, or null while the clock is keeping its promise. */
  text: string | null;
}

/**
 * Did the browser keep the promise the page made?
 *
 * The disclosure said "checks every 15 s", and a background tab does not get
 * a timer every 15 s: browsers throttle a hidden tab's intervals to a minute
 * or more, and a laptop that slept gives nothing at all until it wakes. The
 * cursor means no block is skipped, so the events still arrive — but they
 * arrive late, and a page that goes on printing "every 15 s" while the real
 * gap is four minutes is making a claim it is not keeping. So the gap is
 * measured and, when it stops matching, said out loud.
 */
export function readLag(plannedMs: number, actualMs: number): Lag {
  const late = actualMs > plannedMs * 2;
  if (!late) return { plannedMs, actualMs, late: false, text: null };
  const seconds = Math.round(actualMs / 1000);
  const gap = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  return {
    plannedMs,
    actualMs,
    late: true,
    text: `Last gap was ${gap}, not ${Math.round(plannedMs / 1000)} s — the browser slows a tab it is not showing. No block is skipped, they just arrive late.`,
  };
}
