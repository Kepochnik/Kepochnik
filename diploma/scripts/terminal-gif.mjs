#!/usr/bin/env node
/**
 * Turns a sequence of captured terminal frames into a GIF and an MP4, so the
 * README and the launch post show the tool actually running.
 *
 *   node scripts/terminal-gif.mjs --frames frames.json --out assets/readme/demo.gif [--title "tool watch"] [--accent "#caff38"] [--width 960]
 *
 * frames.json: [{ "text": "...", "holdMs": 1200 }, ...]
 *
 * Needs Chromium (Playwright) and Python 3 with Pillow; ffmpeg is optional for
 * the WebM. PLAYWRIGHT_MODULE, CHROME_PATH and FFMPEG_PATH override the defaults.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const framesPath = opt("frames");
const output = opt("out");
if (!framesPath || !output) {
  console.error("usage: terminal-gif --frames <json> --out <gif> [--title t] [--accent hex] [--width px]");
  process.exit(1);
}
const title = opt("title", "");
const accent = opt("accent", "#caff38");
const width = Number(opt("width", "960"));

const require = createRequire(import.meta.url);
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const chromePath = process.env.CHROME_PATH;

const frames = JSON.parse(readFileSync(framesPath, "utf8"));
const work = mkdtempSync(join(tmpdir(), "terminal-gif-"));
const svgScript = resolve(dirname(new URL(import.meta.url).pathname), "terminal-svg.mjs");

const { chromium } = require(playwrightModule);
const browser = await chromium.launch(chromePath ? { executablePath: chromePath } : {});
const page = await browser.newPage({ viewport: { width, height: 600 }, deviceScaleFactor: 2 });

let maxHeight = 0;
const pngs = [];
for (let i = 0; i < frames.length; i++) {
  const txt = join(work, `frame-${i}.txt`);
  const svg = join(work, `frame-${i}.svg`);
  const png = join(work, `frame-${i}.png`);
  writeFileSync(txt, frames[i].text);
  execFileSync(process.execPath, [svgScript, "--in", txt, "--out", svg, "--title", title, "--accent", accent], { stdio: "pipe" });
  const markup = readFileSync(svg, "utf8");
  await page.setContent(`<html><body style="margin:0;background:#000"><div style="width:${width}px">${markup.replace("<svg ", '<svg style="width:100%;height:auto" ')}</div></body></html>`);
  const el = await page.$("svg");
  const box = await el.boundingBox();
  maxHeight = Math.max(maxHeight, Math.ceil(box.height));
  await el.screenshot({ path: png });
  pngs.push(png);
}
await browser.close();

mkdirSync(dirname(output), { recursive: true });
const manifest = join(work, "manifest.json");
writeFileSync(manifest, JSON.stringify({ frames: pngs.map((png, i) => ({ png, holdMs: frames[i].holdMs ?? 1000 })) }));
const stitch = resolve(dirname(new URL(import.meta.url).pathname), "stitch.py");
const webm = output.replace(/\.gif$/, ".webm");
run(["python3", [stitch, "--manifest", manifest, "--gif", output, "--webm", webm, "--fps", "12"]]);
console.log(`wrote ${output} (${frames.length} frames, tallest ${maxHeight}px)`);

function run([command, commandArgs]) {
  const result = spawnSync(command, commandArgs, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
