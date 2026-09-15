/**
 * Pons V2 on Robinhood Chain: addresses, event shapes and view calls,
 * transcribed from the published contract sources
 * (github.com/ponsdotdev/ponsfamily, contractsV2/src/v2). Only the surface a
 * reader needs is described here.
 */
import type { EventAbi, FunctionAbi } from "./abi.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER = "https://robinhoodchain.blockscout.com";
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase();
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Pons V1 (PonsLaunchFactory): fixed-supply tokens with a Uniswap V3 pool from the first block. */
export const PONS_V1_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase();

/** IPonsV2LaunchFactory.LaunchedToken, field order as declared on-chain. */
export interface LaunchedToken {
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  graduationThreshold: bigint;
  poolFee: bigint;
  tickSpacing: bigint;
  creatorTaxBps: bigint;
  buybackEnabled: boolean;
  phase: GraduationPhase;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
}

export enum GraduationPhase {
  NotGraduated = 0,
  Swept = 1,
  PoolCreated = 2,
  Rescued = 3,
}

export const PHASE_LABEL: Record<GraduationPhase, string> = {
  [GraduationPhase.NotGraduated]: "curve",
  [GraduationPhase.Swept]: "swept",
  [GraduationPhase.PoolCreated]: "pool",
  [GraduationPhase.Rescued]: "rescued",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const FACTORY_EVENTS = {
  TokenLaunched: {
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "deployer", type: "address", indexed: true },
      { name: "pairToken", type: "address", indexed: false },
      { name: "launchConfigId", type: "uint256", indexed: false },
      { name: "graduationThreshold", type: "uint256", indexed: false },
    ],
  },
  LaunchSwept: {
    name: "LaunchSwept",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
  PoolGraduated: {
    name: "PoolGraduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "tokenAmount", type: "uint256", indexed: false },
      { name: "pairTokenAmount", type: "uint256", indexed: false },
    ],
  },
  /** Older factory deployments emitted this shape; both are read. */
  PoolGraduatedLegacy: {
    name: "PoolGraduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: false },
    ],
  },
  CreatorFeeRecipientUpdated: {
    name: "CreatorFeeRecipientUpdated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "previousRecipient", type: "address", indexed: true },
      { name: "newRecipient", type: "address", indexed: true },
    ],
  },
  SnipeTaxStartBpsUpdated: {
    name: "SnipeTaxStartBpsUpdated",
    inputs: [{ name: "bps", type: "uint256", indexed: false }],
  },
  SnipeTaxSecondsUpdated: {
    name: "SnipeTaxSecondsUpdated",
    inputs: [{ name: "secondsWindow", type: "uint256", indexed: false }],
  },
  BuybackEnabledUpdated: {
    name: "BuybackEnabledUpdated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "enabled", type: "bool", indexed: false },
      { name: "controller", type: "address", indexed: true },
    ],
  },
} as const satisfies Record<string, EventAbi>;

export const FACTORY_FUNCTIONS = {
  getLaunchedToken: {
    name: "getLaunchedToken",
    inputs: ["address"],
    outputs: [
      "address", // token
      "address", // curve
      "address", // deployer
      "address", // creatorFeeRecipient
      "address", // pairToken
      "uint256", // graduationThreshold
      "uint24", // poolFee
      "int24", // tickSpacing
      "uint16", // creatorTaxBps
      "bool", // buybackEnabled
      "uint8", // phase
      "uint256", // sweptQuote
      "uint256", // sweptTokens
      "uint256", // sweptAt
      "bool", // exists
    ],
  },
  snipeTaxStartBps: { name: "snipeTaxStartBps", inputs: [], outputs: ["uint256"] },
  snipeTaxSeconds: { name: "snipeTaxSeconds", inputs: [], outputs: ["uint256"] },
  maxCreatorTaxBps: { name: "maxCreatorTaxBps", inputs: [], outputs: ["uint256"] },
  poolManager: { name: "poolManager", inputs: [], outputs: ["address"] },
  memeHook: { name: "memeHook", inputs: [], outputs: ["address"] },
  launchFee: { name: "launchFee", inputs: [], outputs: ["uint256"] },
  launchConfigCount: { name: "launchConfigCount", inputs: [], outputs: ["uint256"] },
  /** LaunchConfig struct: supply, curveFeeBps, phantomQuote, graduationThreshold, poolFee, tickSpacing, enabled. */
  getLaunchConfig: { name: "getLaunchConfig", inputs: ["uint256"], outputs: ["uint256", "uint256", "uint256", "uint256", "uint24", "int24", "bool"] },
  /** PairTokenEconomics struct: phantomQuote, graduationThreshold, decimals. */
  pairTokenEconomics: { name: "pairTokenEconomics", inputs: ["address"], outputs: ["uint256", "uint256", "uint8"] },
} as const satisfies Record<string, FunctionAbi>;

