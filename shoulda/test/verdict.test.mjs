import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoReceipt } from '../src/demo.mjs';
import { card } from '../src/render/card.mjs';
import { replay, verdict } from '../src/verdict.mjs';

const A = { address: '0xa', symbol: 'A' };
const B = { address: '0xb', symbol: 'B' };

test('replays every buy three ways and marks everything to today', () => {
  const trades = [
    { ts: 1, side: 'buy', token: A, qty: 100, eth: 1, usd: 0 },
    { ts: 2, side: 'sell', token: A, qty: 100, eth: 0.5, usd: 0 },
    { ts: 3, side: 'buy', token: B, qty: 10, eth: 0, usd: 200 },
  ];
  const result = replay({
    trades,
    bags: [{ token: B, qty: 10 }],
    quotes: {
      ethAt: new Map([[1, 2000], [3, 2500]]),
      benchAt: new Map([[1, 500], [3, 400]]),
      ethNow: 3000,
      benchNow: 600,
      memeNow: new Map([['0xb', 0.1]]), // B kept 0.5% of what went in: rugged
    },
  });
  assert.equal(result.totals.spent, 2000 + 200);
  assert.equal(result.totals.memes, 0.5 * 3000 + 1);
  assert.equal(result.totals.eth, 1 * 3000 + 200);
  assert.equal(result.totals.index, 2000 * (600 / 500) + 200 * (600 / 400));
  assert.equal(result.apes, 2);
  assert.equal(result.worst.token, A); // -$900 vs index, against B's -$290
  assert.equal(result.best.token, B);
  assert.equal(result.rugged, 1);
});

test('fails loudly instead of inventing a missing price', () => {
  const trades = [{ ts: 9, side: 'buy', token: A, qty: 1, eth: 1, usd: 0 }];
  const quotes = { ethAt: new Map(), benchAt: new Map(), ethNow: 1, benchNow: 1, memeNow: new Map() };
  assert.throws(() => replay({ trades, bags: [], quotes }), /Missing ETH price/);
});

test('verdict tiers follow the memes/index ratio', () => {
  const at = (ratio) => verdict({ apes: 1, ratio }, 'SPY').title;
  assert.equal(at(3), 'GRAMPS IS SPEECHLESS');
  assert.equal(at(1.1), 'FINE. YOU WIN.');
  assert.equal(at(0.7), 'SHOULDA.');
  assert.equal(at(0.3), 'SHOULDA BOUGHT SPY.');
  assert.equal(at(0.01), 'NOT MAD. JUST DISAPPOINTED.');
  assert.equal(verdict({ apes: 0, ratio: null }, 'SPY').title, 'CLEAN HANDS');
});

test('the demo runs end to end and the card escapes token names', () => {
  const r = demoReceipt('NVDA');
  assert.equal(r.verdict.title, 'SHOULDA BOUGHT NVDA.');
  r.result.worst.token.symbol = '<script>';
  const svg = card(r);
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /<script>/);
});
