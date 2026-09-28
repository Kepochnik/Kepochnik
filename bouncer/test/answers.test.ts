import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor, type DoorSlip } from "../src/bouncer/door.js";
import { ANSWER_TOPICS, doorAnswers, splAnswers } from "../src/bouncer/answers.js";
import { topicOf } from "../src/bouncer/topics.js";

const slipFor = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

const SHAPES = [DEMO_PLAIN.token, DEMO_IMPOSTOR.token, DEMO.tokens.late.token, DEMO.tokens.fresh.token, DEMO_V1.token];

test("every token shape answers all five questions, in the order a reader asks them", async () => {
  for (const token of SHAPES) {
    const a = doorAnswers(await slipFor(token));
    assert.deepEqual(a.map((x) => x.topic), ANSWER_TOPICS, token);
    for (const row of a) {
      // A sentence, not a metric, and short enough for one line of a row.
      // The old ceiling was 26 characters, which is what forced values like
      // "4 switches" — short, and meaningless to somebody who has never read
      // a contract.
      assert.ok(row.value.length > 0 && row.value.length <= 72, `${token} ${row.topic}: "${row.value}" is too long for a row`);
      if (row.figure) assert.ok(row.figure.length <= 16, `${token} ${row.topic}: the figure "${row.figure}" will not fit the scan strip`);
      assert.ok(row.question.endsWith("?"), `${token} ${row.topic}: the question is not a question`);
    }
  }
});

/**
 * The rule the first version of this module broke three times: a row's colour
 * is the loudest note the reader will find when they open it. Inventing a
 * severity the notes do not carry makes the row argue with its own evidence —
 * it painted a V1 launch's calm INFO as a red STOP.
 */
test("a row is never louder than the findings behind it", async () => {
  for (const token of SHAPES) {
    const slip = await slipFor(token);
    for (const row of doorAnswers(slip)) {
      if (row.tone === "unknown") continue;
      const loudest = row.notes.some((n) => n.level === "stop") ? "stop" : row.notes.some((n) => n.level === "watch") ? "warn" : "ok";
      assert.equal(row.tone, loudest, `${token} ${row.topic}: the row reads ${row.tone} over findings whose loudest is ${loudest}`);
    }
  }
});

test("a row carries exactly the findings for its own question", async () => {
  const slip = await slipFor(DEMO_PLAIN.token);
  const rows = doorAnswers(slip);
  for (const row of rows) {
    for (const n of row.notes) assert.equal(topicOf(n.code), row.topic, `${n.code} is filed under ${row.topic}`);
  }
  // And between them the rows hold every finding that is not a gap: a note
  // that belongs to no row is a note nobody will ever see.
  const shown = new Set(rows.flatMap((r) => r.notes.map((n) => n.code)));
  for (const n of slip.notes) {
    if (topicOf(n.code) === "unread") continue;
    assert.ok(shown.has(n.code), `${n.code} answers no question and would not be shown`);
  }
});

test("a Pons V1 launch is not announced as a V2 one", async () => {
  // `registered` is true for a V1 token too — the door reads it from the
  // older factory — so asking `registered` first called every V1 launch a V2.
  const slip = await slipFor(DEMO_V1.token);
  assert.ok(slip.id.v1, "the fixture is meant to be a V1 launch");
  const id = doorAnswers(slip)[0];
  assert.match(id.value, /V1/);
  assert.doesNotMatch(id.value, /V2/);
});

test("the impostor's row says which question it failed, not just that it is red", async () => {
  const slip = await slipFor(DEMO_IMPOSTOR.token);
  const id = doorAnswers(slip)[0];
  assert.equal(id.tone, "stop");
  // A red row reading "Ordinary token" is a row whose colour and words
  // disagree: the reader has to open it to find out it means "wrong one".
  assert.match(id.value, /another token used this ticker first/i, `the red id row reads "${id.value}"`);
});

/**
 * A read that did not answer is never `ok`. "No switches found" and "the code
 * could not be read" are opposite answers and must never share a colour.
 */
