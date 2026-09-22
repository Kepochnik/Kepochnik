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
 *   4. paste an address with the chain menu untouched → the page finds the
 *      chain by itself, or says which chains it asked
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
const CONTEXT = { viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] };
let failures = 0;
const fail = (what) => {
  failures++;
  console.error(`::error::flows: ${what}`);
};

/**
 * A journey is a person arriving at the page, so each gets its own context.
 *
 * They shared one, which means they shared localStorage: a walk that picks
 * a chain writes that choice, and the next walk starts on it. A journey
 * that passes or fails depending on which journey ran before it is not a
 * journey, and this bit me the first time a walk touched the chain menu.
 */
async function walk(name, fn) {
  const context = await browser.newContext(CONTEXT);
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
    await context.close();
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

/**
 * The LAST render, not the first one carrying a word.
 *
 * waitForVerdict returns at the `fast` stage — the page has a verdict there
 * and says so — and anything read at that point is a half-finished slip.
 * The completeness band is drawn only on the final render, so a walk that
 * looked for it right after the verdict found nothing and blamed the page.
 *
 * `data-pending` is the page's own marker for "more is coming", and it is
 * already a stated contract with speed-check. Waiting for it to clear is
 * waiting for the render the reader actually keeps.
 */
async function waitForDone(page, ms = 40_000) {
  await waitForVerdict(page, ms);
  await page.waitForFunction(() => document.querySelector(".verdict") && !document.querySelector("[data-pending]"), null, { timeout: ms });
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

  // A PNG is not enough. Two handlers were bound to this button for
  // months — the second built a Solana card out of an EVM slip and
  // overwrote the good one — and this walk passed the whole time,
  // because something always landed on the clipboard. So look at what
  // the card SAYS: open the preview and require the token's own ticker
  // in it. A card about the wrong token cannot pass that.
  const ticker = await page.$eval(".vsym", (el) => el.textContent.trim());
  if (!ticker) throw new Error("the slip has no ticker to check the card against");
  // What the page says it put on the clipboard. One press builds one card,
  // and it is about the token on screen — a second handler bound to the
  // same button shows up here as a second entry, which is the shape of the
  // bug this walk sat through for months while watching only for a PNG.
  const built = await page.evaluate(() => window.__bouncerCards ?? []);
  if (built.length !== 1) throw new Error(`one press built ${built.length} cards: ${JSON.stringify(built)}`);
  if (built[0].ticker !== ticker) throw new Error(`the copied card is about ${built[0].ticker}, the slip is about ${ticker}`);
  // And the preview draws the same token.
  await page.click("#act-card");
  await page.waitForSelector("#card svg", { timeout: 5_000 });
  const card = await page.$eval("#card svg", (el) => el.textContent ?? "");
  if (!card.includes(ticker)) throw new Error(`the card does not name ${ticker}; it says "${card.slice(0, 120).replace(/\s+/g, " ")}"`);
});

await walk("changing the chain does not leave the old report", async (page) => {
  // The header said one chain and the report was read from another: pick
  // Solana while a Robinhood slip is open and the slip stayed, every
  // number in it from the other chain, under a header naming the new one.
  await page.goto(`${url}#/demo/0x0000000000000000000000000000000000f1a1a1`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const w = document.querySelector(".vword")?.textContent?.trim();
    return Boolean(w) && w !== "READING";
  }, null, { timeout: 30_000 });
  const before = await page.$eval(".vword", (el) => el.textContent.trim());

  await page.selectOption("#chain", "solana");
  await page.waitForTimeout(2_500);
  const menu = await page.$eval("#chain", (el) => el.value);
  if (menu !== "solana") throw new Error(`the menu did not take the change: "${menu}"`);
  const label = await page.$eval("#picker-name", (el) => el.textContent.trim());
  if (!/solana/i.test(label)) throw new Error(`the header still reads "${label}"`);
  const word = await page.$eval(".vword", (el) => el.textContent.trim()).catch(() => null);
  if (word !== null && word === before) throw new Error(`the ${before} report from the old chain is still on screen under a Solana header`);
});

await walk("the check button always comes back", async (page) => {
  // busy() disables it and every view was trusted to re-enable it. Search
  // forgot on both of its successful exits — candidates found, or none
  // found — and the control stayed dead until reload. An audit found it;
  // nothing in the code guaranteed it.
  //
  // Walked over the outcomes that can happen with no network: a ticker
  // with no explorer to search, a malformed address, and an address whose
  // chain search finds nothing. Each must end with the button usable.
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const tries = ["bonk", "0xnothexatall", "0x6835dbf2d7d5852f84bf0a80de00cab3864f44b1"];
  for (const input of tries) {
    await page.fill("#q", input);
    await page.click("#go");
    await page.waitForTimeout(2_600);
    const dead = await page.$eval("#go", (el) => el.disabled);
    if (dead) throw new Error(`the button is still disabled after "${input}"`);
  }
});

