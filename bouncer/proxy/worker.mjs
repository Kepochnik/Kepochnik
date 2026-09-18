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
export const UPSTREAMS = {
  robinhood: { rpc: "https://rpc.mainnet.chain.robinhood.com", api: "https://robinhoodchain.blockscout.com" },
  base: { rpc: "https://base-rpc.publicnode.com", api: "https://base.blockscout.com" },
  bnb: { rpc: "https://bsc-rpc.publicnode.com", api: null },
  solana: { rpc: "https://api.mainnet-beta.solana.com", api: null, family: "solana" },
  "arc-testnet": { rpc: "https://rpc.testnet.arc.network", api: "https://testnet.arcscan.app" },
  arc: { rpc: "https://rpc.arc-scan.org", api: null },
};

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
  "getSlot",
  "getBlockTime",
  "getHealth",
  "getVersion",
  "getSignaturesForAddress",
  "getEpochInfo",
]);

const MAX_BATCH = 50;
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
export async function handle(request, upstreams = UPSTREAMS, fetchImpl = (i, o) => fetch(i, o)) {
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
    const upstream = await fetchImpl(up.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: text });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: cors({ "content-type": "application/json" }) });
  }

  const api = url.pathname.match(/^\/api\/([a-z0-9-]+)(\/.*)$/);
  if (api) {
    const up = upstreams[api[1]];
    if (!up || !up.api) return json({ error: `no explorer for ${api[1]}` }, 404);
    if (request.method !== "GET") return json({ error: "GET only" }, 405);
    if (!ALLOWED_API.test(api[2])) return json({ error: "path not allowed through bouncer-proxy" }, 403);
    const upstream = await fetchImpl(`${up.api}${api[2]}${url.search}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; bouncer-proxy/0.3; +https://github.com/Kepochnik/bouncer)" } });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: cors({ "content-type": "application/json" }) });
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: (request) => handle(request),
};
