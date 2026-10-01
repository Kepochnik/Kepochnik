import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { CHAINS } from "../src/chain/chains.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_PLAIN, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor } from "../src/bouncer/door.js";
import { securityRows } from "../src/bouncer/security.js";

const slipFor = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

const by = async (token: string) => Object.fromEntries(securityRows(await slipFor(token)).map((r) => [r.key, r]));

test("a fresh launch: genuine, fixed code, the open door tax is the red row", async () => {
  const rows = await by(DEMO.tokens.fresh.token);
  assert.equal(rows.genuine.tone, "ok");
  assert.equal(rows.code.value, "Fixed");
  assert.equal(rows.door.tone, "stop");
  assert.match(rows.door.value, /^On/);
  assert.equal(rows.fee.value, "11%");
  assert.equal(rows.bundle.tone, "warn");
});

test("a fake copy: the first row says so, and what was not read is never a tick", async () => {
  const rows = await by(DEMO_IMPOSTOR.token);
  assert.equal(rows.genuine.value, "Copy");
  assert.equal(rows.genuine.tone, "stop");
  assert.equal(rows.owner.tone, "unknown");
  assert.equal(rows.powers.tone, "unknown");
  assert.equal(rows.selfdestruct.tone, "stop");
});

test("an ordinary token: owner and powers are read, holders are a share", async () => {
  const rows = await by(DEMO_PLAIN.token);
  assert.equal(rows.owner.value, "Has keys");
  assert.equal(rows.powers.tone, "warn");
  assert.ok(rows.top10);
});

test("every row is short enough for a checklist line", async () => {
  for (const token of [DEMO.tokens.fresh.token, DEMO.tokens.late.token, DEMO.tokens.sprint.token, DEMO_IMPOSTOR.token, DEMO_PLAIN.token]) {
    for (const r of securityRows(await slipFor(token))) {
      assert.ok(r.label.length <= 22, `${r.label}`);
      assert.ok(r.value.length <= 24, `${r.key}: ${r.value}`);
    }
  }
});
