/**
 * The buy links. Two things are worth a test and neither is the string
 * concatenation: that the referral code is actually in the URL, and that a
 * chain nobody proved a slug for gets no button at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVEN, REFERRAL, TRADE_SLUGS, tradeVenues } from "../src/bouncer/trade.js";

const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";

test("the links match the shape of the real ones, referral code included", () => {
  const [gmgn, basedbot] = tradeVenues("robinhood", PONS);
  // Both patterns come from a working URL, and the codes are the point:
  // a link without one earns nothing and looks identical.
  assert.equal(gmgn.url, `https://gmgn.ai/robinhood/token/save_${PONS}`);
  assert.equal(basedbot.url, `https://basedbot.app/r/bot/token/robinhood/${PONS}`);
  assert.ok(gmgn.url.includes(`/${REFERRAL.gmgn}_`), "GMGN puts the code in front of the address");
  assert.ok(basedbot.url.includes(`/r/${REFERRAL.basedbot}/`), "BasedBot puts the code in the path");
});

test("a chain with no proven slug gets no button, rather than a guessed one", () => {
  // A wrong slug is a dead link at best and the right token on the wrong
  // chain at worst. Nothing is the honest output of not knowing.
  assert.deepEqual(tradeVenues("arc", PONS), []);
  assert.deepEqual(tradeVenues("a-chain-that-does-not-exist", PONS), []);
  assert.deepEqual(tradeVenues("robinhood", ""), [], "and no address means no link");
});

test("a venue that does not cover a chain is left out of that chain", () => {
  // BasedBot is only proven on Robinhood Chain. Offering it elsewhere would
  // be inventing coverage on somebody else's product.
  for (const key of ["base", "bnb", "solana"]) {
    const venues = tradeVenues(key, PONS);
    assert.ok(venues.length >= 1, `${key} should still have GMGN`);
    assert.ok(!venues.some((v) => v.key === "basedbot"), `${key} has no proven BasedBot slug`);
  }
});

test("every slug in the table is a plain path segment", () => {
  // A slug with a slash or a space would silently build a URL pointing
  // somewhere else entirely.
  for (const [chain, slugs] of Object.entries(TRADE_SLUGS)) {
    for (const [venue, slug] of Object.entries(slugs)) {
      assert.match(slug as string, /^[a-z0-9-]+$/, `${chain}.${venue} is not a clean slug`);
    }
  }
});

test("every venue says what it is, for somebody who has not used it", () => {
  for (const v of tradeVenues("robinhood", PONS)) {
    assert.ok(v.what.length > 15, `${v.name} needs a line explaining it`);
    assert.ok(v.url.startsWith("https://"));
  }
});

test("the table says which slugs were proven and which are recall", () => {
  // The comment above the table used to claim every entry was proven. It
  // was not, and a false claim in a comment is the same defect as a false
  // claim on a slip — it is just read later.
  assert.deepEqual(PROVEN.robinhood, ["gmgn", "basedbot"]);
  for (const chain of ["base", "bnb", "solana"]) {
    assert.equal(PROVEN[chain], undefined, `${chain} has no proven slug and must not claim one`);
    assert.ok(tradeVenues(chain, PONS).length > 0, `${chain} still ships its recalled slug`);
  }
});
