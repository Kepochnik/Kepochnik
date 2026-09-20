import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256Hex } from "../src/chain/keccak.js";
import { eventTopic, selector } from "../src/chain/abi.js";
import { FACTORY_EVENTS } from "../src/chain/pons.js";
import { readTapeAdaptive } from "../src/chain/tape.js";
import { RpcClient } from "../src/chain/rpc.js";
import { ROBINHOOD_CHAIN_ID } from "../src/chain/pons.js";

test("keccak vectors", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(selector("balanceOf(address)"), "0x70a08231");
  assert.equal(eventTopic(FACTORY_EVENTS.SnipeTaxStartBpsUpdated), keccak256Hex("SnipeTaxStartBpsUpdated(uint256)"));
});

test("the rpc client refuses anything that is not a read", async () => {
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: (async () => new Response("{}")) as typeof fetch });
  await assert.rejects(rpc.send("eth_sendRawTransaction", ["0x"]), /refusing non-read method/);
  await assert.rejects(rpc.send("eth_accounts", []), /refusing non-read method/);
});

test("adaptive chunking narrows fast on a range error and never invents a gap", async () => {
  const seen: [number, number][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    const to = Number(BigInt(req.params[0].toBlock));
    if (to - from + 1 > 4_000) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "block range too wide" } }));
    seen.push([from, to]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });
  const tape = await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 9_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 16_000, minChunk: 1_000, maxChunk: 16_000 });
  assert.equal(tape.logs.length, 0);
  assert.equal(tape.complete, true);
  // The opening guess is refused, so the span narrows until it fits. What
  // matters is that it lands under the endpoint's limit and never skips a
  // block; the step it takes getting there is a tuning choice — eighths now,
  // because halving from a wide guess spends a dozen refusals reaching the
  // first useful request.
  assert.equal(seen[0][0], 0);
  assert.ok(seen[0][1] - seen[0][0] + 1 <= 4_000, "the first successful span must fit the endpoint's limit");
  assert.equal(seen[seen.length - 1][1], 9_999, "the window is covered to its end");
  let cursor = 0;
  for (const [from, to] of seen) {
    assert.equal(from, cursor, "chunks are contiguous");
    cursor = to + 1;
  }
});

test("a walk that reads nothing is an error; one that reads something keeps it", async () => {
  // Refused from the first request: there is no answer to give, so this must
  // be an error rather than a confident empty tape.
  const alwaysNo = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no" } }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: alwaysNo, rateLimitRetries: 0 });
  await assert.rejects(readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 99, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 100, minChunk: 50 }), /no/);

  // Refused only once it is deep into the window: throwing here would discard
  // every log already paid for, which on Base meant sixty-three seconds of
  // reading dropped in order to report nothing.
  let answered = 0;
  const failsLater = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: [{ fromBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    if (from >= 50) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no" } }));
    answered++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc2 = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: failsLater, rateLimitRetries: 0 });
  const tape = await readTapeAdaptive(rpc2, { fromBlock: 0, toBlock: 199, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 50, minChunk: 50 });
  assert.ok(answered > 0);
  assert.equal(tape.complete, false, "a walk cut short must say so");
  assert.ok(tape.toBlock < 199, "and must report how far it actually got");
});

