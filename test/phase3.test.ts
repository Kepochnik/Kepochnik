import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { PonsReader } from "../src/chain/reader.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor } from "../src/bouncer/door.js";
import { readBoard } from "../src/bouncer/leaderboard.js";
import { readWatchEvents, watchLaunch } from "../src/bouncer/watch.js";
import { handleCommand, tickWatches, type Watch } from "../src/bot/telegram.js";
import { createMcpServer, serveStdio } from "../src/mcp/server.js";

const bs = () => new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });

test("watch: the LATE deployer moved tokens, sold, and turned buyback off", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.late.token, head);
  const events = await readWatchEvents(rpc, launch, { fromBlock: head - 300, toBlock: head, chunkSize: 100_000 });
  assert.deepEqual(events.map((e) => e.kind), ["dev-transferred", "dev-sold", "buyback-changed"]);
  assert.equal(events[0].tokens, 10n ** 25n);
  assert.equal(events[1].quote, 40n * 10n ** 15n);
  assert.match(events[2].text, /off/);
  const quiet = await readWatchEvents(rpc, launch, { fromBlock: head - 300_000, toBlock: head - 400, chunkSize: 100_000 });
  assert.equal(quiet.length, 0);
});

test("watch: FRESH's crew leaves together, and a lone seller is not a crew exit", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.fresh.token, head);
  const crew = [DEMO.tokens.fresh.buys[1][1], DEMO.tokens.fresh.buys[2][1]];
  const events = await readWatchEvents(rpc, launch, { fromBlock: head - 100, toBlock: head, crew, chunkSize: 100_000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "crew-exit");
  assert.equal(events[0].wallets.length, 2);
  assert.equal(events[0].quote, 160n * 10n ** 15n);
  const single = await readWatchEvents(rpc, launch, { fromBlock: head - 100, toBlock: head - 3, crew, chunkSize: 100_000 });
  assert.equal(single.length, 0, "one wallet leaving is not a crew exit");
});

test("watch loop: events are delivered once and the cursor moves past the head", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const launch = await new PonsReader(rpc).launchedToken(DEMO.tokens.late.token, head);
  const seen: string[] = [];
  const cursor = await watchLaunch(rpc, launch, { fromBlock: head - 300, intervalMs: 0, chunkSize: 100_000, maxRounds: 3, sleep: async () => {}, onEvent: (e) => { seen.push(e.kind); } });
  assert.equal(seen.length, 3);
  assert.equal(cursor, head + 1);
});

test("board: launches, graduations, cover charge per curve and per wallet", async () => {
  const rpc = demoRpc();
  const head = await rpc.blockNumber();
  const b = await readBoard(rpc, { fromBlock: head - 300_000, toBlock: head, chunkSize: 100_000 });
  assert.equal(b.launches, 5);
  assert.equal(b.graduations, 2);
  assert.equal(b.deployers, 3);
  assert.equal(b.topDeployers[0].deployer, DEMO.tokens.slow.deployer);
  assert.equal(b.taxedBuys, 2);
  assert.equal(b.coverTotal, 180n * 10n ** 15n + 19n * 10n ** 15n);
  assert.equal(b.topCurves[0].token, DEMO.tokens.fresh.token);
  assert.equal(b.topPayers[0].wallet, DEMO.tokens.fresh.buys[1][1]);
  const devOnly = await readBoard(rpc, { fromBlock: head - 300_000, toBlock: head, chunkSize: 100_000, skipCover: true });
  assert.equal(devOnly.coverTotal, 0n);
  assert.equal(devOnly.launches, 5);
});

test("mcp: initialize, list, call, unknown method, notifications are silent", async () => {
  const server = createMcpServer({ demo: true, rpcFor: () => demoRpc(), blockscoutFor: () => bs(), factoryFor: () => PONS_V2_FACTORY });
  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, "bouncer");
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (list?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
  assert.deepEqual(names.map((t) => t.name), ["bouncer_check", "bouncer_tax_now", "bouncer_crew", "bouncer_dev", "bouncer_receipt", "bouncer_exit", "bouncer_wallet", "bouncer_plan", "bouncer_board"]);
  assert.ok(names.every((t) => t.annotations.readOnlyHint));
  const call = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bouncer_check", arguments: { address: DEMO.tokens.fresh.token } } });
  const result = call?.result as { content: { type: string; text: string }[]; structuredContent: { stamp: string; notes: unknown[] }; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.stamp, "ON THE LIST");
  assert.match(result.content[0].text, /Cover charge/);
  // An address with no launch and no pool behind it is a question with an
  // answer — "nothing trades here" — not an error to hand back to an agent.
  const bad = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bouncer_exit", arguments: { address: "0x000000000000000000000000000000000000dead" } } });
  const badResult = bad?.result as { isError: boolean; content: { text: string }[] };
  assert.equal(badResult.isError, false);
  assert.match(badResult.content[0].text, /venue: no pool found/);
  const unknown = await server.handle({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.equal(unknown?.error?.code, -32601);
  const board = await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bouncer_board", arguments: {} } });
  assert.match((board?.result as { content: { text: string }[] }).content[0].text, /launches 5/);

  // The market tools answer for any token, so they must not be gated on a
  // launchpad the way the launchpad tools are. A chain with none used to turn
  // "what would this sell for" into "no launchpad runs here", which is not an
  // answer to the question.
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
  // A server wired the way the real binary is: each chain gets its own factory,
  // and a chain with no launchpad gets none.
  const real = createMcpServer({ demo: true, rpcFor: () => demoRpc(), factoryFor: (c) => c.factory });
  for (const name of ["bouncer_exit", "bouncer_wallet"]) {
    const r = await real.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: { address: DEMO.tokens.fresh.token, wallet: DEMO.tokens.fresh.deployer, chain: "base" } } });
    assert.doesNotMatch(text(r?.result), /no launchpad runs here/, `${name} refused a market question because the chain has no launchpad`);
  }
  // The launchpad tools still say exactly that, and name the one that answers.
  const padOnly = await real.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bouncer_board", arguments: { chain: "base" } } });
  assert.match(text(padOnly?.result), /no launchpad runs here[\s\S]*bouncer_check/);
});

