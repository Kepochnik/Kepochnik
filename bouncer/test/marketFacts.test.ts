/**
 * A board of fresh launches is a board of tokens on a curve, and every one of
 * them used to show "not read" for price, market cap and liquidity — because
 * those figures were only ever looked for in the open-door pool search, which
 * a launch never runs. These are the cases that decide whether the figures a
 * buyer looks for first exist on the tokens the board is for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_PLAIN, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor } from "../src/bouncer/door.js";
import { launchPool, marketFacts } from "../src/bouncer/marketFacts.js";

const slipFor = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

const fact = (m: ReturnType<typeof marketFacts>, label: string) => m.facts.find((f) => f.label === label)!;

test("a token on the curve is priced from the curve, and its depth is the real quote it holds", async () => {
  const slip = await slipFor(DEMO.tokens.fresh.token);
  const m = marketFacts(slip);
  const price = fact(m, "Price");
  assert.ok(price.value, `price was "${price.why}"`);
  assert.match(price.note, /from the curve/);
  assert.equal(m.spot, slip.exit!.spot);
  assert.ok(fact(m, "Market cap").value, "a priced token with a supply has a market cap");

  // The real reserve, never the pricing one — the virtual part of a curve's
  // reserve is money nobody can sell into.
  const liquidity = fact(m, "Liquidity");
  assert.ok(liquidity.value?.startsWith("0.8"), `liquidity "${liquidity.value}" is not the curve's real 0.8 ETH`);
  assert.match(liquidity.note, /to graduation/);
  // And a curve has no pool, so there is none for the tape to read.
  assert.equal(m.pool, null);
});

test("a graduated launch has a V4 pool the tape can read, named by its id", async () => {
  const slip = await slipFor(DEMO.tokens.sprint.token);
  const pool = launchPool(slip);
  assert.ok(pool, "a graduated launch came back with no pool");
  assert.equal(pool!.kind, "v4");
  assert.match(pool!.poolId ?? "", /^0x[0-9a-f]{64}$/);
  const m = marketFacts(slip);
  assert.equal(m.pool?.poolId, pool!.poolId);
  assert.match(fact(m, "Price").note, /V4 pool/);
  // One contract holds every V4 pool's funds, so the depth is refused with the reason, not guessed.
  const liquidity = fact(m, "Liquidity");
  assert.equal(liquidity.value, null);
  assert.match(liquidity.why ?? "", /PoolManager/);
});

test("an ordinary token still takes its figures from the pool it was found in", async () => {
  const m = marketFacts(await slipFor(DEMO_PLAIN.token));
  assert.equal(launchPool(await slipFor(DEMO_PLAIN.token)), null);
  if (m.pool) assert.notEqual(m.pool.kind, "v4");
  const price = fact(m, "Price");
  if (price.value) assert.match(price.note, /from the pool/);
});