test("the memo remembers a pinned read and never remembers a moving one", async () => {
  // The page reads one token three times so a reader sees something true
  // early. Pinned to one block those passes ask the same questions, and
  // asking again is pure waste — but "latest" is the one thing a cache can
  // never be right about, so it has to go out every time.
  const sent: { method: string; params: unknown[] }[] = [];
  const rpc = new RpcClient({
    urls: ["https://node.invalid"],
    expectedChainId: 1,
    memo: true,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const items = Array.isArray(body) ? body : [body];
      for (const item of items) sent.push({ method: item.method, params: item.params });
      const answer = (m: string) => (m === "eth_chainId" ? "0x1" : m === "eth_getBlockByNumber" ? { number: "0x10", timestamp: "0x20", hash: "0xabc" } : "0x2a");
      const out = items.map((item) => ({ jsonrpc: "2.0", id: item.id, result: answer(item.method) }));
      return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });

  await rpc.getCode("0xabc", 16);
  await rpc.getCode("0xabc", 16);
  await rpc.getCode("0xabc", 17);
  assert.equal(sent.filter((s) => s.method === "eth_getCode").length, 2, "the same code at the same block is asked for once");

  sent.length = 0;
  await rpc.getBlock("latest");
  await rpc.getBlock("latest");
  assert.equal(sent.filter((s) => s.method === "eth_getBlockByNumber").length, 2, "'latest' must never come out of a cache");

  // A batch where some slots are known sends only the rest, and the answers
  // still line up with the calls that asked for them.
  sent.length = 0;
  const [a, b] = await rpc.callBatch([{ to: "0x1", data: "0xaa" }, { to: "0x2", data: "0xbb" }], 16);
  const before = sent.length;
  const [c, d] = await rpc.callBatch([{ to: "0x1", data: "0xaa" }, { to: "0x3", data: "0xcc" }], 16);
  assert.equal(a, c, "the repeated call gives the same answer");
  assert.equal(b, d, "and the new one is still answered");
  assert.equal(sent.length - before, 1, "only the call nobody had asked before goes out");
  assert.ok(rpc.memoHits >= 2, `the memo should report its hits; got ${rpc.memoHits}`);
});

test("a client without the memo asks every time, which is the default", async () => {
  let sent = 0;
  const rpc = new RpcClient({
    urls: ["https://node.invalid"],
    expectedChainId: 1,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      sent++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2a" }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  await rpc.getCode("0xabc", 16);
  await rpc.getCode("0xabc", 16);
  assert.equal(sent, 2, "memory that outlives one read would answer the next paste off the last one's chain");
});

test("the log walk fans out once a span is proven, and still never invents a gap", async () => {
  // A window is a queue only until the endpoint has answered one span. After
  // that, every remaining span is the same question already answered, and
  // asking them one at a time is what made the full pass nineteen seconds
  // against a chain answering in under two hundred milliseconds.
  const rounds: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: [{ fromBlock: string; toBlock: string }] };
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    rounds.push(Number(BigInt(req.params[0].fromBlock)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });
  const tape = await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 9_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 1_000, minChunk: 1_000, maxChunk: 1_000, lanes: 6 });
  assert.equal(tape.complete, true);
  assert.equal(rounds.length, 10, "every block of the window is still read exactly once");
  assert.ok(peak > 1, `spans must overlap once one is proven; peak in flight was ${peak}`);
});

test("a span that fails in the middle of a fan-out is a gap, not a skip", async () => {
  // The contract this file is built on: what was not read is reported as not
  // read. A parallel round makes that easy to get wrong — chunk 1 and chunk 3
  // can come back while chunk 2 fails, and keeping 3 would silently drop the
  // blocks in between.
  const served: [number, number][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: [{ fromBlock: string; toBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    const to = Number(BigInt(req.params[0].toBlock));
    // Everything from block 3000 on is refused at any width.
    if (from >= 3_000) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "block range too wide" } }));
    served.push([from, to]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });
  const tape = await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 9_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 1_000, minChunk: 1_000, maxChunk: 1_000, lanes: 6 });
  assert.equal(tape.complete, false, "a window that could not be finished says so");
  assert.equal(tape.toBlock, 2_999, "and says exactly how far it got");
  assert.ok(served.every(([from]) => from < 3_000));
});