test("an unread read is unknown, never a clean answer", () => {
  const blind = {
    chain: CHAINS.robinhood,
    subject: "0x" + "11".repeat(20),
    notes: [],
    id: { registered: false, meta: { symbol: "X", name: "X", decimals: 18, totalSupply: 10n ** 24n }, launch: null, v1: null },
    open: { surfaceFrom: "implementation-unreadable", probes: [], probesSkipped: null, probesPending: false, transferFunction: true, pools: null, holders: null, deployer: null, owner: null, powers: [], ownerUnread: false, market: null },
    rules: null, exit: null, room: null, crew: null, known: null,
  } as unknown as DoorSlip;
  const rows = doorAnswers(blind);
  const by = Object.fromEntries(rows.map((r) => [r.topic, r]));
  assert.equal(by.keep.tone, "unknown");
  assert.match(by.keep.value, /could not be read/);
  assert.equal(by.exit.tone, "unknown", "a refused pool read is not 'no pool'");
  assert.equal(by.room.tone, "unknown");
  // Exactly one row is answered: the token's own symbol and supply came
  // back, so "is this the right token" has a real answer. Everything whose
  // read failed says so. Demanding that every row be unknown would be
  // demanding the page forget what it does know; letting any of the other
  // four read green would be the bug this module exists to stop.
  assert.equal(by.id.tone, "ok");
  assert.equal(by.sell.tone, "unknown", "nothing was simulated, so whether you can sell is not known");
  assert.equal(rows.filter((r) => r.tone === "ok").length, 1, rows.map((r) => `${r.topic}=${r.tone}`).join(" "));
});

test("Solana answers the same five questions with its own reads", () => {
  const mint = {
    chain: { key: "solana", name: "Solana", family: "solana" },
    subject: "So11111111111111111111111111111111111111112",
    stamp: "NOT A LAUNCH",
    notes: [],
    mint: { token2022: false, mintAuthority: null, freezeAuthority: "Fr" + "1".repeat(42), extensions: [], supply: 10n ** 18n, decimals: 9 },
    metadata: { name: "Wrapped SOL", symbol: "SOL", isMutable: false },
    holders: { top: [], top10Bps: 4_200, distinctOwners: 18 },
    market: null,
    skipped: [],
  } as never;
  const rows = splAnswers(mint);
  assert.deepEqual(rows.map((r) => r.topic), ANSWER_TOPICS);
  const by = Object.fromEntries(rows.map((r) => [r.topic, r]));
  assert.match(by.keep.value, /freeze what you hold/, "a freeze authority is something somebody can still do to you");
  assert.deepEqual(by.keep.chips.map((c) => c.text), ["freeze"], "the authority is named as an object, not counted");
  assert.match(by.room.value, /42%/);
  assert.ok(by.room.bar?.length, "who holds the supply reads as a shape, not a percentage alone");
  // No market read at all is not "no pool": it is a question nobody asked,
  // and answering it green would be the audit's own bug in miniature.
  assert.equal(by.exit.tone, "unknown");
  assert.match(by.exit.value, /Not checked/);
});

/**
 * Both exit readers quote a reference position of 1% of the supply and then
 * take shares OF THAT, so a quote's own 10% is a tenth of a percent of the
 * supply. The row said "Selling 10% of the supply", which overstated it a
 * hundredfold — on the one row that is about money.
 */
test("the exit row states a share of the supply, not a share of the sample position", async () => {
  const slip = await slipFor(DEMO_PLAIN.token);
  const exit = doorAnswers(slip).find((a) => a.topic === "exit")!;
  const market = slip.open!.market!;
  const q = market.quotes[0];
  assert.equal(q.shareBps, 1_000, "the fixture's first quote is meant to be 10% of the position");

  // The claim has to survive arithmetic: the figure divided by the spot price
  // is the number of tokens, and that as a share of supply is what the
  // sentence must say.
  const tokens = (q.out * 10n ** 18n) / market.spot!;
  const shareOfSupplyBps = Number((tokens * 10_000n) / slip.id.meta!.totalSupply);
  assert.ok(shareOfSupplyBps >= 9 && shareOfSupplyBps <= 11, `the quote is ${shareOfSupplyBps} bps of supply, not ~10`);
  assert.match(exit.value, /Selling 0\.1% of the supply/, exit.value);
  assert.doesNotMatch(exit.value, /Selling 10% of the supply/);
  // And the detail says where the sample size came from, so the figure can be
  // scaled to whatever somebody actually holds.
  assert.match(exit.detail ?? "", /reference position of 1% of the supply/);
});
