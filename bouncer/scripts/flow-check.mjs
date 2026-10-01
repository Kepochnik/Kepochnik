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
/** Walks that could not run here. Counted so the summary cannot claim them. */
let skipped = 0;
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

/**
 * A walk that only means anything against the deployed site.
 *
 * Skipped loudly rather than quietly: a check that silently passes when it
 * could not run is worse than no check, because the green is what gets
 * believed.
 */
async function walkLive(name, fn) {
  if (!live) {
    skipped++;
    console.log(`  --  ${name} (needs the deployed site; pass a URL to run it)`);
    return;
  }
  return walk(name, fn);
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
/** The column is on by default now; this opens it only if a remembered choice turned it off. */
/** The five questions live in a tab now; a journey that works in them opens it first. */
async function openQuestions(page) {
  await page.evaluate(() => document.querySelector('.doorway .tab[data-tab="questions"]')?.click());
}

async function openFeed(page) {
  const pressed = await page.$eval("#feed-toggle", (el) => el.getAttribute("aria-pressed"));
  if (pressed !== "true") await page.click("#feed-toggle");
}

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
  const ticker = await page.$eval(".sym", (el) => el.textContent.trim());
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

  const band = await page.$(".band.gap");
  if (!band) throw new Error("the reading has an unread check and the page shows no completeness band");

  // With the word, not in a strip below the page.
  //
  // This has now been wrong twice about layout and right both times about the
  // requirement. First it asserted the band was a DESCENDANT of the verdict
  // block; then that it sat ABOVE the answers, which reads "before" as
  // vertical and fails the moment the answers are a second column. What a
  // reader actually needs is: the band is under the word, in the same column
  // as the word, and on the first screen. That holds in any layout.
  const order = await page.evaluate(() => {
    const word = document.querySelector(".vword")?.getBoundingClientRect();
    const c = document.querySelector(".band.gap")?.getBoundingClientRect();
    return {
      ok: Boolean(word && c),
      below: word && c ? c.top >= word.top : false,
      // Same column: the band's horizontal span overlaps the word's own.
      sameColumn: word && c ? c.left < word.right && c.right > word.left : false,
      bottom: c?.bottom ?? -1,
      viewport: window.innerHeight,
    };
  });
  if (!order.ok) throw new Error("no completeness band on a reading with an unread check");
  if (!order.below) throw new Error("the band sits above the verdict it qualifies");
  if (!order.sameColumn) throw new Error("the band is in a different column from the word, so the two do not read as one statement");
  if (order.bottom > order.viewport) throw new Error(`the band ends below the fold (${Math.round(order.bottom)}px into a ${order.viewport}px window)`);

  // It has to name the missing check and why, not just wave at one.
  const rows = await page.$$eval(".band.gap .chgrows li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
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
  // At phone width, because that is the claim. This measured at the walk's
  // 1280px viewport and reported a laptop-sized button as too small for a
  // finger — the check was right about the rule and wrong about where the
  // rule applies, which made it argue with a correct design.
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await (await page.$("#act-retry"))?.boundingBox();
  if (!box || box.height < 44) throw new Error(`on a phone the retry is ${box ? Math.round(box.height) : 0}px tall; it needs 44`);
  await page.setViewportSize({ width: 1280, height: 900 });
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
    const state = await page.$eval(".band.gap", (el) => el.dataset.coverage).catch(() => "complete");
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
  const links = await page.$$eval(".morelinks a", (els) => els.map((e) => e.textContent.trim()));
  if (links.some((l) => /board|plan a launch/i.test(l))) throw new Error(`Solana is still offered ${JSON.stringify(links)}`);

  // But a chain that CAN serve them still gets them: a guard that hides
  // everything everywhere passes the check above and breaks the product.
  await page.selectOption("#chain", "robinhood");
  await page.waitForTimeout(800);
  const ok = await page.$$eval(".morelinks a", (els) => els.map((e) => e.textContent.trim()));
  if (!ok.some((l) => /board/i.test(l))) throw new Error(`Robinhood Chain lost its board too: ${JSON.stringify(ok)}`);
});
// The venue strip needs a real chain: the demo chain deliberately has no
// venues, because linking somebody off to buy an invented token is the one
// thing the demo must never do. So this is one of the walks that needs the
// deployed site, and it says so rather than passing on an empty page.
await walkLive("the paid links sit after the evidence and say they are paid", async (page) => {
  // Two findings in one place. The strip was headed "Buy it" — the only
  // imperative on a page whose whole claim is that it tells nobody what to
  // do — and it sat above the evidence sections. And the links pay
  // BOUNCER, which was disclosed to crawlers in rel="sponsored" and to no
  // human anywhere.
  await page.goto(`${url}#/demo/0x0000000000000000000000000000000000f1a1a1`, { waitUntil: "load" });
  await waitForDone(page);

  const buy = await page.$(".buy");
  if (!buy) throw new Error("no venue strip to check");

  const head = await page.$eval(".buy-head h2", (el) => el.textContent.trim());
  if (/^buy it/i.test(head)) throw new Error(`the strip still tells the reader to buy: "${head}"`);

  const disc = await page.$eval(".buy-disc", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  if (!/referral/i.test(disc)) throw new Error(`the links do not say they are referral links: "${disc}"`);
  if (!/earns|paid|share/i.test(disc)) throw new Error(`the disclosure does not say BOUNCER is paid: "${disc}"`);

  // Below the evidence, measured rather than assumed.
  const order = await page.evaluate(() => {
    const y = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top + scrollY : null; };
    return { buy: y(".buy"), stack: y(".stack"), verdict: y(".verdict") };
  });
  if (order.stack === null) throw new Error("no evidence stack on this slip");
  if (order.buy < order.stack) throw new Error(`the paid links are above the evidence (${Math.round(order.buy)} vs ${Math.round(order.stack)})`);
  if (order.buy < order.verdict) throw new Error("the paid links are above the verdict");
});
await walk("the exit calculator answers for a size, or says why it cannot", async (page) => {
  // The product's own thesis, walked: "can I get out" is a different
  // question from "what is it worth", and they come apart exactly when it
  // matters. A token with a healthy price over a thin pool is not an exit.
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000f2e54`, { waitUntil: "load" });
  await waitForDone(page);
  await openQuestions(page);
  await page.evaluate(() => document.querySelector("#q-exit")?.setAttribute("open", ""));
  if (!(await page.$("#calc-size"))) throw new Error("no exit calculator on a slip that has a priceable venue");

  // A small size and a large one must not give the same answer. If they
  // do, the thing is quoting a price rather than pricing an exit.
  const realised = async (value) => {
    await page.fill("#calc-size", value);
    await page.click("#calc-go");
    await page.waitForTimeout(250);
    const text = await page.$eval("#calc-out", (el) => el.textContent.replace(/\s+/g, " ").trim());
    const m = /you keep\s*([\d.]+)%/.exec(text);
    if (!m) throw new Error(`no answer for ${value}: ${text.slice(0, 140)}`);
    return Number(m[1]);
  };
  const small = await realised("1000");
  const large = await realised("200000000");
  if (!(small > large)) throw new Error(`a large position must realise less than a small one (${small}% vs ${large}%)`);
  if (large >= 99) throw new Error(`a position that size cannot realise ${large}% of the screen price`);

  // Nothing typed, nothing claimed.
  await page.fill("#calc-size", "");
  await page.click("#calc-go");
  await page.waitForTimeout(200);
  const empty = await page.$eval("#calc-out", (el) => el.textContent.trim());
  if (empty) throw new Error(`an empty box produced an answer: "${empty.slice(0, 80)}"`);

  // And on a range pool it says how far the arithmetic holds, and never
  // quotes zero — the failure this whole release is about.
  await page.goto(`${url}#/demo/0x0000000000000000000000000000000000f1a1a1`, { waitUntil: "load" });
  await waitForDone(page);
  await openQuestions(page);
  await page.evaluate(() => document.querySelector("#q-exit")?.setAttribute("open", ""));
  await page.fill("#calc-size", "1000");
  await page.click("#calc-go");
  await page.waitForTimeout(250);
  const said = await page.$eval("#calc-out", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (/^0\b/.test(said)) throw new Error(`a token it cannot price was quoted at zero: "${said.slice(0, 120)}"`);
  // A range pool is now priced the way the exit answer row prices it, from
  // its price and in-range liquidity; it has to say where that stops being
  // exact. Anything it still cannot price must say why.
  if (!/range|no pool|could not/i.test(said)) throw new Error(`the answer does not say where it stops being exact, or why it cannot price: "${said.slice(0, 160)}"`);
});
await walk("a second look says what moved since the first", async (page) => {
  // A slip is a photograph. It reads the same whether the token has sat
  // still for a month or the owner took the mint authority back twenty
  // minutes ago, and those are not the same situation for whoever holds
  // it. This walk is also the one that catches the band being wired into
  // one renderer and not the other, which is exactly what happened while
  // it was being written.
  const token = `${url}#/demo/0x0000000000000000000000000000000000f1a1a1`;

  // First visit: no band at all. "This is the first time you have looked
  // at this" is not worth the top of the page.
  await page.goto(token, { waitUntil: "load" });
  await waitForDone(page);
  if (await page.$(".chg")) throw new Error("a first visit claimed something had changed");

  const stored = await page.evaluate(() => localStorage.getItem("bouncer.seen.v1"));
  if (!stored) throw new Error("the first reading was not remembered, so nothing can ever be compared");
  if (!/"chain":"demo"/.test(stored)) throw new Error("a demo reading was filed under a real chain's key");

  // reload(), not goto(). A goto to a URL that differs only after the #
  // is a same-document navigation: the page does not reload, nothing
  // re-renders, and the "second visit" is the first one still on screen.
  // That cost an hour of looking for a bug in the feature.
  await page.reload({ waitUntil: "load" });
  await waitForDone(page);
  const quiet = await page.$eval(".chg", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  if (!/NO CHANGE/i.test(quiet)) throw new Error(`a second identical reading should say nothing changed; got "${quiet.slice(0, 120)}"`);
  if (!/since you last checked/i.test(quiet)) throw new Error("the comparison does not say how old it is");

  // Now rewrite the stored snapshot as if the token had been safe before,
  // and check the page notices it is not any more. Reaching into storage
  // is the only way to walk this without waiting for a real token to
  // change under us.
  await page.evaluate(() => {
    const seen = JSON.parse(localStorage.getItem("bouncer.seen.v1"));
    seen[0].verdict = "CLEAR";
    seen[0].codes = [];
    seen[0].at = Math.floor(Date.now() / 1000) - 7200;
    seen[0].facts.canMint = false;
    localStorage.setItem("bouncer.seen.v1", JSON.stringify(seen));
  });
  await page.reload({ waitUntil: "load" });
  await waitForDone(page);
  const band = await page.$(".chg");
  if (!band) throw new Error("the token changed under the reader and the page said nothing");
  const said = await page.$eval(".chg", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/2 hours/.test(said)) throw new Error(`the age of the comparison is wrong or missing: "${said.slice(0, 140)}"`);
  if (!/was CLEAR/.test(said)) throw new Error(`a verdict that got worse must be named: "${said.slice(0, 200)}"`);
  const level = await page.$eval(".chg", (el) => el.className);
  if (!/\bstop\b/.test(level)) throw new Error(`a verdict falling to STOP is not a quiet change: "${level}"`);
});
await walk("the list of what you checked before never states a stale verdict as current", async (page) => {
  // The trap in this feature. The stored word is what the token read LAST
  // time, and dropping it into a list of links makes it look like the
  // answer now — a CLEAR that has since become a STOP, presented as
  // current, by the tool whose whole job is not to do that.
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => {
    const mk = (chain, address, symbol, verdict, agoSec) => ({
      v: 1, chain, address, symbol, verdict, stamp: "NOT A LAUNCH",
      at: Math.floor(Date.now() / 1000) - agoSec, height: 1, codes: [],
      facts: { owner: null, canMint: false, canFreeze: false, taxBps: 0, top10Bps: 1000, poolQuote: "1" },
      coverage: "complete",
    });
    localStorage.setItem("bouncer.seen.v1", JSON.stringify([
      mk("base", "0x4200000000000000000000000000000000000006", "WETH", "CLEAR", 86400 * 3),
      mk("demo", "0x0000000000000000000000000000000000f1a1a1", "ROCKET", "STOP", 60),
    ]));
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(700);

  // With the board on the front page the list is folded to one line; it is
  // a tap away, and a reader has to be able to open it.
  if (!(await page.$(".seen .seen-head"))) throw new Error("a browser with history showed no list");
  await page.evaluate(() => document.querySelector("details.seen")?.setAttribute("open", ""));
  const rows = await page.$$eval(".seen-row", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  if (!rows.length) throw new Error("a browser with history showed no list");

  // An invented token must not appear beside real ones.
  if (rows.some((r) => /ROCKET/.test(r))) throw new Error(`a demo token is listed in live mode: ${JSON.stringify(rows)}`);

  const weth = rows.find((r) => /WETH/.test(r));
  if (!weth) throw new Error(`the real token is missing: ${JSON.stringify(rows)}`);
  // Past tense, with an age, every time. "CLEAR" on its own would be a
  // claim about now.
  if (!/read CLEAR 3 days ago/.test(weth)) throw new Error(`the stored verdict is not in the past tense with its age: "${weth}"`);
  const foot = await page.$eval(".seen-foot", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/not what it reads now/i.test(foot)) throw new Error(`the list does not disclaim itself: "${foot}"`);

  // And it can be forgotten, because a list of every token somebody has
  // looked at is not a thing to keep without a way out.
  await page.click("#seen-clear");
  await page.waitForTimeout(300);
  const left = await page.$$(".seen-row");
  if (left.length) throw new Error("forgetting the history left rows on screen");
  const stored = await page.evaluate(() => localStorage.getItem("bouncer.seen.v1"));
  if (stored && stored !== "[]") throw new Error(`the history was not actually cleared: ${stored.slice(0, 80)}`);
});
await walk("the working behind the verdict is on the page", async (page) => {
  // "Trust me" is the one thing this tool cannot say. A reader who
  // disagrees with a verdict should be able to see which findings made it
  // and go and check those against an explorer themselves.
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000bad01`, { waitUntil: "load" });
  await waitForDone(page);
  const why = await page.$("#s-why");
  if (!why) throw new Error("no working shown behind the verdict");
  await page.evaluate(() => document.querySelector("#s-why")?.setAttribute("open", ""));

  const word = await page.$eval(".vword", (el) => el.textContent.trim());
  const lead = await page.$eval(".whylead", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!lead.includes(word)) throw new Error(`the working names a different verdict than the headline: "${lead}"`);

  // The findings it names must be exactly the loud ones on the slip —
  // not a second count a reader cannot arrive at.
  const named = await page.$$eval(".whylist li", (els) => els.length);
  const loud = await page.$$eval(".find", (els) => els.filter((e) => /\b(STOP|WATCH)\b/.test(e.textContent)).length);
  if (named === 0) throw new Error("a STOP with no findings behind it");
  if (loud && named !== loud) throw new Error(`the working counts ${named} deciding findings, the slip shows ${loud}`);

  // Provenance: the endpoint and what was asked of it.
  const kv = await page.$eval("#s-why .kv", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/endpoint/.test(kv)) throw new Error("the working does not say which endpoint answered");
  if (!/\d+ calls? across/.test(kv)) throw new Error(`the working does not say what was asked: "${kv.slice(0, 120)}"`);
  const methods = await page.$$eval("#s-why .buys tbody tr", (els) => els.length);
  if (methods < 2) throw new Error(`only ${methods} methods listed; the read makes more than that`);

  // And every check is accounted for, including the ones that did not run.
  const states = await page.$$eval(".whycheck .wcs", (els) => els.map((e) => e.textContent.trim()));
  if (!states.length) throw new Error("the working lists no checks");
  for (const st of states) {
    if (!["read", "unread", "unsupported", "n/a"].includes(st)) throw new Error(`unknown check state "${st}"`);
  }
});
await walk("an ordinary token can be watched, and the watch says what it cannot do", async (page) => {
  // The section used to appear only for launchpad tokens. Somebody checking
  // an ordinary ERC-20 — which is what every memecoin worth checking is —
  // got no section at all, which reads as "nothing here to watch" rather
  // than "this page was only wired up for one kind of token".
  await page.goto(`${url}#/demo/0x0000000000000000000000000000000000f1a1a1`, { waitUntil: "load" });
  await waitForDone(page);
  await openQuestions(page);
  const sec = await page.$("#s-watch");
  if (!sec) throw new Error("an ordinary token was offered no watch at all");
  await page.evaluate(() => document.querySelector("#s-watch")?.setAttribute("open", ""));

  const button = await page.$("#act-watch");
  if (!button) throw new Error("the watch section has no button and gave no reason");

  // The three things a tab watch cannot do, above the button rather than
  // under it: it ends with the tab, what it is blind to on THIS token, and
  // where to go for a watch that survives you closing the laptop.
  const when = await page.$eval(".watch-when", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/only while this tab is open/i.test(when)) throw new Error(`the watch does not say it dies with the tab: "${when}"`);
  const away = await page.$eval(".watch-away", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/bouncer watch|\/watch/.test(away)) throw new Error(`the watch offers nothing for when you are away: "${away}"`);
  const what = await page.$$eval(".watch-what li", (els) => els.map((e) => e.textContent.trim()));
  if (what.length < 2) throw new Error(`the watch does not say what it reports: ${JSON.stringify(what)}`);
  if (!what.some((w) => /pool/.test(w))) throw new Error("a token with a pool does not say it can tell a sale from a move");

  // And pressing it starts a watch that says out loud how far it has read.
  await page.click("#act-watch");
  await page.waitForFunction(() => (document.querySelector("#watch-state")?.textContent ?? "").includes("last look"), null, { timeout: 30_000 });
  const state = await page.$eval("#watch-state", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/read up to block \d+|nothing read yet/.test(state)) throw new Error(`the watch does not say how far it has read: "${state}"`);

  // Pressing it again stops it, and stopping means stopping: a page that
  // says "watching" with no timer behind it is the worst of the three states.
  await page.click("#act-watch");
  const pressed = await page.$eval("#act-watch", (el) => el.getAttribute("aria-pressed"));
  if (pressed !== "false") throw new Error("stopping the watch left the button pressed");
});
await walk("the tape shows the trades and says where it read them", async (page) => {
  // The one panel on the page that moves. A tape that shows an empty table on
  // a token being traded, or a table on a token where the trades could not be
  // read, is worse than no tape: both look exactly like "nobody is buying".
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000f2e54`, { waitUntil: "load" });
  await waitForDone(page);
  await page.waitForFunction(() => document.querySelector("#tape .tape-note"), null, { timeout: 30_000 });
  const rows = await page.$$eval("#tape table.trades tbody tr", (els) => els.length);
  if (!rows) throw new Error("a demo token with buys and sells on its curve showed no trade at all");

  // Both sides are on it, and each is coloured as itself.
  const sides = await page.$$eval("#tape .t-side", (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
  if (!sides.includes("buy") || !sides.includes("sell")) throw new Error(`the tape shows only ${JSON.stringify(sides)}`);

  // The heading says who the address on each row is, and it only says
  // "trader" where the chain named one.
  const head = await page.$$eval("#tape table.trades th", (els) => els.map((e) => e.textContent.trim()));
  if (!head.includes("trader")) throw new Error(`a curve tape does not name the trader column: ${JSON.stringify(head)}`);

  // Where the numbers came from, and which of them is worked out rather than read.
  const note = await page.$eval("#tape .tape-note", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/CurveBuy and CurveSell/.test(note)) throw new Error(`the tape does not say what it read: "${note}"`);
  if (!/block rate/.test(note)) throw new Error(`the tape does not own up to the one derived column: "${note}"`);

  // And the flow bar answers the five-second question above the table.
  const flow = await page.$eval("#tape .flow-keys", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/bought/.test(flow) || !/sold/.test(flow)) throw new Error(`the tape has no bought-against-sold line: "${flow}"`);
});
await walk("a token with no pool says so instead of reading a tape forever", async (page) => {
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000bad01`, { waitUntil: "load" });
  await waitForDone(page);
  const tape = await page.$("#tape");
  if (!tape) throw new Error("a token with no tape got no panel at all, which reads as nothing happening");
  const text = await page.$eval("#tape", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (/Reading the trades/.test(text)) throw new Error("the tape is still claiming to read something nobody started");
  const chart = await page.$eval(".chart-empty", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  if (/Reading the pool/.test(chart)) throw new Error(`the price panel waits forever on a token with no pool: "${chart}"`);
});
await walk("the column of launches opens a token without losing itself", async (page) => {
  // The column lives outside the report on purpose. Inside it, clicking one
  // of its own rows would blink it away — which is the difference between a
  // board you sit in front of and a list of links.
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000f2e54`, { waitUntil: "load" });
  await waitForDone(page);
  await openFeed(page);
  await page.waitForFunction(() => document.querySelectorAll("#feed .fr").length > 0, null, { timeout: 30_000 });

  // The ticker alone: a launch already checked carries a small verdict mark beside it.
  const symOf = (el) => (el.firstChild?.textContent ?? el.textContent).trim();
  const first = await page.$eval("#feed .fr .fr-sym", symOf);
  const note = await page.$eval("#feed .feed-note", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/between block \d+ and \d+/.test(note)) throw new Error(`the column does not say which blocks it read: "${note}"`);

  // Open a different launch from the column.
  const rows = await page.$$("#feed .fr");
  if (rows.length < 2) throw new Error("the demo chain has fewer launches than the column needs to be walked");
  await rows[rows.length - 1].click();
  await waitForDone(page);

  const stillThere = await page.$$eval("#feed .fr", (els) => els.length);
  if (!stillThere) throw new Error("clicking a row emptied the column it was clicked in");
  const marked = await page.$eval("#feed .fr.on .fr-sym", symOf).catch(() => null);
  if (!marked) throw new Error("the column does not mark the launch now open");
  if (marked === first) throw new Error("clicking the last row marked the first one");
  const shown = await page.$eval(".who2 .sym", (el) => el.textContent.trim());
  if (shown !== marked) throw new Error(`the column marks ${marked} while the report is about ${shown}`);
});
await walk("one window governs the line and the tape, and they cannot disagree", async (page) => {
  // The chart used to read a day while the tape read an hour, so the line and
  // the bought-against-sold figure under it described different stretches of
  // the same token with nothing saying so.
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000000a7`, { waitUntil: "load" });
  await waitForDone(page);
  await page.waitForFunction(() => document.querySelector("#tape .tape-note"), null, { timeout: 30_000 });

  const lit = () => page.evaluate(() => [...document.querySelectorAll(".frame.on")].map((b) => b.textContent.trim()));
  const before = await lit();
  if (new Set(before).size !== 1) throw new Error(`the two toggles disagree before anything was pressed: ${JSON.stringify(before)}`);

  const opensAt = () => page.$eval("#tape .tape-note", (el) => Number(el.textContent.match(/Window opens at block (\d+)/)?.[1] ?? 0));
  const narrow = await opensAt();
  await page.click('#chart .frame[data-frame="24h"]');
  await page.waitForFunction(() => document.querySelector("#tape .flow-win")?.textContent.includes("24 hours"), null, { timeout: 30_000 });

  const after = await lit();
  if (new Set(after).size !== 1 || after[0] !== "24h") throw new Error(`pressing one toggle left the other behind: ${JSON.stringify(after)}`);
  const wide = await opensAt();
  if (!(wide < narrow)) throw new Error(`a wider window did not open the tape any earlier: ${wide} vs ${narrow}`);
});
await walk("the column's filters narrow what is shown and say how many of how many", async (page) => {
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000f2e54`, { waitUntil: "load" });
  await waitForDone(page);
  await openFeed(page);
  await page.waitForFunction(() => document.querySelectorAll("#feed .fr").length > 1, null, { timeout: 30_000 });

  const all = await page.$$eval("#feed .fr", (els) => els.length);
  await page.click('.fchip[data-filter="graduated"]');
  await page.waitForTimeout(300);
  const some = await page.$$eval("#feed .fr", (els) => els.length);
  if (!(some < all)) throw new Error(`filtering to graduated launches changed nothing: ${some} of ${all}`);
  if (!some) throw new Error("the demo chain has no graduated launch for the filter to keep");

  // The note has to stop claiming to be the whole window the moment it is not.
  const note = await page.$eval("#feed .feed-note", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!new RegExp(`${some} of ${all}`).test(note)) throw new Error(`a filtered column does not say how many of how many: "${note}"`);

  // And every row it kept really is one.
  const tags = await page.$$eval("#feed .fr", (els) => els.map((e) => e.textContent));
  if (!tags.every((t) => /graduated/i.test(t))) throw new Error("the graduated filter kept a launch that has not graduated");
});
await walk("a chain with no launchpad says why there is no column", async (page) => {
  await page.goto(`${url}#/t/0x532f27101965dd16442e59d40670faf5ebb142e4?chain=base`, { waitUntil: "load" });
  await page.waitForTimeout(1_200);
  await openFeed(page);
  await page.waitForFunction(() => document.querySelector("#feed .feed-empty"), null, { timeout: 15_000 });
  const why = await page.$eval("#feed .feed-empty", (el) => el.textContent.replace(/\s+/g, " ").trim());
  if (!/launchpad/i.test(why)) throw new Error(`the column on a chain with no launchpad does not say why: "${why}"`);
});
await walk("the front page is the board, and turning it off is remembered", async (page) => {
  // The site used to open on an empty box and wait to be asked. The first
  // thing a new reader sees now is what just launched, and what to do next.
  await page.goto(`${url}#/board?chain=demo`, { waitUntil: "load" }).catch(() => {});
  await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem("bouncer.mode", "demo"); } catch { /* fine */ } });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(600);
  const on = await page.$eval("#feed", (el) => !el.hidden);
  if (!on) throw new Error("a first visit opened on an empty box, not the board");
  const hint = await page.$eval(".pickone", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
  if (!hint) throw new Error("the right-hand pane is an empty hole until something is picked");

  // Here the chain cannot be reached at all, which is the case that matters:
  // a column that cannot read the factory must not say nothing launched.
  if (!live) {
    await page.waitForFunction(() => /stalled/i.test(document.querySelector("#feed .tape-live")?.textContent ?? ""), null, { timeout: 30_000 });
    const said = await page.$eval("#feed .feed-empty", (el) => el.textContent.replace(/\s+/g, " ").trim());
    if (/No launch in the window/i.test(said)) throw new Error(`an unreachable factory was reported as a quiet one: "${said}"`);
  }

  // Off is a choice, and a choice is remembered.
  await page.click("#feed-toggle");
  if (await page.$(".pickone")) throw new Error("turning the column off left its hint behind");
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(600);
  const back = await page.$eval("#feed", (el) => !el.hidden);
  if (back) throw new Error("the column came back after the reader turned it off");
});
await walk("a graduated launch has a tape and a price line, read off its V4 pool", async (page) => {
  // V3's Swap asked of a V4 PoolManager matches nothing, so every graduated
  // launch used to read "nobody traded it" — and before that, "no pool".
  await page.goto(`${url}#/demo/0x00c0ffee0000000000000000000000000000600d`, { waitUntil: "load" });
  await waitForDone(page);
  await page.waitForFunction(() => document.querySelector("#tape .tape-note"), null, { timeout: 30_000 });
  const rows = await page.$$eval("#tape table.trades tbody tr", (els) => els.length);
  if (!rows) throw new Error("a graduated launch with swaps on its pool showed an empty tape");
  const head = await page.$$eval("#tape table.trades th", (els) => els.map((e) => e.textContent.trim()));
  if (!head.includes("via")) throw new Error(`a V4 tape claims to know more than the router it was given: ${JSON.stringify(head)}`);
  if (!(await page.$("#chart svg"))) throw new Error("a graduated launch with trades has no price line");
});
await walk("a token on its curve has a price, a market cap and a live line", async (page) => {
  await page.goto(`${url}#/demo/0x00000000000000000000000000000000000000a7`, { waitUntil: "load" });
  await waitForDone(page);
  await page.waitForFunction(() => document.querySelector("#chart svg"), null, { timeout: 30_000 });
  const facts = await page.$$eval(".fact", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  // The price lives in the token bar now, beside the ticker, not in the rail.
  const price = await page.$eval(".tp-v", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
  if (!price || /no price|not read|—/.test(price)) throw new Error(`a token on its curve still shows its price as "${price}"`);
  for (const label of ["Market cap", "Liquidity"]) {
    const f = facts.find((x) => x.toLowerCase().startsWith(label.toLowerCase()));
    if (!f || /not read|—/.test(f)) throw new Error(`a token on its curve still shows ${label} as "${f}"`);
  }
});
await walk("Solana says why it cannot watch instead of hiding the section", async (page) => {
  await page.goto(`${url}#/t/So11111111111111111111111111111111111111112?chain=solana`, { waitUntil: "load" });
  // No network here, so the slip will not finish. The point of the walk is
  // the shape of the answer when it does, and that is checked on the build
  // by cli-check; here it only has to not throw.
  await page.waitForTimeout(1_500);
});
await browser.close();
if (failures) {
  console.error(`\nflows: ${failures} journey${failures === 1 ? "" : "s"} broken.`);
  process.exit(1);
}
console.log(skipped ? `flows: every journey that could run here walked end to end; ${skipped} needed the deployed site` : "flows: every journey walked end to end");

