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
import { DEAD, ZERO, lockInWords, nameHolders, readV2Lock, readV3Lock, type PoolLock } from "../src/chain/liquidity.js";

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

test("a partial read is never phrased as a fact about the pool", async () => {
  // The live case that prompted this: 106 positions in the pool, twelve read,
  // none of those twelve burned or locked. "100% withdrawable" was true of the
  // sample and false of the pool, whose launch position is locked.
  const many = Array.from({ length: 30 }, (_, i) => i);
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
  const rpc = {
    getLogs: async () =>
      many.map((i) => ({
        address: POOL,
        topics: [mintTopic, addressWord(WALLET), word(BigInt(i)), word(BigInt(i + 60))],
        data: `0x${addressWord(WALLET).slice(2)}${word(1000n).slice(2)}${word(1n).slice(2)}${word(1n).slice(2)}`,
        blockNumber: `0x${(10 + i).toString(16)}`,
        transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
        logIndex: "0x0",
      })),
    sendBatchSettled: async (requests: { method: string }[]) => requests.map(() => "0x60806040"),
    callBatchSettled: async () => [],
  } as unknown as RpcClient;

  const lock = await readV3Lock(rpc, v3Pool, undefined, MANAGER, 100, { fromBlock: 0, maxPositions: 5 });
  assert.equal(lock.partial, true);
  assert.equal(lock.positionsFound, 30);
  assert.equal(lock.positionsRead, 5);
  const words = lockInWords(lock);
  assert.match(words, /of the 5 positions read \(of 30\)/, "the sentence must say what it covered");
  assert.match(lock.unread, /not of the pool/);

  // And when everything was read, no such hedge appears.
  const full = await readV3Lock(rpc, v3Pool, undefined, MANAGER, 100, { fromBlock: 0, maxPositions: 100 });
  assert.equal(full.partial, false);
  assert.doesNotMatch(lockInWords(full), /positions read/);
});

test("a busy pool cannot spend an unbounded number of requests", async () => {
  // The Base failure this exists to prevent: on the USDC/WETH pool the
  // endpoint refuses every wide chunk, the span halves to a single block, and
  // a 300,000-block window becomes 300,000 requests. Ten minutes of a door,
  // and nothing to show for it.
  let requests = 0;
  const rpc = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
      requests++;
      // Anything wider than one block is "too many results", exactly as a busy
      // pool behaves.
      if (toBlock - fromBlock + 1 > 1) throw new Error("query returned more than 10000 results");
      return [];
    },
  } as unknown as RpcClient;

  const lock = await readV3Lock(rpc, v3Pool, undefined, MANAGER, 300_000, { fromBlock: 0, maxRequests: 25 });
  assert.ok(requests <= 25, `the walk must stop at its budget; it spent ${requests} requests`);
  assert.match(lock.unread, /ran out of budget/, "an unfinished walk must not read as 'no positions'");
  assert.equal(lock.partial, true);
});

test("a truncated window makes the read partial, so its shares are never stated as the pool's", async () => {
  // Being cut short is exactly the case where "100% withdrawable" would be a
  // confident lie, so it has to set the same flag a position cap does.
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
  const rpc = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
      if (toBlock - fromBlock + 1 > 10) throw new Error("too many results");
      return fromBlock === 0
        ? [{
            address: POOL,
            topics: [mintTopic, addressWord(WALLET), word(0n), word(60n)],
            data: `0x${addressWord(WALLET).slice(2)}${word(1000n).slice(2)}${word(1n).slice(2)}${word(1n).slice(2)}`,
            blockNumber: "0x1",
            transactionHash: `0x${"5".repeat(64)}`,
            logIndex: "0x0",
          }]
        : [];
    },
    sendBatchSettled: async (requests: { method: string }[]) => requests.map(() => "0x60806040"),
    callBatchSettled: async () => [],
  } as unknown as RpcClient;

  // Budget enough to get past the halving and find the log, not enough to
  // finish the window — which is the case being pinned.
  const lock = await readV3Lock(rpc, v3Pool, undefined, MANAGER, 100_000, { fromBlock: 0, maxRequests: 20 });
  assert.equal(lock.partial, true, "a window that was not finished must not read as a statement about the pool");
  assert.match(lockInWords(lock), /positions read/);
});

