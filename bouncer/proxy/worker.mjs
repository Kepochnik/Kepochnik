/**
 * BOUNCER proxy: a Cloudflare Worker (or any runtime with fetch/Request/
 * Response) that forwards read-only JSON-RPC to a chain's public endpoint
 * and adds the CORS headers browsers need. It is the smallest thing that
 * lets the hosted site read the chain when a public RPC refuses browser
 * requests. It cannot be used to send transactions: every method must be
 * on the read allow-list, batches are capped, and nothing is signed here.
 *
 *   POST /rpc/<chain>          JSON-RPC to that chain's RPC (EVM or Solana, each with its own read list)
 *   GET  /api/<chain>/<path>   Blockscout v2 GET, same path (funding sources, token search, holders, creator)
 *   GET  /                     health: the chains this proxy serves
 */
/**
 * Each chain lists several endpoints, tried in order. This is not belt and
 * braces: a Cloudflare Worker leaves from a shared pool of addresses that
 * public endpoints see a great deal of traffic from, so the polite ones rate
 * limit it (BNB's publicnode answered 429) and some refuse it outright
 * (Solana's api.mainnet-beta answered 403, "your IP or provider is blocked").
 * The CLI never sees this because it runs from an ordinary address. One
 * endpoint saying no must cost a request, not a chain.
 */
export const UPSTREAMS = {
  robinhood: { rpc: ["https://rpc.mainnet.chain.robinhood.com"], api: "https://robinhoodchain.blockscout.com" },
  base: { rpc: ["https://mainnet.base.org", "https://base.llamarpc.com", "https://base-rpc.publicnode.com", "https://base.drpc.org"], api: "https://base.blockscout.com" },
  bnb: { rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://binance.llamarpc.com", "https://bsc.drpc.org", "https://bsc-rpc.publicnode.com"], api: null },
  solana: { rpc: ["https://solana-rpc.publicnode.com", "https://solana.drpc.org", "https://api.mainnet-beta.solana.com"], api: null, family: "solana" },
  "arc-testnet": { rpc: ["https://rpc.testnet.arc.network"], api: "https://testnet.arcscan.app" },
  arc: { rpc: ["https://rpc.arc-scan.org"], api: null },
};

/** Statuses that mean "ask somebody else", not "this is your answer". */
const TRY_NEXT = new Set([401, 403, 407, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

export const READ_ONLY_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getStorageAt",
]);

/** Solana speaks a different JSON-RPC; its read surface is listed separately so neither list can widen the other. */
export const SOLANA_READ_ONLY_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getTokenAccountsByOwner",
  "getSlot",
  "getBlockTime",
  "getHealth",
  "getVersion",
  "getSignaturesForAddress",
  "getEpochInfo",
]);

const MAX_BATCH = 50;
/**
 * How long an explorer answer may be reused.
 *
 * Ten seconds is chosen against what the numbers are FOR: holder
 * concentration, whether the source is verified, who deployed it. None of
 * those changes meaningfully inside ten seconds, and the explorer's own
 * index lags the chain by more than that anyway. Price and the transfer
 * count do move, and the slip says how old the reading is when it is not
 * fresh.
 */
export const API_CACHE_SECONDS = 10;
const MAX_BODY = 256 * 1024;
const ALLOWED_API = /^\/api\/v2\/(addresses\/0x[0-9a-fA-F]{40}(\/transactions)?|search|smart-contracts\/0x[0-9a-fA-F]{40}|tokens\/0x[0-9a-fA-F]{40}(\/holders|\/counters|\/transfers)?)$/;

function cors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors({ "content-type": "application/json" }) });
}

/** Handles one request against the given upstream table (injected for tests). */
/**
 * The edge cache, if the runtime has one. Node and the tests do not, and a
 * proxy that only works on Cloudflare would be a proxy nobody can test.
 */
async function cacheLookup(request, cacheImpl) {
  if (!cacheImpl) return null;
  try {
    const hit = await cacheImpl.match(request);
    if (!hit) return null;
    // Two ways to know, because only one of them is ours. Cloudflare sets a
    // standard Age on a cache hit; the stored-at stamp is the fallback for a
    // runtime that does not, and for the tests.
    const stored = Number(hit.headers.get("x-bouncer-stored-at") ?? 0);
    const standard = Number(hit.headers.get("age") ?? NaN);
    const age = Number.isFinite(standard) ? Math.max(0, Math.round(standard)) : stored ? Math.max(0, Math.round((Date.now() - stored) / 1000)) : 0;
    const headers = new Headers(hit.headers);
    headers.set("x-bouncer-age", String(age));
    return new Response(await hit.text(), { status: hit.status, headers });
  } catch {
    return null;
  }
}

