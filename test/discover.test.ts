/**
 * Finding a DEX nobody wrote down.
 *
 * A DEX table is a list somebody typed, so every chain has venues it misses —
 * Ramses on Robinhood Chain was the one that forced this. The tempting fix is
 * to guess the factory address. The danger of this fix is the opposite one:
 * a search that finds a "pool" that is not one, or that prices a pool with
 * the wrong formula. Both are tested here, from that direction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCall, type Hex, type StaticType } from "../src/chain/abi.js";
import { canPrice, discoverPools } from "../src/chain/market.js";
import type { RpcClient } from "../src/chain/rpc.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const WETH = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const POOL = "0x4444444444444444444444444444444444444444";
const NOT_A_POOL = "0x5555555555555555555555555555555555555555";

const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;
const addressWord = (a: string): Hex => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
const sel = (name: string, inputs: StaticType[] = [], args: unknown[] = []) => encodeCall({ name, inputs, outputs: [] }, args).slice(0, 10);

/** The four-byte selector each call starts with, so a stub can answer by name. */
const SELECTORS = {
  token0: sel("token0"),
  token1: sel("token1"),
  slot0: sel("slot0"),
  stable: sel("stable"),
  getReserves: sel("getReserves"),
  fee: sel("fee"),
  balanceOf: sel("balanceOf", ["address"], ["0x0000000000000000000000000000000000000000"]),
};

/**
 * An RPC where each address answers from a table. Anything not in its table
 * reverts, which is what a contract that is not a pool really does.
 */
function rpcOf(answers: Record<string, Record<string, Hex>>): RpcClient {
  const reply = (call: { to: string; data: string }): Hex | Error => {
    const forAddress = answers[call.to.toLowerCase()];
    const out = forAddress?.[call.data.slice(0, 10)];
    return out ?? new Error("execution reverted");
  };
  return {
    callBatchSettled: async (calls: { to: string; data: string }[]) => calls.map(reply),
    callBatch: async (calls: { to: string; data: string }[]) =>
      calls.map((c) => {
        const out = reply(c);
        if (out instanceof Error) throw out;
        return out;
      }),
  } as unknown as RpcClient;
}

/** A pair of token0/token1 answers. */
const pair = (a: string, b: string): Record<string, Hex> => ({ [SELECTORS.token0]: addressWord(a), [SELECTORS.token1]: addressWord(b) });
const reserves = (r0: bigint, r1: bigint): Record<string, Hex> => ({ [SELECTORS.getReserves]: `0x${word(r0).slice(2)}${word(r1).slice(2)}${word(0n).slice(2)}` as Hex });
const balances = (amount: bigint): Record<string, Hex> => ({ [SELECTORS.balanceOf]: word(amount) });

test("a contract that is a pool for this exact pair is found; one for another pair is not", async () => {
  const rpc = rpcOf({
    [POOL]: { ...pair(TOKEN, WETH), ...reserves(1_000n, 500n) } as Record<string, Hex>,
    // Our token, but paired against something else. Pricing this token
    // against it would be arithmetic on the wrong market.
    [NOT_A_POOL]: { ...pair(TOKEN, OTHER), ...reserves(9_999n, 9_999n) },
    [TOKEN]: balances(1_000n),
    [WETH]: balances(500n),
  });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: POOL }, { address: NOT_A_POOL }], 100);
  assert.equal(found.length, 1);
  assert.equal(found[0].address, POOL);
  assert.equal(found[0].kind, "v2", "it answered getReserves() and nothing else, so it is a V2 pool");
  assert.equal(found[0].tokenIsToken0, true);
});

test("a contract that answers nothing is not a pool, and neither is a wallet", async () => {
  const rpc = rpcOf({ [NOT_A_POOL]: {} });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: NOT_A_POOL }, { address: OTHER }], 100);
  assert.deepEqual(found, []);
});

