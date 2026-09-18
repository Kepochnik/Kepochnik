import assert from "node:assert/strict";
import { test } from "node:test";
import { canPrice, quoteSale, readMarket, spotPrice, type MarketPool } from "../src/chain/market.js";

const Q96 = 2n ** 96n;
const E18 = 10n ** 18n;

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

/** A V3 pool holding `tokens` of the subject and `quote` of the wrapped native coin. */
function v3(tokens: bigint, quote: bigint, tokenIsToken0: boolean, feeBps = 30): MarketPool {
  const [r0, r1] = tokenIsToken0 ? [tokens, quote] : [quote, tokens];
  return {
    dex: "Test V3",
    kind: "v3",
    address: "0x00000000000000000000000000000000000000v3".slice(0, 42),
    feeBps,
    tokenIsToken0,
    tokenReserve: tokens,
    quoteReserve: quote,
    sqrtPriceX96: isqrt((r1 * 2n ** 192n) / r0),
    liquidity: isqrt(r0 * r1),
  };
}

function v2(tokens: bigint, quote: bigint, feeBps = 30): MarketPool {
  return { dex: "Test V2", kind: "v2", address: "0x0000000000000000000000000000000000000002", feeBps, tokenIsToken0: true, tokenReserve: tokens, quoteReserve: quote };
}

test("a constant-product quote matches the closed form exactly", () => {
  const pool = v2(1_000_000n * E18, 100n * E18);
  const amountIn = 1_000n * E18;
  const afterFee = (amountIn * 9_970n) / 10_000n;
  const expected = (afterFee * 100n * E18) / (1_000_000n * E18 + afterFee);
  assert.equal(quoteSale(pool, amountIn)?.out, expected);
});

test("a constant-product quote can never drain the pool", () => {
  const pool = v2(1_000n * E18, 5n * E18);
  const out = quoteSale(pool, 10n ** 30n)?.out ?? 0n;
  assert.ok(out < 5n * E18, "an enormous sale still cannot take more than the pool holds");
});

test("selling a dust amount into a V3 pool realises the fee and almost nothing else", () => {
  const pool = v3(300_000_000n * E18, 12n * E18, true);
  const spot = spotPrice(pool, 18)!;
  const tokensIn = 1_000n * E18; // a rounding error against the pool's size
  const out = quoteSale(pool, tokensIn)!.out;
  const reference = (spot * tokensIn) / E18;
  const realisedBps = Number((out * 10_000n) / reference);
  // 0.3% fee and no measurable impact: anything under 99.5% would mean the
  // arithmetic is charging the trade for depth it did not use.
  assert.ok(realisedBps > 9_950 && realisedBps <= 9_970, `realised ${realisedBps} bps`);
});

test("a bigger sale always realises less per token, in both directions", () => {
  for (const tokenIsToken0 of [true, false]) {
    const pool = v3(300_000_000n * E18, 12n * E18, tokenIsToken0);
    const spot = spotPrice(pool, 18)!;
    let previous = 10_001;
    for (const size of [1_000n, 100_000n, 1_000_000n, 10_000_000n]) {
      const tokensIn = size * E18;
      const out = quoteSale(pool, tokensIn)!.out;
      const realised = Number((out * 10_000n) / ((spot * tokensIn) / E18));
      assert.ok(realised < previous, `token0=${tokenIsToken0}: ${size} realised ${realised}, not below ${previous}`);
      assert.ok(realised > 0, "a sale must return something");
      previous = realised;
    }
  }
});

test("a sale large enough to leave the current tick is flagged rather than quoted as fact", () => {
  const pool = v3(300_000_000n * E18, 12n * E18, true);
  assert.equal(quoteSale(pool, 1_000n * E18)!.beyondTick, false);
  assert.equal(quoteSale(pool, 5_000_000_000n * E18)!.beyondTick, true);
});

test("the spot price is the ratio of the reserves, whichever side the token sorts on", () => {
  const a = spotPrice(v3(300_000_000n * E18, 12n * E18, true), 18)!;
  const b = spotPrice(v3(300_000_000n * E18, 12n * E18, false), 18)!;
  const expected = (12n * E18 * E18) / (300_000_000n * E18);
  for (const [name, got] of [["token0", a], ["token1", b]] as const) {
    const drift = got > expected ? got - expected : expected - got;
    assert.ok((drift * 1_000_000n) / expected < 100n, `${name}: ${got} is not within 0.01% of ${expected}`);
  }
});

test("a Solidly stable pool is not priced, and readMarket says so instead of returning zeros", () => {
  const stable: MarketPool = { dex: "Aerodrome", kind: "solidly", address: "0x0000000000000000000000000000000000000003", feeBps: 5, tokenIsToken0: true, tokenReserve: 1_000n * E18, quoteReserve: 1_000n * E18, stable: true };
  assert.equal(canPrice(stable), false);
  const market = readMarket([stable], 100n * E18, 18, "WETH");
  assert.equal(market.best, null);
  assert.equal(market.spot, null);
  assert.deepEqual(market.quotes, []);
  assert.match(market.note, /invariant this does not model/);
});

test("a pool whose state did not read is not priced as an empty pool", () => {
  const unread: MarketPool = { dex: "Test V3", kind: "v3", address: "0x0000000000000000000000000000000000000004", feeBps: 30, tokenIsToken0: true, tokenReserve: null, quoteReserve: null };
  assert.equal(canPrice(unread), false);
  const market = readMarket([unread], 100n * E18, 18, "WETH");
  assert.equal(market.best, null);
  assert.match(market.note, /did not read/);
});

test("readMarket picks the deepest priceable pool and quotes four sizes", () => {
  const thin = v2(1_000_000n * E18, 1n * E18);
  const deep = v2(300_000_000n * E18, 12n * E18);
  const market = readMarket([deep, thin], 1_000_000n * E18, 18, "WETH");
  assert.equal(market.best?.quoteReserve, 12n * E18);
  assert.deepEqual(market.quotes.map((q) => q.shareBps), [1_000, 2_500, 5_000, 10_000]);
  assert.ok(market.quotes[0].out > 0n);
  assert.ok(market.quotes[3].out > market.quotes[0].out, "selling more returns more in total");
  assert.ok(market.quotes[3].realisedBps < market.quotes[0].realisedBps, "but less per token");
  assert.match(market.note, /Constant product/);
});

test("a zero position asks nothing of the pool", () => {
  const pool = v2(1_000n * E18, 5n * E18);
  assert.equal(quoteSale(pool, 0n), null);
  assert.deepEqual(readMarket([pool], 0n, 18, "WETH").quotes, []);
});
