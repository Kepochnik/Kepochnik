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
 * Give each request a fixed delay and note when each one left and came
 * back. Then the depth is the longest chain of requests that had to wait for
 * each other: a request sits one level below the deepest request that had
 * already finished when it started. Requests that run together share a
 * level; two that run one after the other cost two. No network, no flakes,
 * and the number moves the moment the code does — see waves() for why it is
 * counted this way and not by the clock.
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
    const entry = { at, kind, label, done: 0 };
    tally.timeline.push(entry);
    await new Promise((resolve) => setTimeout(resolve, DELAY));
    entry.done = Date.now() - tally.started;
    return inner(url, init);
  };
}

/**
 * Depth, counted causally rather than by the clock.
 *
 * Dividing wall time by the delay was the first version and it is a biased
 * estimator: every request carries a little parsing and scheduling on top of
 * its artificial delay, that overhead accumulates down the chain, and the
 * fraction it adds is not depth. It showed: the same read measured 5.5 deep
 * at a 100 ms delay and 4.6 at 250 ms — a number that moves when you change
 * the ruler is measuring the ruler. Worse, under CPU load it reached 7.0 and
 * tripped a ceiling that no code change had gone near.
 *
 * So ask the question directly. A request is one level deeper than the
 * deepest request that had already FINISHED when it started — that is what
 * "had to wait for" means. Comparisons are local, so nothing accumulates,
 * and the answer is a whole number that only moves when an await does.
 */
function waves(items) {
  // A little slack: a request released by another's response starts a tick
  // or two after it, and a scheduler hiccup should not invent a level.
  const SLACK = Math.max(5, DELAY * 0.15);
  const sorted = [...items].sort((a, b) => a.at - b.at);
  let deepest = 0;
  for (const r of sorted) {
    let parent = 0;
    for (const p of sorted) {
      if (p === r) continue;
      if (p.done > 0 && p.done <= r.at + SLACK && p.wave > parent) parent = p.wave;
    }
    r.wave = parent + 1;
    if (r.wave > deepest) deepest = r.wave;
  }
  return deepest;
}

const SLOW_SECTIONS = { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true };
/** What the page's FIRST render asks for: the chain, and only the chain. */
const OPENING_SECTIONS = { ...SLOW_SECTIONS, skipMarket: true, skipExplorer: true, skipProbes: true, skipOwnerWallet: true };

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
  // Only this pass's own requests: with a shared client the tally holds the
  // other passes' too, and those are a different chain.
  const depth = waves(tally.timeline.slice(before));
  console.log(
    `${label.padEnd(34)} ${(tally.requests - before).toString().padStart(4)} requests · ${(tally.calls - beforeCalls).toString().padStart(4)} calls · ${String(depth).padStart(2)} deep · ${ms} ms at ${DELAY} ms/request`,
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
      const step = item.wave ?? Math.round(item.at / DELAY);
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
// One level of headroom each, no more. The old ceilings were slack because
// the old estimator was inflated and noisy and had to be given room for
// both; a whole number that does not move under load can be held to the
// thing it measures. One re-serialised await shows up here.
const CEILING = { opening: 4, fast: 8, full: 9, staged: 8, perLookalike: 0.25 };

/** Pads the explorer's token search with decoys carrying the queried ticker. */
function crowdedSearch(inner, extra) {
  if (extra <= 0) return inner;
  return async (url, init) => {
    const res = await inner(url, init);
    if (!String(url).includes("/api/v2/search")) return res;
    const body = await res.json();
    const symbol = new URL(String(url)).searchParams.get("q") ?? "";
    body.items = body.items ?? [];
    for (let i = 0; i < extra; i++) {
      body.items.push({ type: "token", address: `0x${(i + 1).toString(16).padStart(40, "d")}`, name: `Decoy ${i}`, symbol });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

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
      // Everything the shared client had FINISHED by the moment this render
      // landed: the causal chain a reader actually waited through.
      marks[label] = waves(tally.timeline.filter((r) => r.done > 0 && r.done <= Date.now() - tally.started));
    }),
  );
  const total = waves(tally.timeline);
  console.log(
    `  cumulative depth: ${marks["something on screen"]} to the first render, ${marks["a verdict"]} to the verdict, ${total} to the end`,
  );
  console.log(`  ${tally.requests} requests in all · ${rpc.memoHits} chain reads and ${blockscout.memoHits} explorer reads shared instead of asked again`);
  if (total > CEILING.staged) {
    console.error(`depth: the staged read is ${total} round trips deep, over its ceiling of ${CEILING.staged}.`);
    process.exit(1);
  }
  console.log(`depth: the staged read is under its ceiling of ${CEILING.staged}`);
}

// A ticker nobody else uses is the easy case, and it is the only one the
// demo chain had. "cashcat" on a real explorer comes back with a dozen
// addresses, and weighing them one after another made the wait grow with
// how popular the name is — the exact tokens a reader is most likely to
// paste. Measured here so the demo cannot hide it again: the slope, not the
// height, is the thing. Flat means the candidates are weighed together.
{
  console.log("\nwhen a ticker is crowded — the cost of each extra token sharing the name:");
  const depths = [];
  for (const sharing of [1, 8]) {
    const tally = { requests: 0, calls: 0, byMethod: new Map(), timeline: [], started: Date.now() };
    const rpc = new RpcClient({
      urls: ["demo://robinhood-chain"],
      expectedChainId: CHAINS.robinhood.chainId,
      fetchImpl: slow(demoFetch(), tally, "rpc"),
      minSpacingMs: 0,
    });
    const blockscout = new BlockscoutClient({
      baseUrl: DEMO_BLOCKSCOUT,
      fetchImpl: slow(crowdedSearch(demoBlockscoutFetch(), sharing - 1), tally, "explorer"),
    });
    depths.push(await pass(`  ${String(sharing).padStart(2)} tokens share the ticker`, { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true }, 0, { rpc, tally, blockscout }));
  }
  const slope = (depths[1] - depths[0]) / 7;
  console.log(`  ${slope.toFixed(2)} extra round trips per extra token sharing the name`);
  if (slope > CEILING.perLookalike) {
    console.error(`depth: each extra token sharing a ticker costs ${slope.toFixed(2)} round trips, over its ceiling of ${CEILING.perLookalike}. The candidates are being weighed one at a time.`);
    process.exit(1);
  }
  console.log(`depth: a crowded ticker is under its ceiling of ${CEILING.perLookalike} round trips per extra token`);
}

let failed = false;
for (const [label, depth, ceiling] of [["opening pass", opening, CEILING.opening], ["fast pass", fast, CEILING.fast], ["full pass", full, CEILING.full]]) {
  if (depth > ceiling) {
    console.error(`depth: ${label} is ${depth} round trips deep, over its ceiling of ${ceiling}. Something that could share a batch is waiting its turn.`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`depth: under the ceilings (opening ${CEILING.opening}, fast ${CEILING.fast}, full ${CEILING.full})`);
