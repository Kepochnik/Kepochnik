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

test("adaptive chunking halves on a range error and never invents a gap", async () => {
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
  assert.deepEqual(seen[0], [0, 3_999]);
  assert.equal(seen[seen.length - 1][1], 9_999);
  let cursor = 0;
  for (const [from, to] of seen) {
    assert.equal(from, cursor, "chunks are contiguous");
    cursor = to + 1;
  }
});

test("adaptive chunking gives up at the minimum chunk", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no" } }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl, rateLimitRetries: 0 });
  await assert.rejects(readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 99, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 100, minChunk: 50 }), /no/);
});
