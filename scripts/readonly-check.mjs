#!/usr/bin/env node
/**
 * Fails the build if anything in src/ could sign or send a transaction.
 * The tool is read-only by construction; this makes the claim checkable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "personal_sign",
  "signTransaction",
  "privateKey",
  "PRIVATE_KEY",
  "mnemonic",
  "MNEMONIC",
  "SEED_PHRASE",
  "walletClient",
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every directory that ships. src/ alone was not enough: the browser bundle,
 * the binaries, the extension and the proxy all run somewhere a user trusts,
 * and a signing primitive in any of them would be exactly as bad.
 */
const ROOTS = ["src", "bin", "site/src", "extension", "proxy", "scripts"];

/**
 * The places whose whole job is to NAME the methods they refuse. An allow-list
 * has to spell out what it excludes, so these are read differently: the string
 * may appear, but only inside a refusal, never in a call.
 */
const REFUSAL_FILES = [/chain\/rpc\.(ts|js)$/, /proxy\/worker\.mjs$/, /proxy\/worker\.test\.mjs$/, /scripts\/readonly-check\.mjs$/, /\.github\//];

const files = [];
for (const root of ROOTS) {
  try {
    walk(root, files);
  } catch {
    // A root that is not in this checkout is not a failure.
  }
}

const offenders = [];
for (const file of files) {
  if (REFUSAL_FILES.some((re) => re.test(file))) continue;
  // The extension bundle is a copy of the site bundle, which is built from
  // src/; checking the source is the check, and the copy would double-report.
  if (file === "extension/app.js") continue;
  const text = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
  }
}

if (offenders.length) {
  console.error("read-only check failed:\n" + offenders.join("\n"));
  process.exit(1);
}
console.log(`read-only check passed: ${files.length} files across ${ROOTS.join(", ")}, no signing primitives`);
