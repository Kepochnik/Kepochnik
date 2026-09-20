/**
 * How long until something true is on screen, how long until there is a
 * verdict, and how long until it is complete? Three numbers, and they are
 * not the same number.
 *
 * Measured on Base, one door, before any of this:
 *
 *   eth_getLogs                15 calls, 13136 ms
 *   eth_getTransactionReceipt  58 calls,  2649 ms
 *   everything else                       ~1920 ms
 *
 * 89% of an eighteen-second read is one section — who holds the pool's
 * liquidity. So the page renders the fast half first and fills the rest in.
 * That claim is worth nothing unless somebody measures it against the real
 * site on a real chain, which is what this does.
 *
 * The first of the three is the one a reader feels. The page draws the
 * chain-only render first — what the code can do, who holds the keys — with
 * the word READING where the verdict goes, because a verdict off a quarter
 * of the evidence is one that changes while you are reading it. So "a
 * verdict appeared" and "the page stopped being blank" are measured apart.
 *
 *   node scripts/speed-check.mjs <site-url> <chain> <token>
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const [, , site = "https://kepochnik.github.io/bouncer/", chain = "base", token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"] = process.argv;

function findChromium() {
  for (const p of [
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    `${process.env.PLAYWRIGHT_BROWSERS_PATH ?? ""}/chromium-1194/chrome-linux/chrome`,
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright-core"));
} catch {
  // reported below
}
const executablePath = chromium ? findChromium() : null;
if (!executablePath) {
  console.log("speed: no Chromium, so nothing was timed");
  process.exit(0);
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(site, { waitUntil: "load" });
await page.waitForTimeout(500);

const started = Date.now();
await page.evaluate((h) => { location.hash = h; }, `#/t/${token}?chain=${chain}`);

let firstPaint = null;
let firstAnswer = null;
let complete = null;
const DEADLINE = 120_000;
while (Date.now() - started < DEADLINE) {
  const state = await page.evaluate(() => {
    const word = document.querySelector(".vword")?.textContent?.trim() ?? "";
    return {
      // Anything on screen at all, including the opening render.
      painted: Boolean(word),
      // A verdict proper. READING is the page saying it does not have one yet.
      verdict: Boolean(word) && word !== "READING",
      pending: !!document.querySelector(".pendingchip"),
      failed: !!document.querySelector(".error"),
    };
  });
  if (state.failed) {
    console.log(`::warning title=speed on ${chain}::the site could not read this chain from the runner, so nothing was timed`);
    await browser.close();
    process.exit(0);
  }
  if (state.painted && firstPaint === null) firstPaint = Date.now() - started;
  if (state.verdict && firstAnswer === null) firstAnswer = Date.now() - started;
  // Complete means a verdict is up and the "still reading" chip is gone.
  if (state.verdict && !state.pending && firstAnswer !== null) {
    complete = Date.now() - started;
    break;
  }
  await page.waitForTimeout(100);
}
await browser.close();

if (firstAnswer === null) {
  console.error(`::error::speed: no verdict appeared within ${DEADLINE / 1000} s`);
  process.exit(1);
}
const full = complete ?? DEADLINE;
// A notice, not a log line: the numbers are the point of the run and they
// were getting buried under the artifact upload. An annotation shows in the
// run summary and comes back from the API without wrestling a log tail.
console.log(
  `::notice title=speed on ${chain}::first thing on screen in ${((firstPaint ?? firstAnswer) / 1000).toFixed(1)} s, verdict in ${(firstAnswer / 1000).toFixed(1)} s, complete in ${(full / 1000).toFixed(1)} s`,
);
// The whole point of the two passes. If the first answer is not meaningfully
// sooner than the complete one, the split is costing a duplicate read and
// buying nothing, and that is worth knowing rather than assuming.
if (full - firstAnswer < 500) {
  console.log(`::warning title=speed on ${chain}::the slow half arrived with the fast one — on this token the split bought nothing and costs a duplicate read`);
}
