/**
 * The tape has to be right about three things or it is worse than nothing:
 * which side a trade was, how big it was, and whether the name on the row is
 * a person the chain named or an address the tape found. A tape that calls a
 * sell a buy is a tape that shows a token being bought while it is being
 * dumped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventTopic } from "../src/chain/abi.js";
import type { MarketPool } from "../src/chain/market.js";
import { CURVE_EVENTS } from "../src/chain/pons.js";
import { V2_SWAP, V3_SWAP } from "../src/chain/priceSeries.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { addressTopic } from "../src/chain/tape.js";
import { readTrades } from "../src/bouncer/trades.js";

const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const CURVE = "0x00000000000000000000000000000000000000c0";
const POOL = "0x00000000000000000000000000000000000000b0";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";

const u = (n: bigint) => n.toString(16).padStart(64, "0");
/** Two's complement for the signed amounts a V3 swap carries. */
const i = (n: bigint) => (n < 0n ? ((1n << 256n) + n).toString(16).padStart(64, "0") : u(n));

function curveBuy(block: number, buyer: string, quoteIn: bigint, tokensOut: bigint) {
  return {
    address: CURVE,
    topics: [eventTopic(CURVE_EVENTS.CurveBuy), addressTopic(buyer), addressTopic(buyer)],
    data: `0x${u(quoteIn)}${u(tokensOut)}${u(quoteIn / 100n)}${u(quoteIn / 50n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  };
}

function curveSell(block: number, seller: string, tokensIn: bigint, quoteOut: bigint) {
  return {
    address: CURVE,
    topics: [eventTopic(CURVE_EVENTS.CurveSell), addressTopic(seller), addressTopic(seller)],
    data: `0x${u(tokensIn)}${u(quoteOut)}${u(0n)}${u(0n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${(block + 500).toString(16).padStart(64, "0")}`,
    logIndex: "0x1",
  };
}

/** token0 is the subject; a positive amount0 means tokens went INTO the pool. */
function v3Swap(block: number, to: string, amount0: bigint, amount1: bigint) {
  return {
    address: POOL,
    topics: [eventTopic(V3_SWAP), addressTopic(to), addressTopic(to)],
    data: `0x${i(amount0)}${i(amount1)}${u(1n << 96n)}${u(1n)}${u(0n)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  };
}

function v2Swap(block: number, to: string, a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint) {
  return {
    address: POOL,
    topics: [eventTopic(V2_SWAP), addressTopic(to), addressTopic(to)],
    data: `0x${u(a0In)}${u(a1In)}${u(a0Out)}${u(a1Out)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  };
}

function stub(logs: unknown[], fail?: string): RpcClient {
  return {
    getLogs: async () => {
      if (fail) throw new Error(fail);
      return logs;
    },
  } as unknown as RpcClient;
}

const pool = (kind: MarketPool["kind"], tokenIsToken0 = true): MarketPool => ({
  dex: "Uniswap V3",
  kind,
  address: POOL,
  feeBps: 30,
  tokenIsToken0,
  tokenReserve: null,
  quoteReserve: null,
});

const window = { fromBlock: 0, toBlock: 100, supply: SUPPLY, tokenDecimals: 18 };

test("a curve names the trader, and the sides are not swapped", async () => {
  const tape = await readTrades(
    stub([curveBuy(10, ALICE, E18, 1_000_000n * E18), curveSell(11, BOB, 500_000n * E18, E18 / 2n)]),
    { kind: "curve", curve: CURVE, venue: "Pons V2" },
    window,
  );
  assert.equal(tape.unread, null);
  // Newest first.
  assert.deepEqual(tape.trades.map((t) => [t.side, t.wallet]), [["sell", BOB], ["buy", ALICE]]);
  assert.equal(tape.trades[1].walletExact, true);
  assert.equal(tape.buys, 1);
  assert.equal(tape.sells, 1);
  assert.equal(tape.boughtQuote, E18);
  assert.equal(tape.soldQuote, E18 / 2n);
});

test("the size is a share of supply and the price is what the trade actually paid", async () => {
  // 1 ETH for 1% of a billion supply: 0.0001 ETH a token.
  const tape = await readTrades(stub([curveBuy(10, ALICE, E18, SUPPLY / 100n)]), { kind: "curve", curve: CURVE, venue: "Pons V2" }, window);
  assert.equal(tape.trades[0].shareBps, 100);
  assert.equal(tape.trades[0].price, E18 / 10_000_000n);
  assert.equal(tape.trades[0].feeQuote, E18 / 100n);
  assert.equal(tape.trades[0].taxQuote, E18 / 50n);
});

test("a V3 swap with tokens going into the pool is a sell, whichever slot the token sits in", async () => {
  const asToken0 = await readTrades(stub([v3Swap(10, ALICE, 1_000n * E18, -E18)]), { kind: "pool", pool: pool("v3", true) }, window);
  assert.equal(asToken0.trades[0].side, "sell");
  assert.equal(asToken0.trades[0].tokens, 1_000n * E18);
  assert.equal(asToken0.trades[0].quote, E18);

  // Same log, token in slot 1: now amount1 is the token leg, so it is a buy.
  const asToken1 = await readTrades(stub([v3Swap(10, ALICE, 1_000n * E18, -E18)]), { kind: "pool", pool: pool("v3", false) }, window);
  assert.equal(asToken1.trades[0].side, "buy");
  assert.equal(asToken1.trades[0].tokens, E18);
});

test("a pool address is where the tokens went, and the tape does not pretend otherwise", async () => {
  const tape = await readTrades(stub([v3Swap(10, ALICE, -1_000n * E18, E18)]), { kind: "pool", pool: pool("v3") }, window);
  assert.equal(tape.trades[0].side, "buy");
  assert.equal(tape.trades[0].walletExact, false);
});

test("a V2 swap reads its four amounts", async () => {
  const tape = await readTrades(stub([v2Swap(10, BOB, 0n, E18, 1_000n * E18, 0n)]), { kind: "pool", pool: pool("v2") }, window);
  assert.equal(tape.trades[0].side, "buy");
  assert.equal(tape.trades[0].tokens, 1_000n * E18);
  assert.equal(tape.trades[0].quote, E18);
});

test("a pool shape with no swap log this reads says so rather than showing an empty tape", async () => {
  const tape = await readTrades(stub([]), { kind: "pool", pool: pool("solana" as MarketPool["kind"]) }, window);
  assert.match(tape.unread ?? "", /not read here/);
  assert.equal(tape.trades.length, 0);
});

test("a refused log walk is a reason, never a quiet token", async () => {
  const tape = await readTrades(stub([], "range too wide"), { kind: "curve", curve: CURVE, venue: "Pons V2" }, window);
  assert.match(tape.unread ?? "", /range too wide/);
  assert.equal(tape.trades.length, 0);
});

test("the limit cuts the tape but the counts still describe the whole window", async () => {
  const logs = Array.from({ length: 10 }, (_, n) => curveBuy(10 + n, ALICE, E18, 1_000n * E18));
  const tape = await readTrades(stub(logs), { kind: "curve", curve: CURVE, venue: "Pons V2" }, { ...window, limit: 3 });
  assert.equal(tape.trades.length, 3);
  assert.equal(tape.total, 10);
  assert.equal(tape.buys, 10);
  assert.equal(tape.boughtQuote, 10n * E18);
  // Newest kept, not the first three.
  assert.deepEqual(tape.trades.map((t) => t.block), [19, 18, 17]);
});
