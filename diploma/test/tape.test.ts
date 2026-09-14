import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWord, eventTopic } from "../src/chain/abi.js";
import { FACTORY_EVENTS, PONS_V2_FACTORY } from "../src/chain/pons.js";
import { RpcClient } from "../src/chain/rpc.js";
import { addressTopic, findBlockByTimestamp, readTape } from "../src/chain/tape.js";

const TOKEN = "0x78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8";

function launchedLog(block: number, index: number) {
  return {
    address: PONS_V2_FACTORY,
    topics: [
      eventTopic(FACTORY_EVENTS.TokenLaunched),
      addressTopic(TOKEN),
      addressTopic("0x1111111111111111111111111111111111111111"),
      addressTopic("0x2222222222222222222222222222222222222222"),
    ],
    data: `0x${encodeWord("address", "0x0000000000000000000000000000000000000000")}${encodeWord("uint256", 1n)}${encodeWord("uint256", 42n * 10n ** 17n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: "0xabc",
    logIndex: `0x${index.toString(16)}`,
  };
}

test("readTape walks the window in chunks and returns decoded logs in order", async () => {
  const seenRanges: [number, number][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string; topics: unknown[] }] };
    assert.equal(body.method, "eth_getLogs");
    const from = Number(BigInt(body.params[0].fromBlock));
    const to = Number(BigInt(body.params[0].toBlock));
    seenRanges.push([from, to]);
    assert.equal(body.params[0].topics[0], eventTopic(FACTORY_EVENTS.TokenLaunched));
    const result = from <= 1500 && 1500 <= to ? [launchedLog(1500, 3), launchedLog(1500, 1)] : from <= 100 && 100 <= to ? [launchedLog(100, 0)] : [];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  const tape = await readTape(rpc, { fromBlock: 0, toBlock: 2499, events: [FACTORY_EVENTS.TokenLaunched], address: PONS_V2_FACTORY, chunkSize: 1000 });
  assert.deepEqual(seenRanges, [[0, 999], [1000, 1999], [2000, 2499]]);
  assert.equal(tape.chunks, 3);
  assert.deepEqual(tape.logs.map((l) => [l.blockNumber, l.logIndex]), [[100, 0], [1500, 1], [1500, 3]]);
  assert.equal(tape.logs[0].args.token, TOKEN);
});

test("findBlockByTimestamp binary-searches block headers", async () => {
  // Block n has timestamp 1000 + n, latest = 999.
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [string] };
    calls++;
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x3e7" }));
    const n = Number(BigInt(body.params[0]));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { number: body.params[0], timestamp: `0x${(1000 + n).toString(16)}`, hash: "0x" } }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  assert.equal(await findBlockByTimestamp(rpc, 1500), 500);
  assert.ok(calls < 20, `expected O(log n) calls, made ${calls}`);
  assert.equal(await findBlockByTimestamp(rpc, 5000), 999);
});
