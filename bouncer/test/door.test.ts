import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO, DEMO_IMPOSTOR, demoRpc } from "../src/bouncer/demo.js";
import { doorReceipt, findLaunchBlock, readDoor, slipJson } from "../src/bouncer/door.js";
import { readCoverCharge } from "../src/bouncer/coverCharge.js";
import { readDevReport } from "../src/bouncer/devReport.js";
import { readIdCheck } from "../src/bouncer/idCheck.js";
import { doorCard } from "../src/bouncer/card.js";
import { renderReceipt } from "../src/receipt.js";
import { PonsReader } from "../src/chain/reader.js";

const opts = { devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 };

test("FRESH: cover charge open, one sniper paid at the door", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, DEMO.tokens.fresh.token, opts);
  assert.equal(slip.stamp, "ON THE LIST");
  assert.equal(slip.launchBlock, DEMO.tokens.fresh.launched);
  assert.ok(slip.cover);
  assert.equal(slip.cover.status, "open");
  assert.equal(slip.cover.secondsLeft, 6);
  assert.equal(slip.cover.terms.seconds, 15);
  assert.equal(slip.cover.observed.length, 3);
  assert.equal(slip.cover.observed[0].creatorWallet, true);
  assert.equal(slip.cover.observed[1].chargeBps, 7_100);
  assert.ok(slip.notes.some((n) => n.code === "cover-open" && n.level === "watch"));
  assert.ok(slip.notes.some((n) => n.code === "high-tax"));
  assert.ok(!slip.notes.some((n) => n.code === "code"), "Pons demo bytecode must not be flagged");
  assert.ok(slip.rules);
  assert.equal(slip.rules.totalTradeBps, 1_100n);
  assert.equal(slip.rules.fill?.bps, 1_904);
  const text = renderReceipt(doorReceipt(slip), "text");
  assert.match(text, /open · 6 s left/);
  assert.match(text, /FRESH · Fresh Off The Curve/);
});

test("SPRINT: graduated, recipient moved, dev report card counts it", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, DEMO.tokens.sprint.token, opts);
  assert.equal(slip.cover?.status, "closed");
  assert.equal(slip.rules?.creatorFeeRecipientChanges.length, 1);
  assert.ok(slip.notes.some((n) => n.code === "fee-recipient-moved"));
  assert.ok(slip.notes.some((n) => n.code === "graduated"));
  assert.equal(slip.dev?.counts.graduated, 1);
  assert.equal(slip.dev?.launches[0].secondsToSweep, 212);
  assert.match(slipJson(slip), /"stamp": "ON THE LIST"/);
});

test("the curve address resolves to its token", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, DEMO.tokens.slow.curve, { ...opts, skipDev: true });
  assert.equal(slip.id.resolvedAs, "curve");
  assert.equal(slip.subject, DEMO.tokens.slow.token);
  assert.equal(slip.dev, null);
  assert.ok(slip.notes.some((n) => n.code === "curve-input"));
});

test("impostor: not on the list, proxy and dangerous opcodes are STOP notes", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, DEMO_IMPOSTOR.token, opts);
  assert.equal(slip.stamp, "NOT ON THE LIST");
  assert.equal(slip.id.meta?.symbol, "SPRINT");
  assert.equal(slip.id.token.proxyImplementation, DEMO_IMPOSTOR.implementation);
  const stops = slip.notes.filter((n) => n.level === "stop");
  assert.ok(stops.length >= 3);
  assert.equal(slip.cover, null);
  assert.equal(slip.rules, null);
});

test("an EOA is not on the list and has no code", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, "0x000000000000000000000000000000000000dead", opts);
  assert.equal(slip.stamp, "NOT ON THE LIST");
  assert.equal(slip.id.token.code.empty, true);
  assert.match(slip.notes[0].text, /No contract at this address/);
});

test("dev report card for DEV_B: three launches, one graduated", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const report = await readDevReport(rpc, DEMO.tokens.slow.deployer, { fromBlock: head - 300_000, toBlock: head, chunking: { startChunk: 100_000, maxChunk: 100_000 } });
  assert.equal(report.counts.launched, 3);
  assert.equal(report.counts.graduated, 1);
  assert.equal(report.counts.onCurve, 2);
  assert.equal(report.launches[0].symbol, "LATE");
  assert.deepEqual(report.repeatedSymbols, []);
  assert.deepEqual(report.taxRangeBps, [100n, 500n]);
});

test("cover charge: terms, window and observed buys straight from the modules", async () => {
  const rpc = demoRpc();
  const head = await rpc.getBlock("latest");
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.nap.token, head.number);
  const block = await findLaunchBlock(rpc, DEMO.tokens.nap.token, head.number, 400_000, undefined, 100_000);
  assert.equal(block, DEMO.tokens.nap.launched);
  const cover = await readCoverCharge(rpc, launch, { launchBlock: block!, head, chunkSize: 100_000 });
  assert.equal(cover.status, "closed");
  assert.equal(cover.observed.length, 1);
  assert.equal(cover.observed[0].creatorWallet, true);
  assert.equal(cover.termsChangedSinceLaunch, false);
});

test("id check reads bytecode of token and curve", async () => {
  const rpc = demoRpc();
  const id = await readIdCheck(rpc, DEMO.tokens.late.token, await rpc.blockNumber());
  assert.equal(id.registered, true);
  assert.equal(id.token.code.bytes > 0, true);
  assert.equal(id.curve?.code.bytes, 995);
  assert.equal(id.token.proxyImplementation, null);
});

test("the card is valid SVG with the stamp and the gorilla", async () => {
  const rpc = demoRpc();
  const slip = await readDoor(rpc, DEMO.tokens.fresh.token, opts);
  const svg = doorCard(slip, { repoUrl: "github.com/Kepochnik/bouncer", ticker: "$BOUNCER", mascotSvg: '<rect x="0" y="0" width="1" height="1"/>' });
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /ON THE LIST/);
  assert.match(svg, /COVER CHARGE/);
  assert.match(svg, /<rect x="0" y="0" width="1" height="1"\/>/);
});