await walk("one chain does not capture the menu", async (page) => {
  // Reported with a screenshot: the header read "Find the chain", the
  // strip read "Reading Solana", and a valid EVM address came back
  // "paste a Solana mint address". Checking one Solana mint wrote
  // ?chain=solana into the next link, the router read it back into the
  // menu, and the tool stopped working for every other chain until the
  // page was reloaded.
  //
  // Both reads need a network and neither gets one here. That is fine:
  // what this walks is the ROUTING, which is decided before any request
  // goes out, and the failure was never about what came back.
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const menu0 = await page.$eval("#chain", (el) => el.value);
  if (menu0 !== "auto") throw new Error(`the menu should start on auto, not "${menu0}"`);

  await page.fill("#q", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  await page.click("#go");
  await page.waitForTimeout(2_000);
  const afterMint = await page.$eval("#chain", (el) => el.value);
  if (afterMint !== "auto") throw new Error(`one Solana mint pinned the menu to "${afterMint}"`);

  await page.fill("#q", "0x6835dbf2d7d5852f84bf0a80de00cab3864f44b1");
  await page.click("#go");
  await page.waitForTimeout(2_500);
  const afterEvm = await page.$eval("#chain", (el) => el.value);
  if (afterEvm !== "auto") throw new Error(`an EVM address left the menu on "${afterEvm}"`);
  const said = await page.evaluate(() => document.querySelector("#out")?.innerText ?? "");
  if (/Solana mint address/i.test(said)) throw new Error(`an EVM address was answered as a Solana one: ${said.replace(/\s+/g, " ").slice(0, 120)}`);
});

if (live) {
  await walk("paste an address without picking a chain", async (page) => {
    // The whole point of the feature: a reader who does not know which
    // network a token is on should not have to. The menu is left exactly
    // as it loads, and the only thing done to the page is pasting.
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      (document.querySelector("#mode-live") ?? document.querySelector('[data-mode="live"]'))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const menu = await page.$eval("#chain", (el) => el.value);
    if (menu !== "auto") throw new Error(`the menu should start on auto and it is on "${menu}"`);
    // USDC on Base. A reader pasting this has no reason to know that.
    await page.fill("#q", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    // Forget what is already drawn before pressing anything.
    //
    // The page renders the demo token as it loads, so `.vword` is on screen
    // with a verdict in it before this walk pastes a thing — and waiting for
    // `.vword` matched that instantly and then failed on it. The page keeps
    // its own render log, so the honest signal is a render that lands AFTER
    // the click, not an element that happens to exist.
    await page.evaluate(() => { window.__bouncerRenders = []; });
    await page.click("#go");
    await page.waitForFunction(
      () => {
        if (document.querySelector(".chain-hit")) return true;
        if (document.querySelector("#out .error")) return true;
        const drawn = window.__bouncerRenders ?? [];
        return drawn.some((r) => r.word && r.word !== "READING");
      },
      null,
      { timeout: 45_000 },
    );
    const picked = await page.$$(".chain-hit");
    if (picked.length) {
      // Several chains hold that address. Legitimate, and the page must ask
      // rather than choose — but it has to say which, or the question is
      // unanswerable.
      const named = await page.$$eval(".chain-hit .chain-hit-where", (els) => els.filter((e) => e.textContent.trim().length > 3).length);
      if (named !== picked.length) throw new Error(`${picked.length} chains offered, ${named} of them named`);
      console.log(`      (${picked.length} chains hold that address; the page asked instead of guessing, which is the other correct answer)`);
      return;
    }
    const word = await page.evaluate(() => (window.__bouncerRenders ?? []).map((r) => r.word).filter((w) => w && w !== "READING").pop() ?? null);
    if (!word) {
      const message = await page.$eval("#out", (el) => el.innerText.trim()).catch(() => "(the output box is empty)");
      throw new Error(`no verdict and no chain choice: ${message.slice(0, 200)}`);
    }
    // And it has to have landed on the right one, not merely on one.
    const where = await page.$eval("#source-pill, .source-pill", (el) => el.textContent.trim()).catch(() => "");
    if (!/base/i.test(where)) throw new Error(`found a chain but not the right one: the page says "${where}"`);
  });

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


await walk("a reading with a hole says so where the verdict is", async (page) => {
  // The audit's worst find, walked. BONK's holders and pools came back 403
  // and the page said, in its calm voice, that nothing stood out. Both
  // halves were on screen — the refusals were in a strip at the bottom,
  // named and reasoned — and the headline was what got read.
  //
  // The demo impostor has the same shape: its sale simulation did not run,
  // so whether the token can be sold at all is unanswered.
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000bad01`, { waitUntil: "load" });
  await waitForDone(page);

  const band = await page.$(".cov");
  if (!band) throw new Error("the reading has an unread check and the page shows no completeness band");

  // Above the fold of the verdict block, not in a strip below the page.
  // Position is the entire fix here; the text was always right.
  const order = await page.evaluate(() => {
    const v = document.querySelector(".verdict");
    const c = document.querySelector(".cov");
    const u = document.querySelector(".unread, .strip");
    return { insideVerdict: Boolean(v && c && v.contains(c)), covTop: c?.getBoundingClientRect().top ?? -1, unreadTop: u?.getBoundingClientRect().top ?? Infinity };
  });
  if (!order.insideVerdict) throw new Error("the band is not inside the verdict block, which is the one place a reader looks");
  if (order.covTop >= order.unreadTop) throw new Error("the band sits below the strip it was meant to replace");

  // It has to name the missing check and why, not just wave at one.
  const rows = await page.$$eval(".cgap", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  if (!rows.length) throw new Error("the band lists no gaps");
  if (!rows.some((r) => /simulated transfer/i.test(r))) throw new Error(`the unread check is not named: ${JSON.stringify(rows)}`);
  // And the standing limits ride along once the band is open, marked as
  // limits rather than as things that went wrong on this reading.
  const limits = await page.$$eval(".cgap-limit", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  if (!limits.some((r) => /router/i.test(r))) throw new Error(`the router limit is not disclosed: ${JSON.stringify(limits)}`);
  if (limits.some((r) => /^\s*$/.test(r))) throw new Error("an empty limit row");

  // And a retry that can work. A 403 or a timeout is exactly the case where
  // pressing again changes the answer, and the page has to offer it.
  const retry = await page.$("#act-retry");
  if (!retry) throw new Error("an unread check with no way to ask again");
  const box = await retry.boundingBox();
  if (!box || box.height < 44) throw new Error(`the retry is ${box ? Math.round(box.height) : 0}px tall; a phone needs 44`);
});

await walk("a clean-sounding word never sits over an unread check", async (page) => {
  // The rule, stated as a walk rather than as a unit test, because the unit
  // test cannot see what the page does with the answer. CLEAR is a claim
  // about coverage — "I looked and saw nothing" — so it is the one word a
  // hole in the reading makes false. A STOP is a claim about a finding and
  // survives.
  for (const token of ["0x00000000000000000000000000000000000bad01", "0x0000000000000000000000000000000000f1a1a1"]) {
    await page.goto(`${url}#/demo/${token}`, { waitUntil: "load" });
    const word = await waitForDone(page);
    const state = await page.$eval(".cov", (el) => el.dataset.coverage).catch(() => "complete");
    if (word === "CLEAR" && state === "thin") {
      throw new Error(`${token.slice(0, 10)} reads CLEAR over a reading missing a decisive check`);
    }
    if (!["STOP", "WATCH", "CLEAR", "INCOMPLETE"].includes(word)) throw new Error(`unknown verdict "${word}"`);
  }
});
await walk("a feature a chain cannot serve says why, not Method not found", async (page) => {
  // Picking Solana and then "Tonight's board" answered `Method not found`
  // inside "Could not read the chain" — which says BOUNCER is broken, when
  // the truth is that the board walks a launchpad factory's event log and
  // Solana has neither. A reader cannot tell those two apart.
  await page.goto(`${url}#/board?chain=solana`, { waitUntil: "load" });
  await page.waitForSelector(".error, .slip", { timeout: 20_000 });
  const said = await page.$eval(".error, .slip", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (/method not found|-32601|eth_getlogs/i.test(said)) throw new Error(`still an RPC error: ${said.slice(0, 160)}`);
  if (!/not an EVM chain|no launchpad/i.test(said)) throw new Error(`the refusal does not say why: ${said.slice(0, 160)}`);
  if (!/Solana/.test(said)) throw new Error("the refusal does not name the chain it is about");

  // And the link is not offered in the first place, so nobody has to
  // discover the refusal by pressing it.
  await page.goto(`${url}#/`, { waitUntil: "load" });
  await page.selectOption("#chain", "solana");
  await page.waitForTimeout(800);
  const links = await page.$$eval(".more a", (els) => els.map((e) => e.textContent.trim()));
  if (links.some((l) => /board|plan a launch/i.test(l))) throw new Error(`Solana is still offered ${JSON.stringify(links)}`);

  // But a chain that CAN serve them still gets them: a guard that hides
  // everything everywhere passes the check above and breaks the product.
  await page.selectOption("#chain", "robinhood");
  await page.waitForTimeout(800);
  const ok = await page.$$eval(".more a", (els) => els.map((e) => e.textContent.trim()));
  if (!ok.some((l) => /board/i.test(l))) throw new Error(`Robinhood Chain lost its board too: ${JSON.stringify(ok)}`);
});
await browser.close();
if (failures) {
  console.error(`\nflows: ${failures} journey${failures === 1 ? "" : "s"} broken.`);
  process.exit(1);
}
console.log("flows: every journey walked end to end");

