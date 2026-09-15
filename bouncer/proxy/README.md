# bouncer-proxy

Twenty lines of glue so the hosted site can read the chain from a browser: a Cloudflare Worker that forwards read-only JSON-RPC (and two Blockscout GET routes) to the public endpoints and adds CORS headers. Free tier is 100 000 requests a day, which is a lot of slips.

It can only read. Every RPC method must be on the allow-list in `worker.mjs` (`eth_call`, `eth_getLogs`, `eth_getCode`, … and nothing that signs or sends), batches are capped at 50, bodies at 256 KB, explorer paths at the three the site uses.

## Deploy (3 minutes)

```bash
cd proxy
npx wrangler login          # opens the browser once
npx wrangler deploy         # prints https://bouncer-proxy.<your-name>.workers.dev
```

Test it:

```bash
curl -s https://bouncer-proxy.<your-name>.workers.dev/
curl -s -X POST https://bouncer-proxy.<your-name>.workers.dev/rpc/robinhood -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## Point the site at it

Open the site → **Settings** → **Proxy URL** → paste `https://bouncer-proxy.<your-name>.workers.dev` → check a token. The site then reads every chain through `<proxy>/rpc/<chain>` and the explorer through `<proxy>/api/<chain>/…`. The setting stays in your browser.

To make it the default for everyone who opens your hosted site, set `DEFAULT_PROXY` in `site/src/app.ts` and rebuild (`npm run site`).

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | health: chains and methods served |
| `POST /rpc/robinhood`, `/rpc/arc-testnet`, `/rpc/arc` | JSON-RPC, read-only methods only |
| `GET /api/<chain>/api/v2/addresses/0x…/transactions`, `/api/v2/search`, `/api/v2/smart-contracts/0x…` | Blockscout v2, same query string |

Change upstreams in `UPSTREAMS` at the top of `worker.mjs` (for example Circle's official Arc RPC once published).
