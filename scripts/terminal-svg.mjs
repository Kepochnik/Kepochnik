#!/usr/bin/env node
/**
 * Renders captured terminal text as a documentation SVG (dark panel,
 * monospace, one accent color). Used for README images so what the reader
 * sees is real CLI output, not a mock-up.
 *
 *   node scripts/terminal-svg.mjs --in capture.txt --out assets/readme/capture.svg --title "tool inspect 0x…" --accent "#caff38"
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const input = opt("in");
const output = opt("out");
if (!input || !output) {
  console.error("usage: terminal-svg --in <text file> --out <svg> [--title <text>] [--accent <hex>] [--bg <hex>]");
  process.exit(1);
}
const title = opt("title", "");
const accent = opt("accent", "#caff38");
const bg = opt("bg", "#070b07");
const fg = opt("fg", "#e6f2d8");
const dim = opt("dim", "#7d8f6d");

const lines = readFileSync(input, "utf8").replace(/\r/g, "").split("\n");
while (lines.length && lines[lines.length - 1] === "") lines.pop();

const charWidth = 8.4;
const lineHeight = 20;
const padX = 24;
const padY = 56;
const columns = Math.max(...lines.map((line) => [...line].length), 40);
const width = Math.ceil(columns * charWidth + padX * 2);
const height = Math.ceil(lines.length * lineHeight + padY + 28);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Accent rule: lines starting with a box border or containing ALL-CAPS section titles get the accent color.
const colorFor = (line) => {
  if (/^[┌└├]/.test(line)) return accent;
  if (/^│ [A-Z0-9 /·-]{3,}\s*│$/.test(line)) return accent;
  if (/\b(LEAVE|WATCH|QUIET|FIRE|SKIP|OPEN|CLOSED|HALT|LOCKED|UNKNOWN)\b/.test(line)) return accent;
  if (/^\s*[#>]/.test(line)) return dim;
  return fg;
};

const body = lines
  .map((line, index) => {
    const y = padY + index * lineHeight;
    return `<text x="${padX}" y="${y}" fill="${colorFor(line)}" xml:space="preserve">${escape(line)}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
  <rect width="100%" height="100%" rx="12" fill="${bg}"/>
  <circle cx="22" cy="22" r="6" fill="#ff5f57"/><circle cx="42" cy="22" r="6" fill="#febc2e"/><circle cx="62" cy="22" r="6" fill="#28c840"/>
  <text x="${padX + 64}" y="27" fill="${dim}" font-size="12">${escape(title)}</text>
  <line x1="0" y1="40" x2="${width}" y2="40" stroke="${accent}" stroke-opacity="0.25"/>
${body}
</svg>
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, svg);
console.log(`wrote ${output} (${lines.length} lines, ${width}x${height})`);
