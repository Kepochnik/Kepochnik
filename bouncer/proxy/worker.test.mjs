import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_ONLY_METHODS, SOLANA_READ_ONLY_METHODS, UPSTREAMS, handle } from "./worker.mjs";
import { READ_ONLY_METHODS as CLIENT_METHODS } from "../dist/src/chain/rpc.js";
import { SOLANA_READ_ONLY_METHODS as CLIENT_SOLANA_METHODS } from "../dist/src/chain/solana.js";

const upstreams = { demo: { rpc: "https://rpc.demo.invalid", api: "https://api.demo.invalid" } };
const seen = [];
const fetchImpl = async (input, init) => {
  seen.push({ input: String(input), init });
  return new Response(JSON.stringify({ ok: true, echo: init?.body ? JSON.parse(init.body) : null }), { status: 200 });
};

test("health lists chains and methods", async () => {
  const r = await handle(new Request("https://p.invalid/"), upstreams, fetchImpl);
  const b = await r.json();
  assert.deepEqual(b.chains, ["demo"]);
  assert.ok(b.methods.includes("eth_call"));
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("preflight is answered with CORS and no body", async () => {
  const r = await handle(new Request("https://p.invalid/rpc/demo", { method: "OPTIONS" }), upstreams, fetchImpl);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
});

test("read-only methods are forwarded, batches included", async () => {
  seen.length = 0;
  const body = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{}] }]);
  const r = await handle(new Request("https://p.invalid/rpc/demo", { method: "POST", body }), upstreams, fetchImpl);
  assert.equal(r.status, 200);
  assert.equal(seen[0].input, "https://rpc.demo.invalid");
  assert.equal(seen[0].init.body, body);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("anything that could sign or send is refused before it leaves", async () => {
  seen.length = 0;
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_accounts"]) {
    const r = await handle(new Request("https://p.invalid/rpc/demo", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params: [] }) }), upstreams, fetchImpl);
    assert.equal(r.status, 403, method);
    const b = await r.json();
    assert.equal(b.error.code, -32601);
  }
  assert.equal(seen.length, 0, "nothing reached the upstream");
});

test("bad input: unknown chain, parse error, oversized batch, GET on rpc", async () => {
  assert.equal((await handle(new Request("https://p.invalid/rpc/nope", { method: "POST", body: "{}" }), upstreams, fetchImpl)).status, 404);
  assert.equal((await handle(new Request("https://p.invalid/rpc/demo", { method: "POST", body: "not json" }), upstreams, fetchImpl)).status, 400);
  const big = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] })));
  assert.equal((await handle(new Request("https://p.invalid/rpc/demo", { method: "POST", body: big }), upstreams, fetchImpl)).status, 400);
  assert.equal((await handle(new Request("https://p.invalid/rpc/demo"), upstreams, fetchImpl)).status, 405);
});

test("explorer routes: only the three the site uses, query string kept", async () => {
  seen.length = 0;
  const ok = await handle(new Request("https://p.invalid/api/demo/api/v2/search?q=SPRINT"), upstreams, fetchImpl);
  assert.equal(ok.status, 200);
  assert.equal(seen[0].input, "https://api.demo.invalid/api/v2/search?q=SPRINT");
  const denied = await handle(new Request("https://p.invalid/api/demo/api/v2/tokens"), upstreams, fetchImpl);
  assert.equal(denied.status, 403);
  const noApi = await handle(new Request("https://p.invalid/api/other/api/v2/search?q=x"), upstreams, fetchImpl);
  assert.equal(noApi.status, 404);
});

