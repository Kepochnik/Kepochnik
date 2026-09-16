#!/usr/bin/env node
/**
 * Chrome Web Store graphics: icons 16/48 from the gorilla, a 1280×800
 * screenshot of the popup (Playwright, if installed) and a 440×280 promo
 * tile composed from the built site's own styles.
 */
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

execFileSync("python3", ["-c", `
from PIL import Image
g = Image.open('assets/bouncer-gorilla.png')
for s in (16, 48):
    g.resize((s, s), Image.NEAREST).save(f'extension/icon-{s}.png')
`]);

const tile = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:440px;height:280px;background:#0e0d10;color:#ece7dc;font-family:system-ui,sans-serif;display:flex;align-items:center;gap:24px;padding:0 32px;box-sizing:border-box;border-top:6px solid #b3122e}
img{width:120px;height:120px;image-rendering:pixelated}
h1{font:900 44px/1 Impact,'Arial Black',sans-serif;letter-spacing:.06em;margin:0}
p{margin:8px 0 0;color:#8f8a96;font-size:15px;line-height:1.4}
b{color:#c9a227;font:600 12px ui-monospace,monospace;letter-spacing:.12em;display:block;margin-top:10px}
</style><body><img src="../../assets/bouncer-gorilla-transparent.png"><div><h1>BOUNCER</h1><p>Check the list before you pay the cover. Read-only door check for Pons tokens.</p><b>NO KEY · NO SIGNER · NO TX</b></div>`;
writeFileSync("extension/store/tile.html", tile);

const pw = "/opt/node22/lib/node_modules/playwright";
if (existsSync(pw)) {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(`${pw}/package.json`)("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const t = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await t.goto(`file://${process.cwd()}/extension/store/tile.html`);
  await t.screenshot({ path: "extension/store/tile-440x280.png" });
  const s = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await s.goto(`file://${process.cwd()}/site/dist/index.html#/demo/0x00000000000000000000000000000000000f2e54`);
  await s.waitForTimeout(1500);
  await s.screenshot({ path: "extension/store/screenshot-1280x800.png" });
  await browser.close();
  console.log("store assets: tile-440x280.png, screenshot-1280x800.png, icons 16/48");
} else {
  console.log("playwright not found: wrote tile.html, icons 16/48; take the screenshots by hand");
}
