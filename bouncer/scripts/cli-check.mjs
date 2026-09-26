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

// ---- a flag the tool does not know is refused, never dropped
//
// `--chian base` parsed cleanly and read Robinhood Chain while its user
// believed they were checking a token on Base. Silently reading the wrong
// chain is the worst failure available to this tool.
console.log("cli: a mistyped flag stops the run");
for (const [flag, meant] of [["--chian", "--chain"], ["--dem0", "--demo"], ["--formt", "--format"], ["--nosuchthing", null]]) {
  const { code, out } = await bouncer(["door", DEMO_TOKEN, "--demo", flag], { timeout: 25_000 });
  if (code === 0) fail(`${flag} was accepted and something was read anyway`);
  if (!out.includes(`unknown flag ${flag}`)) fail(`${flag} was not named in the refusal: "${out.trim().slice(0, 110)}"`);
  if (meant && !out.includes(`Did you mean ${meant}?`)) fail(`${flag} got no suggestion of ${meant}: "${out.trim().slice(0, 110)}"`);
  if (!meant && /Did you mean/.test(out)) fail(`${flag} was given an invented suggestion: "${out.trim().slice(0, 110)}"`);
}
console.log("  ok  mistyped flags refuse with a suggestion, and nothing is read");

// ---- the MCP server answers over stdio, and takes the same --demo
//
// It took BOUNCER_DEMO=1 and nothing else, so `bouncer-mcp --demo` served
// an agent from the REAL chains while its operator believed otherwise.
console.log("cli: the MCP server over stdio");
{
  const { spawn } = await import("node:child_process");
  const ask = (args, env) =>
    new Promise((resolve) => {
      const p = spawn("node", ["bin/bouncer-mcp.mjs", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      for (const [id, method, params] of [
        [1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } }],
        [2, "tools/list", {}],
        [3, "tools/call", { name: "bouncer_check", arguments: { address: DEMO_TOKEN } }],
      ]) {
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }
      setTimeout(() => {
        p.kill();
        resolve(out);
      }, 30_000);
    });

  const out = await ask(["--demo"], {});
  const replies = out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = new Map(replies.map((r) => [r.id, r]));
  if (!byId.has(1)) fail("the MCP server did not answer initialize");
  const tools = byId.get(2)?.result?.tools ?? [];
  if (tools.length < 5) fail(`the MCP server listed ${tools.length} tools`);
  const call = byId.get(3)?.result;
  if (!call) fail("the MCP server did not answer a tools/call");
  else if (call.isError) fail(`bouncer_check over MCP failed with --demo, so the flag is being ignored: ${JSON.stringify(call.content).slice(0, 140)}`);
  else if (!call.structuredContent) fail("bouncer_check returned no structured content for an agent to read");
  else console.log(`  ok  ${tools.length} tools, and --demo is honoured`);
}

// ---- the extension can reach every chain it offers
//
// The popup is the same app behind a Chrome manifest, and MV3 will only
// let it fetch hosts that manifest lists. Add a chain to the table and
// forget the manifest and the extension ships a chain in its menu that it
// cannot read — a failure that looks exactly like the endpoint being
// down. Only what is FETCHED is checked: explorerUrl is used for links,
// and a link needs no permission.
console.log("cli: the extension's manifest against the chain table");
{
  const { readFileSync } = await import("node:fs");
  const toRe = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  // A browser normalises "https://host" to "https://host/" before matching.
  // Without this every bare-host endpoint in the table looks unreachable,
  // which is what the first version of this check reported.
  const norm = (u) => { try { return new URL(u).href; } catch { return u; } };
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
  const pats = (manifest.host_permissions ?? []).map(toRe);
  const allowed = (u) => pats.some((p) => p.test(norm(u)));

  // The checker gets tested before it is believed. It has been wrong twice:
  // once leaving "*" as a regex quantifier, once not normalising the URL.
  for (const [u, want] of [
    ["https://bouncer-proxy.tarasenkosanja12.workers.dev/rpc/robinhood", true],
    ["https://evil.example.com/", false],
    ["https://base.llamarpc.com.evil.test/", false],
  ]) {
    if (allowed(u) !== want) fail(`the manifest checker is broken: ${u} read as ${allowed(u)}, expected ${want}`);
  }

  let missing = 0;
  for (const c of Object.values(CHAINS)) {
    for (const url of c.rpc) if (!allowed(url)) { fail(`the extension offers ${c.key} but its manifest does not allow ${url}`); missing++; }
    if (c.blockscout && !allowed(c.blockscout)) { fail(`the extension offers ${c.key} but its manifest does not allow its explorer ${c.blockscout}`); missing++; }
  }
  if (!missing) console.log("  ok  every endpoint the extension fetches is allowed by its manifest");
}