async function cacheStore(request, response, cacheImpl) {
  if (!cacheImpl) return;
  try {
    const copy = new Response(await response.clone().text(), { status: response.status, headers: new Headers(response.headers) });
    copy.headers.set("x-bouncer-stored-at", String(Date.now()));
    await cacheImpl.put(request, copy);
  } catch {
    // A cache that will not take it is not a reason to fail the request.
  }
}

export async function handle(request, upstreams = UPSTREAMS, fetchImpl = (i, o) => fetch(i, o), cacheImpl = globalThis.caches?.default ?? null) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (url.pathname === "/" || url.pathname === "") {
    return json({ name: "bouncer-proxy", readOnly: true, chains: Object.keys(upstreams), methods: [...READ_ONLY_METHODS] });
  }

  const rpc = url.pathname.match(/^\/rpc\/([a-z0-9-]+)\/?$/);
  if (rpc) {
    const up = upstreams[rpc[1]];
    if (!up) return json({ error: `unknown chain ${rpc[1]}` }, 404);
    if (request.method !== "POST") return json({ error: "POST a JSON-RPC body" }, 405);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "body too large" }, 413);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const items = Array.isArray(payload) ? payload : [payload];
    if (items.length === 0 || items.length > MAX_BATCH) return json({ error: `batch must be 1..${MAX_BATCH} requests` }, 400);
    const allowed = up.family === "solana" ? SOLANA_READ_ONLY_METHODS : READ_ONLY_METHODS;
    for (const item of items) {
      if (!item || typeof item.method !== "string" || !allowed.has(item.method)) {
        return json({ jsonrpc: "2.0", id: item?.id ?? null, error: { code: -32601, message: `method not allowed through bouncer-proxy: ${item?.method ?? "?"}` } }, 403);
      }
    }
    const endpoints = Array.isArray(up.rpc) ? up.rpc : [up.rpc];
    let lastStatus = 502;
    let lastBody = JSON.stringify({ jsonrpc: "2.0", id: items[0]?.id ?? null, error: { code: -32603, message: "no upstream answered" } });
    for (const endpoint of endpoints) {
      let upstream;
      try {
        upstream = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      } catch {
        continue; // the endpoint did not answer at all; the next one might
      }
      const body = await upstream.text();
      if (!TRY_NEXT.has(upstream.status)) {
        return new Response(body, { status: upstream.status, headers: cors({ "content-type": "application/json", "x-bouncer-upstream": endpoint }) });
      }
      lastStatus = upstream.status;
      lastBody = body;
    }
    // Everybody said no. Hand back the last real answer rather than inventing
    // one, so the reason (rate limited, blocked) reaches the person reading it.
    return new Response(lastBody, { status: lastStatus, headers: cors({ "content-type": "application/json" }) });
  }

  const api = url.pathname.match(/^\/api\/([a-z0-9-]+)(\/.*)$/);
  if (api) {
    const up = upstreams[api[1]];
    if (!up || !up.api) return json({ error: `no explorer for ${api[1]}` }, 404);
    if (request.method !== "GET") return json({ error: "GET only" }, 405);
    if (!ALLOWED_API.test(api[2])) return json({ error: "path not allowed through bouncer-proxy" }, 403);
    const target = `${up.api}${api[2]}${url.search}`;

    // The explorer is the slowest thing in a door read by a wide margin.
    // Measured on Robinhood Chain, one fast pass: the chain answered every
    // request in under 160 ms, and /api/v2/addresses/{address} took 3.2
    // seconds on its own — more than the rest of the read put together.
    //
    // So it is cached here, at the edge, for a few seconds. This is not a
    // decision to serve stale data: the explorer is an index and was always
    // behind the chain, which is why the door re-reads balances on chain
    // before it simulates a sale rather than trusting the holder list. What
    // the cache changes is how far behind, by a handful of seconds, and it
    // says so in a header rather than hiding it.
    const cached = await cacheLookup(request, cacheImpl);
    if (cached) return cached;
    const upstream = await fetchImpl(target, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; bouncer-proxy/0.3; +https://github.com/Kepochnik/bouncer)" } });
    const body = await upstream.text();
    const response = new Response(body, {
      status: upstream.status,
      headers: cors({
        "content-type": "application/json",
        // Only a good answer is worth keeping. A 404 or a rate limit cached
        // for ten seconds would turn one refusal into a wave of them.
        ...(upstream.status === 200 ? { "cache-control": `public, max-age=${API_CACHE_SECONDS}` } : { "cache-control": "no-store" }),
        "x-bouncer-age": "0",
      }),
    });
    if (upstream.status === 200) await cacheStore(request, response, cacheImpl);
    return response;
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: (request) => handle(request),
};
