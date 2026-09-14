import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS, chainById, chainByKey } from "../src/chain/chains.js";
import { PONS_V2_FACTORY, ZERO_ADDRESS } from "../src/chain/pons.js";
import { PonsReader } from "../src/chain/reader.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_FUNDER, DEMO_HOOK, DEMO_IMPOSTOR, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor } from "../src/bouncer/door.js";
import { fullRangeReserves, poolIdFor, quoteExit, readExitDoor } from "../src/bouncer/exitDoor.js";
import { readLookalikes } from "../src/bouncer/lookalike.js";
import { readOneCrew } from "../src/bouncer/oneCrew.js";
import { readLaunchPlan } from "../src/bouncer/planner.js";
import { readPosition } from "../src/bouncer/position.js";
import { readRoom } from "../src/bouncer/room.js";
import { readTradeReceipt } from "../src/bouncer/txReceipt.js";

const bs = () => new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });
const opts = { factory: PONS_V2_FACTORY, blockscout: bs(), devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 };

test("chains: keys, ids, Arc has USDC as the native quote", () => {
  assert.equal(chainByKey(undefined).chainId, 4663);
  assert.equal(chainByKey("arc-testnet").factory, "0x90022cc2107de9c070f889e3a67009fca270e4e2");
  assert.equal(chainByKey("ARC").native.symbol, "USDC");
  assert.equal(CHAINS.arc.factory, null);
  assert.equal(chainById(5042002)?.name, "Arc Testnet");
  assert.throws(() => chainByKey("solana"), /unknown chain/);
});

test("a chain without a published factory refuses the door politely", async () => {
  await assert.rejects(readDoor(demoRpc(), DEMO.tokens.fresh.token, { chain: CHAINS.arc }), /not published yet/);
});

test("pool id: currencies sorted, token side detected", () => {
  const a = poolIdFor(DEMO.tokens.sprint.token, ZERO_ADDRESS, 10_000n, 200n, DEMO_HOOK);
  assert.equal(a.tokenIsCurrency0, false);
  assert.match(a.poolId, /^0x[0-9a-f]{64}$/);
  const b = poolIdFor(ZERO_ADDRESS, DEMO.tokens.sprint.token, 10_000n, 200n, DEMO_HOOK);
  assert.equal(b.poolId, a.poolId, "the pool id does not depend on argument order");
});

test("full-range reserves round-trip through sqrtPrice and liquidity", () => {
  const state = { poolId: "0x" as `0x${string}`, sqrtPriceX96: 2n ** 96n * 2n, liquidity: 10n ** 20n, tokenIsCurrency0: true };
  const r = fullRangeReserves(state);
  assert.equal(r.token, 5n * 10n ** 19n);
  assert.equal(r.quote, 2n * 10n ** 20n);
});

test("exit quotes: fee and creator tax come off the quote leg, impact grows with size", () => {
  const q = quoteExit(10n ** 24n, { token: 10n ** 26n, quote: 10n ** 18n }, 100n, 300n);
  assert.equal(q.length, 4);
  assert.ok(q[0].realisedBps > q[3].realisedBps);
  assert.equal(q[3].net, q[3].gross - q[3].fee - q[3].tax);
  assert.equal(q[3].fee, (q[3].gross * 100n) / 10_000n);
});

test("exit door on the graduated demo pool reproduces the seeded reserves", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.sprint.token, head);
  const exit = await readExitDoor(rpc, launch, { position: 10n ** 25n, block: head, factory: PONS_V2_FACTORY });
  assert.equal(exit.venue, "pool");
  const tokenErr = Number((exit.reserves.token - 2n * 10n ** 26n) * 10_000n / (2n * 10n ** 26n));
  assert.ok(Math.abs(tokenErr) <= 1, `token reserve within 1 bp, got ${tokenErr}`);
  assert.equal(exit.feeBps, 100n);
  assert.ok(exit.quotes[3].net > 0n);
});

test("the room: buyers, dev share, first minute, shared blocks", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.sprint.token, head);
  const room = await readRoom(rpc, launch, DEMO.tokens.sprint.launched, head, 100_000);
  assert.equal(room.buyers, 9);
  assert.equal(room.devShareBps, 6_190);
  assert.equal(room.first[0], DEMO.tokens.sprint.deployer);
  assert.equal(room.sharedBlocks.length, 0);
});

test("one crew: FRESH's two snipers share a funder", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.fresh.token, head);
  const room = await readRoom(rpc, launch, DEMO.tokens.fresh.launched, head, 100_000);
  const crew = await readOneCrew(bs(), room, DEMO.tokens.fresh.launched, [launch.deployer]);
  assert.equal(crew.crews.length, 1);
  assert.equal(crew.crews[0].funder, DEMO_FUNDER);
  assert.equal(crew.crews[0].wallets.length, 2);
  assert.ok(crew.largestCrewShareBps > 2_500);
  assert.equal(crew.fundedByCreator.length, 0);
});

