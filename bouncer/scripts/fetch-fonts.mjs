/**
 * Rebuilds site/fonts.css: the two typefaces, latin subset, base64 inside the
 * stylesheet.
 *
 * Why embedded rather than linked: this site's whole promise is one HTML file
 * that works from a USB stick, inside a Chrome popup and with no network. A
 * <link> to Google Fonts breaks all three — and it broke them silently, which
 * is worse. Every screenshot taken of this page for weeks rendered in the
 * browser's fallback face, layout-check said so on every run, and it was read
 * as a file:// quirk rather than as the page having no typography at all.
 *
 * It also stops every visitor's IP going to a third party to fetch a letter.
 *
 * Run it when a face or a weight range changes: node scripts/fetch-fonts.mjs
 */
import { writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const want = [
  { family: "Geist", spec: "Geist:wght@300..800", weights: "300 800" },
  { family: "JetBrains Mono", spec: "JetBrains+Mono:wght@400..700", weights: "400 700" },
];
const out = [];
for (const f of want) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${f.spec}&display=swap`, { headers: { "user-agent": UA } })).text();
  // The latin block is the last @font-face in the file Google serves.
  const blocks = css.split("@font-face").slice(1);
  const latin = blocks.find((b) => /unicode-range:\s*U\+0000-00FF/.test(b));
  if (!latin) throw new Error(`no latin subset for ${f.family}`);
  const url = /url\((https:[^)]+)\)/.exec(latin)[1];
  const range = /unicode-range:\s*([^;]+);/.exec(latin)[1].trim();
  const bytes = Buffer.from(await (await fetch(url, { headers: { "user-agent": UA } })).arrayBuffer());
  console.log(`${f.family}: ${(bytes.length / 1024).toFixed(0)} KB woff2 → ${(bytes.length * 4 / 3 / 1024).toFixed(0)} KB base64`);
  out.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weights};font-display:swap;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format('woff2');unicode-range:${range}}`);
}
writeFileSync("site/fonts.css", out.join("\n") + "\n");
console.log("total css:", (out.join("").length / 1024).toFixed(0), "KB");
