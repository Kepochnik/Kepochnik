import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWord, eventTopic } from "../src/chain/abi.js";
import { readLaunchLedger, share } from "../src/chain/launches.js";
import { FACTORY_EVENTS, PONS_V2_FACTORY } from "../src/chain/pons.js";
import { RpcClient } from "../src/chain/rpc.js";
import { addressTopic } from "../src/chain/tape.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

const launched = (token: string, block: number) => ({
  address: PONS_V2_FACTORY,
  topics: [eventTopic(FACTORY_EVENTS.TokenLaunched), addressTopic(token), addressTopic("0x1111111111111111111111111111111111111111"), addressTopic("0x2222222222222222222222222222222222222222")],
  data: `0x${encodeWord("address", "0x0000000000000000000000000000000000000000")}${encodeWord("uint256", 1n)}${encodeWord("uint256", 42n * 10n ** 17n)}`,
  blockNumber: `0x${block.toString(16)}`, transactionHash: `0xtx${block}`, logIndex: "0x0",
});
const swept = (token: string, block: number) => ({
  address: PONS_V2_FACTORY,
  topics: [eventTopic(FACTORY_EVENTS.LaunchSwept), addressTopic(token)],
  data: `0x${encodeWord("uint256", 42n * 10n ** 17n)}${encodeWord("uint256", 2n * 10n ** 26n)}`,
  blockNumber: `0x${block.toString(16)}`, transactionHash: `0xtx${block}`, logIndex: "0x1",
});
const graduated = (token: string, block: number) => ({
  address: PONS_V2_FACTORY,
  topics: [eventTopic(FACTORY_EVENTS.PoolGraduated), addressTopic(token)],
  data: `0x${encodeWord("uint256", 7n)}${encodeWord("uint256", 2n * 10n ** 26n)}${encodeWord("uint256", 4n * 10n ** 18n)}`,
  blockNumber: `0x${block.toString(16)}`, transactionHash: `0xtx${block}`, logIndex: "0x2",
});

test("readLaunchLedger joins launch, sweep and graduation per token", async () => {
  const logs = [launched(A, 10), launched(B, 20), swept(A, 30), graduated(A, 31), graduated(C, 40)];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string; address: string }] };
    assert.equal(body.params[0].address, PONS_V2_FACTORY);
    const from = Number(BigInt(body.params[0].fromBlock));
    const to = Number(BigInt(body.params[0].toBlock));
    const result = logs.filter((l) => { const n = Number(BigInt(l.blockNumber)); return n >= from && n <= to; });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  const ledger = await readLaunchLedger(rpc, { fromBlock: 0, toBlock: 99, chunkSize: 50 });
  assert.equal(ledger.chunks, 2);
  assert.equal(ledger.launches.length, 2);
  const a = ledger.launches.find((l) => l.token === A)!;
  assert.equal(a.deployer, "0x2222222222222222222222222222222222222222");
  assert.equal(a.sweptAt?.block, 30);
  assert.equal(a.graduatedAt?.block, 31);
  assert.equal(a.graduatedAt?.pairTokenAmount, 4n * 10n ** 18n);
  const b = ledger.launches.find((l) => l.token === B)!;
  assert.equal(b.sweptAt, undefined);
  assert.equal(b.graduatedAt, undefined);
  assert.deepEqual(ledger.graduationsOutsideWindow, [{ token: C, block: 40 }]);
  assert.equal(share(1, 2), "50.0%");
  assert.equal(share(0, 0), "n/a");
});