test("a refused log span is learned once, not rediscovered by every walk", async () => {
  // Measured on Base: five refused requests at about 2.4 seconds each, and
  // the walk before them had just been taught the same limit. Twelve
  // seconds of a reader's wait spent learning a known thing twice.
  const spans: number[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ fromBlock: string; toBlock: string }] };
    const from = Number(BigInt(req.params[0].fromBlock));
    const to = Number(BigInt(req.params[0].toBlock));
    spans.push(to - from + 1);
    if (to - from + 1 > 1_000) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "exceed maximum block range: 1000" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });

  await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 3_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 64_000, minChunk: 500, maxChunk: 64_000 });
  const firstWalk = spans.length;
  assert.ok(spans.includes(4_000), "the first walk still has to discover the limit");
  assert.ok(rpc.logSpanCeiling() !== null, "and the client remembers what it cost");

  spans.length = 0;
  await readTapeAdaptive(rpc, { fromBlock: 10_000, toBlock: 13_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 64_000, minChunk: 500, maxChunk: 64_000 });
  assert.ok(spans.every((s) => s <= 1_000), `the second walk must not reopen a refused span; asked for ${spans.join(", ")}`);
  assert.ok(spans.length < firstWalk, `and should cost fewer requests than the first (${spans.length} vs ${firstWalk})`);
});

test("being served a narrow span is not evidence that a wide one would be refused", async () => {
  // The first version of the lesson above capped every later walk at the
  // widest span that had been SERVED — but a caller that asked for a
  // thousand blocks and got them has learned nothing about ten thousand,
  // and treating it as a limit made every walk after it needlessly narrow.
  const spans: number[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; params: [{ fromBlock: string; toBlock: string }] };
    spans.push(Number(BigInt(req.params[0].toBlock)) - Number(BigInt(req.params[0].fromBlock)) + 1);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["demo://x"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl });
  await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 99, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 100, minChunk: 100, maxChunk: 100 });
  assert.equal(rpc.logSpanCeiling(), null, "nothing was refused, so nothing is capped");
  spans.length = 0;
  await readTapeAdaptive(rpc, { fromBlock: 0, toBlock: 49_999, events: [FACTORY_EVENTS.TokenLaunched] }, { startChunk: 50_000, minChunk: 1_000, maxChunk: 50_000 });
  assert.deepEqual(spans, [50_000], "the wide walk is still allowed to open wide");
});

test("one dead endpoint costs one timeout, not a walk round the list four times", async () => {
  // Where a 14.4-second door came from on a site whose median is four.
  // The retry budget was urls × (rateLimitRetries + 1) — eight attempts
  // over two endpoints — and each attempt could hold the line for the full
  // fifteen-second timeout. Two minutes for one logical read.
  //
  // A transport failure and a rate limit are different things. An endpoint
  // that did not answer is worth trying its neighbour once; walking the
  // list again learns nothing and costs the timeout each pass.
  let attempts = 0;
  const rpc = new RpcClient({
    urls: ["https://a.invalid", "https://b.invalid"],
    expectedChainId: ROBINHOOD_CHAIN_ID,
    minSpacingMs: 0,
    fetchImpl: (async () => {
      attempts++;
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => rpc.getCode("0xabc", 16), /socket hang up/);
  assert.equal(attempts, 2, `each endpoint is asked once and no more; got ${attempts}`);
});

test("a read gives up on the clock, whatever the endpoint list is doing", async () => {
  // The only bound that holds when one attempt can cost seconds. Without
  // it a long list of slow endpoints multiplies out, and the number nobody
  // is watching is the product.
  const rpc = new RpcClient({
    urls: ["https://slow1.invalid", "https://slow2.invalid", "https://slow3.invalid", "https://slow4.invalid"],
    expectedChainId: ROBINHOOD_CHAIN_ID,
    minSpacingMs: 0,
    timeoutMs: 250,
    requestBudgetMs: 400,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
  });
  const started = Date.now();
  await assert.rejects(() => rpc.getCode("0xabc", 16));
  const spent = Date.now() - started;
  assert.ok(spent < 1_200, `the budget is 400 ms across four endpoints; the read took ${spent} ms`);
});