test("a failed receipt batch costs the NFT owners, not the whole section", async () => {
  // Measured on Base twice: sixty seconds of mint history read, then one
  // batch of receipts failed as a whole and the entire liquidity section came
  // back MISSING. The positions are still known; only who holds their NFTs is
  // not, and unresolved already counts as withdrawable.
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
  const rpc = {
    getLogs: async () => [
      {
        address: POOL,
        topics: [mintTopic, addressWord(MANAGER), word(0n), word(60n)],
        data: `0x${addressWord(WALLET).slice(2)}${word(1000n).slice(2)}${word(1n).slice(2)}${word(1n).slice(2)}`,
        blockNumber: "0xa",
        transactionHash: `0x${"7".repeat(64)}`,
        logIndex: "0x0",
      },
    ],
    // The whole batch fails, as a transport error does.
    sendBatchSettled: async () => { throw new Error("upstream closed the connection"); },
    callBatchSettled: async () => [],
  } as unknown as RpcClient;

  const lock = await readV3Lock(rpc, v3Pool, undefined, MANAGER, 100, { fromBlock: 0 });
  assert.ok(lock.holders.length > 0, "the positions were read and must not be thrown away");
  assert.equal(lock.freeBps, 10_000, "an unresolved holder counts as able to withdraw");
  assert.match(lock.unread, /could not be traced to an NFT holder/);
});

test("an explorer name says what is holding the liquidity — and does not make it locked", async () => {
  // The dangerous version of this feature: the explorer says the contract
  // calls itself "UNCX_ProofOfReservesV2", and the slip quietly promotes it to
  // "locked". A name is a label somebody chose. It is not a lock.
  const lock: PoolLock = {
    pool: POOL,
    dex: "Test V3",
    kind: "v3",
    burnedBps: 0,
    lockedBps: 0,
    freeBps: 10_000,
    partial: false,
    positionsFound: 1,
    positionsRead: 1,
    holders: [{ address: LOCKER, kind: "contract", shareBps: 10_000 }],
    unread: "",
  };
  const named = await nameHolders(lock, async () => "UNCX_ProofOfReservesV2");
  assert.equal(named.holders[0].name, "UNCX_ProofOfReservesV2");
  assert.equal(named.holders[0].namedByExplorer, true, "the reader must be able to tell where the name came from");
  assert.equal(named.holders[0].kind, "contract", "a name must never promote a holder to locked");
  assert.equal(named.lockedBps, 0);
  assert.equal(named.freeBps, 10_000, "and it must not move a single basis point out of withdrawable");
});

test("naming never costs the liquidity read: no explorer, a silent one, or a broken one", async () => {
  const base: PoolLock = {
    pool: POOL,
    dex: "Test V3",
    kind: "v3",
    burnedBps: 0,
    lockedBps: 0,
    freeBps: 10_000,
    partial: false,
    positionsFound: 1,
    positionsRead: 1,
    holders: [{ address: LOCKER, kind: "contract", shareBps: 6_000 }, { address: WALLET, kind: "wallet", shareBps: 4_000 }],
    unread: "",
  };
  const clone = (): PoolLock => ({ ...base, holders: base.holders.map((h) => ({ ...h })) });

  assert.equal((await nameHolders(clone(), undefined)).holders[0].name, undefined);
  assert.equal((await nameHolders(clone(), async () => null)).holders[0].namedByExplorer, undefined, "an unnamed contract must not be marked as named");

  // An explorer that 429s mid-read used to be able to take the whole section
  // down, because this runs inside the try that sets liquidity to null.
  const survived = await nameHolders(clone(), async () => { throw new Error("blockscout 429"); });
  assert.equal(survived.holders.length, 2);
  assert.equal(survived.freeBps, 10_000);
});

test("only contracts are asked about, and only the first few of them", async () => {
  const asked: string[] = [];
  const holders = Array.from({ length: 9 }, (_, i) => ({
    address: `0x${String(i).repeat(40)}`,
    kind: (i === 0 ? "wallet" : "contract") as "wallet" | "contract",
    shareBps: 1_000,
  }));
  await nameHolders({ pool: POOL, dex: "d", kind: "v3", burnedBps: 0, lockedBps: 0, freeBps: 10_000, partial: false, positionsFound: 9, positionsRead: 9, holders, unread: "" }, async (a) => {
    asked.push(a);
    return null;
  });
  // A wallet has no published name and asking about one is a wasted request
  // against a rate-limited explorer; eight contracts must not become eight.
  assert.ok(!asked.includes(holders[0].address), "a wallet has nothing for the explorer to name");
  assert.equal(asked.length, 6);
});
