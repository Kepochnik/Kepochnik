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

test("exit and wallet answer for an ordinary token instead of refusing it", async () => {
  // Both used to throw "is not a Pons V2 launch on this factory" for every token
  // that was not a V2 launch, which is most of them and all of them on a chain
  // with no launchpad.
  const token = "0x0000000000000000000000000000000000f1a1a1";
  const holder = "0x000000000000000000000000000000000000c500";

  const exit = await run(["exit", token, "--demo"]);
  assert.equal(exit.code, 0);
  assert.match(exit.out, /WALK OUT NOW/);
  assert.match(exit.out, /sell 100%/);
  assert.match(exit.out, /WETH/);
  assert.ok(!/is not a Pons V2 launch/.test(exit.out));

  const bag = await run(["wallet", token, holder, "--demo"]);
  assert.equal(bag.code, 0);
  assert.match(bag.out, /THE BAG/i);
  assert.match(bag.out, /balance/);
  assert.match(bag.out, /worth now/);
  assert.match(bag.out, /no launchpad curve/);

  const asJson = await run(["exit", token, "--demo", "--format", "json"]);
  assert.equal(asJson.code, 0);
  const parsed = JSON.parse(asJson.out.replace(/^DEMO.*\n/, ""));
  assert.equal(parsed.market.best.kind, "v3");
  assert.equal(parsed.market.quotes.length, 4);
});

test("exit still uses the curve for a real launch", async () => {
  const { code, out } = await run(["exit", "0x00000000000000000000000000000000000000a7", "--demo"]);
  assert.equal(code, 0);
  assert.match(out, /curve/);
});

test("a launchpad-only command on a chain with no launchpad refuses at once, and names the one that works", async () => {
  // It must not reach the network first: a round trip that fails would hide the
  // real reason behind whatever the endpoint happened to say.
  for (const command of [["dev", "0x0000000000000000000000000000000000000001"], ["board"], ["plan"]]) {
    for (const chain of ["base", "bnb"]) {
      const { code, out } = await run([...command, "--chain", chain]);
      assert.equal(code, 1, `${command[0]} on ${chain}`);
      // The intent, not one phrasing of it. This used to pin the exact
      // sentence, and when the refusal moved to a gate shared with the
      // website the test failed over wording while the behaviour was
      // right — the same blindness that let a matrix check pass a drift
      // it was written to catch, because it knew one refusal and the CLI
      // had two.
      assert.match(out, /launchpad/i, `${command[0]} on ${chain} must say why: ${out.slice(0, 160)}`);
      assert.match(out, new RegExp(chain), "and name the chain it is about");
      assert.match(out, new RegExp(`bouncer door <address> --chain ${chain}`), "and point at the command that does work");
      assert.ok(!/responded \d\d\d|fetch failed|ENOTFOUND/.test(out), "it must not have touched the network");
    }
  }
});

test("the chain list in help names every chain the tool can read", async () => {
  const { out } = await run([]);
  for (const chain of ["robinhood", "base", "bnb", "solana", "arc"]) assert.match(out, new RegExp(chain));
});