test("solana speaks its own read list, and neither list widens the other", async () => {
  const upstreams = {
    solana: { rpc: "https://solana.invalid", api: null, family: "solana" },
    base: { rpc: "https://base.invalid", api: "https://base.blockscout.invalid" },
  };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: init?.body });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { headers: { "content-type": "application/json" } });
  };
  const post = (chain, method) =>
    handle(new Request(`https://proxy.invalid/rpc/${chain}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) }), upstreams, fetchImpl);

  assert.equal((await post("solana", "getAccountInfo")).status, 200);
  assert.equal((await post("solana", "getTokenLargestAccounts")).status, 200);
  // An EVM method must not be smuggled through the Solana route, nor the reverse.
  assert.equal((await post("solana", "eth_call")).status, 403);
  assert.equal((await post("base", "getAccountInfo")).status, 403);
  assert.equal((await post("base", "eth_call")).status, 200);
  // And nothing that writes, on either.
  for (const method of ["sendTransaction", "requestAirdrop", "eth_sendRawTransaction", "eth_sign"]) {
    assert.equal((await post("solana", method)).status, 403, method);
    assert.equal((await post("base", method)).status, 403, method);
  }
});

test("a blocked or rate-limited endpoint costs a request, not the chain", async () => {
  const upstreams = { solana: { rpc: ["https://blocked.invalid", "https://limited.invalid", "https://good.invalid"], api: null, family: "solana" } };
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (url.startsWith("https://blocked")) return new Response(JSON.stringify({ error: { code: 403, message: "Your IP or provider is blocked" } }), { status: 403 });
    if (url.startsWith("https://limited")) return new Response(JSON.stringify({ error: { code: -32005, message: "Rate limit exceeded" } }), { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 12345 }), { status: 200 });
  };
  const post = () => handle(new Request("https://p.invalid/rpc/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }) }), upstreams, fetchImpl);

  const ok = await post();
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(await ok.text()).result, 12345);
  assert.deepEqual(tried, ["https://blocked.invalid", "https://limited.invalid", "https://good.invalid"]);
  assert.equal(ok.headers.get("x-bouncer-upstream"), "https://good.invalid", "the answer should say which endpoint gave it");
});

test("an endpoint that throws is skipped, and a chain where everybody says no reports the real reason", async () => {
  const upstreams = { solana: { rpc: ["https://dead.invalid", "https://blocked.invalid"], api: null, family: "solana" } };
  const fetchImpl = async (url) => {
    if (url.startsWith("https://dead")) throw new TypeError("network error");
    return new Response(JSON.stringify({ error: { code: 403, message: "Your IP or provider is blocked" } }), { status: 403 });
  };
  const res = await handle(new Request("https://p.invalid/rpc/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }) }), upstreams, fetchImpl);
  assert.equal(res.status, 403);
  // Not a made-up message: the last upstream's own words, so the reason is legible.
  assert.match(await res.text(), /blocked/);
});

test("a single-string rpc still works, so one endpoint needs no list", async () => {
  const upstreams = { base: { rpc: "https://only.invalid", api: null } };
  const res = await handle(new Request("https://p.invalid/rpc/base", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }), upstreams, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }), { status: 200 }));
  assert.equal(res.status, 200);
});

test("the explorer is cached for a few seconds, and says how old the answer is", async () => {
  // The measured reason this exists: on Robinhood Chain the chain answered
  // every request in under 160 ms while one /api/v2/addresses read took 3.2
  // seconds. Caching it is the difference between a three-second wait and
  // none — but a cache that hides its age would be lying, so it does not.
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ creator_address_hash: "0xdead" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const store = new Map();
  const cacheImpl = {
    match: async (request) => {
      const hit = store.get(request.url);
      return hit ? new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) }) : undefined;
    },
    put: async (request, response) => {
      store.set(request.url, { body: await response.text(), status: response.status, headers: [...response.headers] });
    },
  };

  const url = "https://proxy.invalid/api/robinhood/api/v2/addresses/0x39dbed3a2bd333467115de45665cc57f813c4571";
  const first = await handle(new Request(url), UPSTREAMS, fetchImpl, cacheImpl);
  assert.equal(first.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(first.headers.get("x-bouncer-age"), "0");
  assert.match(first.headers.get("cache-control") ?? "", /max-age=\d+/);

  const second = await handle(new Request(url), UPSTREAMS, fetchImpl, cacheImpl);
  assert.equal(upstreamCalls, 1, "the second read must not reach the explorer");
  assert.equal(JSON.parse(await second.text()).creator_address_hash, "0xdead");
  assert.ok(second.headers.has("x-bouncer-age"), "a cached answer has to say how old it is");
});

test("a refused explorer answer is never cached", async () => {
  // One 429 kept for ten seconds turns a single refusal into a wave of them,
  // and a cached 404 would tell everybody a token does not exist.
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls++;
    return new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
  };
  const store = new Map();
  const cacheImpl = {
    match: async (request) => {
      const hit = store.get(request.url);
      return hit ? new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) }) : undefined;
    },
    put: async (request, response) => {
      store.set(request.url, { body: await response.text(), status: response.status, headers: [...response.headers] });
    },
  };
  const url = "https://proxy.invalid/api/robinhood/api/v2/tokens/0x39dbed3a2bd333467115de45665cc57f813c4571/holders";
  await handle(new Request(url), UPSTREAMS, fetchImpl, cacheImpl);
  await handle(new Request(url), UPSTREAMS, fetchImpl, cacheImpl);
  assert.equal(upstreamCalls, 2, "a refusal is asked again, not remembered");
  assert.equal(store.size, 0);
});

test("the proxy works with no cache at all, which is how the tests and Node run it", async () => {
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const url = "https://proxy.invalid/api/robinhood/api/v2/tokens/0x39dbed3a2bd333467115de45665cc57f813c4571";
  const a = await handle(new Request(url), UPSTREAMS, fetchImpl, null);
  const b = await handle(new Request(url), UPSTREAMS, fetchImpl, null);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(upstreamCalls, 2);
});

test("the proxy allows everything the client can send", async () => {
  // Two lists in two languages, and neither may widen the other — that is
  // the point of keeping them apart. But nothing held the narrow one
  // against what the client actually sends, and a method allowed by the
  // client and refused here comes back as a 403 the client reads as a dead
  // endpoint: it rotates to a public node and every read after that pays a
  // wasted round trip, quietly, for as long as the drift lasts.
  const missing = [...CLIENT_METHODS].filter((m) => !READ_ONLY_METHODS.has(m));
  assert.deepEqual(missing, [], `the client sends these and the proxy refuses them: ${missing.join(", ")}`);
  const missingSol = [...CLIENT_SOLANA_METHODS].filter((m) => !SOLANA_READ_ONLY_METHODS.has(m));
  assert.deepEqual(missingSol, [], `the Solana client sends these and the proxy refuses them: ${missingSol.join(", ")}`);
});

test("the proxy is no wider than the client: it forwards nothing extra", async () => {
  // The other direction, which matters more. A method the proxy allows and
  // the client never sends is a hole somebody else can reach through — the
  // proxy is public, and its allow-list is the whole of its safety.
  const extra = [...READ_ONLY_METHODS].filter((m) => !CLIENT_METHODS.has(m));
  assert.deepEqual(extra, [], `the proxy allows these and nothing in BOUNCER needs them: ${extra.join(", ")}`);
});
