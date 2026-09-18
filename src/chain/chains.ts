/**
 * The chains BOUNCER knows.
 *
 * Two things vary and both live here. The first is the launchpad: Pons V2 was
 * written to be deployed on more than one chain, Radian is a faithful port of
 * it on Circle's Arc, and most chains have no launchpad BOUNCER knows at all.
 * Where there is one, its factory record is the genuineness test; where there
 * is none, every token is simply an ordinary token and is checked as one.
 *
 * The second is the family. An EVM chain is read with eth_call and eth_getLogs
 * against bytecode; Solana is read with getAccountInfo against account layouts,
 * where the questions that matter (can they mint more, can they freeze you) are
 * explicit fields rather than things inferred from a dispatcher. The two read
 * paths are separate on purpose, and `family` is what picks between them.
 */

/** How this chain is read. */
export type ChainFamily = "evm" | "solana";

/** A Uniswap V3-style factory: getPool(tokenA, tokenB, fee). Fee tiers differ per deployment. */
export interface V3Factory {
  name: string;
  address: string;
  /** Fee tiers to ask for, in hundredths of a basis point. PancakeSwap uses 2500 where Uniswap uses 3000. */
  feeTiers?: number[];
}

/** A Uniswap V2-style factory: getPair(tokenA, tokenB). Most memecoin liquidity outside Robinhood Chain still lives here. */
export interface V2Factory {
  name: string;
  address: string;
}

/** A Solidly-style factory (Aerodrome, Velodrome, Thena): getPool(tokenA, tokenB, stable). */
export interface SolidlyFactory {
  name: string;
  address: string;
}

export interface DexTable {
  /** The wrapped native token every pool is looked up against. */
  weth: string;
  /** What to call it in a sentence: WETH, WBNB. */
  wethSymbol: string;
  v3Factories?: V3Factory[];
  v2Factories?: V2Factory[];
  solidlyFactories?: SolidlyFactory[];
  /**
   * The NonfungiblePositionManager that holds V3 positions as NFTs. Without it
   * a V3 position can be found but not traced to whoever actually holds it, so
   * the liquidity read says so rather than guessing.
   */
  v3PositionManager?: string;
}

/**
 * Contracts that hold liquidity on somebody's behalf with a timer: address to
 * the name to print. Only addresses that have been checked belong here. An
 * address in this table is reported as locked, so a wrong entry would tell
 * somebody their money is safe when it is not — the one mistake this file must
 * never make. An unknown contract is deliberately NOT treated as a lock.
 */
export type LockerTable = Record<string, string>;

/**
 * No chain carries a third-party locker table yet, and that is deliberate
 * rather than unfinished. Naming a contract here makes BOUNCER report the
 * liquidity it holds as safe, so every entry has to be an address somebody has
 * actually checked on that chain — not one recalled from a docs page. Until
 * one is checked, a locker is read the same way as any other contract holding
 * the liquidity: named by address, counted as withdrawable, and said so in
 * words. That is wrong in the cautious direction.
 *
 * The launchpad's own locker is not in here because it does not need to be:
 * the Pons V1 factory answers `locker()` on chain, which is exact.
 */

export interface ChainConfig {
  /** Short key used on the CLI (`--chain base`) and in site links. */
  key: string;
  name: string;
  family: ChainFamily;
  /** EVM chain id, checked against the endpoint before any read. 0 on non-EVM chains. */
  chainId: number;
  rpc: string[];
  /** Blockscout instance base URL (used for links, holders, the funding-source read), or null. */
  blockscout: string | null;
  /** An explorer for links only, when there is no machine-readable one. */
  explorerUrl?: string;
  /** Launchpad factory (PonsV2LaunchFactory or its port), lower-cased, or null when this chain has none. */
  factory: string | null;
  /** The older Pons V1 factory on this chain, when there is one; V1 tokens are read from it so they are not called impostors. */
  factoryV1?: string;
  /** Earlier V1 factory deployments (same read surface); a token that names one of them as its launchFactory() is read from it. */
  olderFactoriesV1?: string[];
  /** The launchpad's name, or null when BOUNCER knows no launchpad here. */
  launchpad: string | null;
  native: { symbol: string; decimals: number };
  /** Roughly how many blocks per second, for "the last N hours" estimates before pinning to headers. */
  blocksPerSecond: number;
  notes?: string;
  /** Well-known contracts that are not launchpad tokens, so the door can say what they are instead of just "not on the list". */
  known?: Record<string, string>;
  /** Where ordinary tokens trade on this chain. */
  dex?: DexTable;
  /** Contracts that hold liquidity with a timer, by address. See LockerTable. */
  lockers?: LockerTable;
}

