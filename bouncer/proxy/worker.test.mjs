import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "./worker.mjs";

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
