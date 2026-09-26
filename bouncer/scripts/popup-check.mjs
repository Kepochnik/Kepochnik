/**
 * Does the Chrome popup actually open the right token on the right chain?
 *
 * The popup is the one surface nothing had ever run. It was checked two ways
 * — that its stylesheet targets classes the app can emit, and that its
 * manifest allows the endpoints its chains need — and both passed while the
 * popup itself did the single worst thing it could do: it sent every page it
 * did not recognise to Robinhood Chain. Open it on a Base token page and it
 * read those twenty bytes on a chain where they are a different contract, or
 * nothing at all, and then printed a verdict about it. On a Solana page it did
 * nothing, because its address pattern was EVM-only.
 *
 * Neither check could see that, because the bug was in what the popup DOES
 * when Chrome hands it a tab. So this one hands it a tab.
 *
 * The three files Chrome loads in the popup are loaded for real
 * (popup.html → page-subject.js → popup-init.js → app.js) over a local
 * server, with `chrome.tabs` and `chrome.storage` stubbed to the answers
 * Chrome would give. Everything after that is the extension's own code.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const guesses = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ];
  for (const path of guesses) if (existsSync(path)) return path;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const name of ["chromium", "chromium-1194"]) {
      const p = `${root}/${name}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright-core"));
} catch {
  console.log("popup: playwright-core is not installed, so the popup was not opened");
  process.exit(0);
}
const executablePath = findChromium();
if (!executablePath) {
  console.log("popup: no Chromium found, so the popup was not opened (set CHROME_PATH)");
  process.exit(0);
}
if (!existsSync("extension/popup.html")) {
  console.error("popup: extension/popup.html is missing — run the site build first");
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join("extension", path === "/" ? "popup.html" : path);
  if (!existsSync(file)) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const fail = (what) => { failures++; console.error(`::error::popup: ${what}`); };

const browser = await chromium.launch({ executablePath });
console.log(`popup: opening extension/popup.html as Chrome does, over ${base}`);

/**
 * One popup opening, on a tab showing `tabUrl`.
 *
 * `chrome` is stubbed rather than mocked away: popup-init.js calls
 * chrome.tabs.query and chrome.storage.sync.get, and a stub that answers
 * those the way Chrome does leaves every line of the extension's own logic
 * running for real.
 */
async function open(tabUrl, width = POPUP_WIDTH || 560) {
  const context = await browser.newContext({ viewport: { width, height: 600 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(`window.chrome = {
    tabs: { query: (_q, cb) => cb([{ url: ${JSON.stringify(tabUrl)} }]) },
    storage: { sync: { get: (d, cb) => cb(d), set: (_v, cb) => cb && cb() } },
    permissions: { request: (_o, cb) => cb && cb(true) },
    runtime: { id: "checkcheckcheckcheckcheckcheckch" },
  };`);
  await page.goto(`${base}/popup.html`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  return { page, context, errors };
}

/** The route the popup actually put itself on. */
const routeOf = (page) => page.evaluate(() => location.hash);

/** The width the stylesheet asks Chrome for, which is the only width it opens at. */
const POPUP_WIDTH = Number(/body\{[^}]*\bwidth:\s*(\d+)px/.exec(readFileSync("extension/popup.css", "utf8"))?.[1] ?? 0);

const EVM = "0x532f27101965dd16442e59d40670faf5ebb142e4";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const CASES = [
  { tab: `https://basescan.org/token/${EVM}`, hash: `#/t/${EVM}?chain=base`, what: "a Base token page" },
  { tab: `https://bscscan.com/token/${EVM}`, hash: `#/t/${EVM}?chain=bnb`, what: "a BNB Chain token page" },
  { tab: `https://robinhoodchain.blockscout.com/token/${EVM}`, hash: `#/t/${EVM}?chain=robinhood`, what: "a Robinhood Chain token page" },
  { tab: `https://solscan.io/token/${MINT}`, hash: `#/t/${MINT}?chain=solana`, what: "a Solana mint page" },
  { tab: `https://dexscreener.com/base/${EVM}`, hash: `#/t/${EVM}?chain=base`, what: "an aggregator page naming its chain" },
  // Nothing to go on: the popup must land on its own front page rather than
  // guess a chain. A guess here is a verdict about a different contract.
  { tab: "https://news.ycombinator.com/", hash: "", what: "a page that is not about a token" },
  { tab: `https://example.com/token/${EVM}`, hash: "", what: "an address on a host nobody mapped" },
];

for (const c of CASES) {
  const { page, context, errors } = await open(c.tab);
  const hash = await routeOf(page);
  if (hash !== c.hash) fail(`${c.what}: the popup opened "${hash}", expected "${c.hash}"`);
  else if (errors.length) fail(`${c.what}: the popup threw — ${errors.join(" | ")}`);
  else console.log(`  ok  ${c.what} → ${hash || "the front page"}`);
  await page.close();
  await context.close();
}

/**
 * And the popup has to be usable at the width it asks Chrome for.
 *
 * The width is read out of popup.css rather than written here: the first
 * version of this check measured at 420 px, found 140 px of sideways scroll,
 * and reported it as a bug in the popup. 140 is 560 minus 420 — the stylesheet
 * asks Chrome for 560 and got it, and the instrument was measuring a window
 * Chrome never opens. Reading the number from the same place the browser does
 * is the only version of this check that cannot be wrong about it.
 */
{
  if (!POPUP_WIDTH) fail("popup.css does not set a body width, so Chrome decides it and nobody knows what it is");
  else if (POPUP_WIDTH > 800) fail(`popup.css asks for ${POPUP_WIDTH} px; Chrome clips an action popup at 800`);
  const { page, context } = await open("https://news.ycombinator.com/", POPUP_WIDTH || 560);
  await page.fill("#q", "0x0000000000000000000000000000000000f1a1a1").catch(() => {});
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) fail(`the popup scrolls ${over} px sideways at the ${POPUP_WIDTH} px it asks for`);
  else console.log(`  ok  no sideways scroll at the ${POPUP_WIDTH} px popup.css asks Chrome for`);
  // The one control that must be reachable without scrolling: the box you
  // paste an address into.
  const box = await page.$("#q");
  const seen = box ? await box.isVisible() : false;
  if (!seen) fail("the address box is not visible when the popup opens");
  else console.log("  ok  the address box is there to paste into");
  await page.close();
  await context.close();
}

await browser.close();
server.close();
if (failures) {
  console.error(`\npopup: ${failures} problem${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("popup: every page shape opens the right token on the right chain");
