import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { pushedSelectors } from "../src/chain/code.js";
import { selector } from "../src/chain/abi.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_CODE, DEMO_IMPOSTOR, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { doorReceipt, readDoor } from "../src/bouncer/door.js";
import { controlLine, powerKinds } from "../src/bouncer/openDoor.js";
import { renderReceipt } from "../src/receipt.js";

const blockscout = () => new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });
const opts = () => ({ chain: CHAINS.robinhood, factory: PONS_V2_FACTORY, blockscout: blockscout(), chunkSize: 100_000, launchSearchBlocks: 400_000, skipDev: true });

test("pushedSelectors reads the dispatcher and ignores PUSH immediates wider than 4 bytes", () => {
  const found = pushedSelectors(DEMO_CODE.plain);
  for (const sig of DEMO_PLAIN.powers) assert.ok(found.has(selector(sig)), sig);
  assert.ok(!pushedSelectors(DEMO_CODE.ponsToken).has(selector("mint(address,uint256)")));
});

test("an ordinary token is NOT A LAUNCH and gets the open-door check", async () => {
  const slip = await readDoor(demoRpc(), DEMO_PLAIN.token, opts());
  assert.equal(slip.stamp, "NOT A LAUNCH");
  assert.equal(slip.id.meta?.symbol, "ROCKET");
  const o = slip.open!;
  assert.deepEqual(powerKinds(o), ["mint", "pause", "blacklist", "fees", "exempt"]);
  assert.equal(o.owner?.address, DEMO_PLAIN.owner);
  assert.equal(o.owner?.renounced, false);
  assert.equal(o.paused, false);
  assert.deepEqual(o.tradingOpen, { view: "tradingOpen()", open: true });
  assert.equal(o.verified, false);
  assert.equal(o.deployer?.address, DEMO_PLAIN.owner);
  assert.equal(o.deployer?.createdAtBlock, DEMO_PLAIN.createdAt);
  assert.equal(o.deployer?.bps, 2_500);
  assert.equal(o.holders?.count, 143);
  assert.equal(o.holders?.transfers, 2_210);
  assert.equal(o.holders?.top10WalletsBps, 2_500 + 800 + 500 + 300);
  assert.equal(o.holders?.contractsBps, 3_000);
  assert.equal(o.holders?.burnedBps, 200);
  // transfer simulation: the owner and two buyers are the largest plain wallets; one of them is blacklisted.
  assert.equal(o.probes.length, 3);
  const failed = o.probes.filter((p) => !p.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].from, DEMO_PLAIN.blacklisted);
  assert.equal(failed[0].reason, "Blacklisted");
  assert.equal(o.activity?.recent, 3);
  assert.equal(o.pools?.length, 1);
  assert.equal(o.pools?.[0].address, DEMO_PLAIN.pool);
  assert.equal(o.pools?.[0].feeBps, 30);
  assert.equal(o.pools?.[0].quoteReserve, 12n * 10n ** 18n);
  assert.equal(o.pools?.[0].tokenReserve, (DEMO_PLAIN.supply * 3_000n) / 10_000n);
  assert.equal(o.explorer?.isScam, false);
  assert.equal(o.activity?.lastTransferBlock, DEMO.head - 1_200);
  assert.match(controlLine(o), /^mint, pause, blacklist, fees · owner 0x/);
  const codes = slip.notes.map((n) => n.code);
  assert.ok(codes.includes("not-registered"));
  assert.ok(codes.includes("owner-powers"));
  assert.ok(codes.includes("unverified"));
  assert.ok(codes.includes("transfer-some-revert"));
  assert.ok(codes.includes("deployer-holds"));
  assert.ok(codes.includes("in-contracts"));
  assert.ok(codes.includes("active"));
  assert.ok(codes.includes("pools"));
  assert.ok(!codes.includes("lookalike-impostor"));
  assert.equal(slip.notes.filter((n) => n.level === "stop").length, 0);
  const text = renderReceipt(doorReceipt(slip), "text");
  assert.match(text, /WHO CONTROLS IT/);
  assert.match(text, /WHO HOLDS IT/);
  assert.match(text, /Blacklisted/);
});

test("without an explorer the open door still reads code, owner and switches", async () => {
  const slip = await readDoor(demoRpc(), DEMO_PLAIN.token, { ...opts(), blockscout: null });
  assert.equal(slip.stamp, "NOT A LAUNCH");
  const o = slip.open!;
  assert.equal(o.holders, null);
  assert.equal(o.deployer, null);
  assert.equal(o.probes.length, 0);
  assert.equal(o.owner?.address, DEMO_PLAIN.owner);
  assert.ok(slip.notes.some((n) => n.code === "owner-powers"));
});

test("a token wearing a real launch's ticker is NOT ON THE LIST", async () => {
  const slip = await readDoor(demoRpc(), DEMO_IMPOSTOR.token, opts());
  assert.equal(slip.stamp, "NOT ON THE LIST");
  assert.equal(slip.notes[0].code, "lookalike-impostor");
  assert.equal(slip.notes[0].level, "stop");
  assert.ok(slip.notes.some((n) => n.code === "code" && n.level === "stop" && /SELFDESTRUCT/.test(n.text)));
  assert.ok(slip.notes.some((n) => n.code === "code" && n.level === "watch" && /replaced/.test(n.text)));
  assert.equal(slip.open?.surfaceFrom, "token");
});

test("a V1 token stays ON THE LIST and also gets the open-door facts", async () => {
  const slip = await readDoor(demoRpc(), DEMO_V1.token, opts());
  assert.equal(slip.stamp, "ON THE LIST");
  assert.equal(slip.id.launchpad, "v1");
  assert.ok(slip.open);
  assert.equal(slip.open!.owner, null);
  assert.deepEqual(slip.open!.powers, []);
  assert.ok(slip.notes.some((n) => n.code === "v1-launch"));
  assert.ok(!slip.notes.some((n) => n.code === "not-registered"));
  assert.ok(slip.notes.some((n) => n.code === "no-pool"));
});
