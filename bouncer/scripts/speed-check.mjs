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

/**
 * The promise, in milliseconds, held against the live site.
 *
 * Not aspirations: a target that nothing checks is a target that drifts
 * back. These fail the run. Five seconds for a complete slip is the number
 * asked for, and the two below it are what that requires — if the verdict
 * takes four, the slow half has one, which it will not make.
 *
 * A read that cannot be done in five seconds is not forbidden; what is
 * forbidden is taking nineteen and calling it complete. The sections that
 * run out of time say so on the slip, which is what the "unread" strip has
 * always been for.
 */
const BUDGET = {
  painted: Number(process.env.BUDGET_PAINTED ?? 2_000),
  // Four, not three. Three was a number derived from the five, and the
  // chain will not have it: on Robinhood one /api/v2/addresses read is
  // about three seconds on its own, and the verdict needs it — that read
  // carries the explorer's scam flag, which is a STOP. A verdict that does
  // not wait for it is one that can turn CLEAR into STOP a second later,
  // which is the thing this whole design refuses to do. So the budget is
  // set to what the slowest server involved actually allows, and said so
  // here rather than quietly relaxed.
  verdict: Number(process.env.BUDGET_VERDICT ?? 4_000),
  complete: Number(process.env.BUDGET_COMPLETE ?? 5_000),
};

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

/**
 * How many times each token is measured, and why more than once.
 *
 * Two runs five minutes apart, against the same site and the same token,
 * with a 250 ms change between them, came back 4.5 s and 9.1 s. Nothing in
 * the code did that; a public endpoint had a bad minute. A check that fails
 * on one sample of a noisy quantity is a check that gets ignored within a
 * week, and every conclusion drawn from one sample of it is a guess wearing
 * a number.
 *
 * So: three runs, judged on the median, with the spread printed. The spread
 * is the honest part — when it is wide, the median is worth less, and
 * whoever reads the run should be able to see that rather than take the
 * middle number on faith.
 *
 * And a gap between them, which matters more than the count.
 *
 * Run one after another, the runs came back 9.5 s, 5.2 s, 5.1 s, and the
 * median called that 5.2. It was measuring its own cache: the proxy holds
 * explorer answers at the edge for ten seconds, so runs two and three read
 * what run one had just fetched. Nobody pasting a contract into this box
 * gets that. They get run one. A median over a warm cache is a number about
 * the check, not about the tool — the same self-flattery as timing a page
 * load with the browser cache on.
 *
 * So the runs are spaced past the cache, and every one of them is cold.
 * Slower to run, and the only version of the number a reader would
 * recognise.
 */
const RUNS = Number(process.env.SPEED_RUNS ?? 3);
/** Longer than the proxy's edge cache, so no run is served another run's reads. */
const COLD_GAP_MS = Number(process.env.SPEED_GAP_MS ?? 12_000);

const browser = await chromium.launch({ executablePath });

/** One measurement: paste the address, watch for the three moments. */
async function measure() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
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
      if (state.failed) return { unreadable: true };
      if (state.painted && firstPaint === null) firstPaint = Date.now() - started;
      if (state.verdict && firstAnswer === null) firstAnswer = Date.now() - started;
      if (state.verdict && !state.pending && firstAnswer !== null) {
        complete = Date.now() - started;
        break;
      }
      await page.waitForTimeout(100);
    }
    // Where the seconds went, from the page's own clock. Only worth printing
    // when a run was slow; on a fast one it is noise.
    const wire = await page.evaluate(() =>
      (window.__bouncerWire ?? []).map((w) => {
        // Strip the host for readability, but never to nothing: a request to a
        // bare origin printed as an empty line, which is the one thing a log
        // of what-took-so-long must not do.
        const short = w.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        return { ...w, url: short || w.url.split("?")[0] };
      }),
    );
    return { firstPaint, firstAnswer, complete: complete ?? DEADLINE, wire };
  } finally {
    await page.close();
  }
}

const samples = [];
for (let i = 0; i < RUNS; i++) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, COLD_GAP_MS));
  const one = await measure();
  if (one.unreadable) {
    console.log(`::warning title=speed on ${chain}::the site could not read this chain from the runner, so nothing was timed`);
    await browser.close();
    process.exit(0);
  }
  if (one.firstAnswer === null) {
    console.error(`::error::speed: no verdict appeared within 120 s`);
    await browser.close();
    process.exit(1);
  }
  samples.push(one);
  console.log(`  run ${i + 1}: painted ${(one.firstPaint / 1000).toFixed(1)} s · verdict ${(one.firstAnswer / 1000).toFixed(1)} s · complete ${(one.complete / 1000).toFixed(1)} s`);
  // The runs that miss a budget are the ones worth explaining, and the page
  // is the only thing that knows. Guessing from here is what got this wrong
  // twice.
  if (one.complete > BUDGET.complete) {
    // Anything still in the air comes first, however long the settled ones
    // took: a request that never answered outranks every one that did.
    const wire = [...(one.wire ?? [])].sort((a, b) => Number(a.done) - Number(b.done) || b.ms - a.ms);
    for (const w of wire.slice(0, 6)) {
      const took = w.done ? `${String(w.ms).padStart(5)} ms` : "  still in the air";
      console.log(`        ${took}  at ${String(w.at).padStart(5)} ms  ${!w.done ? "?" : w.ok ? " " : "!"} ${w.url}`);
    }
  }
}
await browser.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = (xs) => `${(Math.min(...xs) / 1000).toFixed(1)}–${(Math.max(...xs) / 1000).toFixed(1)} s`;
const painted = samples.map((s) => s.firstPaint ?? s.firstAnswer);
const verdicts = samples.map((s) => s.firstAnswer);
const completes = samples.map((s) => s.complete);
const firstPaint = median(painted);
const firstAnswer = median(verdicts);
const full = median(completes);

// A notice, not a log line: the numbers are the point of the run and they
// were getting buried under the artifact upload. An annotation shows in the
// run summary and comes back from the API without wrestling a log tail.
console.log(
  `::notice title=speed on ${chain}::median of ${RUNS}: first thing on screen ${(firstPaint / 1000).toFixed(1)} s, verdict ${(firstAnswer / 1000).toFixed(1)} s, complete ${(full / 1000).toFixed(1)} s · spread ${spread(completes)}`,
);
// The whole point of the two passes. If the first answer is not meaningfully
// sooner than the complete one, the split is costing a duplicate read and
// buying nothing, and that is worth knowing rather than assuming.
if (full - firstAnswer < 500) {
  console.log(`::warning title=speed on ${chain}::the slow half arrived with the fast one — on this token the split bought nothing and costs a duplicate read`);
}

let over = false;
for (const [what, got, budget] of [
  ["something on screen", firstPaint ?? firstAnswer, BUDGET.painted],
  ["a verdict", firstAnswer, BUDGET.verdict],
  ["a complete slip", full, BUDGET.complete],
]) {
  if (got > budget) {
    console.log(`::error title=speed on ${chain}::${what} took ${(got / 1000).toFixed(1)} s at the median of ${RUNS}, over its budget of ${(budget / 1000).toFixed(1)} s`);
    over = true;
  }
}
if (over) process.exit(1);
