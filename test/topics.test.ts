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
import { TOPIC_BLURB, TOPIC_ORDER, TOPIC_QUESTION, mappedCodes, topicOf } from "../src/bouncer/topics.js";

/** Every `code: "…"` literal in the files that build slips. */
function codesInSource(): Set<string> {
  const out = new Set<string>();
  for (const file of ["src/bouncer/door.ts", "src/bouncer/spl.ts"]) {
    for (const m of readFileSync(file, "utf8").matchAll(/code:\s*"([a-z0-9-]+)"/g)) out.add(m[1]);
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
