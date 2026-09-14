import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { PonsReader } from "../src/chain/reader.js";
import { DEMO, DEMO_BLOCKSCOUT, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
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
  assert.deepEqual(names.map((t) => t.name), ["bouncer_check", "bouncer_tax_now", "bouncer_crew", "bouncer_dev", "bouncer_receipt", "bouncer_exit", "bouncer_plan", "bouncer_board"]);
  assert.ok(names.every((t) => t.annotations.readOnlyHint));
  const call = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bouncer_check", arguments: { address: DEMO.tokens.fresh.token } } });
  const result = call?.result as { content: { type: string; text: string }[]; structuredContent: { stamp: string; notes: unknown[] }; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.stamp, "ON THE LIST");
  assert.match(result.content[0].text, /Cover charge/);
  const bad = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bouncer_exit", arguments: { address: "0x000000000000000000000000000000000000dead" } } });
  assert.equal((bad?.result as { isError: boolean }).isError, true);
  const unknown = await server.handle({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.equal(unknown?.error?.code, -32601);
  const board = await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bouncer_board", arguments: {} } });
  assert.match((board?.result as { content: { text: string }[] }).content[0].text, /launches 5/);
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
