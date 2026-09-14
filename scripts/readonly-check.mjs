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

const offenders = [];
for (const file of walk("src")) {
  const text = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    // The RPC client names the methods it refuses; that allow-list is the one exception.
    if (text.includes(needle) && !file.endsWith("chain/rpc.ts") && !file.endsWith("chain/rpc.js")) {
      offenders.push(`${file}: ${needle}`);
    }
  }
}

if (offenders.length) {
  console.error("read-only check failed:\n" + offenders.join("\n"));
  process.exit(1);
}
console.log(`read-only check passed: ${walk("src").length} source files, no signing primitives`);
