/**
 * HOUSE RULES: the terms a launch trades under, read from the factory record
 * and the curve at one block, then said in plain words. Which fee goes to
 * whom, whether the creator can still change where their cut lands, whether
 * "buyback" burns anything (it does not: the vault vests bought-back tokens
 * back to creator and protocol over five years), what the quote asset is,
 * how far the curve is from graduating, and how much the deployer holds.
 */
import { FACTORY_EVENTS, GraduationPhase, PONS_V2_FACTORY, ZERO_ADDRESS, type LaunchedToken } from "../chain/pons.js";
import { PonsReader, readTokenMeta, type LaunchSnapshot } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, readTape } from "../chain/tape.js";
import { formatBps, formatPercent, formatUnits } from "../format.js";

export interface HouseRules {
  snapshot: LaunchSnapshot;
  quote: { symbol: string; decimals: number; native: boolean };
  /** Protocol curve fee + creator tax, in bps, charged on the quote leg of every curve trade. */
  curveFeeBps: bigint;
  creatorTaxBps: bigint;
  totalTradeBps: bigint;
  /** Pool fee for the graduated Uniswap V4 pool, in hundredths of a bip (uint24). */
  poolFeePpm: bigint;
  creatorFeeRecipient: string;
  creatorFeeRecipientChanges: { block: number; from: string; to: string }[];
  buybackEnabled: boolean;
  buybackChanges: { block: number; enabled: boolean }[];
  phase: GraduationPhase;
  fill: { real: bigint; threshold: bigint; bps: number } | null;
  deployerShareBps: number;
  /** The rules in words, one per line, in the order a person at the door would want them. */
  rules: string[];
}

export interface HouseRulesOptions {
  launchBlock: number;
  head: number;
  chunkSize?: number;
  factory?: string;
  /** What the zero pair token is called on this chain (ETH on Robinhood Chain, USDC on Arc). */
  native?: { symbol: string; decimals: number };
}

export async function readHouseRules(rpc: RpcClient, launch: LaunchedToken, options: HouseRulesOptions): Promise<HouseRules> {
  const factory = options.factory ?? PONS_V2_FACTORY;
  const reader = new PonsReader(rpc, factory);
  const snapshot = await reader.snapshot(launch.token, options.head);
  const native = launch.pairToken.toLowerCase() === ZERO_ADDRESS;
  const quote = native ? { ...(options.native ?? { symbol: "ETH", decimals: 18 }), native } : { ...(await readTokenMeta(rpc, launch.pairToken, options.head)), native };

  const history = await readTape(rpc, {
    fromBlock: options.launchBlock,
    toBlock: options.head,
    address: factory,
    events: [FACTORY_EVENTS.CreatorFeeRecipientUpdated, FACTORY_EVENTS.BuybackEnabledUpdated],
    topics: [addressTopic(launch.token)],
    chunkSize: options.chunkSize ?? 100_000,
  });
  const creatorFeeRecipientChanges = history.logs
    .filter((l) => l.name === "CreatorFeeRecipientUpdated")
    .map((l) => ({ block: l.blockNumber, from: String(l.args.previousRecipient).toLowerCase(), to: String(l.args.newRecipient).toLowerCase() }));
  const buybackChanges = history.logs
    .filter((l) => l.name === "BuybackEnabledUpdated")
    .map((l) => ({ block: l.blockNumber, enabled: Boolean(l.args.enabled) }));

  const curveFeeBps = snapshot.curve?.feeBps ?? 0n;
  const creatorTaxBps = launch.creatorTaxBps;
  const fill = snapshot.curve
    ? {
        real: snapshot.curve.realQuoteReserve,
        threshold: snapshot.curve.graduationThreshold,
        bps: snapshot.curve.graduationThreshold === 0n ? 0 : Number((snapshot.curve.realQuoteReserve * 10_000n) / snapshot.curve.graduationThreshold),
      }
    : null;
  const deployerShareBps = snapshot.token.totalSupply === 0n ? 0 : Number((snapshot.deployerBalance * 10_000n) / snapshot.token.totalSupply);

  const rules: HouseRules = {
    snapshot,
    quote,
    curveFeeBps,
    creatorTaxBps,
    totalTradeBps: curveFeeBps + creatorTaxBps,
    poolFeePpm: launch.poolFee,
    creatorFeeRecipient: launch.creatorFeeRecipient.toLowerCase(),
    creatorFeeRecipientChanges,
    buybackEnabled: launch.buybackEnabled,
    buybackChanges,
    phase: launch.phase,
    fill,
    deployerShareBps,
    rules: [],
  };
  rules.rules = houseRulesInWords(rules, launch);
  return rules;
}

export function houseRulesInWords(r: HouseRules, launch: LaunchedToken): string[] {
  const out: string[] = [];
  const q = r.quote.symbol;
  if (r.phase === GraduationPhase.NotGraduated) {
    out.push(`Every buy and sell on the curve pays ${formatBps(r.totalTradeBps)} of the ${q} leg: ${formatBps(r.curveFeeBps)} protocol fee + ${formatBps(r.creatorTaxBps)} creator tax.`);
  } else {
    out.push(`On the curve this launch charged ${formatBps(r.creatorTaxBps)} creator tax on top of the protocol fee; the graduated pool charges ${Number(r.poolFeePpm) / 10_000}% per swap through the Pons hook.`);
  }
  out.push(`The creator tax is paid to ${r.creatorFeeRecipient}${r.creatorFeeRecipientChanges.length ? `, changed ${r.creatorFeeRecipientChanges.length}× since launch` : ", unchanged since launch"}. The creator can move it again at any time.`);
  out.push(
    r.buybackEnabled
      ? "Buyback is on: a share of fees buys tokens back and locks them in a vault that vests them to the creator and the protocol over five years. Nothing is burned."
      : "Buyback is off: fees are split between the protocol and the creator, none is spent buying the token back.",
  );
  if (r.fill) {
    out.push(`Quote asset is ${q}. The curve holds ${formatUnits(r.fill.real, r.quote.decimals)} of the ${formatUnits(r.fill.threshold, r.quote.decimals)} ${q} it needs to graduate (${(r.fill.bps / 100).toFixed(1)}% full).`);
  } else if (r.phase === GraduationPhase.Swept) {
    out.push(`Quote asset is ${q}. The curve was swept at ${formatUnits(launch.sweptQuote, r.quote.decimals)} ${q}; the pool has not been created yet, so nothing trades right now.`);
  } else {
    out.push(`Quote asset is ${q}. Graduated: ${formatUnits(launch.sweptQuote, r.quote.decimals)} ${q} and the reserved tokens seeded a Uniswap V4 pool whose position is held by the Pons locker, not the creator.`);
  }
  out.push(`The deployer holds ${formatPercent(r.snapshot.deployerBalance, r.snapshot.token.totalSupply)} of supply at block ${r.snapshot.block.number}.`);
  return out;
}
