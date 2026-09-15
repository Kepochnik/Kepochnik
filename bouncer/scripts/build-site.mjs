#!/usr/bin/env node
/**
 * Bundles site/src/app.ts with esbuild and writes:
 *   site/dist/app.js          the bundle
 *   site/dist/index.html      the page with the bundle inlined (one file: GitHub Pages, IPFS, a USB stick)
 *   site/dist/artifact.html   body-only variant for hosts that supply their own <html>/<head>
 *   extension/app.js, extension/popup.html   the same app as the Chrome popup (no inline scripts: MV3)
 *   site/dist/bouncer-extension.zip          the extension, ready to drop onto chrome://extensions
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

mkdirSync("site/dist", { recursive: true });
await build({
  entryPoints: ["site/src/app.ts"],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  outfile: "site/dist/app.js",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  tsconfigRaw: { compilerOptions: { target: "ES2022", strict: true } },
});
const js = readFileSync("site/dist/app.js", "utf8");
const html = readFileSync("site/index.html", "utf8");
const inlined = html.replace('<script src="app.js"></script>', `<script>\n${js.replace(/<\/script/g, "<\\/script")}\n</script>`);
writeFileSync("site/dist/index.html", inlined);

const start = inlined.indexOf("<title>");
const headEnd = inlined.indexOf("</head>");
const bodyStart = inlined.indexOf("<body>") + "<body>".length;
const bodyEnd = inlined.lastIndexOf("</body>");
writeFileSync("site/dist/artifact.html", `${inlined.slice(start, headEnd)}\n${inlined.slice(bodyStart, bodyEnd)}`);
// The Chrome popup is the site with local scripts only (MV3 forbids inline and remote scripts),
// system fonts, and a popup-sized stylesheet layered on top.
const popupCss = readFileSync("extension/popup.css", "utf8");
const popup = html
  .replace(/<link rel="preconnect"[^>]*>\n/g, "")
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n/, "")
  .replace("</style>", `${popupCss}</style>`)
  .replace('<script src="app.js"></script>', '<script src="popup-init.js"></script>\n<script src="app.js"></script>');
writeFileSync("extension/popup.html", popup);
copyFileSync("site/dist/app.js", "extension/app.js");
try {
  execFileSync("zip", ["-q", "-r", "-X", "../site/dist/bouncer-extension.zip", ".", "-x", "*.DS_Store"], { cwd: "extension" });
  console.log("extension: site/dist/bouncer-extension.zip");
} catch (error) {
  console.warn(`extension zip skipped: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`site: ${(inlined.length / 1024).toFixed(0)} KB single file, ${(js.length / 1024).toFixed(0)} KB script`);
