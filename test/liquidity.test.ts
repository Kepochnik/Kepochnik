/**
 * Who holds the liquidity. Every case here is one where the wrong answer tells
 * somebody their money is safe when it is not, so the tests are written from
 * that direction: what would have to be true for this read to lie.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventTopic } from "../src/chain/abi.js";
import type { MarketPool } from "../src/chain/market.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { DEAD, ZERO, lockInWords, readV2Lock, readV3Lock } from "../src/chain/liquidity.js";

const E18 = 10n ** 18n;
const POOL = "0x00000000000000000000000000000000000000p0".slice(0, 42);
const LOCKER = "0x00000000000000000000000000000000000010c4";
const WALLET = "0x00000000000000000000000000000000000000a1";
const MANAGER = "0x0000000000000000000000000000000000000ff1";
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const addressWord = (a: string) => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

const v2Pool: MarketPool = { dex: "Test V2", kind: "v2", address: POOL, feeBps: 30, tokenIsToken0: true, tokenReserve: E18, quoteReserve: E18 };
const v3Pool: MarketPool = { ...v2Pool, kind: "v3", dex: "Test V3" };

/** An RPC whose LP token answers a fixed balance sheet. */
function lpRpc(supply: bigint, balances: Record<string, bigint>): RpcClient {
  return {
    callBatchSettled: async (calls: { data: string }[]) =>
      calls.map((call, i) => {
        if (i === 0) return word(supply);
        const who = `0x${call.data.slice(-40)}`;
        return word(balances[who.toLowerCase()] ?? 0n);
      }),
  } as unknown as RpcClient;
}

test("LP tokens at a burn address are gone; LP tokens in a wallet are not", async () => {
  const lock = await readV2Lock(lpRpc(100n * E18, { [DEAD]: 90n * E18, [WALLET]: 10n * E18 }), v2Pool, undefined, 1);
  assert.equal(lock.burnedBps, 9_000);
  assert.equal(lock.lockedBps, 0);
  assert.equal(lock.freeBps, 1_000, "the tenth held in a wallet must read as withdrawable");
  assert.match(lockInWords(lock), /90% burned/);
});

test("a locker BOUNCER knows is named; an unknown contract is never called locked", async () => {
  const known = await readV2Lock(lpRpc(100n * E18, { [LOCKER]: 100n * E18 }), v2Pool, { [LOCKER]: "TestLock" }, 1);
  assert.equal(known.lockedBps, 10_000);
  assert.equal(known.freeBps, 0);
  assert.match(lockInWords(known), /TestLock/);

  // The same address with no entry in the table. It still has bytecode, it is
  // still holding everything — and it must NOT be reported as locked, because
  // plenty of contracts withdraw on somebody's say-so.
  const unknown = await readV2Lock(lpRpc(100n * E18, { [LOCKER]: 100n * E18 }), v2Pool, undefined, 1);
  assert.equal(unknown.lockedBps, 0);
  assert.equal(unknown.freeBps, 10_000);
  assert.match(lockInWords(unknown), /100% withdrawable/);
});

test("LP tokens nobody enumerated are withdrawable, not missing", async () => {
  // Nothing burned, nothing in a known locker: the whole supply is out there.
  const lock = await readV2Lock(lpRpc(100n * E18, {}), v2Pool, undefined, 1);
  assert.equal(lock.freeBps, 10_000);
  assert.match(lock.unread, /any of them can withdraw/);
});

test("an LP token that will not answer says so instead of reporting zero", async () => {
  const dead = { callBatchSettled: async () => { throw new Error("no"); } } as unknown as RpcClient;
  const lock = await readV2Lock(dead, v2Pool, undefined, 1);
  assert.equal(lock.burnedBps, 0);
  assert.equal(lock.freeBps, 0, "a failed read must not be dressed up as a finding either way");
  assert.match(lock.unread, /did not answer/);
});

/** A V3 stub: one Mint owned by the position manager, whose NFT belongs to `nftOwner`. */
function v3Rpc(nftOwner: string, positionOwner = MANAGER): RpcClient {
  const mintTopic = eventTopic({
    name: "Mint",
    inputs: [
      { name: "sender", type: "address", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: true },
      { name: "tickUpper", type: "int24", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  });
  const increaseTopic = eventTopic({
    name: "IncreaseLiquidity",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  });
  return {
    getLogs: async () => [
      {
        address: POOL,
        topics: [mintTopic, addressWord(positionOwner), word(0n), word(60n)],
        data: addressWord(WALLET).slice(2) === "" ? "0x" : `0x${addressWord(WALLET).slice(2)}${word(1000n).slice(2)}${word(1n).slice(2)}${word(1n).slice(2)}`,
        blockNumber: "0xa",
        transactionHash: `0x${"1".repeat(64)}`,
        logIndex: "0x0",
      },
    ],
    sendBatchSettled: async (requests: { method: string }[]) =>
      requests.map((r) =>
        r.method === "eth_getTransactionReceipt"
          ? { logs: [{ address: MANAGER, topics: [increaseTopic, word(7n)], data: `0x${word(1000n).slice(2)}${word(1n).slice(2)}${word(1n).slice(2)}` }] }
          : "0x60806040",
      ),
    callBatchSettled: async () => [addressWord(nftOwner)],
  } as unknown as RpcClient;
}

test("a V3 position is traced through the manager to whoever holds the NFT", async () => {
  const burned = await readV3Lock(v3Rpc(DEAD), v3Pool, undefined, MANAGER, 100, { fromBlock: 0 });
  assert.equal(burned.burnedBps, 10_000, "an NFT sent to the burn address is liquidity nobody can take back");
  assert.equal(burned.freeBps, 0);

  const held = await readV3Lock(v3Rpc(WALLET), v3Pool, undefined, MANAGER, 100, { fromBlock: 0 });
  assert.equal(held.freeBps, 10_000, "an NFT in a wallet is liquidity that wallet can withdraw whenever it likes");
  assert.equal(held.holders[0].address, WALLET.toLowerCase());
});

test("a V3 pool whose manager is unknown says so rather than reporting the manager as the owner", async () => {
  const lock = await readV3Lock(v3Rpc(WALLET), v3Pool, undefined, undefined, 100, { fromBlock: 0 });
  assert.equal(lock.freeBps, 10_000, "unresolved is counted as withdrawable, never as safe");
  assert.match(lock.unread, /position manager is not in BOUNCER's table/);
});

test("a V3 pool with no mints in the window is reported as unread, not as an empty pool", async () => {
  const empty = { getLogs: async () => [] } as unknown as RpcClient;
  const lock = await readV3Lock(empty, v3Pool, undefined, MANAGER, 100, { fromBlock: 50 });
  assert.equal(lock.holders.length, 0);
  assert.match(lock.unread, /no position was opened/);
  assert.match(lockInWords(lock), /no position was opened/);
});

test("the zero address counts as burned wherever it turns up", async () => {
  const lock = await readV2Lock(lpRpc(100n * E18, { [ZERO]: 100n * E18 }), v2Pool, undefined, 1);
  assert.equal(lock.burnedBps, 10_000);
});
