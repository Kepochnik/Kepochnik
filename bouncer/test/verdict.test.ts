import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_PLAIN, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { cardVerdict, doorCard } from "../src/bouncer/card.js";
import { snapshotOfDoor } from "../src/bouncer/changes.js";
import { doorCoverage, type Coverage } from "../src/bouncer/coverage.js";
import { doorReceipt, readDoor } from "../src/bouncer/door.js";
import { readVerdict } from "../src/bouncer/verdict.js";

const slipFor = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

/**
 * The bug this file exists for: four copies of "which word goes on top", one
 * per surface, and the fourth disagreed with the other three. The stored
 * snapshot applied no completeness rule, so "Checked before" printed CLEAR for
 * a reading the page had headlined INCOMPLETE.
 */
test("every surface states the same word for the same token", async () => {
  for (const token of [DEMO_PLAIN.token, DEMO_IMPOSTOR.token, DEMO.tokens.late.token, DEMO.tokens.fresh.token]) {
    const slip = await slipFor(token);
    const coverage = doorCoverage(slip);
    const want = readVerdict(slip.notes, coverage).word;

    assert.equal(doorReceipt(slip).verdict?.word, want, `the CLI receipt for ${token}`);
    assert.equal(cardVerdict(slip.notes, coverage).word, want, `the share card for ${token}`);
    assert.equal(snapshotOfDoor(slip).verdict, want, `the stored snapshot for ${token}`);
    // The card is drawn, not just computed: the word has to reach the SVG.
    assert.match(doorCard(slip, { repoUrl: "https://example.invalid", checkUrl: "https://example.invalid", ticker: "BOUNCER", mascotSvg: "" }), new RegExp(`>${want}<`), `the drawn card for ${token}`);
  }
});

/**
 * The case the first version of the test above could not see.
 *
 * All four demo tokens have loud notes, so all four are STOP or WATCH — and a
 * STOP keeps its word under every rule, including the wrong one. Reverting the
 * snapshot to its old "no completeness rule" code left that test green. The
 * disagreement only shows on a reading with NOTHING loud and a decisive check
 * unread, which is exactly the shape the audit found on BONK: the page says
 * INCOMPLETE and the old snapshot said CLEAR.
 */
test("a clean-sounding reading with a hole in it is INCOMPLETE on every surface", async () => {
  const slip = await slipFor(DEMO_PLAIN.token);
  // Nothing loud, and the two decisive reads refused. Built rather than
  // recorded: no demo token is both quiet and half-read, and the aggregation
  // rule is what is under test, not the fixture.
  const quiet = {
    ...slip,
    notes: slip.notes.filter((n) => n.level === "info"),
    open: slip.open ? { ...slip.open, probes: [], probesSkipped: "the node refused the call", holders: null } : null,
    skipped: [{ section: "holders", reason: "the node refused the request (403)" }],
  };
  const coverage = doorCoverage(quiet);
  assert.equal(coverage.state, "thin", "the fixture is meant to be a half-read slip");
  assert.equal(readVerdict(quiet.notes, coverage).word, "INCOMPLETE", "a quiet reading with a decisive gap is not CLEAR");
  assert.equal(doorReceipt(quiet).verdict?.word, "INCOMPLETE", "the CLI receipt");
  assert.equal(cardVerdict(quiet.notes, coverage).word, "INCOMPLETE", "the share card");
  assert.equal(snapshotOfDoor(quiet).verdict, "INCOMPLETE", "the stored snapshot, which used to say CLEAR here");
});

/**
 * The rule itself, on coverage it cannot read. A CLEAR is the only word that
 * is a claim about what was LOOKED AT, so it is the only one a gap takes away.
 */
test("a decisive gap takes CLEAR away and leaves STOP and WATCH alone", () => {
  const thin = { state: "thin", line: "A simulated sale could not be read.", read: 3, asked: 6 } as Coverage;
  const whole = { state: "complete", line: "", read: 6, asked: 6 } as Coverage;
  const clear = readVerdict([], thin);
  assert.equal(clear.word, "INCOMPLETE");
  assert.equal(clear.kind, "incomplete");
  assert.match(clear.line, /simulated sale could not be read/, "the reason has to travel with the word");
  assert.equal(readVerdict([], whole).word, "CLEAR");

  const stop = [{ level: "stop", text: "x", code: "X" }] as never;
  assert.equal(readVerdict(stop, thin).word, "STOP", "a danger that was found is still found");
  assert.match(readVerdict(stop, thin).line, /There may be more/, "but the count must not read as the whole list");
  const watch = [{ level: "watch", text: "x", code: "X" }] as never;
  assert.equal(readVerdict(watch, thin).word, "WATCH");
});

test("the first render has no verdict, and says so rather than guessing one", () => {
  const opening = readVerdict([{ level: "stop", text: "x", code: "X" }] as never, null, "opening");
  assert.equal(opening.word, "READING");
  assert.equal(opening.stop, 0, "a count off half the evidence is a count that will change");
  assert.match(opening.line, /no verdict until/);
});

test("the count in the sentence is the count of findings that made it", () => {
  const notes = [
    { level: "stop", text: "a", code: "A" },
    { level: "watch", text: "b", code: "B" },
    { level: "watch", text: "c", code: "C" },
    { level: "info", text: "d", code: "D" },
  ] as never;
  const v = readVerdict(notes, null);
  assert.equal(v.word, "STOP");
  assert.equal(v.stop, 1);
  assert.equal(v.watch, 2);
  assert.match(v.line, /^1 thing here/, "singular for one, and INFO notes are not findings");
});