test("blockscout client: funding source ignores outgoing, zero-value and post-launch transfers", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        items: [
          { hash: "0x1", value: "5", block_number: 900, from: { hash: "0xaaaa" }, to: { hash: "0xwallet" } },
          { hash: "0x2", value: "0", block_number: 100, from: { hash: "0xbbbb" }, to: { hash: "0xwallet" } },
          { hash: "0x3", value: "7", block_number: 200, from: { hash: "0xcccc" }, to: { hash: "0xwallet" } },
          { hash: "0x4", value: "9", block_number: 50, from: { hash: "0xdddd" }, to: { hash: "0xother" } },
        ],
        next_page_params: null,
      }),
    )) as typeof fetch;
  const client = new BlockscoutClient({ baseUrl: "https://x.invalid", fetchImpl });
  const src = await client.fundingSource("0xwallet", 500);
  assert.equal(src?.from, "0xcccc");
  assert.equal(src?.block, 200);
});

test("lookalikes: the impostor shows up, the real SPRINT came first", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const l = await readLookalikes(rpc, bs(), DEMO.tokens.sprint.token, "SPRINT", head, PONS_V2_FACTORY, 400_000);
  assert.equal(l.candidates.length, 2);
  assert.equal(l.registeredCount, 1);
  assert.equal(l.subjectIsEarliest, true);
  assert.ok(l.candidates.some((c) => c.address === DEMO_IMPOSTOR.token && !c.registered));
});

test("receipt: the sniper's buy splits into fee, creator tax and cover charge", async () => {
  const rpc = demoRpc();
  const [r] = await readTradeReceipt(rpc, `0xdemoFRESH${DEMO.tokens.fresh.launched + 22}`, PONS_V2_FACTORY);
  assert.equal(r.kind, "buy");
  assert.equal(r.quote, 300n * 10n ** 15n);
  assert.equal(r.creatorTaxPart, 30n * 10n ** 15n);
  assert.equal(r.coverChargePart, 180n * 10n ** 15n);
  assert.equal(r.launch?.token, DEMO.tokens.fresh.token);
  await assert.rejects(readTradeReceipt(rpc, "0xnothing", PONS_V2_FACTORY), /no receipt/);
});

test("position: buys, a sell, cost basis and exit value", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.late.token, head);
  const p = await readPosition(rpc, launch, DEMO.tokens.late.buys[1][1], DEMO.tokens.late.launched, head, PONS_V2_FACTORY, 100_000);
  assert.equal(p.trades.length, 4);
  assert.equal(p.spentQuote, 150n * 10n ** 15n);
  assert.equal(p.receivedQuote, 20n * 10n ** 15n);
  assert.equal(p.costBasis, 130n * 10n ** 15n);
  assert.equal(p.exit.venue, "curve");
});

test("launch planner: the curve's own arithmetic", async () => {
  const rpc = demoRpc();
  const plan = await readLaunchPlan(rpc, { factory: PONS_V2_FACTORY, block: await rpc.blockNumber(), nativeSymbol: "ETH", creatorTaxBps: 300n });
  assert.equal(plan.supply, 10n ** 27n);
  assert.equal(plan.tokensToPool, (10n ** 27n * 9n * 10n ** 17n) / (9n * 10n ** 17n + DEMO.threshold));
  assert.equal(plan.tokensSoldOnCurve + plan.tokensToPool, plan.supply);
  assert.ok(plan.graduationPrice > plan.startPrice * 30n);
  assert.equal(plan.sampleDoorCharge, (plan.sampleBuy * 9_900n) / 10_000n);
  assert.equal(plan.hookFeeBps, 100n);
  await assert.rejects(readLaunchPlan(rpc, { factory: PONS_V2_FACTORY, block: 1, nativeSymbol: "ETH", creatorTaxBps: 5_000n }), /above the factory ceiling/);
});

test("the full slip carries the phase 2 sections and their notes", async () => {
  const slip = await readDoor(demoRpc(), DEMO.tokens.fresh.token, opts);
  assert.ok(slip.room && slip.exit && slip.crew && slip.lookalikes && slip.dev);
  assert.ok(slip.notes.some((n) => n.code === "one-crew"));
  assert.ok(slip.notes.some((n) => n.code === "dev-funded"));
  assert.equal(slip.skipped.length, 0);
  assert.equal(slip.chain.native.symbol, "ETH");
  const noCrew = await readDoor(demoRpc(), DEMO.tokens.fresh.token, { ...opts, blockscout: null });
  assert.equal(noCrew.crew, null);
  assert.equal(noCrew.lookalikes, null);
});
