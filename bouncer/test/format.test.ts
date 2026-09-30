import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice } from "../src/format.js";

const E18 = 10n ** 18n;

test("a tiny price collapses its zeros into a subscript count, and keeps four digits", () => {
  // 0.0000000133 ETH: seven zeros after the point, and the subscript counts
  // all of them — DexScreener's convention, where 0.0₅123 is 0.00000123.
  assert.equal(formatPrice(133n * 10n ** 8n, 18), "0.0₇133");
  assert.equal(formatPrice(123_456n * 10n ** 4n, 18), "0.0₈1234");
  // Double-digit counts are two subscript digits, not a mangled one.
  assert.equal(formatPrice(5n, 18), "0.0₁₇5");
});

test("a price with few zeros is written out, and a whole-coin price is ordinary", () => {
  assert.equal(formatPrice(E18 / 1000n * 15n, 18), "0.015");
  assert.equal(formatPrice(E18 * 3n / 2n, 18), "1.5");
  assert.equal(formatPrice(E18 * 12_345n, 18), "12,345");
  assert.equal(formatPrice(0n, 18), "0");
});

import { formatCoin, formatMoney, formatUsd, formatUsdPrice } from "../src/format.js";

test("dollar totals are compact, three significant figures", () => {
  assert.equal(formatUsd(3_210_000), "$3.21M");
  assert.equal(formatUsd(3_200_000), "$3.2M");
  assert.equal(formatUsd(12_400), "$12.4K");
  assert.equal(formatUsd(950), "$950");
  assert.equal(formatUsd(9.5), "$9.50");
  assert.equal(formatUsd(99.21), "$99");
  assert.equal(formatUsd(1_234_000_000), "$1.23B");
  assert.equal(formatUsd(0.004), "$<0.01");
});

test("a tiny dollar price collapses its zeros like the coin price does", () => {
  assert.equal(formatUsdPrice(0.000002134), "$0.0₅2134");
  assert.equal(formatUsdPrice(0.0123), "$0.0123");
  assert.equal(formatUsdPrice(1.5), "$1.5");
  assert.equal(formatUsdPrice(2480.37), "$2.48K");
});

test("a coin amount is short and never loses a small value to zero", () => {
  assert.equal(formatCoin(20n * E18, 18), "20");
  assert.equal(formatCoin(31n * E18 / 10n, 18), "3.1");
  assert.equal(formatCoin(E18 * 42n / 10_000n, 18), "0.0042");
  assert.equal(formatCoin(12_345n * E18, 18), "12.3K");
  assert.equal(formatCoin(1_234n * E18, 18), "1,234");
  assert.equal(formatCoin(1_000_000_000n * E18, 18), "1B");
});

test("market cap reads $X (Y ETH), and without a price it is the coin alone — never an invented dollar", () => {
  assert.equal(formatMoney(20n * E18, 18, "ETH", 160_000), "$3.2M (20 ETH)");
  assert.equal(formatMoney(20n * E18, 18, "ETH", null), "20 ETH");
  assert.equal(formatMoney(20n * E18, 18, "ETH", 0), "20 ETH");
});

import { BlockscoutClient } from "../src/chain/blockscout.js";

test("the coin's dollar price is the explorer's, and a missing one is null rather than zero", async () => {
  const at = (body: unknown) => new BlockscoutClient({ baseUrl: "https://x.test", fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  assert.equal(await at({ coin_price: "2480.37" }).coinPriceUsd(), 2480.37);
  assert.equal(await at({ coin_price: null }).coinPriceUsd(), null);
  assert.equal(await at({ coin_price: "0" }).coinPriceUsd(), null);
});

import { humanUtc } from "../src/format.js";

test("a moment on the page is a date a person reads, not an ISO string", () => {
  assert.equal(humanUtc(Date.UTC(2026, 8, 15, 0, 0) / 1000), "15 Sep 2026, 00:00 UTC");
  assert.equal(humanUtc(Date.UTC(2026, 0, 3, 14, 7) / 1000), "3 Jan 2026, 14:07 UTC");
});

test("plural: a count with its noun", async () => {
  const { plural } = await import("../src/format.js");
  assert.equal(plural(1, "buy"), "1 buy");
  assert.equal(plural(3, "buy"), "3 buys");
  assert.equal(plural(1, "wallet has", "wallets have"), "1 wallet has");
  assert.equal(plural(1200, "sell"), "1,200 sells");
});

test("compact money keeps whole-number zeros and carries across units", async () => {
  const { formatUsd, formatCoin, formatUsdPrice } = await import("../src/format.js");
  assert.equal(formatUsd(120_000), "$120K");
  assert.equal(formatUsd(200_000), "$200K");
  assert.equal(formatUsd(100_000_000), "$100M");
  assert.equal(formatUsd(999_600), "$1M");
  assert.equal(formatUsd(999.6), "$1K");
  assert.equal(formatUsd(9.996), "$10");
  assert.equal(formatUsd(950), "$950");
  assert.equal(formatUsd(-857), "−$857");
  assert.equal(formatCoin(200_000n * 10n ** 18n, 18), "200K");
  assert.equal(formatCoin(10n ** 18n * 120n, 18), "120");
  assert.equal(formatCoin(-(10n ** 18n) * 3n / 10n, 18), "−0.3");
  assert.equal(formatUsdPrice(0.1), "$0.1");
  assert.equal(formatUsdPrice(0.0999999), "$0.1");
  assert.equal(formatUsdPrice(0.99999), "$1");
  assert.equal(formatUsdPrice(0.0001), "$0.0001");
  assert.equal(formatUsdPrice(0.00000540), "$0.0₅54");
});

test("a per-token price with its dollar figure", async () => {
  const { formatPriceMoney } = await import("../src/format.js");
  assert.equal(formatPriceMoney(2_174n * 10n ** 4n, 18, "ETH", null), "0.0₁₀2174 ETH");
  assert.equal(formatPriceMoney(10n ** 15n, 18, "ETH", 2000), "$2 (0.001 ETH)");
});
