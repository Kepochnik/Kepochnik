import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, demoRpc } from "../src/diploma/demo.js";
import { readOdds } from "../src/diploma/odds.js";
import { watch } from "../src/diploma/watch.js";
import { main } from "../src/cli.js";

function capture() {
  let out = "";
  return { write: (t: string) => { out += t; }, text: () => out };
}

test("odds on the demo chain grades LATE as JUNIOR with an eta and NAP as DROPOUT", async () => {
  const rpc = demoRpc();
  const late = await readOdds(rpc, DEMO.tokens.late.token, 3600);
  assert.equal(late.report.grade, "JUNIOR");
  assert.ok(late.report.etaSeconds! > 0);
  assert.equal(late.activity!.buys, 60);
  const nap = await readOdds(rpc, DEMO.tokens.nap.token, 24 * 3600);
  assert.equal(nap.report.grade, "DROPOUT");
  assert.ok(nap.activity!.secondsSinceLastBuy! > 6 * 3600, "only the dev buy at launch, hours ago");
});

test("watch fires confetti exactly once per graduation and counts events", async () => {
  const out = capture();
  const stats = await watch(demoRpc(), { intervalMs: 0, backfillBlocks: 300_000, chunkSize: 100_000, party: false, color: false, animate: false, maxSweeps: 2, write: out.write, sleep: async () => {} });
  assert.equal(stats.launched, 4);
  assert.equal(stats.swept, 2);
  assert.equal(stats.graduated, 2);
  assert.equal(stats.sweeps, 2);
  const text = out.text();
  assert.equal((text.match(/🎓 \$SPRINT · block/g) ?? []).length, 1, "one line per graduation");
  assert.match(text, /\$SPRINT · block \d+ · raised 4\.2 ETH · graduated in 212 s · 9 buyers · dev funded 62% · 71% bought in the first minute/);
  assert.match(text, /\$SLOW · block \d+ · raised 4\.2 ETH · graduated in 62 min · 40 buyers · dev funded 8% · 8% bought in the first minute/);
  assert.match(text, /LAUNCH {3}0x00c0…600d/);
  assert.match(text, /SWEPT {4}0x00c0…600d/);
  assert.match(text, /rate 50\.00%/);
  const party = capture();
  await watch(demoRpc(), { intervalMs: 0, backfillBlocks: 300_000, chunkSize: 100_000, party: true, color: false, animate: false, maxSweeps: 1, write: party.write, sleep: async () => {} });
  assert.match(party.text(), /[▪▫◆•✦]/, "party mode prints confetti");
});

test("cli commands run against the demo chain", async () => {
  for (const argv of [["doctor", "--demo"], ["grade", "--demo"], ["class", "--demo"], ["demo"], ["watch", "--demo", "--static"], ["print", "--demo", "--holder", DEMO.tokens.slow.buys[12][1]]]) {
    const out = capture();
    const code = await main(argv, out.write);
    assert.equal(code, 0, `${argv.join(" ")} -> ${out.text().slice(0, 200)}`);
  }
  const odds = capture();
  await main(["grade", "--demo", "--format", "json"], odds.write);
  const parsed = JSON.parse(odds.text());
  assert.equal(parsed.meta.grade, "JUNIOR");

  const dir = mkdtempSync(join(tmpdir(), "cap-cli-"));
  const svgPath = join(dir, "diploma.svg");
  const svg = capture();
  assert.equal(await main(["print", "--demo", "--format", "svg", "--output", svgPath], svg.write), 0);
  const written = readFileSync(svgPath, "utf8");
  assert.match(written, /\$SPRINT/);
  assert.match(written, /graduated in 212 s · 9 buyers · dev funded 62%/);
  assert.match(written, /4663/);
  const again = capture();
  assert.equal(await main(["print", "--demo", "--format", "svg", "--output", svgPath], again.write), 1, "refuses to overwrite");
  assert.match(again.text(), /refusing to overwrite/);

  const stub = capture();
  await main(["print", DEMO.tokens.slow.token, "--demo", "--holder", DEMO.tokens.slow.buys[12][1]], stub.write);
  assert.match(stub.text(), /buyer #13 of 40/);

  const notGraduated = capture();
  assert.equal(await main(["print", DEMO.tokens.late.token, "--demo"], notGraduated.write), 1);
  assert.match(notGraduated.text(), /has not graduated/);

  const help = capture();
  assert.equal(await main([], help.write), 0);
  assert.match(help.text(), /No key\. No signer\. No transaction path\./);
});
