// Turns raw explorer history into apes: buys and sells of memecoins, each with
// the money that went in or came out. Pure: no network, easy to test.
//
// A transaction is a buy when the wallet received a memecoin and paid ETH,
// WETH or USDG in the same transaction; a sell is the mirror image. Pons
// bonding-curve buys pay native ETH (tx value) and sells pay it back as an
// internal transaction, so all three sources are merged per transaction hash.

import { STOCK_TOKENS, USDG, WETH } from './config.mjs';

/**
 * @typedef {{ address: string, symbol: string, name: string, decimals: number }} Token
 * @typedef {{ hash: string, ts: number, side: 'buy'|'sell', token: Token, qty: number, eth: number, usd: number }} Trade
 *   `eth` and `usd` are the quote paid (buy) or received (sell); usually one of them is zero.
 */

const WEI = 1e18;

export function classify(history, wallet) {
  const me = wallet.toLowerCase();
  const groups = new Map();
  const group = (hash) => {
    if (!groups.has(hash)) groups.set(hash, { ts: 0, ok: true, ethOut: 0, ethIn: 0, legs: [] });
    return groups.get(hash);
  };

  for (const tx of history.txs) {
    const g = group(tx.hash);
    g.ts ||= toTs(tx.timestamp);
    if (tx.status && tx.status !== 'ok') g.ok = false;
    if (addr(tx.from) === me) g.ethOut += Number(tx.value ?? 0) / WEI;
  }
  for (const itx of history.internal) {
    if (itx.success === false || addr(itx.to) !== me) continue;
    const g = group(itx.transaction_hash);
    g.ts ||= toTs(itx.timestamp);
    g.ethIn += Number(itx.value ?? 0) / WEI;
  }
  for (const t of history.transfers) {
    const g = group(t.transaction_hash);
    g.ts ||= toTs(t.timestamp);
    g.legs.push(t);
  }

  /** @type {Trade[]} */
  const trades = [];
  const skipped = { stockTrades: 0, memeToMeme: 0, failed: 0 };

  for (const [hash, g] of groups) {
    if (!g.ok) {
      skipped.failed++;
      continue;
    }
    let { ethOut, ethIn } = g;
    let usdOut = 0;
    let usdIn = 0;
    const memeIn = [];
    const memeOut = [];
    let touchedStock = false;

    for (const leg of g.legs) {
      const token = tokenOf(leg);
      const qty = amount(leg, token);
      const incoming = addr(leg.to) === me;
      const outgoing = addr(leg.from) === me;
      if (!incoming && !outgoing) continue;
      if (token.address === WETH) incoming ? (ethIn += qty) : (ethOut += qty);
      else if (token.address === USDG) incoming ? (usdIn += qty) : (usdOut += qty);
      else if (isStock(token)) touchedStock = true;
      else (incoming ? memeIn : memeOut).push({ token, qty });
    }

    if (touchedStock) {
      skipped.stockTrades++;
      continue;
    }
    if (memeIn.length && memeOut.length) {
      skipped.memeToMeme++;
      continue;
    }
    // Net the legs: routers refund unused ETH on buys, and some sells pay a fee in ETH.
    const paid = { eth: Math.max(0, ethOut - ethIn), usd: Math.max(0, usdOut - usdIn) };
    const got = { eth: Math.max(0, ethIn - ethOut), usd: Math.max(0, usdIn - usdOut) };
    if (memeIn.length && (paid.eth > 0 || paid.usd > 0)) {
      for (const m of memeIn) trades.push(trade(hash, g.ts, 'buy', m, paid, memeIn.length));
    } else if (memeOut.length && (got.eth > 0 || got.usd > 0)) {
      for (const m of memeOut) trades.push(trade(hash, g.ts, 'sell', m, got, memeOut.length));
    }
  }

  trades.sort((a, b) => a.ts - b.ts);
  return { trades, skipped };
}

/** Net memecoin quantity still attributable to buys, capped by what the wallet actually holds. */
export function openBags(trades, balances) {
  const held = new Map(
    balances.map((b) => {
      const token = tokenOf(b);
      return [token.address, Number(b.value ?? 0) / 10 ** token.decimals];
    }),
  );
  const net = new Map();
  for (const t of trades) {
    const cur = net.get(t.token.address) ?? { token: t.token, qty: 0 };
    cur.qty = Math.max(0, cur.qty + (t.side === 'buy' ? t.qty : -t.qty));
    net.set(t.token.address, cur);
  }
  return [...net.values()]
    .map((b) => ({ token: b.token, qty: Math.min(b.qty, held.get(b.token.address) ?? 0) }))
    .filter((b) => b.qty > 0);
}

function trade(hash, ts, side, { token, qty }, quote, split) {
  return { hash, ts, side, token, qty, eth: quote.eth / split, usd: quote.usd / split };
}

function isStock(token) {
  return STOCK_TOKENS.has(token.address) || /•\s*Robinhood Token$/i.test(token.name);
}

function tokenOf(leg) {
  const t = leg.token ?? {};
  return {
    address: String(t.address_hash ?? t.address ?? '').toLowerCase(),
    symbol: t.symbol ?? '???',
    name: t.name ?? '',
    decimals: Number(t.decimals ?? 18),
  };
}

function amount(leg, token) {
  const raw = leg.total?.value ?? leg.value ?? 0;
  const decimals = Number(leg.total?.decimals ?? token.decimals);
  return Number(raw) / 10 ** decimals;
}

function addr(party) {
  return String(party?.hash ?? party ?? '').toLowerCase();
}

function toTs(iso) {
  return iso ? Math.floor(Date.parse(iso) / 1000) : 0;
}
