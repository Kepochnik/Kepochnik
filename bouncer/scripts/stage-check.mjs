/**
 * Does the page actually draw three times, in order?
 *
 * The whole argument for the opening render is that a reader sees something
 * true before the slowest server has answered. That is a claim about what
 * happens in a browser over time, and nothing in the source proves it: the
 * passes could silently collapse into one, or the opening one could start
 * printing a verdict it has not earned, and every unit test would still be
 * green.
 *
 * So: load a demo token in a real browser, watch the verdict block, and
 * record every state it passes through.
 *
 *   node scripts/stage-check.mjs [url]
 *
 * Two things fail it. Fewer than two distinct renders means the staging is
 * not happening. A word other than READING on the first one means a verdict
 * was published off a quarter of the evidence — which is worse than slow,
 * because a STOP that turns into a CLEAR teaches a reader to ignore the
 * next one.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright-core"));
} catch {
  console.log("stages: playwright-core is not installed, so the renders were not watched");
  process.exit(0);
}

function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const path of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]) {
    if (existsSync(path)) return path;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const name of ["chromium", "chromium-1194"]) {
      const p = `${root}/${name}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}
const executablePath = findChromium();
if (!executablePath) {
  console.log("stages: no Chromium found, so the renders were not watched (set CHROME_PATH)");
  process.exit(0);
}

const target = process.argv[2] || process.env.BOUNCER_SITE_URL;
const url = target || (existsSync("site/dist/index.html") ? `file://${process.cwd()}/site/dist/index.html` : null);
if (!url) {
  console.error("stages: site/dist/index.html is missing — run the site build first");
  process.exit(1);
}
console.log(`stages: watching ${url}`);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// The route is in the URL from the first paint. Loading the page bare and
// then setting the hash means watching TWO runs: the demo the front page
// starts by itself, and the one the hash asks for.
const route = "#/demo/0x0000000000000000000000000000000000f1a1a1";
await page.goto(`${url}${route}`, { waitUntil: "load" });

// Record every distinct state the verdict block passes through, from before
// the route is set until the reads have finished.
await page.evaluate(() => {
  window.__stages = [];
  const seen = new Set();
  const look = () => {
    const el = document.querySelector(".verdict");
    if (!el) return;
    const kind = [...el.classList].find((c) => c.startsWith("v-")) ?? "";
    const word = el.querySelector(".vword")?.textContent?.trim() ?? "";
    const chip = el.querySelector(".pendingchip")?.textContent?.trim() ?? "";
    const key = `${kind}|${word}|${chip}`;
    if (seen.has(key)) return;
    seen.add(key);
    window.__stages.push({ kind, word, chip, at: Math.round(performance.now()) });
  };
  new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true });
  look();
});

// Long enough for the full pass, which walks the demo chain's log fixture.
for (let waited = 0; waited < 20_000; waited += 250) {
  await page.waitForTimeout(250);
  const done = await page.evaluate(() => !document.querySelector(".verdict .pendingchip") && Boolean(document.querySelector(".verdict")));
  if (done) break;
}

const stages = await page.evaluate(() => window.__stages);
await browser.close();

for (const s of stages) console.log(`  ${String(s.at).padStart(5)} ms  ${s.word.padEnd(8)} ${s.kind}${s.chip ? ` · ${s.chip}` : ""}`);

let failed = false;
if (errors.length) {
  for (const e of errors) console.error(`::error::stages: the page threw — ${e}`);
  failed = true;
}
if (stages.length < 2) {
  console.error(`::error::stages: the verdict block was drawn ${stages.length} time(s); the staged render is not happening`);
  failed = true;
}
if (stages.length && stages[0].word !== "READING") {
  console.error(`::error::stages: the first render already said "${stages[0].word}" — a verdict off part of the evidence`);
  failed = true;
}
if (stages.length && stages[stages.length - 1].chip) {
  console.error(`::error::stages: the last render still says "${stages[stages.length - 1].chip}"`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`stages: ${stages.length} renders, opening one carries no verdict, the last one carries no "still reading"`);
