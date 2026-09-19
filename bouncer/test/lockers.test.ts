/**
 * Where a locker's name is allowed to come from.
 *
 * The rule this codebase will not break: a table of locker addresses written
 * from memory never ships, because a wrong entry tells somebody their money
 * is safe. A launchpad publishing its own locker through a view is a
 * different thing entirely — it is read from the chain at a block, like the
 * factory record itself. These tests are about keeping those two apart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCall, encodeWord, type Hex } from "../src/chain/abi.js";
import { CHAINS } from "../src/chain/chains.js";
import { V1_FACTORY_FUNCTIONS } from "../src/chain/pons.js";
import type { RpcClient } from "../src/chain/rpc.js";
import { resolveLockers } from "../src/bouncer/door.js";

const FACTORY_V2 = "0x00000000000000000000000000000000000000f2";
const FACTORY_V1 = "0x00000000000000000000000000000000000000f1";
const LOCKER_V2 = "0x000000000000000000000000000000000000l0c2".slice(0, 42).replace("l0c2", "ac02");
const LOCKER_V1 = "0x000000000000000000000000000000000000ac01";
const ZERO = "0x0000000000000000000000000000000000000000";

const chain = { ...CHAINS.robinhood, lockers: undefined };
const addressWord = (a: string): Hex => `0x${encodeWord("address", a)}`;
const SELECTOR = encodeCall(V1_FACTORY_FUNCTIONS.locker, []).slice(0, 10);

/** An RPC where each factory answers locker() from a table; anything else reverts. */
function rpcOf(answers: Record<string, string | Error>): RpcClient {
  return {
    callBatchSettled: async (calls: { to: string; data: string }[]) =>
      calls.map((call) => {
        if (call.data.slice(0, 10) !== SELECTOR) return new Error("execution reverted");
        const out = answers[call.to.toLowerCase()];
        if (out === undefined || out instanceof Error) return out ?? new Error("execution reverted");
        return addressWord(out);
      }),
  } as unknown as RpcClient;
}

test("the locker the factory publishes is named, and named after the launchpad", async () => {
  const table = await resolveLockers(rpcOf({ [FACTORY_V2]: LOCKER_V2, [FACTORY_V1]: LOCKER_V1 }), chain, FACTORY_V2, FACTORY_V1, 100);
  assert.ok(table);
  assert.match(table[LOCKER_V2], /Pons V2 locker/);
  assert.match(table[LOCKER_V1], /Pons V1 locker/);
});

test("a factory that does not answer contributes nothing, and does not take the other with it", async () => {
  // One of the two reverting is the normal case on a chain that only ever
  // had one launchpad version.
  const table = await resolveLockers(rpcOf({ [FACTORY_V2]: LOCKER_V2 }), chain, FACTORY_V2, FACTORY_V1, 100);
  assert.deepEqual(Object.keys(table ?? {}), [LOCKER_V2]);
});

test("a zero address is not a locker", async () => {
  // An unset locker() returns zero, and entering it would mean every holder
  // BOUNCER cannot classify gets compared against the zero address.
  const table = await resolveLockers(rpcOf({ [FACTORY_V2]: ZERO, [FACTORY_V1]: ZERO }), chain, FACTORY_V2, FACTORY_V1, 100);
  assert.equal(Object.keys(table ?? {}).length, 0);
});

test("an endpoint that refuses the batch claims no locker at all", async () => {
  // The safe direction: no verified locker means the liquidity reads as
  // withdrawable, which overstates the risk rather than understating it.
  const rpc = { callBatchSettled: async () => { throw new Error("upstream closed the connection"); } } as unknown as RpcClient;
  assert.equal(await resolveLockers(rpc, chain, FACTORY_V2, FACTORY_V1, 100), undefined);
});

test("the V1 factory that registered this token wins over the configured one", async () => {
  // A chain can have had more than one V1 factory, and a locker read off the
  // wrong one is the near-miss that would name a contract that locks somebody
  // else's liquidity.
  const OTHER_V1 = "0x00000000000000000000000000000000000000f9";
  const withConfigured = { ...chain, factoryV1: FACTORY_V1 };
  const table = await resolveLockers(rpcOf({ [FACTORY_V2]: LOCKER_V2, [OTHER_V1]: LOCKER_V1, [FACTORY_V1]: "0x00000000000000000000000000000000000000bb" }), withConfigured, FACTORY_V2, OTHER_V1, 100);
  assert.ok(table?.[LOCKER_V1], "the factory this token was actually registered by is the one asked");
  assert.equal(table?.["0x00000000000000000000000000000000000000bb"], undefined, "and the configured fallback is not also asked");
});

test("no factory at all leaves the chain's own table untouched", async () => {
  // A chain with no launchpad has nothing to ask, so nothing is asked.
  const withTable = { ...chain, factoryV1: undefined, lockers: { [LOCKER_V1]: "a locker from the chain config" } };
  let asked = false;
  const rpc = { callBatchSettled: async () => { asked = true; return []; } } as unknown as RpcClient;
  assert.deepEqual(await resolveLockers(rpc, withTable, undefined, undefined, 100), withTable.lockers);
  assert.equal(asked, false);
});
