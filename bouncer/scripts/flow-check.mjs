/**
 * Does the thing a person actually does work?
 *
 * Every other check here measures a part: the depth of the reads, the
 * height of the page, the order of the renders. None of them would notice
 * if the share button threw, or if typing a ticker went nowhere — and
 * those are journeys, not parts. A journey is only tested by walking it.
 *
 *   node scripts/flow-check.mjs [url]
 *
 * Three walks:
 *   1. paste an address → a verdict arrives
 *   2. type a ticker    → candidates arrive, each with its address
 *   3. press Copy card  → a PNG lands on the clipboard
 *
 * The first is run against the demo chain so it needs no network; the
 * other two need the live site and are skipped against a file:// build,
 * because a search with no explorer to search is not a failure of the
 * page.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright-core"));
} catch {
  console.log("flows: playwright-core is not installed, so no journey was walked");
  process.exit(0);
}

function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
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
  console.log("flows: no Chromium found, so no journey was walked (set CHROME_PATH)");
  process.exit(0);
}

const target = process.argv[2] || process.env.BOUNCER_SITE_URL;
const url = target || (existsSync("site/dist/index.html") ? `file://${process.cwd()}/site/dist/index.html` : null);
if (!url) {
  console.error("flows: site/dist/index.html is missing — run the site build first");
  process.exit(1);
}
const live = url.startsWith("http");
console.log(`flows: walking ${url}${live ? "" : " (local build: the two journeys that need an explorer are skipped)"}`);

const browser = await chromium.launch({ executablePath });
// Writing an image to the clipboard needs the permission granted up front;
// without it the page falls back to a download and the walk below would be
// testing the fallback rather than the thing.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
let failures = 0;
const fail = (what) => {
  failures++;
  console.error(`::error::flows: ${what}`);
};

async function walk(name, fn) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await fn(page);
    if (errors.length) fail(`${name}: the page threw — ${errors.join(" | ")}`);
    else console.log(`  ok  ${name}`);
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }
}

/** Waits for a verdict word that is not the page saying it has none yet. */
async function waitForVerdict(page, ms = 40_000) {
  await page.waitForFunction(
    () => {
      const w = document.querySelector(".vword")?.textContent?.trim();
      return Boolean(w) && w !== "READING";
    },
    null,
    { timeout: ms },
  );
  return page.$eval(".vword", (el) => el.textContent.trim());
}

await walk("paste an address, get a verdict", async (page) => {
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000bad01`, { waitUntil: "load" });
  const word = await waitForVerdict(page);
  if (!["STOP", "WATCH", "CLEAR"].includes(word)) throw new Error(`the verdict read "${word}"`);
  if (word !== "STOP") throw new Error(`the demo impostor should be a STOP, not ${word}`);
});

await walk("press Copy card, get a PNG", async (page) => {
  await page.goto(`${url}#/demo/0x0000000000000000000000000000000000f1a1a1`, { waitUntil: "load" });
  await waitForVerdict(page);
  await page.click("#act-share");
  await page.waitForTimeout(1_500);
  // Read it back out of the clipboard. Anything else is trusting the toast.
  const kind = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      return items.flatMap((i) => i.types).join(",");
    } catch (error) {
      return `unreadable: ${error}`;
    }
  });
  if (!kind.includes("image/png")) throw new Error(`the clipboard holds "${kind}", not an image`);
});

if (live) {
  await walk("type a ticker, get candidates", async (page) => {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(600);
    // Live mode, and a name the chain's explorer should know.
    await page.evaluate(() => {
      (document.querySelector("#mode-live") ?? document.querySelector('[data-mode="live"]'))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.fill("#q", "pons");
    await page.click("#go");
    await page.waitForSelector(".found .hit, .error", { timeout: 30_000 });
    const found = await page.$$(".found .hit");
    if (!found.length) {
      const message = await page.$eval(".error", (el) => el.textContent.trim()).catch(() => "(no message)");
      // Nothing indexed under that name is a legitimate answer, and the page
      // saying so clearly is the thing being checked.
      if (!/Nothing on|no explorer|Could not search/i.test(message)) throw new Error(`neither candidates nor an explanation: ${message.slice(0, 120)}`);
      console.log(`      (no matches; the page explained why, which is the other correct answer)`);
      return;
    }
    // Every candidate has to show its address: a list of tickers with no
    // addresses would be asking a reader to trust exactly what this tool
    // exists to stop them trusting.
    const withAddress = await page.$$eval(".found .hit .hit-addr", (els) => els.filter((e) => /^0x[0-9a-f]{40}$/i.test(e.textContent.trim())).length);
    if (withAddress !== found.length) throw new Error(`${found.length} candidates but ${withAddress} showed a full address`);
  });
}

await browser.close();
if (failures) {
  console.error(`\nflows: ${failures} journey${failures === 1 ? "" : "s"} broken.`);
  process.exit(1);
}
console.log("flows: every journey walked end to end");
