/**
 * The grouping table, held against the notes the tool can actually emit.
 *
 * A mapping like this rots the moment somebody adds a note and forgets the
 * table, and the rot is silent: the new note lands in the default group and
 * the slip looks fine. So the codes are read out of the source rather than
 * listed here, and the test fails the day the two disagree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { TOPIC_BLURB, TOPIC_ORDER, TOPIC_QUESTION, mappedCodes, probeCodes, topicOf } from "../src/bouncer/topics.js";
import { readDoor } from "../src/bouncer/door.js";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";

/**
 * Every code the slip builders can emit.
 *
 * The literals AND the ones composed at runtime. This used to be the
 * regex alone, matching `code: "…"` in double quotes, so every code built
 * as `code: \`${kind}-${outcome}\`` was invisible to it — and this test
 * then reported full coverage of a set that excluded, by construction,
 * exactly the codes that were broken. All ten simulation results fell to
 * the default group, `sell-reverts` among them: a STOP reading "the token
 * cannot be sold", filed under "questions BOUNCER could not answer".
 *
 * A coverage test that cannot see part of what it covers is worse than no
 * coverage test, because it is believed.
 */
function codesInSource(): Set<string> {
  const out = new Set<string>(probeCodes());
  for (const file of ["src/bouncer/door.ts", "src/bouncer/spl.ts"]) {
    for (const m of readFileSync(file, "utf8").matchAll(/code:\s*"([a-z0-9-]+)"/g)) out.add(m[1]);
    // Anything composed from a template is named here or it is not tested.
    for (const m of readFileSync(file, "utf8").matchAll(/code:\s*`([^`]*)`/g)) {
      const shape = m[1];
      const known = probeCodes().some((c) => new RegExp(`^${shape.replace(/\$\{[^}]+\}/g, "[a-z-]+")}$`).test(c));
      assert.ok(known, `a note code is built as \`${shape}\` and nothing in topics.ts enumerates its shape`);
    }
  }
  return out;
}

test("every note the tool emits has a question it answers", () => {
  const emitted = codesInSource();
  assert.ok(emitted.size > 50, `expected the slip builders to emit plenty of codes, saw ${emitted.size}`);
  const missing = [...emitted].filter((code) => !mappedCodes().includes(code));
  assert.deepEqual(missing, [], `these notes would fall into the default group unnoticed: ${missing.join(", ")}`);
});

test("the table has no entries for notes that no longer exist", () => {
  // The other direction. A stale entry is harmless at runtime and a lie in
  // the source: it says the tool emits something it does not.
  const emitted = codesInSource();
  const stale = mappedCodes().filter((code) => !emitted.has(code));
  assert.deepEqual(stale, [], `these codes are mapped but never emitted: ${stale.join(", ")}`);
});

test("the unknown code falls where a mistake is noticed, not hidden", () => {
  // A finding shown among the caveats gets spotted. A caveat shown as a
  // finding does not, and that is the direction that costs somebody money.
  assert.equal(topicOf("a-code-nobody-wrote-yet"), "unread");
});

test("every question has a heading and a plain-language line, and unread is last", () => {
  for (const topic of TOPIC_ORDER) {
    assert.ok(TOPIC_QUESTION[topic]?.endsWith("?") || topic === "unread", `${topic} should be phrased as a question`);
    assert.ok(TOPIC_BLURB[topic]?.length > 40, `${topic} needs a line somebody new can read`);
  }
  assert.equal(TOPIC_ORDER[TOPIC_ORDER.length - 1], "unread", "what was not read is never folded in among findings");
  assert.equal(new Set(TOPIC_ORDER).size, TOPIC_ORDER.length);
});

test("a finding is never filed as something BOUNCER could not read", () => {
  // The invariant the simulation codes broke. `unread` means "this was not
  // checked"; a STOP or a WATCH means "it was checked and here is what it
  // said". A note cannot be both, and when one is filed as unread it
  // leaves the findings ledger and lands inside a collapsed strip — which
  // is a safe place for a caveat and the worst possible place for "you
  // cannot sell this".
  //
  // Checked against real notes rather than the table, because the table is
  // what was wrong.
  const stopLike = ["move-reverts", "sell-reverts", "move-some-revert", "sell-some-revert", "move-ok", "sell-ok"];
  for (const code of stopLike) {
    assert.notEqual(topicOf(code), "unread", `${code} reports a completed simulation and must not be filed as unread`);
  }
});

test("no finding a reader must act on is hidden in the unread strip", async () => {
  // The general form, over real slips rather than a list I remembered to
  // write down — which is how the simulation codes survived: the hand-made
  // list could not name what it did not know about.
  //
  // `unread` renders as a collapsed strip titled "questions BOUNCER could
  // not answer". Anything at STOP or WATCH was answered, and putting it
  // there buries the loudest thing on the slip in the quietest box.
  const blockscout = () => new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });
  const opts = { chain: CHAINS.robinhood, factory: PONS_V2_FACTORY, chunkSize: 100_000, launchSearchBlocks: 400_000, skipDev: true };
  const subjects = [DEMO_PLAIN.token, DEMO_IMPOSTOR.token, DEMO.tokens.fresh.token, DEMO.tokens.sprint.token, DEMO_V1.token];

  const buried: string[] = [];
  for (const subject of subjects) {
    const slip = await readDoor(demoRpc(), subject, { ...opts, blockscout: blockscout() });
    for (const n of slip.notes) {
      if (n.level !== "info" && topicOf(n.code) === "unread") buried.push(`${subject.slice(0, 10)} ${n.level} ${n.code}`);
    }
  }
  assert.deepEqual(buried, [], `these were answered and filed as unanswered: ${buried.join("; ")}`);
});
