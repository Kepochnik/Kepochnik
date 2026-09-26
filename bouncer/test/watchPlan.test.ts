import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor, type DoorSlip } from "../src/bouncer/door.js";
import { doorWatch, readLag, splWatch } from "../src/bouncer/watchPlan.js";

const slipFor = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

/**
 * The bug this file exists for: the website offered a watch to launchpad
 * tokens and nothing else. Every memecoin anybody actually wants to check is
 * an ordinary ERC-20, so the feature was missing exactly where it was wanted.
 */
test("an ordinary ERC-20 can be watched, on its own transfer log", async () => {
  const slip = await slipFor(DEMO_PLAIN.token);
  assert.equal(slip.id.registered, false, "the fixture is meant to be a token no launchpad made");
  const offer = doorWatch(slip);
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  assert.equal(offer.plan.mode, "tape");
  assert.ok(offer.plan.pools.length, "the pool was read, so the plan should carry it");
  assert.ok(offer.plan.watching.some((w) => /into a pool, which is a sale/.test(w)), offer.plan.watching.join(" | "));
  assert.ok(offer.plan.supply > 0n, "the share-of-supply column needs the supply");
});

test("a launchpad token gets the richer tape, and the dev is not filed as a crew", async () => {
  const slip = await slipFor(DEMO.tokens.late.token);
  const offer = doorWatch(slip);
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  assert.equal(offer.plan.mode, "launch");
  assert.ok(offer.plan.watching.some((w) => /tax recipient/.test(w)));
  // The deployer belongs in `wallets` and must NOT reach `crew`: the launch
  // watcher reads `crew` as a group and would report the dev's own sale as
  // several wallets leaving together.
  const dev = slip.id.launch!.deployer.toLowerCase();
  assert.ok(offer.plan.wallets.includes(dev));
  assert.ok(!offer.plan.crew.includes(dev), "the deployer was filed as a crew member");
});

/**
 * A V1 launch has a launch record and none of the V2 curve events. Offering
 * the launch watcher there would poll for events that cannot fire and print
 * "quiet" for ever, which is the most convincing way to be wrong.
 */
test("a Pons V1 launch is watched on its transfers, not on curve events it does not have", async () => {
  const slip = await slipFor(DEMO_V1.token);
  assert.ok(slip.id.v1, "the fixture is meant to be a V1 launch");
  const offer = doorWatch(slip);
  assert.equal(offer.ok, true);
  if (!offer.ok) return;
  assert.equal(offer.plan.mode, "tape");
});

test("an address that is not a token is refused with the reason, not offered a watch", () => {
  const slip = { id: { registered: false, meta: null, launch: null }, open: null, crew: null } as unknown as DoorSlip;
  const offer = doorWatch(slip);
  assert.equal(offer.ok, false);
  if (offer.ok) return;
  assert.match(offer.why, /no transfer log/);
});

/**
 * `pools: null` is a refused read; `pools: []` is a finished one that found
 * nothing. Both leave the watch unable to call a sale a sale, and only one is
 * worth retrying, so they must not share a sentence.
 */
test("a refused pool read and an empty one give different reasons", () => {
  const base = { id: { registered: false, meta: { totalSupply: 10n ** 24n, decimals: 18 }, launch: null }, crew: null } as unknown as DoorSlip;
  const refused = doorWatch({ ...base, open: { pools: null, owner: null, deployer: { address: "0x00000000000000000000000000000000000000f1" } } } as unknown as DoorSlip);
  const empty = doorWatch({ ...base, open: { pools: [], owner: null, deployer: { address: "0x00000000000000000000000000000000000000f1" } } } as unknown as DoorSlip);
  assert.equal(refused.ok, true);
  assert.equal(empty.ok, true);
  if (!refused.ok || !empty.ok) return;
  assert.ok(refused.plan.blind.some((b) => /could not be read/.test(b)), refused.plan.blind.join(" | "));
  assert.ok(empty.plan.blind.some((b) => /no pool was found/.test(b)), empty.plan.blind.join(" | "));
  assert.notDeepEqual(refused.plan.blind, empty.plan.blind);
});

test("a renounced owner is not a wallet worth reporting at any size", () => {
  const base = { id: { registered: false, meta: { totalSupply: 10n ** 24n, decimals: 18 }, launch: null }, crew: null } as unknown as DoorSlip;
  const renounced = doorWatch({ ...base, open: { pools: [], deployer: null, owner: { address: "0x00000000000000000000000000000000000000f1", renounced: true } } } as unknown as DoorSlip);
  assert.equal(renounced.ok, true);
  if (!renounced.ok) return;
  assert.deepEqual(renounced.plan.wallets, []);
  assert.ok(renounced.plan.blind.some((b) => /neither a deployer nor an owner/.test(b)));
});

test("Solana is refused with the reason, and the reason says what to do instead", () => {
  const offer = splWatch({} as never);
  assert.equal(offer.ok, false);
  if (offer.ok) return;
  assert.match(offer.why, /no log filter/);
  assert.match(offer.why, /Re-check/);
});

/**
 * The page promises a heartbeat the browser does not have to keep. A hidden
 * tab's timers are throttled to a minute or more, and a page that goes on
 * printing "every 15 s" while the real gap is four minutes is making a claim
 * it is not keeping.
 */
test("a gap the browser did not keep is measured and said out loud", () => {
  assert.equal(readLag(15_000, 15_400).late, false);
  assert.equal(readLag(15_000, 15_400).text, null);
  assert.equal(readLag(15_000, 29_000).late, false, "twice the gap is the edge, not yet late");
  const late = readLag(15_000, 240_000);
  assert.equal(late.late, true);
  assert.match(late.text ?? "", /4 min/);
  assert.match(late.text ?? "", /No block is skipped/);
  // Under two minutes it reads in seconds, because "1 min" for 70 s is a
  // rounding the reader can check against their own clock and find wrong.
  assert.match(readLag(15_000, 70_000).text ?? "", /70 s/);
});
