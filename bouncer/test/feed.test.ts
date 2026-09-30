/**
 * The feed's whole reason to exist is that it reads the tip and not the day.
 * These are the cases that decide whether it can be trusted on a page that
 * refreshes: the order, what it admits it did not read, and what it does when
 * a token will not say its own name.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventTopic } from "../src/chain/abi.js";
import { CHAINS } from "../src/chain/chains.js";
import { FACTORY_EVENTS, PONS_V2_FACTORY } from "../src/chain/pons.js";
import { RpcError, type RpcClient } from "../src/chain/rpc.js";
import { addressTopic } from "../src/chain/tape.js";
import { feedBlocker, readFeed } from "../src/bouncer/feed.js";

const HEAD = 10_000;
const HEAD_TIME = 1_700_000_000;

const word = (n: bigint | string) => (typeof n === "string" ? n.toLowerCase().replace(/^0x/, "").padStart(64, "0") : n.toString(16).padStart(64, "0"));
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function launched(block: number, token: string, deployer: string, curve = addr(0xc0 + block)) {
  return {
    address: PONS_V2_FACTORY,
    topics: [eventTopic(FACTORY_EVENTS.TokenLaunched), addressTopic(token), addressTopic(curve), addressTopic(deployer)],
    data: `0x${word(addr(0x4200))}${word(1n)}${word(10n ** 18n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  };
}

function graduated(block: number, token: string) {
  return {
    address: PONS_V2_FACTORY,
    topics: [eventTopic(FACTORY_EVENTS.PoolGraduated), addressTopic(token)],
    data: `0x${word(7n)}${word(1n)}${word(2n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${(block + 1).toString(16).padStart(64, "0")}`,
    logIndex: "0x1",
  };
}

function swept(block: number, token: string) {
  return {
    address: PONS_V2_FACTORY,
    topics: [eventTopic(FACTORY_EVENTS.LaunchSwept), addressTopic(token)],
    data: `0x${word(1n)}${word(2n)}`,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x2",
    transactionHash: `0x${(block + 2).toString(16).padStart(64, "0")}`,
  };
}

/** An RPC that honours the block range it is asked for, so a backward walk behaves like one. */
function stub(logs: { blockNumber: string }[], over: Partial<RpcClient> = {}): RpcClient & { ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  const rpc = {
    ranges,
    getLogs: async (filter: { fromBlock: number; toBlock: number }) => {
      ranges.push([filter.fromBlock, filter.toBlock]);
      return logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber));
        return b >= filter.fromBlock && b <= filter.toBlock;
      });
    },
    sendBatchSettled: async (requests: { params: unknown[] }[]) =>
      requests.map((r) => ({ timestamp: `0x${(HEAD_TIME - (HEAD - Number(BigInt(String(r.params[0]))))).toString(16)}` })),
    callBatchSettled: async (calls: { to: string }[]) =>
      calls.map((_c, i) => (i % 2 === 0 ? `0x${word(32n)}${word(3n)}${Buffer.from("TKN").toString("hex").padEnd(64, "0")}` : `0x${word(32n)}${word(4n)}${Buffer.from("Nine").toString("hex").padEnd(64, "0")}`)),
    ...over,
  };
  return rpc as unknown as RpcClient & { ranges: [number, number][] };
}

const base = { fromBlock: 0, toBlock: HEAD, headTimestamp: HEAD_TIME, sliceSize: 1_000 };

test("the newest launch is the first row, and the walk stops once it has enough", async () => {
  const rpc = stub([launched(9_990, addr(1), addr(0xd1)), launched(9_995, addr(2), addr(0xd2)), launched(9_998, addr(3), addr(0xd3)), launched(100, addr(4), addr(0xd4))]);
  const feed = await readFeed(rpc, { ...base, limit: 2 });
  assert.deepEqual(feed.rows.map((r) => r.token), [addr(3), addr(2)]);
  // One slice of a thousand blocks was enough; the other nine thousand were never opened.
  assert.deepEqual(rpc.ranges, [[9_001, 10_000]]);
  assert.deepEqual(feed.window, { fromBlock: 9_001, toBlock: 10_000 });
  assert.deepEqual(feed.unread, { fromBlock: 0, toBlock: 9_000 });
});

