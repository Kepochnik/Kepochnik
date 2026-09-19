/**
 * Does the page actually fit on a phone?
 *
 * This exists because of a bug that is invisible in the source and obvious
 * in a browser. One address chip deep inside the verdict carried
 * `white-space:nowrap`; a grid item's min-width defaults to its min-content,
 * so that one string pushed the card, the column and the page with it —
 * 238 pixels of horizontal scroll on a 390-wide screen, from CSS that reads
 * perfectly well. No test over the source could have caught it, and no
 * amount of care writing the stylesheet did.
 *
 * So the page is loaded in a real browser at real widths and measured.
 * Horizontal scroll on the document is a failure; a table scrolling inside
 * its own box is not, which is why the check is on the document element
 * rather than on every node.
 *
 * Runs against demo routes only: they need no network and exercise every
 * slip shape the renderer can produce.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const WIDTHS = [
  { w: 390, h: 844, name: "phone" },
  { w: 768, h: 1024, name: "tablet" },
  { w: 1280, h: 900, name: "laptop" },
];

/** Every slip shape the demo chain can produce, so none of them is measured by luck. */
const ROUTES = [
  { hash: "", what: "the first load" },
  { hash: "#/demo/0x00000000000000000000000000000000000bad01", what: "an impostor (STOP, every card)" },
  { hash: "#/demo/0x0000000000000000000000000000000000f1a1a1", what: "an ordinary token" },
  { hash: "#/board?hours=1&chain=demo", what: "the board" },
  { hash: "#/plan?tax=100&chain=demo", what: "the launch planner" },
];

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
  // Anything the pw-browsers directory happens to hold, whatever its build number.
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
  console.log("layout: playwright-core is not installed, so the page was not measured in a browser");
  process.exit(0);
}
const executablePath = findChromium();
if (!executablePath) {
  console.log("layout: no Chromium found, so the page was not measured in a browser (set CHROME_PATH)");
  process.exit(0);
}

/**
 * The built file by default, or a deployed URL when one is given. The second
 * is not the same check: only the real site loads the real fonts, and a
 * headline measured in a fallback face is not the headline anybody sees.
 */
const target = process.argv[2] || process.env.BOUNCER_SITE_URL;
let url;
if (target) {
  url = target;
} else {
  const built = "site/dist/index.html";
  if (!existsSync(built)) {
    console.error("layout: site/dist/index.html is missing — run the site build first");
    process.exit(1);
  }
  url = `file://${process.cwd()}/${built}`;
}
console.log(`layout: measuring ${url}`);

const browser = await chromium.launch({ executablePath });
let failures = 0;
let checked = 0;
for (const size of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: size.w, height: size.h } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const route of ROUTES) {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(400);
    if (route.hash) await page.evaluate((h) => { location.hash = h; }, route.hash);
    await page.waitForTimeout(1800);
    checked++;
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) {
      failures++;
      // Name the element, because "the page is too wide" is not actionable
      // and the culprit is never the element that looks too wide.
      const who = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        for (const el of document.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.right <= vw + 1) continue;
          if ([...el.children].some((c) => c.getBoundingClientRect().right > vw + 1)) continue;
          if (el.closest(".tbl")) continue;
          return `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").filter(Boolean).join(".")}: ${(el.textContent || "").trim().slice(0, 60)}`;
        }
        return "(could not name it)";
      });
      console.error(`::error::${size.name} (${size.w}px), ${route.what}: ${over}px of horizontal scroll — ${who}`);
    }
  }
  if (errors.length) {
    failures++;
    console.error(`::error::${size.name}: the page threw — ${errors.join(" | ")}`);
  }
  // One picture per width from the last route, when asked. A measurement
  // says the page fits; only a picture says whether it is worth looking at.
  if (process.env.BOUNCER_SHOTS) {
    await page.screenshot({ path: `${process.env.BOUNCER_SHOTS}/${size.name}.png`, fullPage: true });
  }
  await page.close();
}
await browser.close();

if (failures) {
  console.error(`\nlayout: ${failures} of ${checked} checks failed.`);
  process.exit(1);
}
console.log(`layout: ${checked} page loads across ${WIDTHS.length} widths, no horizontal scroll, no page errors`);
