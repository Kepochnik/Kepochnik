import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots, type Snapshot } from "../src/bouncer/changes.js";

const text = (code: string) => `the finding called ${code}`;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    chain: "robinhood",
    address: "0xabc",
    at: 1_700_000_000,
    height: 100,
    verdict: "CLEAR",
    stamp: "NOT A LAUNCH",
    symbol: "TKN",
    codes: [],
    facts: { owner: null, canMint: false, canFreeze: false, taxBps: 100, top10Bps: 2_000, poolQuote: "1000" },
    coverage: "complete",
    ...over,
  };
}

test("a verdict that got worse is the loudest thing on the diff", () => {
  const before = snap({ verdict: "CLEAR" });
  const after = snap({ verdict: "STOP", at: before.at + 3_600, codes: [{ code: "mint-authority", level: "stop" }] });
  const d = diffSnapshots(before, after, text);
  assert.equal(d.ageSeconds, 3_600);
  assert.equal(d.changes[0].level, "stop", "the worst change has to come first");
  assert.ok(d.changes.some((c) => c.kind === "verdict" && /was CLEAR.*is STOP now/.test(c.text)));
  assert.equal(d.confident, false);
});

test("a power that appeared is a STOP; one that went away is not", () => {
  const before = snap({ facts: { ...snap().facts, canMint: false } });
  const after = snap({ at: before.at + 60, facts: { ...snap().facts, canMint: true } });
  assert.ok(diffSnapshots(before, after, text).changes.some((c) => c.kind === "mint" && c.level === "stop"));
  // And the other direction is not an alarm.
  const back = diffSnapshots(after, snap({ at: after.at + 60 }), text);
  assert.ok(!back.changes.some((c) => c.level === "stop"), `losing a mint power must not read as danger: ${JSON.stringify(back.changes)}`);
});

test("a section that could not be read is never reported as a change", () => {
  // The rule this file is built around. "The dev dumped" and "the
  // explorer was down" must never look the same, and the second is by far
  // the more common.
  const before = snap({ facts: { ...snap().facts, top10Bps: 2_000, owner: "0x1", poolQuote: "1000" } });
  const after = snap({
    at: before.at + 600,
    // Everything unreadable this time.
    facts: { owner: null, canMint: null, canFreeze: null, taxBps: null, top10Bps: null, poolQuote: null },
    coverage: "thin",
  });
  const d = diffSnapshots(before, after, text);
  for (const c of d.changes) {
    assert.ok(!["owner", "liquidity", "concentration", "tax", "mint", "freeze"].includes(c.kind), `an unread section produced "${c.kind}": ${c.text}`);
  }
  assert.equal(d.confident, false, "a half-read slip can never support 'nothing changed'");
});

test("a finding that vanished while the check was incomplete is not called gone", () => {
  const before = snap({ codes: [{ code: "mint-authority", level: "stop" }] });
  // Same token, but this reading never got to the powers.
  const after = snap({ at: before.at + 600, codes: [], coverage: "thin" });
  const d = diffSnapshots(before, after, text);
  assert.ok(!d.changes.some((c) => c.kind.startsWith("gone:")), `a gap made a finding look resolved: ${JSON.stringify(d.changes)}`);
});

test("a finding that vanished from a complete reading IS reported", () => {
  const before = snap({ codes: [{ code: "freeze-authority", level: "stop" }], verdict: "STOP" });
  const after = snap({ at: before.at + 600, codes: [], verdict: "CLEAR" });
  const d = diffSnapshots(before, after, text);
  assert.ok(d.changes.some((c) => c.kind === "gone:freeze-authority"));
  // Good news is not shouted.
  assert.ok(!d.changes.some((c) => c.kind.startsWith("gone:") && c.level === "stop"));
});

test("a new finding is described in the words the page is already using", () => {
  const after = snap({ at: snap().at + 60, codes: [{ code: "high-tax", level: "stop" }] });
  const d = diffSnapshots(snap(), after, (c) => (c === "high-tax" ? "Every sale pays 30% to the deployer." : null));
  const made = d.changes.find((c) => c.kind === "new:high-tax");
  assert.ok(made);
  assert.match(made!.text, /Every sale pays 30%/, "the diff must not invent a second vocabulary for the same finding");
});

test("a gap appearing in the unread strip is not news", () => {
  const after = snap({ at: snap().at + 60, codes: [{ code: "skipped", level: "info" }] });
  const d = diffSnapshots(snap(), after, text);
  assert.deepEqual(d.changes, [], `a failed read is not a change in the token: ${JSON.stringify(d.changes)}`);
  assert.equal(d.confident, true, "both readings were complete and nothing about the token moved");
});

test("a pool that shrank is reported without claiming to know why", () => {
  const before = snap({ facts: { ...snap().facts, poolQuote: "1000" } });
  const after = snap({ at: before.at + 60, facts: { ...snap().facts, poolQuote: "300" } });
  const d = diffSnapshots(before, after, text);
  const liq = d.changes.find((c) => c.kind === "liquidity");
  assert.ok(liq && liq.level === "stop", "70% smaller is a STOP");
  // Balances cannot tell a withdrawal from a price move, and saying "the
  // liquidity was pulled" would be a claim this has no evidence for.
  assert.ok(!/pulled|rug|withdrawn by/i.test(liq!.text));
  assert.match(liq!.text, /do not say which/);
  // And noise stays quiet.
  const small = diffSnapshots(before, snap({ at: before.at + 60, facts: { ...snap().facts, poolQuote: "950" } }), text);
  assert.ok(!small.changes.some((c) => c.kind === "liquidity"), "a 5% move is not an event");
});

test("nothing changed is only claimed when both readings actually looked", () => {
  const d = diffSnapshots(snap(), snap({ at: snap().at + 86_400 }), text);
  assert.equal(d.changes.length, 0);
  assert.equal(d.confident, true);
  assert.equal(d.ageSeconds, 86_400, "the age has to travel with the answer — 'nothing changed' since March is worth little");
});
