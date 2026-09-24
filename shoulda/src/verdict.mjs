// The whole product in one pure function: every dollar you aped, replayed
// three ways and marked to today.
//
//   memes  — what you actually have: sell proceeds + open bags at today's price
//   eth    — if you had just held the ETH (or USDG) you spent
//   index  — if every buy had bought the benchmark Stock Token instead
//
// Sell proceeds received in ETH are marked at today's ETH price, the same way
// the "eth" line marks the ETH you spent, so neither line gets a free ride.

/**
 * @param {object} input
 * @param {import('./trades.mjs').Trade[]} input.trades
 * @param {{ token: import('./trades.mjs').Token, qty: number }[]} input.bags
 * @param {object} input.quotes
 * @param {Map<number, number>} input.quotes.ethAt    ETH/USD at each buy timestamp
 * @param {Map<number, number>} input.quotes.benchAt  benchmark USD/share at each buy timestamp
 * @param {number} input.quotes.ethNow
 * @param {number} input.quotes.benchNow
 * @param {Map<string, number>} input.quotes.memeNow  USD price per memecoin address
 */
export function replay({ trades, bags, quotes }) {
  const perToken = new Map();
  const row = (token) => {
    if (!perToken.has(token.address)) {
      perToken.set(token.address, { token, buys: 0, spent: 0, memes: 0, eth: 0, index: 0 });
    }
    return perToken.get(token.address);
  };

  for (const t of trades) {
    const r = row(t.token);
    if (t.side === 'buy') {
      const ethUsd = must(quotes.ethAt.get(t.ts), `ETH price at ${t.ts}`);
      const bench = must(quotes.benchAt.get(t.ts), `benchmark price at ${t.ts}`);
      const spent = t.eth * ethUsd + t.usd;
      r.buys++;
      r.spent += spent;
      r.eth += t.eth * quotes.ethNow + t.usd;
      r.index += spent * (quotes.benchNow / bench);
    } else {
      r.memes += t.eth * quotes.ethNow + t.usd;
    }
  }
  for (const bag of bags) {
    row(bag.token).memes += bag.qty * (quotes.memeNow.get(bag.token.address) ?? 0);
  }

  const tokens = [...perToken.values()].filter((r) => r.buys > 0);
  const sum = (k) => tokens.reduce((s, r) => s + r[k], 0);
  const totals = { spent: sum('spent'), memes: sum('memes'), eth: sum('eth'), index: sum('index') };
  const byGap = [...tokens].sort((a, b) => a.memes - a.index - (b.memes - b.index));

  return {
    apes: tokens.reduce((s, r) => s + r.buys, 0),
    coins: tokens.length,
    totals,
    gap: totals.memes - totals.index,
    ratio: totals.index > 0 ? totals.memes / totals.index : null,
    worst: byGap[0] ?? null,
    best: byGap.at(-1) ?? null,
    rugged: tokens.filter((r) => r.memes < r.spent * 0.01).length, // kept less than 1% of what went in
    tokens: byGap,
  };
}

const TIERS = [
  { min: 2, title: 'GRAMPS IS SPEECHLESS', line: 'You beat {BENCH} twice over. Screenshot it. Frame it.' },
  { min: 1, title: 'FINE. YOU WIN.', line: 'You beat {BENCH}. Gramps is updating his will.' },
  { min: 0.5, title: 'SHOULDA.', line: 'Close. {BENCH} did it with zero Telegram groups.' },
  { min: 0.1, title: 'SHOULDA BOUGHT {BENCH}.', line: 'Gramps bought {BENCH} in 1993 and went fishing.' },
  { min: 0, title: 'NOT MAD. JUST DISAPPOINTED.', line: 'Every dollar, replayed. {BENCH} would have kept it.' },
];

export function verdict(result, bench) {
  if (!result.apes) return { title: 'CLEAN HANDS', line: 'No apes found. Gramps respects a quiet wallet.' };
  const tier = TIERS.find((t) => (result.ratio ?? 0) >= t.min);
  const fill = (s) => s.replaceAll('{BENCH}', bench);
  return { title: fill(tier.title), line: fill(tier.line) };
}

function must(value, what) {
  if (!(value > 0)) throw new Error(`Missing ${what}`);
  return value;
}