test("mcp over stdio: one line in, one line out, parse errors answered", async () => {
  const server = createMcpServer({ demo: true, rpcFor: () => demoRpc(), factoryFor: () => PONS_V2_FACTORY });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  const done = serveStdio(server, input, output);
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write("not json\n");
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bouncer_tax_now","arguments":{"address":"' + DEMO.tokens.fresh.token + '"}}}\n');
  input.end();
  await done;
  const lines = written.trim().split("\n").map((l) => JSON.parse(l) as { id: number | null; error?: { code: number }; result?: { content?: { text: string }[] } });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(lines[1].error?.code, -32700);
  assert.match(lines[2].result?.content?.[0].text ?? "", /status: open/);
});

test("bot: /watch registers, a tick delivers the crew exit, /unwatch clears", async () => {
  const options = { token: "t", rpcFor: () => demoRpc(), siteUrl: "https://example.invalid" };
  const watches: Watch[] = [];
  const ctx = { chatId: 7, watches };
  const chain = { ...CHAINS.robinhood, blockscout: null };
  const reply = await handleCommand(`/watch ${DEMO.tokens.fresh.token}`, chain, () => {}, options, ctx);
  assert.match(reply ?? "", /watching FRESH/);
  assert.equal(watches.length, 1);
  watches[0].crew = [DEMO.tokens.fresh.buys[1][1], DEMO.tokens.fresh.buys[2][1]];
  watches[0].cursor = DEMO.head - 100;
  const sent: string[] = [];
  await tickWatches(watches, options, async (_id, text) => { sent.push(text); }, () => {});
  assert.equal(sent.length, 1);
  assert.match(sent[0], /crew-exit/);
  assert.equal(watches[0].cursor, DEMO.head + 1);
  await tickWatches(watches, options, async (_id, text) => { sent.push(text); }, () => {});
  assert.equal(sent.length, 1, "nothing new is not re-sent");
  assert.match((await handleCommand("/watches", chain, () => {}, options, ctx)) ?? "", /FRESH/);
  assert.match((await handleCommand("/unwatch", chain, () => {}, options, ctx)) ?? "", /stopped 1 watch/);
  assert.equal(watches.length, 0);
  const board = await handleCommand("/board 1", chain, () => {}, { ...options }, ctx).catch((e: Error) => e.message);
  assert.ok(typeof board === "string");
});

test("a Pons V1 token is on the list with its own rules, not bounced", async () => {
  const slip = await readDoor(demoRpc(), DEMO_V1.token, { chain: CHAINS.robinhood, factory: PONS_V2_FACTORY, blockscout: null, chunkSize: 100_000, launchSearchBlocks: 400_000 });
  assert.equal(slip.stamp, "ON THE LIST");
  assert.equal(slip.id.launchpad, "v1");
  assert.equal(slip.id.v1?.record.positionId, 777n);
  assert.equal(slip.id.v1?.restrictionBlocksLeft, 40);
  assert.equal(slip.cover, null);
  assert.ok(slip.notes.some((n) => n.code === "v1-launch"));
  assert.ok(slip.notes.some((n) => n.code === "v1-caps"));
  assert.ok(slip.id.v1!.rules.some((r) => /Uniswap V3/.test(r)));
  const unknown = await readDoor(demoRpc(), "0x00000000000000000000000000000000000bad01", { chain: CHAINS.robinhood, factory: PONS_V2_FACTORY, blockscout: null, chunkSize: 100_000, launchSearchBlocks: 400_000 });
  assert.equal(unknown.stamp, "NOT A LAUNCH");
  assert.match(unknown.notes[0].text, /nor the Pons V1 factory/);
});

test("a well-known non-launch contract is named instead of bounced", async () => {
  const rpc = demoRpc();
  const chain = { ...CHAINS.robinhood, known: { "0x00000000000000000000000000000000000bad01": "a demo platform token, not a launch." } };
  const slip = await readDoor(rpc, "0x00000000000000000000000000000000000bad01", { chain, factory: PONS_V2_FACTORY, blockscout: null, chunkSize: 100_000, launchSearchBlocks: 400_000 });
  assert.equal(slip.stamp, "NOT A LAUNCH");
  assert.match(slip.known ?? "", /platform token/);
  assert.equal(slip.notes[0].code, "known-address");
  assert.equal(slip.notes[0].level, "info");
});
