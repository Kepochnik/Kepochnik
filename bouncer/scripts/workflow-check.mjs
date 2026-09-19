/**
 * Syntax-check every `run:` script in the workflows, before a runner does it
 * for us at a minute a go.
 *
 * This exists because of one character. A comment inside a `node -e '...'`
 * block said "Raydium's pool account", the apostrophe closed the shell quote,
 * and everything after it became bash — which failed on the next parenthesis.
 * The script was valid JavaScript, the YAML was valid YAML, and the only place
 * it was wrong was a place nothing here was looking. `bash -n` looks there.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = ".github/workflows";
const scratch = mkdtempSync(join(tmpdir(), "wf-"));
let failed = 0;
let checked = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
  const lines = readFileSync(join(DIR, file), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)(?:- )?run:\s*\|\s*$/.exec(lines[i]);
    if (!start) continue;
    // The block is every following line indented past the `run:` key itself.
    const indent = start[1].length + (lines[i].includes("- run:") ? 2 : 0);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const depth = line.length - line.trimStart().length;
      if (depth <= indent) break;
      body.push(line.slice(indent + 2));
    }
    i = j - 1;
    // `${{ }}` is filled in by the runner, not by bash. Substituting a
    // placeholder keeps a real expression from reading as a syntax error.
    const script = body.join("\n").replace(/\$\{\{[^}]*\}\}/g, "PLACEHOLDER");
    const path = join(scratch, `${file}-${j}.sh`);
    writeFileSync(path, script);
    checked++;
    try {
      execFileSync("bash", ["-n", path], { stdio: "pipe" });
    } catch (error) {
      failed++;
      const message = String(error.stderr ?? error).replace(new RegExp(scratch, "g"), "");
      console.error(`${DIR}/${file}: a run: block starting at line ${i - body.length + 1} is not valid bash`);
      console.error(message.trim());
    }
  }
}

if (failed) {
  console.error(`\n${failed} of ${checked} run: blocks would fail on the runner.`);
  process.exit(1);
}
console.log(`workflows: ${checked} run: blocks parse`);
