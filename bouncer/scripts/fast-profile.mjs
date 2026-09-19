/**
 * What is still slow in the half that is supposed to be fast?
 *
 * The site renders the door twice: everything but the log scans, then the
 * whole thing. Measured against the live site that first render took 11 s on
 * Robinhood Chain and 23 s on Base — better than the 28 and 56 it replaced,
 * and nowhere near the two seconds the method profile said the non-log reads
 * cost. So something in the fast pass is still reading logs, and guessing
 * which is how an afternoon gets wasted.
 *
 *   node scripts/fast-profile.mjs <chain> <token>
 */
import { RpcClient } from "../dist/src/chain/rpc.js";
import { BlockscoutClient } from "../dist/src/chain/blockscout.js";
import { CHAINS } from "../dist/src/chain/chains.js";
import { readDoor } from "../dist/src/bouncer/door.js";

const [, , key = "base", token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"] = process.argv;
const chain = CHAINS[key];

/** The same flags the site uses for its first render. */
const SLOW = { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true };

for (const [label, slow] of [["fast pass (what the reader waits for)", true], ["full pass", false]]) {
  const rpc = new RpcClient({ urls: chain.rpc, expectedChainId: chain.chainId });
  // A fresh explorer client per pass, so its counters measure that pass.
  const blockscout = chain.blockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null;
  const options = { chain, factory: chain.factory || undefined, blockscout, ...(slow ? SLOW : {}) };
  const started = Date.now();
  try {
    const slip = await readDoor(rpc, token, options);
    console.log(`\n${label}: ${Date.now() - started} ms · ${slip.notes.length} notes`);
  } catch (error) {
    console.log(`\n${label}: threw after ${Date.now() - started} ms — ${error instanceof Error ? error.message : error}`);
  }
  let rpcMs = 0;
  for (const r of rpc.stats()) {
    rpcMs += r.ms;
    console.log(`  rpc ${r.method}: ${r.calls} calls, ${r.ms} ms, ${r.failures} failed`);
  }
  let bsMs = 0;
  for (const r of blockscout?.stats() ?? []) {
    bsMs += r.ms;
    console.log(`  explorer ${r.path}: ${r.calls} calls, ${r.ms} ms, ${r.failures} failed`);
  }
  // The line that matters. A wall time far above the sum of the calls means
  // the cost is somewhere nobody is counting, which is how the last four
  // wrong guesses happened.
  console.log(`  == rpc ${rpcMs} ms + explorer ${bsMs} ms = ${rpcMs + bsMs} ms of calls`);
}
