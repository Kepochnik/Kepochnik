// Blockscout v2 reader: a wallet's native, internal and ERC-20 history, plus
// ETH price context. Read-only, unauthenticated.
//
// The explorer occasionally serves a short page with next_page_params = null
// (a silently truncated history; see 33hodl/rh-chain-wallet-lens). A short
// page is refetched once and the fuller answer kept.

const PAGE_SIZE = 50;

export function createExplorer(baseUrl, { fetchImpl = fetch, maxPages = 40, retries = 2 } = {}) {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v2`;

  async function getJson(path) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(api + path, { signal: AbortSignal.timeout(20_000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`explorer answered HTTP ${res.status} for ${path}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function crawl(path) {
    const items = [];
    let next = null;
    for (let page = 0; page < maxPages; page++) {
      const url = path + (next ? `${path.includes('?') ? '&' : '?'}${new URLSearchParams(next)}` : '');
      let body = await getJson(url);
      if (body?.items?.length < PAGE_SIZE && !body.next_page_params) {
        const again = await getJson(url);
        if ((again?.items?.length ?? 0) > body.items.length) body = again;
      }
      items.push(...(body?.items ?? []));
      next = body?.next_page_params;
      if (!next) return { items, complete: true };
    }
    return { items, complete: false };
  }

  return {
    /** Everything shoulda needs about one wallet. */
    async history(address) {
      const a = address.toLowerCase();
      const [txs, internal, transfers, balances] = await Promise.all([
        crawl(`/addresses/${a}/transactions`),
        crawl(`/addresses/${a}/internal-transactions`),
        crawl(`/addresses/${a}/token-transfers?type=ERC-20`),
        getJson(`/addresses/${a}/token-balances`),
      ]);
      return {
        txs: txs.items,
        internal: internal.items,
        transfers: transfers.items,
        balances: Array.isArray(balances) ? balances : [],
        complete: txs.complete && internal.complete && transfers.complete,
      };
    },

    /** Daily ETH closes as a sorted [{ day, price }] list, oldest first. */
    async ethDailyCloses() {
      const body = await getJson('/stats/charts/market');
      return (body?.chart_data ?? [])
        .map((d) => ({ day: Date.parse(`${d.date}T00:00:00Z`) / 1000, price: Number(d.closing_price) }))
        .filter((d) => Number.isFinite(d.day) && d.price > 0)
        .sort((x, y) => x.day - y.day);
    },

    async ethPriceNow() {
      const body = await getJson('/stats');
      const price = Number(body?.coin_price);
      return price > 0 ? price : null;
    },
  };
}
