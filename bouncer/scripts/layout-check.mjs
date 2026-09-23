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
/**
 * How tall a full slip may be before it has stopped being one answer and
 * become a document. Measured on the richest demo token.
 */
// Measured on the ordinary-token demo slip: 2070 px at 1280, 2666 at 768,
// 3863 at 390. A narrow window is taller for the same content, so the
// ceiling follows the width rather than pretending one number fits.
const TALL = { 390: 4400, 768: 3050, 1280: 2400 };

const ROUTES = [
  { hash: "", what: "the first load" },
  { hash: "#/demo/0x00000000000000000000000000000000000bad01", what: "an impostor (STOP, every card)", tall: true },
  { hash: "#/demo/0x0000000000000000000000000000000000f1a1a1", what: "an ordinary token", tall: true },
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
let warnedFont = false;
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
    // Did the display face actually arrive?
    //
    // document.fonts.check() is no use here: for a family the browser does
    // not have at all it returns true, so the first version of this check
    // passed in a sandbox that cannot reach Google Fonts — a false green of
    // exactly the kind this file exists to prevent. The reliable test is to
    // render the same string twice, once in the wanted family and once in a
    // generic, and compare: a condensed display face is not the same width
    // as the fallback, and identical widths mean the fallback is what you
    // are looking at.
    //
    // Only a failure when the page came over http(s). On a file:// page in
    // an offline sandbox a missing webfont is the sandbox, not the page.
    const font = await page.evaluate(async () => {
      await (document.fonts?.ready ?? Promise.resolve());
      const el = document.querySelector(".wordmark");
      if (!el) return null;
      const wanted = getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
      const measure = (family) => {
        const probe = document.createElement("span");
        probe.textContent = "BOUNCER HANDGLOVES 0123456789";
        probe.style.cssText = `position:absolute;left:-9999px;white-space:nowrap;font:900 64px ${family}`;
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      };
      return { wanted, real: measure(`"${wanted}", sans-serif`), fallback: measure("sans-serif") };
    });
    if (font && Math.abs(font.real - font.fallback) < 1) {
      const remote = url.startsWith("http");
      const say = `the display face ${font.wanted} is not being used — the page is rendering in the fallback`;
      if (remote) {
        failures++;
        console.error(`::error::${size.name}, ${route.what}: ${say}`);
      } else if (!warnedFont) {
        warnedFont = true;
        console.log(`layout: ${say} (expected on a file:// page with no network; checked for real against a deployed URL)`);
      }
    }

    // How tall the slip got.
    //
    // A page that answers in one screen and a page that answers in six are
    // different products, and the difference creeps back one paragraph at a
    // time. This one was 3631 px on a desktop and 6290 on a phone, mostly
    // because four sections opened themselves and the summary said what the
    // cards below it then said again.
    //
    // A ceiling, not a target: content varies, so it is set well above what
    // the demo slip measures and only fires when something structural has
    // changed.
    if (route.tall) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const ceiling = TALL[size.w];
      if (!ceiling) throw new Error(`no height ceiling set for ${size.w}px; add one rather than letting the width go unchecked`);
      if (height > ceiling) {
        failures++;
        console.error(`::error::${size.name} (${size.w}px), ${route.what}: the page is ${height}px tall, over its ceiling of ${ceiling}px — the answer has spread out again`);
      }
    }

// ---- contrast, measured in the browser rather than read off the palette
    //
    // An outside audit measured one pairing on this page at 2.78:1 against
    // a requirement of 4.5. Reading the stylesheet would not have found it:
    // the colour is a token used in a dozen rules, and what matters is the
    // pair that ends up on screen — the computed colour of the text against
    // the first ancestor that actually paints a background. Only a browser
    // knows that.
    //
    // Small text only, per WCAG: 18.66px bold or 24px normal and up is
    // large text and clears at 3:1. Measured per element and reported with
    // the pair, because "the page has a contrast problem" is not something
    // anybody can act on.
    const dull = await page.evaluate((MIN) => {
      const lum = (rgb) => {
        const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const parse = (s) => {
        const m = /rgba?\(([^)]+)\)/.exec(s || "");
        if (!m) return null;
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
      };
      // The colour actually behind an element: walk up until something
      // paints. A transparent background is not a background.
      const behind = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const bg = parse(getComputedStyle(n).backgroundColor);
          if (bg && bg.a > 0.95) return bg.rgb;
        }
        return [0, 0, 0];
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const bad = [];
      const seen = new Set();
      for (const el of document.querySelectorAll("body *")) {
        // Only elements holding their own visible text.
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const fg = parse(cs.color);
        if (!fg || fg.a < 0.95) continue;
        const size = parseFloat(cs.fontSize);
        const weight = Number(cs.fontWeight) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const need = large ? 3 : MIN;
        const got = ratio(fg.rgb, behind(el));
        if (got >= need) continue;
        const key = `${cs.color}|${el.className}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push({ sel: `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").filter(Boolean).join(".")}`, got: Math.round(got * 100) / 100, need, color: cs.color, text: own.slice(0, 32) });
      }
      return bad;
    }, 4.5);
    for (const b of dull) {
      failures++;
      console.error(`::error::${size.name} (${size.w}px), ${route.what}: ${b.sel} is ${b.got}:1 against its background, needs ${b.need}:1 — ${b.color} on "${b.text}"`);
    }

    // ---- tap targets
    //
    // The audit measured the export buttons at 29px and the chain switch at
    // 26. A control a thumb misses is a control that is not there, and the
    // retry this release adds is the one somebody presses when a check came
    // back incomplete — the worst possible moment to miss.
    if (size.w <= 480) {
      const small = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("button, a[href], select, [role=button], input")) {
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          // Pushed off-screen for a screen reader. The native <select> behind
          // the chain picker lives here: it is the control of record and the
          // thing assistive tech drives, and no thumb ever reaches for it.
          if (r.right < 0 || r.bottom < 0) continue;
          // An inline link inside prose is text, not a target.
          if (el.tagName === "A" && el.closest("p, li, dd, td")) continue;
          // Two rules, because they are two different promises. A control —
          // a button, a menu, a field — is something a thumb aims at, and 44
          // is the size a thumb needs; that is where the audit's 27px export
          // buttons and 26px chain switch sit. A standalone link is closer
          // to text, and WCAG 2.2's own AA floor for a target is 24.
          const need = el.tagName === "A" ? 24 : 44;
          if (r.height < need) out.push({ need, sel: `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").filter(Boolean).join(".")}`, h: Math.round(r.height), text: (el.textContent || el.value || "").trim().slice(0, 28) });
        }
        return out;
      });
      for (const t of small) {
        failures++;
        console.error(`::error::${size.name} (${size.w}px), ${route.what}: ${t.sel} is ${t.h}px tall, needs ${t.need} — "${t.text}"`);
      }
    }

