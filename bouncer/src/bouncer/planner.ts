/**
 * LAUNCH PLANNER: what a launch would look like under the factory's
 * current terms, before anything is signed. Reads the launch config, the
 * quote asset's economics, the launch fee, the creator tax ceiling, the
 * anti-snipe terms and the hook policy, then does the curve's own
 * arithmetic: starting price, graduation price, tokens sold on the curve,
 * tokens seeded into the pool, what the creator earns per unit of volume,
 * how the buyback leg is split, and what the door charges a buy in the
 * first second. Every number is derived from a read; none is a promise.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { FACTORY_FUNCTIONS, HOOK_FUNCTIONS, ZERO_ADDRESS } from "../chain/pons.js";
import { readTokenMeta } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";

export interface LaunchPlan {
  block: number;
  configId: number;
  configEnabled: boolean;
  pairToken: string;
  quote: { symbol: string; decimals: number };
  supply: bigint;
  curveFeeBps: bigint;
  creatorTaxBps: bigint;
  maxCreatorTaxBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFeePpm: bigint;
  tickSpacing: bigint;
  launchFee: bigint;
  hookFeeBps: bigint;
  protocolFeeShareBps: bigint;
  buybackBurnBps: bigint;
  snipe: { startBps: bigint; seconds: number };
  /** Quote wei per whole token at the first buy. */
  startPrice: bigint;
  /** Quote wei per whole token at the moment the curve fills. */
  graduationPrice: bigint;
  tokensSoldOnCurve: bigint;
  tokensToPool: bigint;
  /** Fully diluted value at graduation, in quote wei. */
  fdvAtGraduation: bigint;
  /** Creator's cut of one unit of quote traded on the curve, in bps of volume. */
  creatorPerVolumeBps: bigint;
  /** What a buy of `sampleBuy` pays at the door in the launch second, to the creator. */
  sampleBuy: bigint;
  sampleDoorCharge: bigint;
}

export interface PlanOptions {
  configId?: number;
  pairToken?: string;
  creatorTaxBps?: bigint;
  sampleBuy?: bigint;
  factory: string;
  block: number;
  nativeSymbol: string;
}

export async function readLaunchPlan(rpc: RpcClient, options: PlanOptions): Promise<LaunchPlan> {
  const f = options.factory;
  const configId = options.configId ?? 0;
  const pairToken = (options.pairToken ?? ZERO_ADDRESS).toLowerCase();
  const native = pairToken === ZERO_ADDRESS;
  const calls = [
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.getLaunchConfig, [BigInt(configId)]) },
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.launchFee, []) },
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.maxCreatorTaxBps, []) },
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxStartBps, []) },
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxSeconds, []) },
    { to: f, data: encodeCall(FACTORY_FUNCTIONS.memeHook, []) },
    ...(native ? [] : [{ to: f, data: encodeCall(FACTORY_FUNCTIONS.pairTokenEconomics, [pairToken]) }]),
  ];
  const r = await rpc.callBatch(calls, options.block);
  const [supply, curveFeeBps, phantomNative, thresholdNative, poolFee, tickSpacing, enabled] = decodeOutputs(FACTORY_FUNCTIONS.getLaunchConfig, r[0]) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
  const [launchFee] = decodeOutputs(FACTORY_FUNCTIONS.launchFee, r[1]) as [bigint];
  const [maxCreatorTaxBps] = decodeOutputs(FACTORY_FUNCTIONS.maxCreatorTaxBps, r[2]) as [bigint];
  const [startBps] = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxStartBps, r[3]) as [bigint];
  const [seconds] = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxSeconds, r[4]) as [bigint];
  const [hook] = decodeOutputs(FACTORY_FUNCTIONS.memeHook, r[5]) as [string];
  let phantomQuote = phantomNative;
  let graduationThreshold = thresholdNative;
  let quote = { symbol: options.nativeSymbol, decimals: 18 };
  if (!native) {
    const [p, t] = decodeOutputs(FACTORY_FUNCTIONS.pairTokenEconomics, r[6]) as [bigint, bigint, bigint];
    phantomQuote = p;
    graduationThreshold = t;
    quote = await readTokenMeta(rpc, pairToken, options.block);
  }
  let hookFeeBps = 0n;
  let protocolFeeShareBps = 0n;
  let buybackBurnBps = 0n;
  try {
    const [policyRaw] = await rpc.callBatch([{ to: hook, data: encodeCall(HOOK_FUNCTIONS.currentFeePolicy, []) }], options.block);
    const p = decodeOutputs(HOOK_FUNCTIONS.currentFeePolicy, policyRaw) as [string, bigint, bigint, bigint, bigint];
    protocolFeeShareBps = p[1];
    buybackBurnBps = p[2];
    hookFeeBps = p[3];
  } catch {
    /* hook policy unavailable: the plan still stands on the factory reads */
  }
  const creatorTaxBps = options.creatorTaxBps ?? 100n;
  if (creatorTaxBps > maxCreatorTaxBps) throw new Error(`creator tax ${creatorTaxBps} bps is above the factory ceiling of ${maxCreatorTaxBps} bps`);
  const reserved = phantomQuote + graduationThreshold === 0n ? 0n : (supply * phantomQuote) / (phantomQuote + graduationThreshold);
  const startPrice = supply === 0n ? 0n : (phantomQuote * 10n ** 18n) / supply;
  const graduationPrice = reserved === 0n ? 0n : ((phantomQuote + graduationThreshold) * 10n ** 18n) / reserved;
  const sampleBuy = options.sampleBuy ?? 10n ** BigInt(quote.decimals) / 10n;
  return {
    block: options.block,
    configId,
    configEnabled: enabled,
    pairToken,
    quote,
    supply,
    curveFeeBps,
    creatorTaxBps,
    maxCreatorTaxBps,
    phantomQuote,
    graduationThreshold,
    poolFeePpm: poolFee,
    tickSpacing,
    launchFee,
    hookFeeBps,
    protocolFeeShareBps,
    buybackBurnBps,
    snipe: { startBps, seconds: Number(seconds) },
    startPrice,
    graduationPrice,
    tokensSoldOnCurve: supply - reserved,
    tokensToPool: reserved,
    fdvAtGraduation: (graduationPrice * supply) / 10n ** 18n,
    creatorPerVolumeBps: creatorTaxBps,
    sampleBuy,
    sampleDoorCharge: (sampleBuy * startBps) / 10_000n,
  };
}
