// A made-up wallet run through the real pipeline (classify → bags → replay →
// verdict) with fixed prices. No network. Used by `shoulda demo` and the tests.

import { USDG, WETH } from './config.mjs';
import { classify, openBags } from './trades.mjs';
import { replay, verdict } from './verdict.mjs';

export const DEMO_WALLET = '0xde6000000000000000000000000000000000beef';
const POOL = '0x9001000000000000000000000000000000000001';
const DAY = 86_400;
const T0 = Date.parse('2026-07-08T15:00:00Z') / 1000;

const COINS = {
  FROG: { address: '0xf000000000000000000000000000000000000001', symbol: 'FROG', name: 'Frog on a Stock' },
  CEO: { address: '0xf000000000000000000000000000000000000002', symbol: 'CEO', name: 'Tendies CEO' },
  HOODRAT: { address: '0xf000000000000000000000000000000000000003', symbol: 'HOODRAT', name: 'Hood Rat' },
  GOBLIN: { address: '0xf000000000000000000000000000000000000004', symbol: 'GOBLIN', name: 'Goblin Capital' },
};

// [day, coin, side, tokens, quote amount, quote asset]
const TAPE = [
  [0, 'FROG', 'buy', 2_000_000, 0.5, 'eth'],
  [3, 'CEO', 'buy', 800_000, 0.8, 'weth'],
  [9, 'FROG', 'sell', 1_000_000, 0.9, 'eth'],
  [14, 'HOODRAT', 'buy', 5_000_000, 1.2, 'eth'],
  [21, 'GOBLIN', 'buy', 300_000, 900, 'usdg'],
  [30, 'CEO', 'sell', 800_000, 0.1, 'eth'],
  [44, 'HOODRAT', 'buy', 2_000_000, 0.6, 'eth'],
  [52, 'GOBLIN', 'sell', 100_000, 150, 'usdg'],
];

export function demoHistory() {
  const history = { txs: [], internal: [], transfers: [], balances: [], complete: true };
  const held = {};
  TAPE.forEach(([day, sym, side, qty, quote, asset], i) => {
    const hash = `0x${String(i + 1).padStart(64, '0')}`;
    const timestamp = new Date((T0 + day * DAY) * 1000).toISOString();
    const coin = COINS[sym];
    const buy = side === 'buy';
    const [from, to] = buy ? [POOL, DEMO_WALLET] : [DEMO_WALLET, POOL];
    history.transfers.push(leg(hash, timestamp, coin, qty, from, to));
    held[sym] = (held[sym] ?? 0) + (buy ? qty : -qty);

    if (asset === 'eth' && buy) {
      history.txs.push({ hash, timestamp, status: 'ok', from: { hash: DEMO_WALLET }, to: { hash: POOL }, value: wei(quote) });
    } else {
      history.txs.push({ hash, timestamp, status: 'ok', from: { hash: DEMO_WALLET }, to: { hash: POOL }, value: '0' });
      if (asset === 'eth') {
        history.internal.push({ transaction_hash: hash, timestamp, success: true, from: { hash: POOL }, to: { hash: DEMO_WALLET }, value: wei(quote) });
      } else {
        const money = asset === 'weth' ? { address: WETH, symbol: 'WETH', name: 'Wrapped Ether' } : { address: USDG, symbol: 'USDG', name: 'Global Dollar' };
        history.transfers.push(leg(hash, timestamp, money, quote, buy ? DEMO_WALLET : POOL, buy ? POOL : DEMO_WALLET));
      }
    }
  });
  for (const [sym, qty] of Object.entries(held)) {
    if (qty > 0) history.balances.push({ token: token(COINS[sym]), value: wei(qty) });
  }
  return history;
}

export const DEMO_QUOTES = (() => {
  const ethAt = new Map();
  const benchAt = new Map();
  TAPE.forEach(([day]) => {
    const ts = T0 + day * DAY;
    ethAt.set(ts, 3_900 + day * 12);
    benchAt.set(ts, 700 + day * 0.9);
  });
  return {
    ethAt,
    benchAt,
    ethNow: 4_380,
    benchNow: 761,
    memeNow: new Map([
      [COINS.FROG.address, 0.00000031],
      [COINS.CEO.address, 0],
      [COINS.HOODRAT.address, 0.000000052],
      [COINS.GOBLIN.address, 0.0011],
    ]),
  };
})();

export function demoReceipt(bench = 'SPY') {
  const history = demoHistory();
  const { trades, skipped } = classify(history, DEMO_WALLET);
  const result = replay({ trades, bags: openBags(trades, history.balances), quotes: DEMO_QUOTES });
  return {
    wallet: DEMO_WALLET,
    bench,
    benchLabel: 'demo',
    result,
    verdict: verdict(result, bench),
    notes: { completeHistory: true, skipped, ethSource: 'demo prices', generatedAt: new Date().toISOString() },
  };
}

function leg(hash, timestamp, coin, qty, from, to) {
  return { transaction_hash: hash, timestamp, from: { hash: from }, to: { hash: to }, token: token(coin), total: { value: wei(qty), decimals: '18' } };
}

function token(coin) {
  return { address_hash: coin.address, symbol: coin.symbol, name: coin.name, decimals: '18', type: 'ERC-20' };
}

function wei(amount) {
  return BigInt(Math.round(amount * 1e6)) * 10n ** 12n + '';
}
