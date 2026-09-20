import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { pushedSelectors } from "../src/chain/code.js";
import { selector } from "../src/chain/abi.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_CODE, DEMO_IMPOSTOR, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc, demoRpcWith, dispatcherCode } from "../src/bouncer/demo.js";
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
  assert.equal(o.constants >= o.selectors, true);
  assert.equal(o.holders?.count, 143);
  assert.equal(o.holders?.transfers, 2_210);
  assert.equal(o.holders?.top10WalletsBps, 2_500 + 800 + 500 + 300 + 400); // the 7702 wallet counts as a wallet
  assert.equal(o.holders?.contractsBps, 3_000);
  assert.equal(o.holders?.burnedBps, 200);
  // transfer simulation: the owner and the deployer are excluded on purpose, so the
  // candidates are plain holders; one of them is blacklisted. Each is tried twice,
  // once to a fresh wallet and once into the pool, because only the second is a sale.
  const moves = o.probes.filter((p) => p.target === "fresh-wallet");
  const sells = o.probes.filter((p) => p.target === "pool");
  assert.equal(moves.length, 3);
  assert.equal(sells.length, 3);
  assert.ok(o.probes.every((p) => p.from !== DEMO_PLAIN.owner));
  const failed = o.probes.filter((p) => p.status === "reverts");
  assert.equal(failed.length, 2);
  assert.ok(failed.every((p) => p.from === DEMO_PLAIN.blacklisted));
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
  assert.ok(codes.includes("powers"));
  assert.ok(codes.includes("unverified"));
  assert.ok(codes.includes("move-some-revert"));
  assert.ok(codes.includes("sell-some-revert"));
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

test("without an explorer the sale is still simulated, from holders found in the chain's own logs", async () => {
  // BNB Chain has no public Blockscout. Without this path the headline check
  // would simply not run there, which is worse than running it on fewer wallets.
  const slip = await readDoor(demoRpc(), DEMO_PLAIN.token, { ...opts(), blockscout: null });
  assert.equal(slip.stamp, "NOT A LAUNCH");
  const o = slip.open!;
  assert.equal(o.holders, null, "there is no holder list without an explorer");
  assert.equal(o.deployer, null);
  assert.equal(o.owner?.address, DEMO_PLAIN.owner);
  assert.ok(slip.notes.some((n) => n.code === "powers"));
  assert.ok(o.probes.length > 0, "the sale is still simulated");
  assert.ok(o.probes.some((p) => p.target === "pool"), "and it is aimed at the pool");
  assert.ok(o.probes.every((p) => p.from !== DEMO_PLAIN.owner), "the owner is still excluded");
  assert.equal(o.probesSkipped, null);
  // The blacklisted wallet was sent tokens too, so it should be caught here as well.
  assert.ok(slip.notes.some((n) => n.code === "sell-some-revert" || n.code === "sell-ok"));
});

