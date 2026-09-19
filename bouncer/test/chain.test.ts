import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256Hex } from "../src/chain/keccak.js";
import { eventTopic, selector } from "../src/chain/abi.js";
import { FACTORY_EVENTS } from "../src/chain/pons.js";
import { readTapeAdaptive } from "../src/chain/tape.js";
import { RpcClient } from "../src/chain/rpc.js";
import { ROBINHOOD_CHAIN_ID } from "../src/chain/pons.js";

test("keccak vectors", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(selector("balanceOf(address)"), "0x70a08231");
  assert.equal(eventTopic(FACTORY_EVENTS.SnipeTaxStartBpsUpdated), keccak256Hex("SnipeTaxStartBpsUpdated(uint256)"));
});

test("the rpc client refuses anything that is not a read", async () => {
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: (async () => new Response("{}")) as typeof fetch });
  await assert.rejects(rpc.send("eth_sendRawTransaction", ["0x"]), /refusing non-read method/);
  await assert.rejects(rpc.send("eth_accounts", []), /refusing non-read method/);
});

test("adaptive chunking narrows fast on a range error and never invents a gap", async () => {
  const seen: [number, number][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    const to = Number(BigInt(req.params[0].toBlock));
    if (to - from + 1 > 4_000) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "block range too wide" } }));
    seen.push([from, to]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });
  const tape = await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 9_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 16_000, minChunk: 1_000, maxChunk: 16_000 });
  assert.equal(tape.logs.length, 0);
  assert.equal(tape.complete, true);
  // The opening guess is refused, so the span narrows until it fits. What
  // matters is that it lands under the endpoint's limit and never skips a
  // block; the step it takes getting there is a tuning choice — eighths now,
  // because halving from a wide guess spends a dozen refusals reaching the
  // first useful request.
  assert.equal(seen[0][0], 0);
  assert.ok(seen[0][1] - seen[0][0] + 1 <= 4_000, "the first successful span must fit the endpoint's limit");
  assert.equal(seen[seen.length - 1][1], 9_999, "the window is covered to its end");
  let cursor = 0;
  for (const [from, to] of seen) {
    assert.equal(from, cursor, "chunks are contiguous");
    cursor = to + 1;
  }
});

test("a walk that reads nothing is an error; one that reads something keeps it", async () => {
  // Refused from the first request: there is no answer to give, so this must
  // be an error rather than a confident empty tape.
  const alwaysNo = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no" } }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: alwaysNo, rateLimitRetries: 0 });
  await assert.rejects(readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 99, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 100, minChunk: 50 }), /no/);

  // Refused only once it is deep into the window: throwing here would discard
  // every log already paid for, which on Base meant sixty-three seconds of
  // reading dropped in order to report nothing.
  let answered = 0;
  const failsLater = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: [{ fromBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    if (from >= 50) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no" } }));
    answered++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc2 = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: failsLater, rateLimitRetries: 0 });
  const tape = await readTapeAdaptive(rpc2, { fromBlock: 0, toBlock: 199, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 50, minChunk: 50 });
  assert.ok(answered > 0);
  assert.equal(tape.complete, false, "a walk cut short must say so");
  assert.ok(tape.toBlock < 199, "and must report how far it actually got");
});
