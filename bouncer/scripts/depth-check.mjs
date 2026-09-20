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
      // Calls, not just requests. A round trip carrying forty eth_calls is
      // one request and forty EVM executions, and on a real node the second
      // number is the one that costs seconds — measured on Robinhood Chain,
      // 86 eth_calls in the fast pass, 8.3 s, and only two log reads.
      tally.calls += items.length;
      for (const item of items) tally.byMethod.set(item.method, (tally.byMethod.get(item.method) ?? 0) + 1);
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

async function pass(label, extra, spacingMs = 0, shared = null) {
  const tally = shared?.tally ?? { requests: 0, calls: 0, byMethod: new Map(), timeline: [], started: Date.now() };
  const rpc =
    shared?.rpc ??
    new RpcClient({
      urls: ["demo://robinhood-chain"],
      expectedChainId: CHAINS.robinhood.chainId,
      fetchImpl: slow(demoFetch(), tally, "rpc"),
      minSpacingMs: spacingMs,
    });
  const blockscout = shared?.blockscout ?? new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: slow(demoBlockscoutFetch(), tally, "explorer") });
  const started = Date.now();
  if (!shared) tally.started = started;
  const before = tally.requests;
  const beforeCalls = tally.calls;
  const beforeByMethod = new Map(tally.byMethod);
  await readDoor(rpc, DEMO_PLAIN.token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    blockscout,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    ...extra,
    ...(shared?.at ? { at: shared.at } : {}),
  });
  const ms = Date.now() - started;
  // Depth is what the number is for; the fraction is scheduler noise.
  const depth = ms / DELAY;
  console.log(
    `${label.padEnd(34)} ${(tally.requests - before).toString().padStart(4)} requests · ${(tally.calls - beforeCalls).toString().padStart(4)} calls · depth ${depth.toFixed(1)} · ${ms} ms at ${DELAY} ms/request`,
  );
  if (process.env.CALLS) {
    for (const [method, n] of [...tally.byMethod].map(([m, n]) => [m, n - (beforeByMethod.get(m) ?? 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}× ${method}`);
    }
  }
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
const CEILING = { opening: 6, fast: 10, full: 14, staged: 9 };

const opening = await pass("opening pass (first thing on screen)", OPENING_SECTIONS);
const fast = await pass("fast pass (what the reader waits for)", SLOW_SECTIONS);
const full = await pass("full pass", { skipDev: true });
// What the client's own rate-limit spacing adds on top of the depth. The
// site sets 120 ms between requests to keep public endpoints from refusing
// it; that protection is not free and the bill is worth reading.
if (process.env.SPACING) await pass(`fast pass, ${process.env.SPACING} ms spacing`, SLOW_SECTIONS, Number(process.env.SPACING));

// What the page actually does: all three passes, one client, one block. The
// three numbers above are each measured from cold; this is the bill a reader
// pays for the whole staged read, and the question is whether the two extra
// renders cost anything worth having.
{
  const tally = { requests: 0, calls: 0, byMethod: new Map(), timeline: [], started: Date.now() };
  const rpc = new RpcClient({
    urls: ["demo://robinhood-chain"],
    expectedChainId: CHAINS.robinhood.chainId,
    fetchImpl: slow(demoFetch(), tally, "rpc"),
    minSpacingMs: 0,
    memo: true,
  });
  // And one explorer client, memoizing, for the same reason.
  const blockscout = new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: slow(demoBlockscoutFetch(), tally, "explorer"), memo: true });
  const at = await rpc.head();
  const shared = { rpc, tally, at, blockscout };
  console.log("\nall three at once, one client, one block — what a reader actually waits through:");
  // Together, because that is what the page does. Running them one after
  // the other here would measure a version of the code that no longer
  // exists, which is the failure mode this whole file was built against.
  const started = Date.now();
  const marks = {};
  await Promise.all(
    [
      ["something on screen", OPENING_SECTIONS],
      ["a verdict", SLOW_SECTIONS],
      ["the whole slip", { skipDev: true }],
    ].map(async ([label, extra]) => {
      await pass(`  ${label}`, extra, 0, shared);
      marks[label] = (Date.now() - started) / DELAY;
    }),
  );
  const total = (Date.now() - tally.started) / DELAY;
  console.log(
    `  cumulative depth: ${marks["something on screen"].toFixed(1)} to the first render, ${marks["a verdict"].toFixed(1)} to the verdict, ${marks["the whole slip"].toFixed(1)} to the end`,
  );
  console.log(`  ${tally.requests} requests in all · ${rpc.memoHits} chain reads and ${blockscout.memoHits} explorer reads shared instead of asked again`);
  if (total > CEILING.staged) {
    console.error(`depth: the staged read is ${total.toFixed(1)} round trips deep, over its ceiling of ${CEILING.staged}.`);
    process.exit(1);
  }
  console.log(`depth: the staged read is under its ceiling of ${CEILING.staged}`);
}

let failed = false;
for (const [label, depth, ceiling] of [["opening pass", opening, CEILING.opening], ["fast pass", fast, CEILING.fast], ["full pass", full, CEILING.full]]) {
  if (depth > ceiling) {
    console.error(`depth: ${label} is ${depth.toFixed(1)} round trips deep, over its ceiling of ${ceiling}. Something that could share a batch is waiting its turn.`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`depth: under the ceilings (opening ${CEILING.opening}, fast ${CEILING.fast}, full ${CEILING.full})`);
