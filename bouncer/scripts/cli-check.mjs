/**
 * Does the command-line tool actually work?
 *
 * Every other check in here measures the website. The CLI is the same
 * core with a different face, and it had rotted quietly: the completeness
 * state the site had carried for days was missing from the terminal
 * entirely, its footer claimed "Every value was read" over readings that
 * had been refused, and its idea of which commands a chain can serve had
 * drifted from the one the site uses — so `bouncer wallet --chain base`
 * went out to the network to read a launchpad that does not exist there.
 *
 * None of that was visible from the website, and all of it was obvious in
 * one run of the actual command. So the actual commands get run.
 *
 *   node scripts/cli-check.mjs
 *
 * Three things are checked:
 *   1. every command answers on the demo chain, which needs no network
 *   2. one decision about what a chain can serve, shared with the site —
 *      a blocked command refuses without touching the network, and an
 *      allowed one is never refused
 *   3. nothing prints the debris of a bug: undefined, NaN, [object
 *      Object], an unresolved template, or an error wrapped in itself
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHAINS, featureBlocker } from "../dist/src/chain/chains.js";

const run = promisify(execFile);
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`::error::cli: ${msg}`);
};

async function bouncer(args, { timeout = 90_000 } = {}) {
  try {
    const { stdout, stderr } = await run("node", ["bin/bouncer.mjs", ...args], { timeout, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * The debris a bug leaves in output nobody read closely.
 *
 * "undefined" and "NaN" are a value that was never there printed as
 * though it were; "[object Object]" is a structure interpolated into a
 * sentence; "${" is a template that never ran. An error quoted inside
 * another copy of itself is the nesting that made one refusal two
 * terminal lines of brackets.
 */
function debrisIn(text) {
  const found = [];
  if (/\bundefined\b/.test(text)) found.push("undefined");
  if (/\bNaN\b/.test(text)) found.push("NaN");
  if (/\[object [A-Z]/.test(text)) found.push("[object …]");
  if (/\$\{/.test(text)) found.push("an unrendered ${…} template");
  if (/refused this read \(.*refused this read/s.test(text)) found.push("an error wrapped inside itself");
  return found;
}

console.log("cli: running every command against the demo chain");

const DEMO_TOKEN = "0x0000000000000000000000000000000000f1a1a1";
const DEMO_LAUNCH = "0x00000000000000000000000000000000000f2e54";
const DEMO_DEV = "0x00000000000000000000000000000000000000f1";

const COMMANDS = [
  { name: "doctor", args: ["doctor", "--demo"] },
  { name: "door", args: ["door", DEMO_TOKEN, "--demo"] },
  { name: "door (json)", args: ["door", DEMO_TOKEN, "--demo", "--format", "json"] },
  { name: "door (markdown)", args: ["door", DEMO_TOKEN, "--demo", "--format", "markdown"] },
  { name: "door (svg)", args: ["door", DEMO_TOKEN, "--demo", "--format", "svg"] },
  { name: "dev", args: ["dev", DEMO_DEV, "--demo"] },
  { name: "exit", args: ["exit", DEMO_LAUNCH, "--demo"] },
  { name: "wallet", args: ["wallet", DEMO_LAUNCH, DEMO_DEV, "--demo"] },
  { name: "plan", args: ["plan", "--demo"] },
  { name: "board", args: ["board", "--demo"] },
  { name: "demo", args: ["demo"] },
];

for (const c of COMMANDS) {
  const { code, out } = await bouncer(c.args);
  if (code !== 0) {
    fail(`${c.name} exited ${code}: ${out.trim().split("\n").slice(0, 2).join(" | ").slice(0, 200)}`);
    continue;
  }
  if (out.trim().length < 40) fail(`${c.name} answered with almost nothing (${out.trim().length} chars)`);
  const debris = debrisIn(out);
  if (debris.length) fail(`${c.name} printed ${debris.join(", ")}`);
  if (c.args.includes("json")) {
    try {
      JSON.parse(out.slice(out.indexOf("{")));
    } catch (error) {
      fail(`${c.name} did not produce parseable JSON: ${error.message}`);
    }
  }
  if (c.name === "door (svg)" && !out.includes("<svg")) fail("door --format svg produced no SVG");
  console.log(`  ok  ${c.name}`);
}

// ---- the capability matrix, as the CLI actually behaves
//
// A blocked command has to refuse BEFORE it reaches the network: the point
// is not the error, it is not spending somebody's rate limit to discover
// something the config already knew.
console.log("cli: what each chain says it can serve");
const FEATURES = { board: ["board"], plan: ["plan"], wallet: ["wallet", "0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"], receipt: ["receipt", `0x${"11".repeat(32)}`], dev: ["dev", "0x0000000000000000000000000000000000000001"] };
const FEATURE_OF = { board: "board", plan: "plan", wallet: "wallet", receipt: "tx", dev: "dev" };

for (const chain of Object.values(CHAINS)) {
  for (const [command, args] of Object.entries(FEATURES)) {
    const blocked = featureBlocker(chain, FEATURE_OF[command]);
    // Short timeout: a refusal is instant, and anything that reaches the
    // network on a blocked command is the bug this is looking for.
    const { code, out } = await bouncer([...args, "--chain", chain.key], { timeout: 25_000 });
    // Every phrasing the CLI can refuse with, not just the newest one.
    //
    // This started as /is not available on/ and quietly passed a drift
    // that was deliberately reintroduced to test it: the older gate
    // refuses with "reads a launchpad, and none that BOUNCER knows runs
    // on …", which that pattern does not match, so the check saw
    // "allowed, and not refused" and agreed with itself.
    const refused = /is not available on|reads a launchpad, and none that BOUNCER knows|needs the .* factory address/.test(out);
    if (blocked && !refused) {
      fail(`${chain.key}/${command}: the matrix blocks it and the CLI tried anyway — "${out.trim().split("\n")[0].slice(0, 110)}"`);
    }
    if (!blocked && refused) {
      fail(`${chain.key}/${command}: the matrix allows it and the CLI refused — "${out.trim().split("\n")[0].slice(0, 110)}"`);
    }
    if (blocked && refused && code === 0) fail(`${chain.key}/${command} refused but exited 0`);
    if (blocked && refused) {
      const debris = debrisIn(out);
      if (debris.length) fail(`${chain.key}/${command} refusal printed ${debris.join(", ")}`);
    }
  }
}
console.log(`  ok  ${Object.keys(CHAINS).length} chains × ${Object.keys(FEATURES).length} commands agree with the shared matrix`);

// ---- an explicit --factory still unlocks a chain the table has no address for
//
// The gate above is derived from the chain table, and the table is not the
// whole story: --factory is how somebody reads a launchpad BOUNCER does not
// ship an address for. Gating on the shipped config alone took that escape
// hatch away, which is a regression a matrix check cannot see, because the
// matrix and the gate agreed with each other perfectly while the feature
// was gone.
const unpublished = Object.values(CHAINS).find((c) => c.family === "evm" && !c.factory);
if (unpublished) {
  const { out } = await bouncer(["board", "--chain", unpublished.key, "--factory", `0x${"ab".repeat(20)}`], { timeout: 25_000 });
  if (/is not available on|reads a launchpad, and none/.test(out)) {
    fail(`${unpublished.key}: --factory no longer unlocks a chain with no published address — "${out.trim().split("\n")[0].slice(0, 120)}"`);
  } else {
    console.log(`  ok  --factory still unlocks ${unpublished.key}`);
  }
}

if (failures) {
  console.error(`\ncli: ${failures} problem${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("cli: every command answers, and every chain serves exactly what it says it can");
