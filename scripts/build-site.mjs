#!/usr/bin/env node
/**
 * Bundles site/src/app.ts with esbuild and writes:
 *   site/dist/app.js          the bundle
 *   site/dist/index.html      the page with the bundle inlined (one file: GitHub Pages, IPFS, a USB stick)
 *   site/dist/artifact.html   body-only variant for hosts that supply their own <html>/<head>
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
console.log(`site: ${(inlined.length / 1024).toFixed(0)} KB single file, ${(js.length / 1024).toFixed(0)} KB script`);