// ---------------------------------------------------------------------------
// Pons V1 (PonsLaunchFactory): a different design, kept readable so a V1
// token is "on the list" too rather than a false NOT ON THE LIST.
// ---------------------------------------------------------------------------

export interface V1LaunchedToken {
  token: string;
  deployer: string;
  pairedToken: string;
  positionManager: string;
  positionId: bigint;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  supply: bigint;
  isToken0: boolean;
  poolFee: bigint;
  exists: boolean;
  initialBuyAmount: bigint;
}

export const V1_FACTORY_FUNCTIONS = {
  getLaunchedToken: {
    name: "getLaunchedToken",
    inputs: ["address"],
    outputs: ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "uint24", "bool", "uint256"],
  },
  /** pairedPrincipal, threshold, graduated */
  graduationStatus: { name: "graduationStatus", inputs: ["address"], outputs: ["uint256", "uint256", "bool"] },
  /** pairToken, graduationThreshold, initialTick, supply, maxWalletBps, maxTxBps, restrictionBlocks, reservedFee, enabled, routerRequiresDeadline */
  getLaunchConfig: { name: "getLaunchConfig", inputs: ["uint256"], outputs: ["address", "uint256", "int24", "uint256", "uint16", "uint16", "uint32", "uint24", "bool", "bool"] },
  locker: { name: "locker", inputs: [], outputs: ["address"] },
} as const satisfies Record<string, FunctionAbi>;

