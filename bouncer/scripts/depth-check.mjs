/**
 * How many round trips deep is a door check?
 *
 * Wall time on a real chain is round-trip depth times the round trip. Depth
 * is the part this codebase controls; the round trip belongs to whoever runs
 * the node. Every performance guess in this project that was made by reading
 * the code was wrong, and every correct one came from an instrument — but the
 * instruments so far all needed the network, and the network is a twenty
 * minute round trip through CI. So: the demo chain, with an artificial cost
 * bolted onto every HTTP request.
 *
 * Give each request a fixed delay. Then simulated wall time divided by that
 * delay IS the depth of the longest chain of requests that had to wait for
 * each other. Requests that run in parallel cost one delay between them; two
 * that run one after the other cost two. No network, no flakes, and the
 * number moves the moment the code does.
 *
 *   node scripts/depth-check.mjs [delayMs]
 *
 * It measures the demo chain, not Base. The absolute milliseconds are made
 * up. The depth is real, and it is the thing worth lowering.
 */
import { BlockscoutClient } from "../dist/src/chain/blockscout.js";
import { RpcClient } from "../dist/src/chain/rpc.js";
import { CHAINS } from "../dist/src/chain/chains.js";
import { PONS_V2_FACTORY } from "../dist/src/chain/pons.js";
import { DEMO_BLOCKSCOUT, DEMO_PLAIN, demoBlockscoutFetch, demoFetch } from "../dist/src/bouncer/demo.js";
import { readDoor } from "../dist/src/bouncer/door.js";

const DELAY = Number(process.argv[2] ?? 100);

/** Wraps a fetch so every request costs DELAY ms and is counted. */
function slow(inner, tally, kind) {
  return async (url, init) => {
    tally.requests++;
    const at = Date.now() - tally.started;
    let label;
    if (kind === "rpc") {
      const body = JSON.parse(String(init?.body));
      const items = Array.isArray(body) ? body : [body];
      label = items.length === 1 ? items[0].method : `${items[0].method} ×${items.length}`;
    } else {
      label = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    }
    tally.timeline.push({ at, kind, label });
    await new Promise((resolve) => setTimeout(resolve, DELAY));
    return inner(url, init);
  };
}

const SLOW_SECTIONS = { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true };
/** What the page's FIRST render asks for: the chain, and only the chain. */
const OPENING_SECTIONS = { ...SLOW_SECTIONS, skipMarket: true, skipExplorer: true, skipProbes: true };

async function pass(label, extra, spacingMs = 0) {
  const tally = { requests: 0, timeline: [], started: Date.now() };
  const rpc = new RpcClient({
    urls: ["demo://robinhood-chain"],
    expectedChainId: CHAINS.robinhood.chainId,
    fetchImpl: slow(demoFetch(), tally, "rpc"),
    minSpacingMs: spacingMs,
  });
  const blockscout = new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: slow(demoBlockscoutFetch(), tally, "explorer") });
  const started = Date.now();
  tally.started = started;
  await readDoor(rpc, DEMO_PLAIN.token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    blockscout,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    ...extra,
  });
  const ms = Date.now() - started;
  // Depth is what the number is for; the fraction is scheduler noise.
  const depth = ms / DELAY;
  console.log(`${label.padEnd(34)} ${tally.requests.toString().padStart(4)} requests · depth ${depth.toFixed(1)} · ${ms} ms at ${DELAY} ms/request`);
  if (process.env.TIMELINE) {
    // Grouped by the step they started in: everything in one group ran at
    // once, and the number of groups is the depth.
    const groups = new Map();
    for (const item of tally.timeline) {
      const step = Math.round(item.at / DELAY);
      if (!groups.has(step)) groups.set(step, []);
      groups.get(step).push(`${item.kind === "explorer" ? "explorer " : ""}${item.label}`);
    }
    for (const [step, items] of [...groups].sort((a, b) => a[0] - b[0])) {
      console.log(`   ${String(step).padStart(3)}  ${items.length > 1 ? `${items.length}× ` : "    "}${items.join(", ")}`);
    }
  }
  return depth;
}

/**
 * The ceilings. Not targets — a line in the sand, so a change that quietly
 * puts an await back in front of a batch is caught here and not by a reader
 * three weeks from now watching a spinner.
 */
const CEILING = { opening: 6, fast: 10, full: 14 };

const opening = await pass("opening pass (first thing on screen)", OPENING_SECTIONS);
const fast = await pass("fast pass (what the reader waits for)", SLOW_SECTIONS);
const full = await pass("full pass", { skipDev: true });
// What the client's own rate-limit spacing adds on top of the depth. The
// site sets 120 ms between requests to keep public endpoints from refusing
// it; that protection is not free and the bill is worth reading.
if (process.env.SPACING) await pass(`fast pass, ${process.env.SPACING} ms spacing`, SLOW_SECTIONS, Number(process.env.SPACING));

let failed = false;
for (const [label, depth, ceiling] of [["opening pass", opening, CEILING.opening], ["fast pass", fast, CEILING.fast], ["full pass", full, CEILING.full]]) {
  if (depth > ceiling) {
    console.error(`depth: ${label} is ${depth.toFixed(1)} round trips deep, over its ceiling of ${ceiling}. Something that could share a batch is waiting its turn.`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`depth: under the ceilings (opening ${CEILING.opening}, fast ${CEILING.fast}, full ${CEILING.full})`);