export const CHAINS: Record<string, ChainConfig> = {
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    family: "evm",
    chainId: 4663,
    rpc: ["https://rpc.mainnet.chain.robinhood.com"],
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
      "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "the Pons V1 launch factory itself, not a token.",
    },
    dex: {
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase(),
      wethSymbol: "WETH",
      v3Factories: [{ name: "Uniswap V3", address: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA".toLowerCase() }],
      v3PositionManager: "0x943e6b11d6a2a0dD87eC5E23Cf58A63A8D9Ec2B7".toLowerCase(),
    },
  },
  base: {
    key: "base",
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
      v3PositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1".toLowerCase(),
    },
  },
  bnb: {
    key: "bnb",
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
        { name: "PancakeSwap V3", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865".toLowerCase(), feeTiers: [100, 500, 2_500, 10_000] },
        { name: "Uniswap V3", address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7".toLowerCase() },
      ],
      v2Factories: [{ name: "PancakeSwap V2", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73".toLowerCase() }],
      v3PositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364".toLowerCase(),
    },
  },
  solana: {
    key: "solana",
    name: "Solana",
    family: "solana",
    chainId: 0,
    rpc: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://solana.drpc.org"],
    blockscout: null,
    explorerUrl: "https://solscan.io",
    factory: null,
    launchpad: null,
    native: { symbol: "SOL", decimals: 9 },
    blocksPerSecond: 2.5,
    notes: "Read as SPL: the mint account says outright whether anyone can print more tokens or freeze yours, and Token-2022 extensions say whether a transfer costs a fee, runs someone's code, or can be reversed by a permanent delegate. Where it trades is read too: the pump.fun bonding curve exactly, and Raydium, Orca, Meteora and pump.fun AMM pools against SOL or USDC. A ranged pool is shown but not priced, because its vault balances are not what a trade moves through.",
  },
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc Testnet",
    family: "evm",
    chainId: 5042002,
    rpc: ["https://rpc.testnet.arc.network", "https://rpc.testnet.arc.io"],
    blockscout: "https://testnet.arcscan.app",
    factory: "0x90022cC2107De9c070F889E3A67009FcA270E4E2".toLowerCase(),
    launchpad: "Radian (Pons V2 port)",
    native: { symbol: "USDC", decimals: 18 },
    blocksPerSecond: 1,
    notes: "Native USDC is the gas and quote asset, counted in 18-decimal native units on chain (the ERC-20 view shows 6).",
  },
  arc: {
    key: "arc",
    name: "Arc",
    family: "evm",
    chainId: 5042,
    rpc: ["https://rpc.arc-scan.org"],
    blockscout: null,
    factory: null,
    launchpad: "Radian (Pons V2 port)",
    native: { symbol: "USDC", decimals: 18 },
    blocksPerSecond: 1,
    notes: "The Radian mainnet factory is not published yet: pass --factory 0x… (CLI) or set it in the site's live settings once it is. Every check that needs no factory runs regardless.",
  },
};

export const DEFAULT_CHAIN = CHAINS.robinhood;

/** Uniswap's standard fee tiers, used by any V3 factory that does not name its own. */
export const DEFAULT_V3_FEE_TIERS = [100, 500, 3_000, 10_000];

export function chainByKey(key: string | undefined): ChainConfig {
  if (!key) return DEFAULT_CHAIN;
  const found = CHAINS[key.toLowerCase()];
  if (!found) throw new Error(`unknown chain ${key}; known: ${Object.keys(CHAINS).join(", ")}`);
  return found;
}

export function chainById(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.family === "evm" && c.chainId === chainId);
}

/** Explorer link for an address on this chain, or null when the chain has no known explorer. */
export function explorerAddress(chain: ChainConfig, address: string): string | null {
  if (chain.blockscout) return `${chain.blockscout}/address/${address}`;
  if (chain.explorerUrl) return chain.family === "solana" ? `${chain.explorerUrl}/token/${address}` : `${chain.explorerUrl}/address/${address}`;
  return null;
}
