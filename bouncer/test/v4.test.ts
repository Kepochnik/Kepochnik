/**
 * Uniswap V4. The two things worth pinning: a pool with no factory to ask is
 * still found exactly, and a V4 pool is priced with concentrated arithmetic
 * rather than falling into the constant-product branch, where its reserves —
 * which live in a singleton and so read as null — would quote a sale at zero.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventTopic, encodeWord } from "../src/chain/abi.js";
import { canPrice, depth, quoteSale, readMarket, spotPrice, type MarketPool } from "../src/chain/market.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { V4_EVENTS, hookNote, readV4Pools, type V4Pool } from "../src/chain/v4.js";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const WETH = "0x00000000000000000000000000000000000000ee";
const MANAGER = "0x0000000000000000000000000000000000000f00";
const HOOK = "0x0000000000000000000000000000000000000h00".replace("h", "b");
const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 2n ** 96n;

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const addressTopicOf = (a: string) => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

/** One Initialize log, and extsload answers for its slot0 and liquidity. */
function v4Rpc(opts: { hooks: string; other?: string; sqrt: bigint; liquidity: bigint }): RpcClient {
  const topic = eventTopic(V4_EVENTS.Initialize);
  const other = opts.other ?? WETH;
  const tokenIsCurrency0 = BigInt(TOKEN) < BigInt(other);
  const [c0, c1] = tokenIsCurrency0 ? [TOKEN, other] : [other, TOKEN];
  const log = {
    address: MANAGER,
    topics: [topic, word(0x1234n), addressTopicOf(c0), addressTopicOf(c1)],
    data: `0x${encodeWord("uint24", 3000n)}${encodeWord("int24", 60n)}${encodeWord("address", opts.hooks)}${encodeWord("uint160", opts.sqrt)}${encodeWord("int24", 0n)}`,
    blockNumber: "0xa",
    transactionHash: `0x${"2".repeat(64)}`,
    logIndex: "0x0",
  };
  return {
    // Only the side the token really is on returns the log; the other is empty,
    // exactly as the node would answer.
    getLogs: async (filter: { topics?: (string | string[] | null)[] }) => {
      const wantsCurrency0 = filter.topics?.[1] !== null && filter.topics?.[1] !== undefined;
      return wantsCurrency0 === tokenIsCurrency0 ? [log] : [];
    },
    callBatchSettled: async (calls: unknown[]) => calls.map((_, i) => (i % 2 === 0 ? word(opts.sqrt) : word(opts.liquidity))),
  } as unknown as RpcClient;
}

test("a V4 pool is found from the singleton's own Initialize log", async () => {
  const sqrt = isqrt((10n ** 18n * 2n ** 192n) / 10n ** 21n);
  const pools = await readV4Pools(v4Rpc({ hooks: ZERO, sqrt, liquidity: 10n ** 18n }), TOKEN, WETH, MANAGER, { fromBlock: 0, toBlock: 100 });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].kind, "v4");
  assert.equal(pools[0].dex, "Uniswap V4");
  assert.equal(pools[0].feeBps, 30, "a 3000 fee is 30 basis points");
  assert.equal(pools[0].tickSpacing, 60);
  // The singleton holds every pool's funds, so this pool has no balance of its
  // own. Null is the truthful answer, not zero.
  assert.equal(pools[0].tokenReserve, null);
  assert.equal(pools[0].quoteReserve, null);
});

test("a hooked pool is named as one and carries a warning", async () => {
  const sqrt = isqrt((10n ** 18n * 2n ** 192n) / 10n ** 21n);
  const pools = await readV4Pools(v4Rpc({ hooks: HOOK, sqrt, liquidity: 10n ** 18n }), TOKEN, WETH, MANAGER, { fromBlock: 0, toBlock: 100 });
  assert.equal(pools[0].dex, "Uniswap V4 (hooked)");
  assert.equal(pools[0].hooks, HOOK.toLowerCase());
  assert.match(hookNote(pools[0])!, /every swap/);
  assert.equal(hookNote({ ...pools[0], hooks: ZERO } as V4Pool), null);
});

test("a V4 pair against something else is not counted as a pool for this token", async () => {
  const sqrt = isqrt((10n ** 18n * 2n ** 192n) / 10n ** 21n);
  const other = "0x00000000000000000000000000000000000000cc";
  const pools = await readV4Pools(v4Rpc({ hooks: ZERO, other, sqrt, liquidity: 10n ** 18n }), TOKEN, WETH, MANAGER, { fromBlock: 0, toBlock: 100 });
  assert.deepEqual(pools, []);
});

test("a V4 pool is priced with concentrated arithmetic, not as constant product", async () => {
  // 1000 tokens per WETH, with real liquidity in range.
  const tokens = 10n ** 24n;
  const quote = 10n ** 21n;
  const sqrt = isqrt((quote * 2n ** 192n) / tokens);
  const pool: MarketPool = {
    dex: "Uniswap V4", kind: "v4", address: MANAGER, feeBps: 30, tokenIsToken0: true,
    tokenReserve: null, quoteReserve: null, sqrtPriceX96: sqrt, liquidity: isqrt(tokens * quote),
  };
  assert.equal(canPrice(pool), true);
  assert.ok((spotPrice(pool, 18) ?? 0n) > 0n, "a V4 pool must have a spot price");
  const sale = quoteSale(pool, 10n ** 21n);
  assert.ok(sale && sale.out > 0n, "a V4 sale priced at zero means it fell into the reserves branch");
});

test("a V4 pool is ranked by the quote behind its liquidity, not shoved last for having no balance", () => {
  const tokens = 10n ** 24n;
  const quote = 10n ** 21n;
  const sqrt = isqrt((quote * 2n ** 192n) / tokens);
  const v4: MarketPool = {
    dex: "Uniswap V4", kind: "v4", address: MANAGER, feeBps: 30, tokenIsToken0: true,
    tokenReserve: null, quoteReserve: null, sqrtPriceX96: sqrt, liquidity: isqrt(tokens * quote),
  };
  const shallowV2: MarketPool = { dex: "Test V2", kind: "v2", address: "0x1", feeBps: 30, tokenIsToken0: true, tokenReserve: 1n, quoteReserve: 1n };
  assert.ok(depth(v4) > depth(shallowV2), "a deep V4 pool must outrank a dust V2 pool");
  const market = readMarket([v4, shallowV2].sort((a, b) => (depth(b) > depth(a) ? 1 : -1)), 10n ** 21n, 18, "WETH");
  assert.equal(market.best?.kind, "v4");
  assert.match(market.note, /V4/);
});
