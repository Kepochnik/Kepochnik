// Wires the sources together for one wallet. Everything here is a read.

import { BENCHMARKS, CHAIN, ETH_USD_FEED } from './config.mjs';
import { createFeedReader } from './chainlink.mjs';
import { createExplorer } from './explorer.mjs';
import { createEthPrices, memePricesNow } from './prices.mjs';
import { createRpc } from './rpc.mjs';
import { classify, openBags } from './trades.mjs';
import { replay, verdict } from './verdict.mjs';

export async function receipt(wallet, { bench = 'SPY', onStep = () => {} } = {}) {
  const benchmark = BENCHMARKS[bench];
  if (!benchmark) throw new Error(`Unknown benchmark ${bench}. Try: ${Object.keys(BENCHMARKS).join(', ')}`);

  const explorer = createExplorer(CHAIN.explorer);
  const feeds = createFeedReader(createRpc(CHAIN.rpc));
  const eth = createEthPrices({ explorer, feeds, ethUsdFeed: ETH_USD_FEED });

  onStep('reading wallet history');
  const history = await explorer.history(wallet);
  const { trades, skipped } = classify(history, wallet);
  const bags = openBags(trades, history.balances);

  onStep(`pricing ${trades.length} trades against ${bench}`);
  const buyTimes = [...new Set(trades.filter((t) => t.side === 'buy').map((t) => t.ts))];
  const ethAt = new Map();
  const benchAt = new Map();
  await pool(buyTimes, 6, async (ts) => {
    const [e, b] = await Promise.all([eth.at(ts), feeds.at(benchmark.feed, ts)]);
    ethAt.set(ts, e);
    // A buy older than the feed's first round is replayed at the first known price.
    benchAt.set(ts, b?.price ?? (await feeds.first(benchmark.feed)).price);
  });

  onStep('marking bags to market');
  const [ethNow, benchNow, memeNow] = await Promise.all([
    eth.now(),
    feeds.latest(benchmark.feed).then((p) => p.price),
    memePricesNow(bags.map((b) => b.token.address)),
  ]);

  const result = replay({ trades, bags, quotes: { ethAt, benchAt, ethNow, benchNow, memeNow } });
  return {
    wallet: wallet.toLowerCase(),
    bench,
    benchLabel: benchmark.label,
    result,
    verdict: verdict(result, bench),
    notes: {
      completeHistory: history.complete,
      skipped,
      ethSource: ETH_USD_FEED ? 'chainlink' : 'explorer daily close',
      generatedAt: new Date().toISOString(),
    },
  };
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}
