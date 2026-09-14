import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.js";

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(argv, (t) => { out += t; });
  return { code, out };
}

test("help", async () => {
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.match(out, /bouncer door <token\|curve>/);
});

test("demo walkthrough prints three slips", async () => {
  const { code, out } = await run(["demo"]);
  assert.equal(code, 0);
  assert.equal((out.match(/BOUNCER · /g) ?? []).length, 3);
  assert.match(out, /NOT ON THE LIST/);
  assert.match(out, /open · 6 s left/);
});

test("door --demo --format json", async () => {
  const { code, out } = await run(["door", "--demo", "--format", "json"]);
  assert.equal(code, 0);
  const slip = JSON.parse(out.slice(out.indexOf("{")));
  assert.equal(slip.stamp, "ON THE LIST");
  assert.equal(slip.cover.status, "open");
});

test("door --demo --format svg", async () => {
  const { code, out } = await run(["door", "--demo", "--format", "svg", "--no-dev"]);
  assert.equal(code, 0);
  assert.match(out, /<svg xmlns/);
});

test("doctor --demo", async () => {
  const { code, out } = await run(["doctor", "--demo"]);
  assert.equal(code, 0);
  assert.match(out, /snipe tax window\s+15s/);
});

test("dev --demo", async () => {
  const { code, out } = await run(["dev", "--demo"]);
  assert.equal(code, 0);
  assert.match(out, /3 launches · 1 graduated/);
});

test("bad address is a clean error", async () => {
  const { code, out } = await run(["door", "nope", "--demo"]);
  assert.equal(code, 1);
  assert.match(out, /not an address/);
});
