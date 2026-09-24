// Every price shoulda needs, from three read-only sources:
//   Chainlink feeds (stocks, then and now), the explorer (ETH, then and now),
//   and DexScreener (what your bags are marked at right now).

const DEXSCREENER = 'https://api.dexscreener.com/tokens/v1/robinhood';
const DEXSCREENER_BATCH = 30;

/** ETH/USD at a timestamp: Chainlink when a feed is configured, else the explorer's daily close. */
export function createEthPrices({ explorer, feeds, ethUsdFeed }) {
  let closes;
  return {
    async at(ts) {
      if (ethUsdFeed) {
        const p = await feeds.at(ethUsdFeed, ts);
        if (p) return p.price;
      }
      closes ??= explorer.ethDailyCloses();
      return closeAt(await closes, ts);
    },
    async now() {
      if (ethUsdFeed) return (await feeds.latest(ethUsdFeed)).price;
      const live = await explorer.ethPriceNow();
      if (live) return live;
      const all = await (closes ??= explorer.ethDailyCloses());
      return all.at(-1)?.price ?? null;
    },
  };
}

/** Last daily close at or before `ts`; the earliest close when `ts` predates the series. */
export function closeAt(closes, ts) {
  if (!closes.length) return null;
  let lo = 0;
  let hi = closes.length - 1;
  if (ts < closes[0].day) return closes[0].price;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (closes[mid].day <= ts) lo = mid;
    else hi = mid - 1;
  }
  return closes[lo].price;
}

/**
 * Current USD price per memecoin, taken from its deepest pool. Tokens with no
 * pool (rugged, delisted, never graduated off-index) are marked at zero.
 */
export async function memePricesNow(addresses, { fetchImpl = fetch } = {}) {
  const prices = new Map();
  for (let i = 0; i < addresses.length; i += DEXSCREENER_BATCH) {
    const batch = addresses.slice(i, i + DEXSCREENER_BATCH);
    const res = await fetchImpl(`${DEXSCREENER}/${batch.join(',')}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`DexScreener answered HTTP ${res.status}`);
    const pairs = await res.json();
    const depth = new Map();
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      const token = String(pair.baseToken?.address ?? '').toLowerCase();
      const liquidity = Number(pair.liquidity?.usd ?? 0);
      const price = Number(pair.priceUsd);
      if (!token || !(price > 0) || liquidity < (depth.get(token) ?? -1)) continue;
      depth.set(token, liquidity);
      prices.set(token, price);
    }
  }
  for (const a of addresses) if (!prices.has(a)) prices.set(a, 0);
  return prices;
}