// ---- is the answer on the first screen?
    //
    // The audit said the phone's first screen was too long. Measured, it
    // was worse than "too long": with a slip open the verdict word began
    // around 900px on an 844px viewport, so the one word the whole page
    // exists to say was below the fold, under a headline explaining the
    // page to somebody who had already used it.
    //
    // A ceiling on where the ANSWER starts, which is the thing a reader
    // came for. Everything above it — header, search box — is allowed to
    // exist; it is just not allowed to push the verdict off the screen.
    if (size.w <= 480 && route.tall) {
      const top = await page.evaluate(() => {
        const el = document.querySelector(".vword");
        return el ? Math.round(el.getBoundingClientRect().top + scrollY) : null;
      });
      if (top === null) {
        failures++;
        console.error(`::error::${size.name} (${size.w}px), ${route.what}: no verdict word to measure`);
      } else if (top > size.h - 120) {
        failures++;
        console.error(`::error::${size.name} (${size.w}px), ${route.what}: the verdict starts ${top}px down a ${size.h}px screen — the answer is below the fold`);
      }
    }

// ---- every class on screen has a rule behind it
    //
    // This is the bug that rendered the token's address as a default grey
    // button: an edit spliced the stylesheet by index and took four rules
    // with it (.vwho, .vsym, .vname, .vaddr), the markup kept emitting
    // them, and nothing failed. Reading the source would not have found
    // it — what matters is what ends up in the DOM.
    //
    // Collected from the live page and checked against the stylesheet
    // text, so a class that is emitted but has no rule anywhere fails.
    const orphans = await page.evaluate((exempt) => {
      const sheet = [...document.styleSheets]
        .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
        .map((r) => r.cssText)
        .join("\n");
      // An element styled by its id is styled. The chain picker's name is
      // exactly that: class="picker-name" id="picker-name", with the rule
      // on the id — reporting it as unstyled would be the check being
      // wrong about the page rather than the page being wrong.
      const styledById = new Set();
      for (const el of document.querySelectorAll("[id]")) {
        if (new RegExp(`#${el.id.replace(/[-]/g, "\\-")}(?![\\w-])`).test(sheet)) for (const c of el.classList) styledById.add(c);
      }
      const seen = new Set();
      for (const el of document.querySelectorAll("*")) for (const c of el.classList) seen.add(c);
      return [...seen].filter(
        (c) => !exempt.includes(c) && !styledById.has(c) && !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(sheet),
      );
    }, [
      // Deliberately unstyled, each for a stated reason.
      //
      // "mono" and "num" are markers the script and the card reader look
      // for. "lv-info" is the quiet level: .find.lv-stop and .lv-watch
      // colour their rows, and INFO is what a row looks like when nothing
      // has coloured it.
      "mono", "num", "lv-info",
    ]);
    for (const c of orphans) {
      failures++;
      console.error(`::error::${size.name} (${size.w}px), ${route.what}: class "${c}" is on the page and has no rule anywhere — an edit took its styling and nothing noticed`);
    }

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
// Name what passed, not just that something did. A summary that says "no
// horizontal scroll" while two other checks sat silently disabled is how a
// green run stops meaning anything.
console.log(`layout: ${checked} page loads across ${WIDTHS.length} widths · no horizontal scroll · no page errors · nothing over its height ceiling · every text pairing at or above WCAG AA (4.5:1, 3:1 for large) · every phone control at 44px and every standalone link at 24 · the verdict above the fold on a phone · every class on screen has a rule behind it`);
