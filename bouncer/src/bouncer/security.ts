/**
 * THE CHECKLIST — every safety fact the slip read, one row each.
 *
 * The page answered five questions in sentences, and a trader who wanted to
 * know "is the code fixed, who owns it, can I sell, how much does the dev
 * hold" had to open folds to find each one. Token pages people use every day
 * put those facts in one list with a mark beside each. This builds that list
 * from what the slip already read — nothing new is asked of the chain, and a
 * fact that was not read is a "?" row with its reason, never a green tick.
 */
import type { DoorSlip } from "./door.js";
import { impostorOf } from "./door.js";
import { sellProbes } from "./openDoor.js";
import { formatBps, shortAddress } from "../format.js";

export type CheckTone = "ok" | "warn" | "stop" | "unknown";

export interface CheckRow {
  /** Stable key, for tests and for the page to address a row. */
  key: string;
  label: string;
  /** The short answer: "Fixed", "Renounced", "3.0%", "Not read". */
  value: string;
  tone: CheckTone;
  /** One line of why, shown under the value. */
  hint?: string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps < 1_000 ? 1 : 0)}%`;

export function securityRows(slip: DoorSlip): CheckRow[] {
  const rows: CheckRow[] = [];
  const t = slip.id.token;
  const o = slip.open;
  const r = slip.rules;

  // Is it the token it says it is.
  const fake = impostorOf(slip);
  if (fake) {
    rows.push({ key: "genuine", label: "Genuine launch", value: "Copy", tone: "stop", hint: `a real ${slip.chain.launchpad ?? "launchpad"} launch uses this name: ${shortAddress(fake.address)}` });
  } else if (slip.id.registered) {
    rows.push({ key: "genuine", label: "Genuine launch", value: "Yes", tone: "ok", hint: `the ${slip.id.launchpad === "v1" ? "Pons V1" : (slip.chain.launchpad ?? "launchpad")} factory made it` });
  } else if (slip.chain.launchpad) {
    rows.push({ key: "genuine", label: "Genuine launch", value: "Not a launch", tone: "unknown", hint: `not made by the ${slip.chain.launchpad} factory; checked as an ordinary token` });
  }

  // The code.
  if (!t.code.empty) {
    const proxy = t.proxyImplementation || t.proxyBeacon || t.code.minimalProxyTarget;
    rows.push(
      proxy
        ? { key: "code", label: "Contract code", value: "Replaceable", tone: "warn", hint: "a proxy: whoever controls it decides what the token does tomorrow" }
        : { key: "code", label: "Contract code", value: "Fixed", tone: "ok", hint: "no proxy; the code cannot be swapped" },
    );
    rows.push(
      t.code.opcodes.selfdestruct
        ? { key: "selfdestruct", label: "Can delete itself", value: "Yes", tone: "stop", hint: "if it does, the token stops working" }
        : { key: "selfdestruct", label: "Can delete itself", value: "No", tone: "ok" },
    );
  }

  // Who holds the keys, and what they can do with them.
  if (o) {
    const unreadable = o.surfaceFrom === "implementation-unreadable";
    rows.push(
      unreadable || o.ownerUnread
        ? { key: "owner", label: "Owner", value: "Not read", tone: "unknown", hint: unreadable ? "the code that runs could not be read" : "owner() did not answer" }
        : o.owner === null
          ? { key: "owner", label: "Owner", value: "None", tone: "ok", hint: "no owner() in the code" }
          : o.owner.renounced
            ? { key: "owner", label: "Owner", value: "Renounced", tone: "ok" }
            : { key: "owner", label: "Owner", value: "Has keys", tone: "warn", hint: shortAddress(o.owner.address) },
    );
    const kinds = [...new Set(o.powers.filter((p) => p.kind !== "exempt" && p.kind !== "sweep").map((p) => p.kind))];
    rows.push(
      unreadable
        ? { key: "powers", label: "Owner powers", value: "Not read", tone: "unknown", hint: "implementation not readable" }
        : kinds.length
          ? { key: "powers", label: "Owner powers", value: `${kinds.length} found`, tone: "warn", hint: kinds.join(", ") }
          : { key: "powers", label: "Owner powers", value: "None found", tone: "ok", hint: "no mint, pause, blacklist, fee or upgrade function" },
    );
  }

  // Can you get out.
  const e = slip.exit;
  if (e) {
    rows.push(
      e.venue === "closed"
        ? { key: "sell", label: "Can sell now", value: "No", tone: "warn", hint: "swept: nothing trades until the pool exists" }
        : { key: "sell", label: "Can sell now", value: "Yes", tone: "ok", hint: e.venue === "curve" ? "the curve takes sells at any size" : "the pool takes sells" },
    );
  } else if (o) {
    const probes = sellProbes(o);
    const ok = probes.filter((p) => p.status === "ok").length;
    const bad = probes.filter((p) => p.status === "reverts").length;
    rows.push(
      !probes.length
        ? { key: "sell", label: "Can sell now", value: "Not tested", tone: "unknown", hint: o.probesSkipped ?? "no transfer was simulated" }
        : bad
          ? { key: "sell", label: "Can sell now", value: `${bad} of ${probes.length} blocked`, tone: "stop", hint: "a transfer to the pool reverted" }
          : { key: "sell", label: "Can sell now", value: "Yes", tone: ok ? "ok" : "unknown", hint: "a transfer to the pool went through" },
    );
  }

  // What it costs.
  const fee = e && e.venue === "pool" ? e.feeBps + e.creatorTaxBps : r?.totalTradeBps ?? null;
  if (fee !== null) rows.push({ key: "fee", label: "Trade fee", value: formatBps(fee), tone: fee >= 1_000n ? "warn" : "ok", hint: r ? `${formatBps(r.creatorTaxBps)} of each trade to the creator` : undefined });
  const c = slip.cover;
  if (c && c.status !== "disabled") {
    rows.push(
      c.status === "open"
        ? { key: "door", label: "Door tax", value: `On · ${c.secondsLeft}s`, tone: "stop", hint: `a buy now pays up to ${formatBps(c.terms.startBps)} extra to the creator` }
        : { key: "door", label: "Door tax", value: "Ended", tone: "ok", hint: `it ran for ${c.terms.seconds}s after launch` },
    );
  }

  // Who holds it.
  const devBps = r ? r.deployerShareBps : (o?.deployer?.bps ?? null);
  if (r || o) rows.push(devBps === null ? { key: "dev", label: "Dev holds", value: "Not read", tone: "unknown" } : { key: "dev", label: "Dev holds", value: pct(devBps), tone: devBps >= 2_000 ? "warn" : "ok", hint: "of supply" });
  if (o) {
    const top = o.holders?.top10WalletsBps ?? null;
    rows.push(top === null ? { key: "top10", label: "Top 10 wallets", value: "Not read", tone: "unknown", hint: "the explorer's holder list did not answer" } : { key: "top10", label: "Top 10 wallets", value: pct(top), tone: top >= 5_000 ? "warn" : "ok", hint: "of supply, contracts left out" });
  }
  const room = slip.room;
  if (room && room.buys > 0) {
    rows.push({ key: "devfunded", label: "Bought by the dev", value: pct(room.devShareBps), tone: room.devShareBps >= 5_000 ? "warn" : "ok", hint: "share of every buy paid by the creator's wallets" });
    const devSold = room.wallets.filter((w) => w.creatorWallet && w.sells > 0).reduce((a, w) => a + w.sells, 0);
    rows.push(devSold ? { key: "devsold", label: "Dev sold", value: `${devSold}×`, tone: "warn", hint: "the creator's wallets sold on the curve" } : { key: "devsold", label: "Dev sold", value: "No", tone: "ok" });
  }
  const crew = slip.crew;
  if (crew) {
    const top = crew.crews[0];
    rows.push(
      top
        ? { key: "bundle", label: "Bundled buyers", value: `${top.wallets.length} wallets · ${pct(top.shareBps)}`, tone: top.shareBps >= 2_000 ? "warn" : "ok", hint: `funded by ${shortAddress(top.funder)} before the launch` }
        : crew.unresolved >= crew.checked
          ? { key: "bundle", label: "Bundled buyers", value: "Not read", tone: "unknown", hint: "no first buyer's funding could be traced" }
          : { key: "bundle", label: "Bundled buyers", value: "None found", tone: "ok", hint: `${crew.checked - crew.unresolved} first buyers traced` },
    );
  }
  const d = slip.dev;
  if (d) {
    const others = Math.max(0, d.counts.launched - 1);
    rows.push({ key: "serial", label: "Dev's other launches", value: others ? `${others} in the window` : "None", tone: others >= 4 && d.counts.graduated === 0 ? "warn" : "ok", hint: others ? `${d.counts.graduated} graduated` : undefined });
  }
  return rows;
}
