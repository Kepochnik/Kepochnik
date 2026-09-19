/**
 * Do the buy links actually go anywhere?
 *
 * Each venue spells each chain its own way, and the slugs in trade.ts came
 * from two real URLs plus recall for the rest. Recall is not knowledge: a
 * wrong slug is a dead link, and a dead referral link earns nothing while
 * looking exactly like a working one. There is no way to tell from here, so
 * this asks the venues, from a runner that can reach them.
 *
 * A 404 is a finding and fails. A 403, a 429 or a challenge page is the
 * venue declining to talk to a script, which says nothing about the slug
 * and is reported rather than treated as a verdict.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { TRADE_SLUGS, tradeVenues } from "../dist/src/bouncer/trade.js";

/** A real, live token per chain, so the page under test is a page that exists. */
const SAMPLES = {
  robinhood: "0x39dbed3a2bd333467115de45665cc57f813c4571",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  bnb: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/**
 * A browser, not fetch. Both venues sit behind a bot check that answers a
 * plain request with 403 whatever the slug is — every link came back "could
 * not be judged", which is a check that never says anything. A real browser
 * gets a real page, and a real page can be told apart from a 404.
 */
function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of [
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
  // checked below
}
const executablePath = chromium ? findChromium() : null;
if (!executablePath) {
  console.log("trade links: no Chromium, so the venues were not asked");
  process.exit(0);
}
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let bad = 0;
let unknown = 0;
let ok = 0;

for (const chain of Object.keys(TRADE_SLUGS)) {
  const address = SAMPLES[chain];
  if (!address) {
    console.log(`${chain}: no sample token, not checked`);
    continue;
  }
  for (const venue of tradeVenues(chain, address)) {
    let status = 0;
    let note = "";
    try {
      const response = await page.goto(venue.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      status = response?.status() ?? 0;
      await page.waitForTimeout(1500);
      // A single-page app answers 200 and then renders "not found", so the
      // status alone is not the answer for these two.
      const body = (await page.textContent("body").catch(() => "")) ?? "";
      if (/not found|does not exist|invalid (token|address|chain)/i.test(body.slice(0, 4000))) {
        note = "the page loaded and says the token is not there";
        status = 404;
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    const label = `${chain} · ${venue.name} · ${venue.url}`;
    if (status === 404 || status === 410) {
      bad++;
      console.error(`::error::${label} — HTTP ${status}. The slug is wrong, so this link earns nothing and shows nothing.`);
    } else if (status >= 200 && status < 400) {
      ok++;
      console.log(`ok   ${label} — HTTP ${status}`);
    } else {
      unknown++;
      console.log(`::warning::${label} — ${status ? `HTTP ${status}` : note}. The venue declined to answer a script; the slug is neither proven nor disproven.`);
    }
  }
}

await browser.close();
console.log(`\ntrade links: ${ok} answered, ${unknown} could not be judged, ${bad} broken`);
process.exit(bad ? 1 : 0);
