/**
 * The chains BOUNCER knows. Pons V2 was written to be deployed on more than
 * one chain ("any chain this deploys to", in the factory's own comments);
 * Radian is a faithful port of it on Circle's Arc, quoted in native USDC.
 * Everything chain-specific lives here: id, RPC, explorer, the factory, and
 * what the native quote asset is called. The read path is the same.
 */
export interface ChainConfig {
  /** Short key used on the CLI (`--chain arc`) and in site links. */
  key: string;
  name: string;
  chainId: number;
  rpc: string[];
  /** Blockscout instance base URL (used for links and the funding-source read), or null. */
  blockscout: string | null;
  /** Launchpad factory (PonsV2LaunchFactory or its port), lower-cased, or null when not published yet. */
  factory: string | null;
  /** The older Pons V1 factory on this chain, when there is one; V1 tokens are read from it so they are not called impostors. */
  factoryV1?: string;
  launchpad: string;
  native: { symbol: string; decimals: number };
  /** Roughly how many blocks per second, for "the last N hours" estimates before pinning to headers. */
  blocksPerSecond: number;
  notes?: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    rpc: ["https://rpc.mainnet.chain.robinhood.com"],
    blockscout: "https://robinhoodchain.blockscout.com",
    factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase(),
    factoryV1: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase(),
    launchpad: "Pons V2",
    native: { symbol: "ETH", decimals: 18 },
    blocksPerSecond: 10,
  },
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc Testnet",
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
    chainId: 5042,
    rpc: ["https://rpc.arc-scan.org"],
    blockscout: null,
    factory: null,
    launchpad: "Radian (Pons V2 port)",
    native: { symbol: "USDC", decimals: 18 },
    blocksPerSecond: 1,
    notes: "Mainnet opens 2026-09-16. The Radian mainnet factory is not published yet: pass --factory 0x… (CLI) or set it in the site's live settings once it is.",
  },
};

export const DEFAULT_CHAIN = CHAINS.robinhood;

export function chainByKey(key: string | undefined): ChainConfig {
  if (!key) return DEFAULT_CHAIN;
  const found = CHAINS[key.toLowerCase()];
  if (!found) throw new Error(`unknown chain ${key}; known: ${Object.keys(CHAINS).join(", ")}`);
  return found;
}

export function chainById(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}

/** Explorer link for an address on this chain, or null when the chain has no known explorer. */
export function explorerAddress(chain: ChainConfig, address: string): string | null {
  return chain.blockscout ? `${chain.blockscout}/address/${address}` : null;
}
