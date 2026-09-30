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