test("a window read to its end admits nothing unread", async () => {
  const rpc = stub([launched(9_990, addr(1), addr(0xd1))]);
  const feed = await readFeed(rpc, { ...base, fromBlock: 9_500, limit: 30 });
  assert.equal(feed.rows.length, 1);
  assert.equal(feed.unread, null);
  assert.deepEqual(feed.window, { fromBlock: 9_500, toBlock: 10_000 });
});

test("a slice budget that runs out is unread too, not a quiet chain", async () => {
  const rpc = stub([launched(10, addr(1), addr(0xd1))]);
  const feed = await readFeed(rpc, { ...base, limit: 30, maxSlices: 2 });
  assert.equal(feed.rows.length, 0);
  assert.deepEqual(feed.unread, { fromBlock: 0, toBlock: 8_000 });
});

test("the age is read off the block, and an unreadable header leaves it blank rather than guessed", async () => {
  const good = await readFeed(stub([launched(9_940, addr(1), addr(0xd1))]), base);
  assert.equal(good.rows[0].timestamp, HEAD_TIME - 60);
  assert.equal(good.rows[0].ageSeconds, 60);

  const blind = await readFeed(
    stub([launched(9_940, addr(1), addr(0xd1))], { sendBatchSettled: async (r: unknown[]) => r.map(() => new RpcError("no header", -1, "eth_getBlockByNumber")) } as Partial<RpcClient>),
    base,
  );
  assert.equal(blind.rows[0].timestamp, null);
  assert.equal(blind.rows[0].ageSeconds, null);
});

test("a token that will not say its name is a blank ticker, not a failed feed", async () => {
  const rpc = stub([launched(9_990, addr(1), addr(0xd1))], {
    callBatchSettled: async (c: unknown[]) => c.map(() => new RpcError("reverted", 3, "eth_call")),
  } as Partial<RpcClient>);
  const feed = await readFeed(rpc, base);
  assert.equal(feed.rows.length, 1);
  assert.equal(feed.rows[0].symbol, null);
  assert.deepEqual(feed.namesUnread, [addr(1)]);
});

test("a symbol that does answer lands on the row", async () => {
  const feed = await readFeed(stub([launched(9_990, addr(1), addr(0xd1))]), base);
  assert.equal(feed.rows[0].symbol, "TKN");
  assert.equal(feed.rows[0].name, "Nine");
  assert.deepEqual(feed.namesUnread, []);
});

test("graduation and a sweep land on their own row, not on the neighbours", async () => {
  const rpc = stub([launched(9_900, addr(1), addr(0xd1)), launched(9_910, addr(2), addr(0xd2)), graduated(9_950, addr(1)), swept(9_960, addr(2))]);
  const feed = await readFeed(rpc, base);
  const one = feed.rows.find((r) => r.token === addr(1))!;
  const two = feed.rows.find((r) => r.token === addr(2))!;
  assert.equal(one.graduated, true);
  assert.equal(one.swept, false);
  assert.equal(two.swept, true);
  assert.equal(two.graduated, false);
});

test("a deployer who launched four times in the window carries the count on every row", async () => {
  const rpc = stub([9_910, 9_920, 9_930, 9_940].map((b, i) => launched(b, addr(i + 1), addr(0xdd))));
  const feed = await readFeed(rpc, base);
  assert.equal(feed.rows.length, 4);
  for (const row of feed.rows) assert.equal(row.deployerLaunches, 4);
});

test("a chain with no launchpad has no feed, and says why", async () => {
  assert.equal(feedBlocker(CHAINS.robinhood), null);
  // Base runs no launchpad BOUNCER knows, so there is no factory to walk.
  const noPad = feedBlocker(CHAINS.base);
  assert.ok(noPad && /launchpad/i.test(noPad), noPad ?? "Base reported a feed it cannot serve");
  const offChain = feedBlocker(CHAINS.solana);
  assert.ok(offChain && /Solana/i.test(offChain));
});
