/**
 * How loudly an unlocked pool should be said.
 *
 * A live run made the problem plain. USDT on BNB Chain — a top-three token by
 * transfers on the chain — got a STOP reading "whoever holds it can take the
 * pool away". True of the PancakeSwap V2 pool, and useless as a warning: that
 * pool's LP is spread over thousands of ordinary providers and not one of
 * them can empty it. A STOP that fires on USDT is a STOP nobody reads.
 *
 * What makes an unlocked pool dangerous is one address being able to empty
 * it. So the tests here are about telling those two apart — and about the
 * third case, where the holders were never enumerated and claiming either
 * shape would be invented.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { doorNotes, type DoorSlip } from "../src/bouncer/door.js";
import type { PoolLock, LiquidityHolder } from "../src/chain/liquidity.js";

const POOL = "0x00000000000000000000000000000000000000p0".slice(0, 42);

function lock(holders: LiquidityHolder[], over = 10_000): PoolLock {
  return {
    pool: POOL,
    dex: "PancakeSwap V2",
    kind: "v2",
    read: true,
    burnedBps: 0,
    lockedBps: 0,
    freeBps: 10_000,
    partial: false,
    positionsFound: holders.length,
    positionsRead: holders.length,
    holders,
    shareOfLiquidityBps: over,
    unread: "",
  };
}

const holder = (n: number, shareBps: number): LiquidityHolder => ({
  address: `0x${String(n).repeat(40)}`,
  kind: "wallet",
  shareBps,
});

/** The smallest slip doorNotes will read: an unregistered token with one pool and a lock. */
function slipWith(liquidity: PoolLock): DoorSlip {
  return {
    chain: { key: "bnb", name: "BNB Chain", chainId: 56, launchpad: null, native: { symbol: "BNB", decimals: 18 } },
    at: { block: 1, timestamp: 0 },
    subject: "0x1111111111111111111111111111111111111111",
    stamp: "NOT A LAUNCH",
    id: {
      input: "0x1111111111111111111111111111111111111111",
      resolvedAs: "token",
      registered: false,
      launchpad: null,
      launch: null,
      v1: null,
      token: { address: "0x1111111111111111111111111111111111111111", code: { empty: false, minimalProxyTarget: null, opcodes: {} }, proxyImplementation: null, proxyBeacon: null },
      meta: { symbol: "USDT", name: "Tether", decimals: 18, totalSupply: 10n ** 24n },
    },
    open: {
      surfaceFrom: "token",
      powers: [],
      ownable: false,
      owner: null,
      paused: null,
      tradingOpen: null,
      selectors: 0,
      probes: [],
      pools: [{ dex: "PancakeSwap V2", kind: "v2", address: POOL, feeBps: 30, tokenIsToken0: true, tokenReserve: 1n, quoteReserve: 1n }],
      market: null,
      liquidity,
      holders: null,
      deployer: null,
      activity: null,
      verified: null,
      explorer: null,
      explorerError: null,
      transfersBlocked: null,
    },
    notes: [],
    skipped: [],
  } as unknown as DoorSlip;
}

const noteOf = (l: PoolLock) => doorNotes(slipWith(l)).find((n) => n.code === "liquidity-free");

test("an unlocked pool spread over many holders is not a STOP", async () => {
  // Five holders, largest a fifth. This is USDT on PancakeSwap: nothing is
  // locked and nothing about it is a trap.
  const n = noteOf(lock([holder(1, 2_500), holder(2, 2_200), holder(3, 2_000), holder(4, 1_800), holder(5, 1_500)]));
  assert.ok(n);
  assert.equal(n.level, "watch", "an ordinary unlocked pool is worth knowing about, not worth a STOP");
  assert.match(n.text, /spread across 5 holders/);
  assert.match(n.text, /no single one can empty the pool/);
  assert.doesNotMatch(n.text, /take the pool away/, "nobody here can");
});

test("an unlocked pool where one address holds most of it is a STOP", async () => {
  const n = noteOf(lock([holder(1, 7_000), holder(2, 1_500), holder(3, 1_500)]));
  assert.ok(n);
  assert.equal(n.level, "stop");
  assert.match(n.text, /one address holds 70/);
  assert.match(n.text, /can take most of the pool away on its own/);
});

test("the boundary is a majority, and it is not off by one", async () => {
  assert.equal(noteOf(lock([holder(1, 4_999), holder(2, 5_001)]))?.level, "stop", "5001 bps is a majority");
  assert.equal(noteOf(lock([holder(1, 4_900), holder(2, 4_900), holder(3, 200)]))?.level, "watch");
});

test("holders nobody enumerated stay a STOP, and say why", async () => {
  // A V2 read only asks the burn addresses and the lockers it knows, so the
  // withdrawable share is held by addresses nobody listed. Reporting that as
  // "spread across 0 holders" would be the worst of both readings.
  const n = noteOf(lock([]));
  assert.ok(n);
  assert.equal(n.level, "stop");
  assert.match(n.text, /was not enumerated/);
  assert.match(n.text, /one address or ten thousand is unknown/);
  assert.doesNotMatch(n.text, /spread across/);
});

test("a pool holding a sliver of the market is information whatever its shape", async () => {
  // Concentration in a pool nobody trades through is not a warning.
  const n = noteOf(lock([holder(1, 9_000), holder(2, 1_000)], 50));
  assert.ok(n);
  assert.equal(n.level, "info");
  assert.match(n.text, /0\.5% of this token's liquidity/);
});

test("a read that did not happen is never shown as three zeroes", async () => {
  // A live BNB run printed "0% burned, 0% locked, 0% withdrawable" for two of
  // three tokens. Three zeroes add to zero, not a hundred, so they were
  // plainly not a reading — but only to somebody checking the arithmetic. The
  // receipt now asks the flag.
  const { doorReceipt } = await import("../src/bouncer/door.js");
  const unread: PoolLock = { ...lock([]), read: false, freeBps: 0, unread: "the endpoint did not answer the liquidity history within 30 seconds" };
  const rows = doorReceipt(slipWith(unread)).sections.flatMap((s) => s.rows);
  const row = rows.find((r) => String(r.label).startsWith("liquidity"));
  assert.ok(row);
  assert.match(String(row.value), /did not answer/);
  assert.doesNotMatch(String(row.value), /0\.0% burned/, "zeroes from a read that never ran must not be printed as shares");
});

test("an unlocked pool with nothing to list still shows its shares", async () => {
  // The mirror image, and the bug the flag also fixes. A V2 read asks the
  // burn addresses and the lockers; a pool with neither has no holders to
  // list, and counting holders hid a real 100%-withdrawable reading behind
  // "not read".
  const { doorReceipt } = await import("../src/bouncer/door.js");
  const rows = doorReceipt(slipWith(lock([]))).sections.flatMap((s) => s.rows);
  const row = rows.find((r) => String(r.label).startsWith("liquidity"));
  assert.ok(row);
  assert.match(String(row.value), /100\.0% withdrawable/);
});
