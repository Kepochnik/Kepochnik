import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAINS, canDo, featureBlocker, type Feature } from "../src/chain/chains.js";

const FEATURES: Feature[] = ["door", "board", "plan", "wallet", "tx", "dev"];

test("the board and the planner are not offered where there is no factory to walk", () => {
  // The audit: picking Solana and then "Tonight's board" answered
  // `Method not found`, because the board reads a launchpad factory's
  // event log with eth_getLogs and Solana has neither.
  assert.equal(canDo(CHAINS.solana, "board"), false);
  assert.equal(canDo(CHAINS.solana, "plan"), false);
  assert.match(featureBlocker(CHAINS.solana, "board") ?? "", /not an EVM chain/);
  // Robinhood Chain has the launchpad these two exist for.
  assert.equal(canDo(CHAINS.robinhood, "board"), true, "the chain with the factory must keep its board");
  assert.equal(canDo(CHAINS.robinhood, "plan"), true);
});

test("an EVM chain with no launchpad is refused for a different reason, and says so", () => {
  // Base is an EVM chain, so eth_getLogs works fine — there is simply no
  // factory whose launches could be listed. Same refusal, different
  // reason, and a reader who is told "not an EVM chain" about Base would
  // rightly conclude the tool has no idea what it is talking about.
  const base = CHAINS.base;
  if (base.factory && base.launchpad) return; // a launchpad was published since; nothing to assert
  assert.equal(canDo(base, "board"), false);
  assert.match(featureBlocker(base, "board") ?? "", /knows no launchpad/);
  assert.ok(!/not an EVM chain/.test(featureBlocker(base, "board") ?? ""));
});

test("reading a token is offered on every chain BOUNCER lists", () => {
  // The one thing the tool is for. A chain whose door is closed should
  // not be in the menu at all, so this failing means the menu is lying.
  for (const chain of Object.values(CHAINS)) {
    assert.equal(featureBlocker(chain, "door"), null, `${chain.name} is offered in the picker but its door is blocked`);
  }
});

test("every refusal is a sentence a reader can act on, never a method name", () => {
  for (const chain of Object.values(CHAINS)) {
    for (const feature of FEATURES) {
      const why = featureBlocker(chain, feature);
      if (why === null) continue;
      assert.ok(why.length > 30, `${chain.key}/${feature}: "${why}" is too short to explain anything`);
      assert.ok(why.includes(chain.name), `${chain.key}/${feature}: the refusal must name the chain it is about`);
      // The failure this replaces. If any of these leak through, the
      // reader is back to reading a JSON-RPC error and guessing.
      assert.ok(!/Method not found|-32601|eth_[a-z]+\b/i.test(why), `${chain.key}/${feature}: "${why}" is an RPC error, not an answer`);
    }
  }
});

test("the matrix is derived from the config, so a published factory turns its features on", () => {
  // Not a hand-kept table. The moment a launchpad address is published for
  // a chain, the board and the planner have to become available there
  // without anybody remembering to edit a second list — and if this ever
  // stops being true, the list and the chains will drift apart silently.
  const nowhere = { ...CHAINS.base, factory: null, launchpad: null };
  const somewhere = { ...CHAINS.base, factory: "0x" + "11".repeat(20), launchpad: "Pons V2" };
  assert.equal(canDo(nowhere, "board"), false);
  assert.equal(canDo(somewhere, "board"), true, "publishing a factory must be all it takes");
});

test("an ordinary token is not stamped as a shortfall", async () => {
  const { stampLabel, stampTone } = await import("../src/bouncer/door.js");
  // The audit: "NOT A LAUNCH" appeared on BONK and on USDC, boxed in the
  // palette's WATCH amber. On a chain with no launchpad BOUNCER knows it
  // is true of every token that will ever be pasted in, so it carries no
  // information and reads as an accusation.
  assert.equal(stampLabel("NOT A LAUNCH", null), "ORDINARY TOKEN");
  assert.equal(stampTone("NOT A LAUNCH"), "flat", "an ordinary token must not be coloured like a warning");
  assert.notEqual(stampTone("NOT A LAUNCH"), "no");

  // Where there IS a launchpad the distinction is worth drawing, because
  // the reader may have been told this token was one of its launches.
  assert.equal(stampLabel("NOT A LAUNCH", "Pons V2"), "NOT A PONS V2 LAUNCH");
  assert.equal(stampLabel("ON THE LIST", "Pons V2"), "PONS V2 LAUNCH");

  // The one stamp that IS a warning keeps its voice: a token wearing the
  // ticker of a real launch is exactly what this tool exists to catch.
  assert.equal(stampTone("NOT ON THE LIST"), "no");
});
