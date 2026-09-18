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