export const V1_FACTORY_EVENTS = {
  TokenLaunched: {
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "deployer", type: "address", indexed: true },
      { name: "dexFactory", type: "address", indexed: true },
      { name: "pairToken", type: "address", indexed: false },
      { name: "pool", type: "address", indexed: false },
      { name: "dexId", type: "uint256", indexed: false },
      { name: "launchConfigId", type: "uint256", indexed: false },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "restrictionsEndBlock", type: "uint256", indexed: false },
      { name: "initialBuyAmount", type: "uint256", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

export function decodeV1LaunchedToken(values: unknown[]): V1LaunchedToken {
  const [token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount] = values as [string, string, string, string, bigint, bigint, bigint, bigint, bigint, boolean, bigint, boolean, bigint];
  return { token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount };
}

/** PonsV2MemeHook: the fee policy the factory snapshots at launch. */
export const HOOK_FUNCTIONS = {
  /** FeePolicySnapshot: protocolFeeRecipient, protocolFeeShareBps, buybackBurnBps, hookFeeBps, maxInternalPriceImpactBps. */
  currentFeePolicy: { name: "currentFeePolicy", inputs: [], outputs: ["address", "uint16", "uint16", "uint16", "uint16"] },
} as const satisfies Record<string, FunctionAbi>;

export function decodeLaunchedToken(values: unknown[]): LaunchedToken {
  const [
    token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold,
    poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase, sweptQuote,
    sweptTokens, sweptAt, exists,
  ] = values as [string, string, string, string, string, bigint, bigint, bigint, bigint, boolean, bigint, bigint, bigint, bigint, boolean];
  return {
    token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold,
    poolFee, tickSpacing, creatorTaxBps, buybackEnabled,
    phase: Number(phase) as GraduationPhase,
    sweptQuote, sweptTokens, sweptAt, exists,
  };
}

// ---------------------------------------------------------------------------
// Bonding curve
// ---------------------------------------------------------------------------

export const CURVE_EVENTS = {
  CurveBuy: {
    name: "CurveBuy",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "quoteIn", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  CurveSell: {
    name: "CurveSell",
    inputs: [
      { name: "seller", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "tokensIn", type: "uint256", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  FeesSwept: {
    name: "FeesSwept",
    inputs: [
      { name: "protocolAmount", type: "uint256", indexed: false },
      { name: "buybackAmount", type: "uint256", indexed: false },
      { name: "creatorAmount", type: "uint256", indexed: false },
    ],
  },
  BuybackLocked: {
    name: "BuybackLocked",
    inputs: [
      { name: "quoteSpent", type: "uint256", indexed: false },
      { name: "tokensLocked", type: "uint256", indexed: false },
    ],
  },
  CurveCompleted: {
    name: "CurveCompleted",
    inputs: [
      { name: "recipient", type: "address", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

export const CURVE_FUNCTIONS = {
  getReserves: { name: "getReserves", inputs: [], outputs: ["uint256", "uint256"] },
  realQuoteReserve: { name: "realQuoteReserve", inputs: [], outputs: ["uint256"] },
  graduationThreshold: { name: "graduationThreshold", inputs: [], outputs: ["uint256"] },
  readyToGraduate: { name: "readyToGraduate", inputs: [], outputs: ["bool"] },
  graduated: { name: "graduated", inputs: [], outputs: ["bool"] },
  phantomQuote: { name: "phantomQuote", inputs: [], outputs: ["uint256"] },
  feeBps: { name: "feeBps", inputs: [], outputs: ["uint256"] },
  creatorTaxBps: { name: "creatorTaxBps", inputs: [], outputs: ["uint256"] },
  sellableTokens: { name: "sellableTokens", inputs: [], outputs: ["uint256"] },
  quoteFeeBalance: { name: "quoteFeeBalance", inputs: [], outputs: ["uint256"] },
  creatorTaxBalance: { name: "creatorTaxBalance", inputs: [], outputs: ["uint256"] },
  buybackQuoteBalance: { name: "buybackQuoteBalance", inputs: [], outputs: ["uint256"] },
  deployer: { name: "deployer", inputs: [], outputs: ["address"] },
  token: { name: "token", inputs: [], outputs: ["address"] },
  pairToken: { name: "pairToken", inputs: [], outputs: ["address"] },
  isNativeQuote: { name: "isNativeQuote", inputs: [], outputs: ["bool"] },
} as const satisfies Record<string, FunctionAbi>;

// ---------------------------------------------------------------------------
// ERC-20 and buyback vault
// ---------------------------------------------------------------------------

export const ERC20_FUNCTIONS = {
  name: { name: "name", inputs: [], outputs: ["string"] },
  symbol: { name: "symbol", inputs: [], outputs: ["string"] },
  decimals: { name: "decimals", inputs: [], outputs: ["uint8"] },
  totalSupply: { name: "totalSupply", inputs: [], outputs: ["uint256"] },
  balanceOf: { name: "balanceOf", inputs: ["address"], outputs: ["uint256"] },
} as const satisfies Record<string, FunctionAbi>;

export const ERC20_EVENTS = {
  Transfer: {
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

export const BUYBACK_VAULT_FUNCTIONS = {
  totalLocked: { name: "totalLocked", inputs: ["address"], outputs: ["uint256"] },
  totalReleased: { name: "totalReleased", inputs: ["address"], outputs: ["uint256"] },
  vestingStart: { name: "vestingStart", inputs: ["address"], outputs: ["uint256"] },
  vestedAmount: { name: "vestedAmount", inputs: ["address"], outputs: ["uint256"] },
  releasable: { name: "releasable", inputs: ["address"], outputs: ["uint256"] },
} as const satisfies Record<string, FunctionAbi>;

/**
 * Constant-product quote used by PonsV2BondingCurveMath.getAmountOut. Fee is
 * charged on the input leg in basis points. Returns 0n where the contract
 * would revert, so callers treat "unpriceable" as a state, not a crash.
 */
export function curveAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n || feeBps >= 10_000n) return 0n;
  const amountInWithFee = amountIn * (10_000n - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * 10_000n + amountInWithFee);
}