// ---- the popup's overrides still target things that exist
//
// popup.css is the extension's only difference from the website, and it
// rots invisibly: after the terminal redesign it still carried ten rules
// for a layout that was gone (.qcard, .vbody, .stamp-row) and two that
// still matched and fought the new one — a 34-pixel glow behind a verdict
// the design had deliberately flattened.
//
// Checked against the classes the app CAN emit, not against one rendered
// page: half of these are states a slip only reaches sometimes — an
// incomplete check, a second visit, a used calculator — and a page-based
// check would call every one of them dead.
console.log("cli: the extension's popup overrides");
{
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("extension/popup.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const emitted = readFileSync("site/src/app.ts", "utf8") + readFileSync("site/index.html", "utf8");
  const selectors = [...new Set(
    css.split("}").map((b) => b.split("{")[0].trim()).filter(Boolean)
      .flatMap((s) => s.split(",").map((x) => x.trim()))
      .filter((s) => s && !s.startsWith("@")),
  )];
  let dead = 0;
  for (const sel of selectors) {
    const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    // A selector with no class (body, header, footer) is an element that
    // always exists; nothing to check.
    if (!classes.length) continue;
    const missing = classes.filter((c) => !new RegExp(`\\b${c}\\b`).test(emitted));
    if (missing.length) {
      fail(`popup.css styles ".${missing.join(', .')}" (in "${sel}"), which the app never emits any more`);
      dead++;
    }
  }
  if (!dead) console.log(`  ok  all ${selectors.length} popup overrides target something the app can render`);
}

// ---- the extension sends a page's token to the chain that page is about
//
// The popup and the badge each used to keep a host table, and they disagreed:
// the popup sent every page it did not recognise to Robinhood Chain, so a Base
// token page produced a confident verdict about a different contract, and a
// Solana mint produced nothing. Both now read one table from the core, which
// is generated into extension/page-subject.js — so this checks the SHIPPED
// file rather than the source, and checks it by asking it questions.
console.log("cli: the extension reads a page's chain from its URL");
{
  const { readFileSync } = await import("node:fs");
  const before = globalThis.__bouncerPageSubject;
  await import("../extension/page-subject.js");
  const read = globalThis.__bouncerPageSubject;
  globalThis.__bouncerPageSubject = before;
  if (typeof read !== "function") fail("the built page-subject.js does not define __bouncerPageSubject");
  else {
    const EVM = "0x532f27101965dd16442e59d40670faf5ebb142e4";
    const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const cases = [
      [`https://basescan.org/token/${EVM}`, "base", EVM],
      [`https://www.basescan.org/token/${EVM}`, "base", EVM],
      [`https://base.blockscout.com/token/${EVM}`, "base", EVM],
      [`https://bscscan.com/token/${EVM}`, "bnb", EVM],
      [`https://robinhoodchain.blockscout.com/token/${EVM}`, "robinhood", EVM],
      [`https://testnet.arcscan.app/token/${EVM}`, "arc-testnet", EVM],
      [`https://dexscreener.com/base/${EVM}`, "base", EVM],
      [`https://dexscreener.com/bsc/${EVM}`, "bnb", EVM],
      [`https://solscan.io/token/${MINT}`, "solana", MINT],
      [`https://gmgn.ai/sol/token/${MINT}`, "solana", MINT],
      // A page on a host nobody mapped, and a mapped host with nothing on it.
      [`https://example.com/token/${EVM}`, null, null],
      ["https://basescan.org/blocks", null, null],
      // An EVM address on a Solana page is not a Solana mint, and the reverse
      // is not an EVM address: neither may be answered on the other's chain.
      [`https://solscan.io/token/${EVM}`, null, null],
      [`https://basescan.org/token/${MINT}`, null, null],
    ];
    let wrong = 0;
    for (const [url, chain, address] of cases) {
      const got = read(url);
      const gotChain = got?.chain ?? null;
      const gotAddress = got?.address ?? null;
      if (gotChain !== chain || (address && gotAddress !== address.toLowerCase() && gotAddress !== address)) {
        fail(`${url} read as ${gotChain ?? "nothing"}/${gotAddress ?? "nothing"}, expected ${chain ?? "nothing"}/${address ?? "nothing"}`);
        wrong++;
      }
    }
    // Every page the badge is injected into must be a page it can answer for.
    // A match pattern with no chain behind it puts a script on somebody's site
    // for nothing, which is exactly the permission a reviewer asks about.
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    for (const pattern of manifest.content_scripts?.[0]?.matches ?? []) {
      const host = pattern.replace(/^https:\/\//, "").replace(/\/\*$/, "");
      if (/\*/.test(host)) { fail(`a content script match with a wildcard host: ${pattern}`); wrong++; continue; }
      // Both address shapes, because a Solana host answers only for a base58
      // mint and an EVM host only for twenty bytes. The first probe asked with
      // an EVM address alone and reported solscan.io as unmappable, which was
      // the probe being wrong about the extension rather than the other way
      // round.
      const probe = [`${host}/base/token/${EVM}`, `${host}/sol/token/${MINT}`, `${host}/token/${EVM}`, `${host}/token/${MINT}`]
        .map((path) => read(`https://${path}`))
        .find(Boolean);
      if (!probe) { fail(`the badge is injected into ${host}, which the shared table cannot name a chain for`); wrong++; }
    }
    if (!wrong) console.log(`  ok  ${cases.length} page URLs resolve to the right chain, and every injected page resolves to one`);
  }
}

if (failures) {
  console.error(`\ncli: ${failures} problem${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("cli: every command answers, and every chain serves exactly what it says it can");
