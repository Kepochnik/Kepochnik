/**
 * The tape for a token with no curve. These are the cases that decide whether
 * a line is useful or noise: a sale is a transfer INTO a pool, a wallet the
 * caller named is reported at any size, and everything else has to be big
 * enough to matter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventTopic } from "../src/chain/abi.js";
import { ERC20_EVENTS } from "../src/chain/pons.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { addressTopic } from "../src/chain/tape.js";
import { readTokenWatchEvents, watchToken } from "../src/bouncer/tokenWatch.js";

const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const TOKEN = "0x00000000000000000000000000000000000000aa";
const POOL = "0x00000000000000000000000000000000000000b0";
const WHALE = "0x00000000000000000000000000000000000000c1";
const DUST = "0x00000000000000000000000000000000000000d2";
const DEV = "0x00000000000000000000000000000000000000e3";

function transfer(block: number, from: string, to: string, tokens: bigint, tx = `0x${block.toString(16).padStart(64, "0")}`) {
  return {
    address: TOKEN,
    topics: [eventTopic(ERC20_EVENTS.Transfer), addressTopic(from), addressTopic(to)],
    data: `0x${tokens.toString(16).padStart(64, "0")}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: tx,
    logIndex: "0x0",
  };
}

/** An RPC that serves one fixed set of logs and a fixed head. */
function stub(logs: unknown[], head = 100): RpcClient {
  return {
    getLogs: async () => logs,
    blockNumber: async () => head,
  } as unknown as RpcClient;
}

test("the tape names a sale by direction, not by guessing", async () => {
  const events = await readTokenWatchEvents(
    stub([
      transfer(10, WHALE, POOL, SUPPLY / 50n), // 2% sold into the pool
      transfer(11, POOL, WHALE, SUPPLY / 40n), // 2.5% taken out of it
      transfer(12, WHALE, DEV, SUPPLY / 20n), // 5% moved wallet to wallet
    ]),
    TOKEN,
    { fromBlock: 0, toBlock: 100, pools: [POOL], supply: SUPPLY },
  );
  assert.deepEqual(events.map((e) => e.kind), ["sold-into-pool", "bought-from-pool", "moved"]);
  assert.match(events[0].text, /sent .* into the pool/);
  assert.match(events[0].text, /2\.00% of supply/);
  assert.match(events[1].text, /out of the pool/);
});

test("mint and burn are not moves, and the burn address counts as a burn", async () => {
  const events = await readTokenWatchEvents(
    stub([
      transfer(10, "0x0000000000000000000000000000000000000000", WHALE, SUPPLY / 10n),
      transfer(11, WHALE, "0x000000000000000000000000000000000000dEaD", SUPPLY / 10n),
    ]),
    TOKEN,
    { fromBlock: 0, toBlock: 100, supply: SUPPLY },
  );
  assert.deepEqual(events.map((e) => e.kind), ["minted", "burned"]);
});

test("dust is dropped, but a watched wallet is reported at any size", async () => {
  const logs = [
    transfer(10, DUST, WHALE, E18), // one token out of a billion: noise
    transfer(11, DEV, WHALE, E18), // the same size, but the dev is watched
  ];
  const quiet = await readTokenWatchEvents(stub(logs), TOKEN, { fromBlock: 0, toBlock: 100, supply: SUPPLY });
  assert.equal(quiet.length, 0, "a transfer far below the threshold should not produce a line");

  const watched = await readTokenWatchEvents(stub(logs), TOKEN, { fromBlock: 0, toBlock: 100, supply: SUPPLY, watch: [DEV] });
  assert.equal(watched.length, 1);
  assert.equal(watched[0].wallets[0], DEV);
  assert.match(watched[0].text, /watched wallet/);
});

test("an unreadable supply reports every transfer rather than silently dropping them all", async () => {
  // shareBps is null when the supply is unknown, and a null must not be read as
  // "below the threshold" — that would turn a failed read into an empty tape.
  const events = await readTokenWatchEvents(stub([transfer(10, WHALE, POOL, E18)]), TOKEN, { fromBlock: 0, toBlock: 100, pools: [POOL], supply: 0n });
  assert.equal(events.length, 1);
  assert.equal(events[0].shareBps, null);
  assert.doesNotMatch(events[0].text, /% of supply/);
});

test("the loop advances its cursor past the head it already read", async () => {
  const seen: number[] = [];
  const cursor = await watchToken(stub([transfer(10, WHALE, POOL, SUPPLY / 50n)], 42), TOKEN, {
    fromBlock: 0,
    intervalMs: 0,
    maxRounds: 1,
    pools: [POOL],
    supply: SUPPLY,
    onEvent: (e) => { seen.push(e.block); },
    sleep: async () => {},
  });
  assert.deepEqual(seen, [10]);
  assert.equal(cursor, 43, "the next round must start after the block already scanned");
});

test("a busy token is read by narrowing the span, down to a single block", async () => {
  // USDC on Base is the real case: the endpoint answers 400 rather than
  // returning a partial page, and a floor of a thousand blocks would mean the
  // busiest tokens are the ones that cannot be watched at all.
  const MAX_SPAN = 1;
  const spans: number[] = [];
  const rpc = {
    blockNumber: async () => 100,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
      const span = toBlock - fromBlock + 1;
      spans.push(span);
      if (span > MAX_SPAN) throw new Error("query returned more than 10000 results");
      return fromBlock === 10 ? [transfer(10, WHALE, POOL, SUPPLY / 50n)] : [];
    },
  } as unknown as RpcClient;

  const events = await readTokenWatchEvents(rpc, TOKEN, { fromBlock: 0, toBlock: 20, pools: [POOL], supply: SUPPLY });
  assert.equal(events.length, 1, "the transfer must still be found once the span is small enough");
  assert.equal(events[0].kind, "sold-into-pool");
  assert.ok(spans.some((s) => s > MAX_SPAN), "it should start wide rather than crawling from block one");
  assert.ok(spans.includes(1), "and narrow all the way to a single block when that is what the endpoint takes");
});

test("an endpoint that refuses even a single block is an error, never a quietly empty tape", async () => {
  const rpc = {
    blockNumber: async () => 100,
    getLogs: async () => { throw new Error("upstream unavailable"); },
  } as unknown as RpcClient;
  await assert.rejects(
    () => readTokenWatchEvents(rpc, TOKEN, { fromBlock: 0, toBlock: 20, supply: SUPPLY }),
    /upstream unavailable/,
    "a failed read must not look like a quiet token",
  );
});

/**
 * A wallet the caller named is reported at any size, so this tape has to be
 * able to print a move below its own threshold — and "(0.00% of supply)"
 * reads as a measurement of nothing rather than as a move too small to round.
 */
test("a move too small to round says so rather than printing 0.00%", async () => {
  const dust = SUPPLY / 1_000_000n;
  const events = await readTokenWatchEvents(stub([transfer(10, DEV, POOL, dust)]), TOKEN, {
    fromBlock: 0,
    toBlock: 100,
    pools: [POOL],
    supply: SUPPLY,
    watch: [DEV],
  });
  assert.equal(events.length, 1, "a watched wallet is reported at any size");
  assert.ok(!events[0].text.includes("0.00%"), events[0].text);
  assert.match(events[0].text, /under 0\.01% of supply/);
  // A move that does round still prints its own number.
  const real = await readTokenWatchEvents(stub([transfer(10, DEV, POOL, SUPPLY / 20n)]), TOKEN, { fromBlock: 0, toBlock: 100, pools: [POOL], supply: SUPPLY });
  assert.match(real[0].text, /\(5\.00% of supply\)/);
});
