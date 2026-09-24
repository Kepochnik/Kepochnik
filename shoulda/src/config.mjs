// Chain constants for Robinhood Chain mainnet.
//
// Stock Token and Chainlink feed addresses come from the verified registry in
// nirholas/robinhood-chain-sdk (src/registry/stock-tokens.json, generated at
// block 7690522 and cross-checked on-chain against Chainlink's feed directory).
// Re-verify against https://docs.robinhood.com/chain/oracles-and-price-feeds/
// before trusting a new entry.

export const CHAIN = Object.freeze({
  id: 4663,
  name: 'Robinhood Chain',
  rpc: process.env.SHOULDA_RPC ?? 'https://rpc.mainnet.chain.robinhood.com',
  explorer: process.env.SHOULDA_EXPLORER ?? 'https://robinhoodchain.blockscout.com',
});

export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/** Benchmarks a trade can be measured against. Feed answers are USD per share, 8 decimals. */
export const BENCHMARKS = Object.freeze({
  SPY: {
    label: 'S&P 500',
    token: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
    feed: '0x319724394d3a0e3669269846abe664cd621f9f6a',
  },
  NVDA: {
    label: 'NVIDIA',
    token: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    feed: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
  },
  QQQ: {
    label: 'Nasdaq 100',
    token: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
    feed: '0x80901d846d5d7b030f26b480776ee3b29374c2ae',
  },
  TSLA: {
    label: 'Tesla',
    token: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
    feed: '0x4a1166a659a55625345e9515b32adecea5547c38',
  },
});

export const DEFAULT_BENCHMARK = 'SPY';

/**
 * Optional Chainlink ETH/USD proxy. When set, historical ETH prices come from
 * the feed (per-round precision); otherwise from the explorer's daily close.
 */
export const ETH_USD_FEED = process.env.SHOULDA_ETH_USD_FEED?.toLowerCase() || null;

/** Stock Tokens are investments, not apes; any "<Name> • Robinhood Token" is also treated as one. */
export const STOCK_TOKENS = new Set(Object.values(BENCHMARKS).map((b) => b.token));