test("the token itself and the quote asset are never candidates", async () => {
  // Both hold enormous balances and both are contracts, so both turn up in
  // any holder list. Neither is a pool, and asking them costs four calls.
  let asked = 0;
  const rpc = {
    callBatchSettled: async (calls: unknown[]) => {
      asked += calls.length;
      return calls.map(() => new Error("reverted"));
    },
  } as unknown as RpcClient;
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: TOKEN }, { address: WETH.toUpperCase() }], 100);
  assert.deepEqual(found, []);
  assert.equal(asked, 0, "neither should have been asked at all");
});

test("a pool already found by a factory is not asked about again", async () => {
  let asked = 0;
  const rpc = {
    callBatchSettled: async (calls: unknown[]) => {
      asked += calls.length;
      return calls.map(() => new Error("reverted"));
    },
  } as unknown as RpcClient;
  await discoverPools(rpc, TOKEN, WETH, [{ address: POOL }], 100, new Set([POOL]));
  assert.equal(asked, 0);
});

test("a concentrated pool is recognised as one and never priced by constant product", async () => {
  // This is the failure that matters. A Ramses CL pool holds both tokens, so
  // its raw balances look exactly like reserves — and constant product over
  // them overstates a large sale by the most, which is the sale people paste
  // this tool for.
  const rpc = rpcOf({
    [POOL]: {
      ...pair(TOKEN, WETH),
      [SELECTORS.slot0]: `0x${word(2n ** 96n).slice(2)}${word(0n).slice(2)}${word(0n).slice(2)}${word(0n).slice(2)}${word(0n).slice(2)}${word(0n).slice(2)}${word(1n).slice(2)}`,
      [SELECTORS.fee]: word(3_000n),
    },
    [TOKEN]: balances(1_000n),
    [WETH]: balances(500n),
  });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: POOL }], 100);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "v3");
  assert.equal(found[0].feeBps, 30, "the fee is read off the pool, not assumed");
  // It answered no liquidity(), so there is nothing to price with — and the
  // constant-product path must not be reached as a fallback.
  assert.equal(canPrice(found[0]), false);
});

test("a stable Solidly pool is recognised, and is not priced", async () => {
  const rpc = rpcOf({
    [POOL]: { ...pair(WETH, TOKEN), [SELECTORS.stable]: word(1n), ...reserves(500n, 1_000n) },
    [TOKEN]: balances(1_000n),
    [WETH]: balances(500n),
  });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: POOL }], 100);
  assert.equal(found[0].kind, "solidly");
  assert.equal(found[0].stable, true);
  assert.equal(found[0].tokenIsToken0, false, "the token sorts second here, and every formula turns on that");
  assert.equal(canPrice(found[0]), false, "a stable pool uses an invariant this tool does not implement");
});

test("a pool of an unknown shape keeps its reserves and is never priced", async () => {
  const rpc = rpcOf({
    [POOL]: pair(TOKEN, WETH),
    [TOKEN]: balances(1_000n),
    [WETH]: balances(500n),
  });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: POOL, name: "SomeDEX: Pool" }], 100);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "unknown");
  assert.equal(found[0].dex, "SomeDEX: Pool", "the explorer's name is the only thing that can name the venue");
  assert.equal(found[0].tokenReserve, 1_000n, "the balances are real and worth showing");
  assert.equal(canPrice(found[0]), false, "and the invariant is not guessed");
});

test("an unnamed venue says it is unidentified rather than borrowing a name", async () => {
  const rpc = rpcOf({ [POOL]: { ...pair(TOKEN, WETH), ...reserves(1n, 1n) }, [TOKEN]: balances(1n), [WETH]: balances(1n) });
  const found = await discoverPools(rpc, TOKEN, WETH, [{ address: POOL, name: null }], 100);
  assert.match(found[0].dex, /unidentified/);
});

test("an endpoint that refuses the whole batch finds nothing rather than throwing", async () => {
  const rpc = { callBatchSettled: async () => { throw new Error("upstream closed the connection"); } } as unknown as RpcClient;
  assert.deepEqual(await discoverPools(rpc, TOKEN, WETH, [{ address: POOL }], 100), []);
});
