import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeedReader } from '../src/chainlink.mjs';
import { encodeUint } from '../src/rpc.mjs';
import { closeAt } from '../src/prices.mjs';

const FEED = '0xfeed';
const OLD_AGG = '0x00000000000000000000000000000000000a0001';

// Phase 1: rounds 1..40 at t = 1000 + 10r (price r). Phase 2: rounds 1..100 at t = 2000 + 10r (price 100 + r).
function fakeFeed() {
  const calls = { n: 0 };
  const rounds = new Map();
  for (let r = 1n; r <= 40n; r++) rounds.set((1n << 64n) | r, [1000n + 10n * r, r * 10n ** 8n]);
  for (let r = 1n; r <= 100n; r++) rounds.set((2n << 64n) | r, [2000n + 10n * r, (100n + r) * 10n ** 8n]);
  const latestId = (2n << 64n) | 100n;
  const encode = (id) => {
    const [ts, answer] = rounds.get(id);
    return '0x' + [id, answer, ts, ts, id].map(encodeUint).join('');
  };
  const rpc = {
    async call(to, data) {
      calls.n++;
      const sel = data.slice(0, 10);
      if (to === FEED && sel === '0x313ce567') return '0x' + encodeUint(8);
      if (to === FEED && sel === '0xfeaf968c') return encode(latestId);
      if (to === FEED && sel === '0x9a6fc8f5') {
        const id = BigInt('0x' + data.slice(10));
        return rounds.has(id) ? encode(id) : null;
      }
      if (to === FEED && sel === '0xc1597304') return '0x' + OLD_AGG.slice(2).padStart(64, '0');
      if (to === OLD_AGG && sel === '0x668a0f02') return '0x' + encodeUint(40);
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
  return { rpc, calls };
}

test('finds the last round at or before a timestamp', async () => {
  const feeds = createFeedReader(fakeFeed().rpc);
  assert.deepEqual(await feeds.at(FEED, 2505), { price: 150, updatedAt: 2500 });
  assert.deepEqual(await feeds.at(FEED, 2500), { price: 150, updatedAt: 2500 });
  assert.deepEqual(await feeds.at(FEED, 9999), { price: 200, updatedAt: 3000 });
});

test('walks back into an older phase', async () => {
  const feeds = createFeedReader(fakeFeed().rpc);
  assert.deepEqual(await feeds.at(FEED, 1255), { price: 25, updatedAt: 1250 });
  assert.deepEqual(await feeds.at(FEED, 2005), { price: 40, updatedAt: 1400 });
});

test('returns null before the feed existed, and first() finds its start', async () => {
  const feeds = createFeedReader(fakeFeed().rpc);
  assert.equal(await feeds.at(FEED, 500), null);
  assert.deepEqual(await feeds.first(FEED), { price: 1, updatedAt: 1010 });
});

test('binary search stays logarithmic and caches rounds', async () => {
  const { rpc, calls } = fakeFeed();
  const feeds = createFeedReader(rpc);
  await feeds.at(FEED, 2505);
  const first = calls.n;
  assert.ok(first < 15, `expected < 15 calls, got ${first}`);
  await feeds.at(FEED, 2506);
  assert.ok(calls.n - first < 3);
});

test('daily closes pick the last close at or before a timestamp', () => {
  const closes = [{ day: 100, price: 1 }, { day: 200, price: 2 }, { day: 300, price: 3 }];
  assert.equal(closeAt(closes, 250), 2);
  assert.equal(closeAt(closes, 300), 3);
  assert.equal(closeAt(closes, 50), 1);
  assert.equal(closeAt([], 50), null);
});
