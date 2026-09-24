import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WETH } from '../src/config.mjs';
import { DEMO_WALLET, demoHistory } from '../src/demo.mjs';
import { classify, openBags } from '../src/trades.mjs';

const ME = DEMO_WALLET;
const POOL = '0x9001000000000000000000000000000000000001';
const MEME = { address_hash: '0xaaaa000000000000000000000000000000000001', symbol: 'MEME', name: 'Meme', decimals: '18' };
const e18 = (n) => BigInt(n) * 10n ** 18n + '';
const tx = (hash, value = '0') => ({ hash, timestamp: '2026-07-10T00:00:00Z', status: 'ok', from: { hash: ME }, to: { hash: POOL }, value });
const leg = (hash, token, value, from, to) => ({ transaction_hash: hash, timestamp: '2026-07-10T00:00:00Z', from: { hash: from }, to: { hash: to }, token, total: { value, decimals: token.decimals } });

test('reads native, WETH, USDG and internal-ETH legs into buys and sells', () => {
  const { trades, skipped } = classify(demoHistory(), ME);
  assert.equal(trades.length, 8);
  assert.deepEqual(
    trades.map((t) => `${t.side}:${t.token.symbol}`),
    ['buy:FROG', 'buy:CEO', 'sell:FROG', 'buy:HOODRAT', 'buy:GOBLIN', 'sell:CEO', 'buy:HOODRAT', 'sell:GOBLIN'],
  );
  const [frogBuy, ceoBuy, frogSell, , goblinBuy] = trades;
  assert.equal(frogBuy.eth, 0.5); // native tx value
  assert.equal(ceoBuy.eth, 0.8); // WETH leg
  assert.equal(frogSell.eth, 0.9); // internal transfer back
  assert.equal(goblinBuy.usd, 900); // USDG leg
  assert.equal(goblinBuy.eth, 0);
  assert.deepEqual(skipped, { stockTrades: 0, memeToMeme: 0, failed: 0 });
});

test('nets router refunds out of the price paid', () => {
  const history = {
    txs: [tx('0x1', e18(1))],
    internal: [{ transaction_hash: '0x1', success: true, from: { hash: POOL }, to: { hash: ME }, value: (3n * 10n ** 17n).toString() }],
    transfers: [leg('0x1', MEME, e18(1000), POOL, ME)],
  };
  const [buy] = classify(history, ME).trades;
  assert.equal(buy.side, 'buy');
  assert.ok(Math.abs(buy.eth - 0.7) < 1e-12);
});

test('leaves stock-token trades and failed transactions out', () => {
  const tsla = { address_hash: '0xbbbb000000000000000000000000000000000002', symbol: 'XYZ', name: 'Some Co • Robinhood Token', decimals: '18' };
  const weth = { address_hash: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' };
  const history = {
    txs: [tx('0x1'), { ...tx('0x2', e18(1)), status: 'error' }],
    internal: [],
    transfers: [leg('0x1', tsla, e18(1), POOL, ME), leg('0x1', weth, e18(1), ME, POOL), leg('0x2', MEME, e18(5), POOL, ME)],
  };
  const { trades, skipped } = classify(history, ME);
  assert.equal(trades.length, 0);
  assert.equal(skipped.stockTrades, 1);
  assert.equal(skipped.failed, 1);
});

test('open bags count bought tokens only, capped by the live balance', () => {
  const trades = [
    { side: 'buy', token: { address: '0xa' }, qty: 100 },
    { side: 'sell', token: { address: '0xa' }, qty: 30 },
    { side: 'buy', token: { address: '0xb' }, qty: 50 },
  ];
  const balances = [
    { token: { address_hash: '0xa', decimals: '0' }, value: '1000' }, // airdrop on top: ignored
    { token: { address_hash: '0xb', decimals: '0' }, value: '20' }, // moved some to another wallet
  ];
  assert.deepEqual(
    openBags(trades, balances).map((b) => [b.token.address, b.qty]),
    [['0xa', 70], ['0xb', 20]],
  );
});
