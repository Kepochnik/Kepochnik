"use strict";
(() => {
  // src/chain/chains.ts
  var PUBLIC_PROXY = "https://bouncer-proxy.tarasenkosanja12.workers.dev";
  var CHAINS = {
    robinhood: {
      key: "robinhood",
      tint: "#c8f751",
      mark: '<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="currentColor">R</text>',
      name: "Robinhood Chain",
      family: "evm",
      chainId: 4663,
      // Robinhood Chain publishes one endpoint, so a 403 from it used to stop
      // every read on the chain outright — which happened during a live run
      // today. The proxy is a different address in front of the same node, so it
      // survives a per-caller limit even though it cannot survive the node
      // itself going down. That is the honest half of a fix, and it is better
      // than the nothing that was here.
      rpc: ["https://rpc.mainnet.chain.robinhood.com", `${PUBLIC_PROXY}/rpc/robinhood`],
      blockscout: "https://robinhoodchain.blockscout.com",
      factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase(),
      factoryV1: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase(),
      olderFactoriesV1: ["0x0c37a24F5D23A486FA692d1500881d698B1F77a4".toLowerCase()],
      launchpad: "Pons V2",
      native: { symbol: "ETH", decimals: 18 },
      blocksPerSecond: 10,
      known: {
        "0x39dbed3a2bd333467115de45665cc57f813c4571": "$PONS, the launchpad's own platform token: a fixed-supply PonsLauncherToken paired into a Uniswap V3 pool at launch. The V2 curve, door tax and creator tax do not apply to it.",
        "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e": "the Pons V2 launch factory itself, not a token.",
        "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "the Pons V1 launch factory itself, not a token."
      },
      dex: {
        weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase(),
        wethSymbol: "WETH",
        v3Factories: [{ name: "Uniswap V3", address: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA".toLowerCase() }],
        v3PositionManager: "0x943e6b11d6a2a0dD87eC5E23Cf58A63A8D9Ec2B7".toLowerCase(),
        // The launchpad graduates into V4 and its factory names the singleton, so
        // the address is read from the chain rather than recalled.
        v4PoolManager: "from-launchpad"
      }
    },
    base: {
      key: "base",
      tint: "#3f6cff",
      mark: '<path d="M9.5 1.57a6.6 6.6 0 1 0 0 12.86Z" fill="currentColor"/>',
      name: "Base",
      family: "evm",
      chainId: 8453,
      rpc: ["https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org", "https://base.drpc.org"],
      blockscout: "https://base.blockscout.com",
      factory: null,
      launchpad: null,
      native: { symbol: "ETH", decimals: 18 },
      blocksPerSecond: 0.5,
      notes: "No launchpad BOUNCER knows runs here, so every address is checked as an ordinary token: who can change its rules, whether a holder can sell right now, who holds it, where it trades.",
      dex: {
        weth: "0x4200000000000000000000000000000000000006",
        wethSymbol: "WETH",
        v3Factories: [{ name: "Uniswap V3", address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD".toLowerCase() }],
        v2Factories: [{ name: "Uniswap V2", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6".toLowerCase() }],
        solidlyFactories: [{ name: "Aerodrome", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da".toLowerCase() }],
        v3PositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1".toLowerCase()
      }
    },
    bnb: {
      key: "bnb",
      tint: "#f0b90b",
      mark: '<g fill="currentColor"><rect x="6.6" y="1.2" width="2.8" height="2.8" transform="rotate(45 8 2.6)"/><rect x="6.6" y="12" width="2.8" height="2.8" transform="rotate(45 8 13.4)"/><rect x="1.2" y="6.6" width="2.8" height="2.8" transform="rotate(45 2.6 8)"/><rect x="12" y="6.6" width="2.8" height="2.8" transform="rotate(45 13.4 8)"/><rect x="6.2" y="6.2" width="3.6" height="3.6" transform="rotate(45 8 8)"/></g>',
      name: "BNB Chain",
      family: "evm",
      chainId: 56,
      rpc: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://binance.llamarpc.com"],
      blockscout: null,
      explorerUrl: "https://bscscan.com",
      factory: null,
      launchpad: null,
      native: { symbol: "BNB", decimals: 18 },
      blocksPerSecond: 1.33,
      notes: "No launchpad BOUNCER knows runs here, and BNB Chain has no public Blockscout, so holders, the deployer and the price feed are not read. Everything the chain itself answers still is: the code's switches, the owner, whether a holder can sell into the pool, and the pools themselves.",
      dex: {
        weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase(),
        wethSymbol: "WBNB",
        v3Factories: [
          { name: "PancakeSwap V3", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865".toLowerCase(), feeTiers: [100, 500, 2500, 1e4] },
          { name: "Uniswap V3", address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7".toLowerCase() }
        ],
        v2Factories: [{ name: "PancakeSwap V2", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73".toLowerCase() }],
        v3PositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364".toLowerCase()
      }
    },
    solana: {
      key: "solana",
      tint: "#14f195",
      mark: '<g fill="currentColor"><path d="M3.6 4.2h9.2l-1.9 2H1.7l1.9-2Z"/><path d="M3.6 7h9.2l-1.9 2H1.7L3.6 7Z"/><path d="M3.6 9.8h9.2l-1.9 2H1.7l1.9-2Z"/></g>',
      name: "Solana",
      family: "solana",
      chainId: 0,
      // Measured, not assumed. A probe asked eight public endpoints for the
      // three methods this reader depends on:
      //   api.mainnet-beta      getTokenAccountsByOwner 96ms, getMultipleAccounts
      //                         58ms, getTokenLargestAccounts throttled (429)
      //   solana-rpc.publicnode getMultipleAccounts 75ms, the other two blocked
      // Everything else — drpc, ankr, public-rpc, omniatech, onfinality,
      // blockeden — refused all three: paid plan, no key, or down. drpc was in
      // this list and served nothing, so it was three wasted failover attempts
      // on every call.
      rpc: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
      blockscout: null,
      explorerUrl: "https://solscan.io",
      factory: null,
      launchpad: null,
      native: { symbol: "SOL", decimals: 9 },
      blocksPerSecond: 2.5,
      notes: "Read as SPL: the mint account says outright whether anyone can print more tokens or freeze yours, and Token-2022 extensions say whether a transfer costs a fee, runs someone's code, or can be reversed by a permanent delegate. Where it trades is read too: the pump.fun bonding curve exactly, and Raydium, Orca, Meteora and pump.fun AMM pools against SOL or USDC. A ranged pool is shown but not priced, because its vault balances are not what a trade moves through."
    },
    "arc-testnet": {
      key: "arc-testnet",
      tint: "#8a8fa8",
      mark: '<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="currentColor">A</text>',
      name: "Arc Testnet",
      family: "evm",
      chainId: 5042002,
      rpc: ["https://rpc.testnet.arc.network", "https://rpc.testnet.arc.io"],
      blockscout: "https://testnet.arcscan.app",
      factory: "0x90022cC2107De9c070F889E3A67009FcA270E4E2".toLowerCase(),
      launchpad: "Radian (Pons V2 port)",
      native: { symbol: "USDC", decimals: 18 },
      blocksPerSecond: 1,
      notes: "Native USDC is the gas and quote asset, counted in 18-decimal native units on chain (the ERC-20 view shows 6)."
    },
    arc: {
      key: "arc",
      tint: "#6f7bff",
      mark: '<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="currentColor">A</text>',
      name: "Arc",
      family: "evm",
      chainId: 5042,
      rpc: ["https://rpc.arc-scan.org"],
      blockscout: null,
      factory: null,
      launchpad: "Radian (Pons V2 port)",
      native: { symbol: "USDC", decimals: 18 },
      blocksPerSecond: 1,
      notes: "The Radian mainnet factory is not published yet: pass --factory 0x\u2026 (CLI) or set it in the site's live settings once it is. Every check that needs no factory runs regardless."
    }
  };
  var DEFAULT_CHAIN = CHAINS.robinhood;

  // src/bouncer/pageSubject.ts
  var THIRD_PARTY_HOSTS = {
    "basescan.org": "base",
    "bscscan.com": "bnb",
    "solscan.io": "solana",
    "solana.fm": "solana",
    // Arc mainnet has no factory in the table, so a bare arcscan.app link is
    // read on the testnet BOUNCER can actually answer for rather than on a
    // chain where every read would come back empty.
    "arcscan.app": "arc-testnet",
    "ponsfamily.com": "robinhood"
  };
  var MULTI_CHAIN_HOSTS = ["dexscreener.com", "gmgn.ai"];
  var PATH_SEGMENTS = {
    base: "base",
    bsc: "bnb",
    bnb: "bnb",
    solana: "solana",
    sol: "solana",
    robinhood: "robinhood",
    arc: "arc-testnet"
  };
  function tokenPageHosts() {
    const out = {};
    for (const chain of Object.values(CHAINS)) {
      for (const url of [chain.blockscout, chain.explorerUrl]) {
        if (!url) continue;
        try {
          out[new URL(url).host.replace(/^www\./, "")] = chain.key;
        } catch {
        }
      }
    }
    for (const [host, key] of Object.entries(THIRD_PARTY_HOSTS)) out[host] ??= key;
    return out;
  }
  var EVM = /0x[0-9a-fA-F]{40}/;
  var SOLANA = /\/(?:token|account|address|mint)\/([1-9A-HJ-NP-Za-km-z]{32,44})/;
  function pageSubject(url) {
    let host;
    let segments;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      host = parsed.host.replace(/^www\./, "");
      segments = parsed.pathname.split("/").filter(Boolean);
    } catch {
      return null;
    }
    let chain = tokenPageHosts()[host] ?? null;
    if (!chain && MULTI_CHAIN_HOSTS.includes(host)) chain = PATH_SEGMENTS[(segments[0] ?? "").toLowerCase()] ?? null;
    if (!chain) return null;
    const family = CHAINS[chain]?.family ?? "evm";
    if (family === "solana") {
      const mint = SOLANA.exec(url)?.[1];
      return mint ? { chain, address: mint, kind: "solana" } : null;
    }
    const address = EVM.exec(url)?.[0];
    return address ? { chain, address: address.toLowerCase(), kind: "evm" } : null;
  }

  // <stdin>
  globalThis.__bouncerPageSubject = pageSubject;
})();
