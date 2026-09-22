import assert from "node:assert/strict";
import { test } from "node:test";
import { evmExitFor, splExitFor, readSizeQuote } from "../src/bouncer/exitSize.js";
import type { SplSlip } from "../src/bouncer/spl.js";
import type { DoorSlip } from "../src/bouncer/door.js";

const E = 10n ** 18n;

/** A Solana slip carrying one honest constant-product pool. */
function splWithPool(tokenReserve: bigint, quoteReserve: bigint): SplSlip {
  return {
    chain: { key: "solana", name: "Solana", family: "solana" },
    at: { slot: 1, timestamp: 1, span: null },
    subject: "mint",
    stamp: "NOT A LAUNCH",
    mint: { supply: 1_000_000n * E, decimals: 9 } as never,
    whatItIs: null,
    metadata: null,
    metadataInline: false,
    holders: null,
    market: {
      curve: null,
      pools: [{ address: "p", program: "x", name: "Raydium CPMM", concentrated: false, tokenReserve, quoteMint: "So1", quoteSymbol: "SOL", quoteDecimals: 9, quoteReserve }],
      best: { kind: "pool", name: "Raydium CPMM" },
      spot: 1,
      quoteSymbol: "SOL",
      quotes: [],
      locks: [],
      note: "",
      unread: null,
    },
    notes: [],
    skipped: [],
  };
}

test("a small position gets close to the screen price; a large one does not", () => {
  // The whole point of the feature: the same token, the same block, two
  // sizes, two completely different answers. A price is not an exit.
  const slip = splWithPool(1_000_000n * E, 1_000n * E);
  const small = splExitFor(slip, 100n * E);
  const large = splExitFor(slip, 400_000n * E);
  assert.ok(small.ok && large.ok);
  assert.ok(small.quote.realisedBps > 9_900, `a 0.01% position should barely move it; got ${small.quote.realisedBps}`);
  assert.ok(large.quote.realisedBps < 8_000, `a 40% position must not realise near the screen price; got ${large.quote.realisedBps}`);
  assert.ok(large.quote.out > small.quote.out, "more tokens still fetch more, just much less per token");
  // And the reading says which case you are in, in words.
  assert.equal(readSizeQuote(small.quote).level, "info");
  assert.equal(readSizeQuote(large.quote).level, "stop");
  assert.match(readSizeQuote(large.quote).text, /pool/i);
});

test("a position too big for its pool is called out on size, not just on slippage", () => {
  const slip = splWithPool(1_000n * E, 10n * E);
  const answer = splExitFor(slip, 500n * E);
  assert.ok(answer.ok);
  assert.ok(answer.quote.shareOfPoolBps >= 3_333, `500 of 1000 is half the pool; got ${answer.quote.shareOfPoolBps} bps`);
  const said = readSizeQuote(answer.quote);
  assert.equal(said.level, "stop");
  assert.match(said.text, /whatever the price says|cannot leave/i);
});

test("no venue is a sentence, never a quote of zero", () => {
  // The failure mode this file is written against. "You would get 0" is a
  // statement about the token; "no pool was found" is a statement about
  // the reading, and printing the first when the second is true is the
  // whole class of bug the audit came here about.
  const empty = splWithPool(1n, 1n);
  empty.market!.pools = [];
  const answer = splExitFor(empty, 100n * E);
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && /nowhere|no pool/i.test(answer.why), `got "${!answer.ok ? answer.why : ""}"`);
});

test("a search that could not finish is not an empty market", () => {
  const refused = splWithPool(1n, 1n);
  refused.market!.pools = [];
  refused.market!.unread = "the public endpoint refused this read (403)";
  const answer = splExitFor(refused, 100n * E);
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && /could not finish|proves nothing/i.test(answer.why), `got "${!answer.ok ? answer.why : ""}"`);
  // Crucially a DIFFERENT sentence from "no pool was found": one means
  // nobody trades this, the other means nobody would tell us.
  assert.ok(!answer.ok && !/nowhere for a sale/.test(answer.why));
});

test("a concentrated pool is refused rather than priced off its vault balances", () => {
  // V3/V4 and Orca Whirlpools keep liquidity in ranges, so the vault
  // balances are not what a trade moves through. Pricing off them
  // overstates the exit — in the direction that costs somebody money,
  // which is the only direction that matters.
  const slip = splWithPool(1_000_000n * E, 1_000n * E);
  slip.market!.pools[0].concentrated = true;
  const answer = splExitFor(slip, 100n * E);
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && /concentrated/i.test(answer.why));
  assert.ok(!answer.ok && /overstate/i.test(answer.why), "and it must say which way the error would go");
});

test("an EVM token with only range pools is refused for the same reason", () => {
  const slip = {
    chain: { key: "base", name: "Base", chainId: 8453, launchpad: null, native: { symbol: "ETH", decimals: 18 } },
    exit: null,
    open: { pools: [{ dex: "Uniswap", kind: "v3", address: "0x", feeBps: 30, tokenIsToken0: true, tokenReserve: 100n * E, quoteReserve: 5n * E }] },
  } as unknown as DoorSlip;
  const answer = evmExitFor(slip, 1n * E);
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && /ranges|V3/i.test(answer.why));
});

test("an EVM token on a plain pool is priced, fee included", () => {
  const slip = {
    chain: { key: "base", name: "Base", chainId: 8453, launchpad: null, native: { symbol: "ETH", decimals: 18 } },
    exit: null,
    open: { pools: [{ dex: "Uniswap", kind: "v2", address: "0x", feeBps: 30, tokenIsToken0: true, tokenReserve: 1_000_000n * E, quoteReserve: 100n * E }] },
  } as unknown as DoorSlip;
  const answer = evmExitFor(slip, 1_000n * E);
  assert.ok(answer.ok);
  assert.ok(answer.quote.out > 0n);
  assert.equal(answer.quote.quoteSymbol, "ETH");
  // 0.3% fee plus slippage, so strictly under the screen price and not by much.
  assert.ok(answer.quote.realisedBps < 10_000 && answer.quote.realisedBps > 9_000, `got ${answer.quote.realisedBps}`);
  assert.match(answer.quote.venue, /Uniswap/);
});

test("asking for nothing is refused rather than answered with a zero", () => {
  const slip = splWithPool(1_000n * E, 1n * E);
  for (const size of [0n, -5n]) {
    const answer = splExitFor(slip, size);
    assert.equal(answer.ok, false, `${size} should not produce a quote`);
  }
});