test("a token wearing a real launch's ticker is NOT ON THE LIST", async () => {
  const slip = await readDoor(demoRpc(), DEMO_IMPOSTOR.token, opts());
  assert.equal(slip.stamp, "NOT ON THE LIST");
  assert.equal(slip.notes[0].code, "lookalike-impostor");
  assert.equal(slip.notes[0].level, "stop");
  assert.ok(slip.notes.some((n) => n.code === "code" && n.level === "stop" && /SELFDESTRUCT/.test(n.text)));
  assert.ok(slip.notes.some((n) => n.code === "code" && n.level === "watch" && /replaced/.test(n.text)));
  // Its EIP-1967 slot points at a contract with no code, so the surface behind the
  // proxy is unknown. That must read as unknown, never as "no dangerous functions".
  assert.equal(slip.open?.surfaceFrom, "implementation-unreadable");
  assert.equal(slip.open?.powers.length, 0);
  assert.ok(slip.notes.some((n) => n.code === "surface-unreadable"));
  assert.ok(!slip.notes.some((n) => n.code === "no-powers"), "an unread surface must not be reported as no powers");
  assert.match(controlLine(slip.open!), /could not be read/);
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

// ---------------------------------------------------------------------------
// The three ways a reader is tempted to print a guess as a fact. Each of these
// reproduces a state the fixture alone never reaches, and asserts the slip says
// "not read" rather than inventing an answer.
// ---------------------------------------------------------------------------

const TRANSFER = selector("transfer(address,uint256)");
const callData = (params: unknown[]) => String((params[0] as { data?: string })?.data ?? "");

test("a rate-limited probe is reported as not run, never as a reverting token", async () => {
  const rpc = demoRpcWith((method, params) =>
    method === "eth_call" && callData(params).startsWith(TRANSFER) ? { error: { code: 429, message: "Too Many Requests" } } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  const o = slip.open!;
  assert.ok(o.probes.length > 0, "the probes were attempted");
  assert.ok(o.probes.every((p) => p.status === "unread"), "every probe is unread");
  assert.ok(!slip.notes.some((n) => n.code === "move-reverts" || n.code === "sell-reverts"), "nothing claims a revert");
  assert.ok(!slip.notes.some((n) => n.level === "stop"), "a rate limit is not a STOP");
  assert.ok(slip.notes.some((n) => n.code === "sell-unread"));
  assert.match(renderReceipt(doorReceipt(slip), "text"), /not run/);
});

test("an endpoint that drops the connection is reported as not run", async () => {
  const rpc = demoRpcWith((method, params) =>
    method === "eth_call" && callData(params).startsWith(TRANSFER) ? { transport: "socket hang up" } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  assert.ok(slip.open!.probes.every((p) => p.status === "unread"));
  assert.ok(!slip.notes.some((n) => n.level === "stop"));
});

test("a genuine revert is still a STOP, and the sale is reported apart from the move", async () => {
  const rpc = demoRpcWith((method, params) =>
    method === "eth_call" && callData(params).startsWith(TRANSFER)
      ? { error: { code: 3, message: "execution reverted: Trading not open", data: "0x" } }
      : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  assert.ok(slip.open!.probes.every((p) => p.status === "reverts"));
  assert.ok(slip.notes.some((n) => n.code === "move-reverts" && n.level === "stop"));
  const sell = slip.notes.find((n) => n.code === "sell-reverts");
  assert.ok(sell && sell.level === "stop");
  assert.match(sell.text, /A sale is a transfer into the pool/);
  assert.match(sell.text, /Trading not open/);
});

test("a contract with no transfer function is not called a trapping token", async () => {
  // A router, a multisig or an ERC-721 pasted into the box: the ERC-20 question
  // does not apply, and answering it anyway would stamp them all as honeypots.
  const code = dispatcherCode(["owner()", "balanceOf(address)", "totalSupply()"]);
  const rpc = demoRpcWith((method, params) =>
    method === "eth_getCode" && String(params[0]).toLowerCase() === DEMO_PLAIN.token ? { result: code } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  const o = slip.open!;
  assert.equal(o.probes.length, 0);
  assert.match(o.probesSkipped ?? "", /no transfer\(address,uint256\) function/);
  assert.ok(!slip.notes.some((n) => n.level === "stop"));
  assert.ok(slip.notes.some((n) => n.code === "no-probe"));
});

test("an unreadable totalSupply leaves every share unknown instead of zero", async () => {
  const supply = selector("totalSupply()");
  const rpc = demoRpcWith((method, params) =>
    method === "eth_call" && callData(params).startsWith(supply) ? { error: { code: 3, message: "execution reverted", data: "0x" } } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  const o = slip.open!;
  assert.equal(slip.id.meta, null, "the metadata read fails as a whole");
  assert.equal(o.holders?.top10WalletsBps, null);
  assert.equal(o.holders?.contractsBps, null);
  assert.equal(o.deployer?.bps, null);
  assert.ok(o.holders!.top.every((h) => h.bps === null));
  const text = renderReceipt(doorReceipt(slip), "text");
  assert.ok(!/0\.0%/.test(text), "no share is printed as a measured zero");
  assert.match(text, /unknown/);
  assert.ok(!slip.notes.some((n) => n.code === "concentrated" || n.code === "deployer-holds"), "no threshold fires on an unknown share");
  assert.ok(slip.notes.some((n) => n.code === "shares-unknown"));
});

test("an EIP-7702 wallet pasted into the box is named a wallet, not checked as a token", async () => {
  const delegated = `0xef0100${DEMO_PLAIN.pool.slice(2)}`;
  const rpc = demoRpcWith((method, params) =>
    method === "eth_getCode" && String(params[0]).toLowerCase() === DEMO_PLAIN.token ? { result: delegated } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  assert.equal(slip.id.token.code.delegatedTo, DEMO_PLAIN.pool);
  assert.ok(slip.notes.some((n) => n.code === "delegated-wallet"));
  assert.ok(!slip.notes.some((n) => n.code === "powers" || n.code === "no-powers"));
});

// ---------------------------------------------------------------------------
// The staged render only works if the early passes never say something the
// later ones take back. A STOP that turns into a WATCH teaches a reader to
// ignore the next STOP, which is worse than the second of waiting it saved.
// ---------------------------------------------------------------------------

const PAUSED = selector("paused()");
const OPENING = { skipMarket: true, skipExplorer: true, skipProbes: true, skipOwnerWallet: true, skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true } as const;

test("the opening pass never publishes a STOP the full pass retracts", async () => {
  // A token whose paused() says true while transfers actually go through:
  // the exact shape where the two passes disagree. The full read can see the
  // contradiction because it simulates a transfer; the opening read cannot,
  // and must not pretend otherwise.
  const paused = () => demoRpcWith((method, params) => (method === "eth_call" && callData(params).startsWith(PAUSED) ? { result: `0x${"0".repeat(63)}1` } : null));

  const first = await readDoor(paused(), DEMO_PLAIN.token, { ...opts(), ...OPENING });
  const full = await readDoor(paused(), DEMO_PLAIN.token, opts());

  assert.ok(first.open!.probesPending, "the opening pass did not simulate a transfer");
  assert.ok(!full.open!.probesPending, "the full pass did");
  assert.equal(first.notes.find((n) => n.code === "paused")?.level, "watch", "an unsimulated pause is not a STOP");
  assert.match(first.notes.find((n) => n.code === "paused")!.text, /still being simulated/);

  const retracted = first.notes.filter((n) => n.level === "stop").filter((n) => !full.notes.some((f) => f.code === n.code && f.level === "stop"));
  assert.deepEqual(retracted, [], `the opening pass published ${retracted.length} STOP(s) the full pass does not agree with`);
});

test("the opening pass reads nothing it has not asked for as zero", async () => {
  const slip = await readDoor(demoRpc(), DEMO_PLAIN.token, { ...opts(), ...OPENING });
  const o = slip.open!;
  // Each of the three is null or a sentence, never an empty list that reads
  // as "checked, found nothing".
  assert.equal(o.pools, null, "pools must be unread, not an empty market");
  assert.equal(o.holders, null, "holders must be unread, not nobody");
  assert.equal(o.deployer, null);
  assert.equal(o.probes.length, 0);
  assert.ok(o.probesSkipped, "a skipped simulation has to say so");
  // And what IS read is the point of the pass: the code and the keys.
  assert.ok(o.powers.length > 0, "the powers come off the bytecode, which is read");
  assert.equal(o.owner?.address, DEMO_PLAIN.owner);
  assert.equal(o.paused, false);
});

test("an owner whose wallet was not read is not reported as a person", async () => {
  // The owner's own wallet — contract or not, how much it holds — is a whole
  // round trip below the rest of the read, and the opening pass skips it.
  // The trap is reporting `isContract: false` for it, which is not "unread",
  // it is the claim that BOUNCER looked and found a human being. Null says
  // the true thing, and the pass behind it fills it in.
  const first = await readDoor(demoRpc(), DEMO_PLAIN.token, { ...opts(), ...OPENING });
  const full = await readDoor(demoRpc(), DEMO_PLAIN.token, { ...opts(), skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true });

  assert.ok(first.open!.ownerWalletPending, "the opening pass has to say the owner's wallet went unread");
  assert.equal(first.open!.owner?.isContract, null, "unread is null, never false");
  assert.equal(first.open!.ownerBalance, null, "an unread balance is not a balance of zero");

  assert.ok(!full.open!.ownerWalletPending, "the pass behind it does read the owner's wallet");
  assert.equal(typeof full.open!.owner?.isContract, "boolean", "and turns the null into an answer");

  // And no finding that needs the balance may be published off the unread one.
  assert.equal(first.notes.find((n) => n.code === "owner-holds"), undefined, "a holding note off a balance nobody read");
});

test("the explorer is asked once for a path, however many readers want it", async () => {
  // The page starts these reads the moment an address is pasted and the
  // pass that needs them begins a second later, so two callers wanting the
  // same path before either answer arrives is the ordinary case — not an
  // edge one. A memo of values would let both requests go out, which is
  // exactly what it exists to prevent.
  let calls = 0;
  const slow = (async (input: RequestInfo | URL) => {
    calls++;
    await new Promise((r) => setTimeout(r, 40));
    return demoBlockscoutFetch()(input as string);
  }) as unknown as typeof fetch;
  const bs = new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: slow, memo: true });

  bs.prewarm(BlockscoutClient.doorPaths(DEMO_PLAIN.token));
  const started = calls;
  assert.equal(started, 4, "prewarm asks for each path once, without being awaited");

  const [a, b] = await Promise.all([bs.addressInfo(DEMO_PLAIN.token), bs.addressInfo(DEMO_PLAIN.token)]);
  assert.deepEqual(a, b);
  assert.equal(calls, started, "a path already in flight is not asked for again");
  await bs.tokenHolders(DEMO_PLAIN.token);
  assert.equal(calls, started, "nor one already answered");
  assert.ok(bs.memoHits >= 3);
});

test("an explorer path that failed is not retried into the same wall twice", async () => {
  let calls = 0;
  const dead = (async () => {
    calls++;
    return new Response("nope", { status: 504 });
  }) as unknown as typeof fetch;
  const bs = new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: dead, memo: true });
  await assert.rejects(() => bs.addressInfo(DEMO_PLAIN.token));
  await assert.rejects(() => bs.addressInfo(DEMO_PLAIN.token));
  assert.equal(calls, 1, "six seconds of timeout is not worth paying for twice in one read");
});

test("a contract that reads as nothing is never CLEAR", async () => {
  // From a live report. Someone was given an address for a ticker, pasted
  // it, and got a green CLEAR on a slip that also said: no name, no owner,
  // no switches, no simulation, explorer unreachable, holders unknown. The
  // tool had read almost nothing and said so in six quiet places, and then
  // put the one loud word on the page in the colour that means "fine".
  //
  // CLEAR is only ever "nothing was found". It must never be reachable when
  // there was nothing to look at.
  const nothing = dispatcherCode(["somethingElse()"]);
  const meta = new Set([selector("name()"), selector("symbol()"), selector("decimals()"), selector("totalSupply()")]);
  const rpc = demoRpcWith((method, params) => {
    if (method === "eth_getCode" && String(params[0]).toLowerCase() === DEMO_PLAIN.token) return { result: nothing };
    if (method === "eth_call" && meta.has(callData(params).slice(0, 10) as `0x${string}`)) return { error: { code: 3, message: "execution reverted" } };
    return null;
  });
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: null });

  assert.equal(slip.id.meta, null, "the premise: nothing identifies it");
  assert.equal(slip.open!.transferFunction, false, "and no balance of it can move");
  const stop = slip.notes.find((n) => n.code === "not-a-token");
  assert.ok(stop, "the slip has to say so");
  assert.equal(stop!.level, "stop");
  assert.match(stop!.text, /not that token/);
  assert.ok(
    slip.notes.some((n) => n.level === "stop"),
    "and with a stop present the page cannot render CLEAR",
  );
});

test("a named contract with no transfer selector is not accused of anything", async () => {
  // The other half of the same rule, and the reason it is narrow.
  //
  // The selector scan is a heuristic reading bytes out of a dispatcher, and
  // it misses: on the demo chain it misses transfer() on a real Pons V1
  // launch, a token the factory itself vouches for. So "no transfer
  // selector" on its own earns no headline — it stays the quiet line it has
  // always been, under the simulation that did not run. Only when a second,
  // independent read agrees — the ERC-20 views answering nothing at all —
  // does the slip tell somebody the thing they were sent is not a token.
  const code = dispatcherCode(["owner()", "balanceOf(address)", "totalSupply()"]);
  const rpc = demoRpcWith((method, params) =>
    method === "eth_getCode" && String(params[0]).toLowerCase() === DEMO_PLAIN.token ? { result: code } : null,
  );
  const slip = await readDoor(rpc, DEMO_PLAIN.token, { ...opts(), blockscout: blockscout() });
  assert.equal(slip.open!.transferFunction, false);
  assert.ok(slip.id.meta, "but the chain did say what it is called");
  assert.ok(!slip.notes.some((n) => n.code === "not-a-token"), "a heuristic on its own does not get to say that");
  assert.ok(!slip.notes.some((n) => n.level === "stop"));
  assert.ok(slip.notes.some((n) => n.code === "no-probe"), "the quiet line still carries it");
});
