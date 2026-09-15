/**
 * Pons V1: the older launchpad on Robinhood Chain. Different design (a
 * fixed-supply token paired into a Uniswap V3 pool from the first block,
 * with per-wallet and per-transaction caps for a number of blocks), same
 * question at the door: did the factory make this token, and what are the
 * rules? Read from the V1 factory so a V1 token is on the list with its
 * own terms rather than wrongly bounced.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { V1_FACTORY_FUNCTIONS, ZERO_ADDRESS, decodeV1LaunchedToken, type V1LaunchedToken } from "../chain/pons.js";
import { readTokenMeta } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { formatBps, formatUnits } from "../format.js";

export interface V1Launch {
  factory: string;
  record: V1LaunchedToken;
  quote: { symbol: string; decimals: number };
  status: { pairedPrincipal: bigint; threshold: bigint; graduated: boolean };
  config: { maxWalletBps: bigint; maxTxBps: bigint; restrictionBlocks: bigint; reservedFee: bigint; supply: bigint } | null;
  locker: string | null;
  /** Blocks until the wallet and transaction caps lift; 0 when they already have. */
  restrictionBlocksLeft: number;
  rules: string[];
}

export async function readV1Launch(rpc: RpcClient, factory: string, token: string, block: number, native: { symbol: string; decimals: number }): Promise<V1Launch | null> {
  const [raw] = await rpc.callBatch([{ to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.getLaunchedToken, [token]) }], block);
  const record = decodeV1LaunchedToken(decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchedToken, raw));
  if (!record.exists) return null;
  const [statusRaw, configRaw, lockerRaw] = await rpc.callBatch(
    [
      { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.graduationStatus, [token]) },
      { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.getLaunchConfig, [record.launchConfigId]) },
      { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.locker, []) },
    ],
    block,
  ).catch(() => [null, null, null] as (`0x${string}` | null)[]);
  const [pairedPrincipal, threshold, graduated] = statusRaw ? (decodeOutputs(V1_FACTORY_FUNCTIONS.graduationStatus, statusRaw) as [bigint, bigint, boolean]) : [0n, 0n, false];
  let config: V1Launch["config"] = null;
  if (configRaw) {
    try {
      const c = decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchConfig, configRaw) as [string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
      config = { maxWalletBps: c[4], maxTxBps: c[5], restrictionBlocks: c[6], reservedFee: c[7], supply: c[3] };
    } catch {
      config = null;
    }
  }
  let locker: string | null = null;
  if (lockerRaw) {
    try {
      locker = (decodeOutputs(V1_FACTORY_FUNCTIONS.locker, lockerRaw)[0] as string).toLowerCase();
    } catch {
      locker = null;
    }
  }
  const pairedNative = record.pairedToken.toLowerCase() === ZERO_ADDRESS;
  let quote = native;
  if (!pairedNative) {
    try {
      quote = await readTokenMeta(rpc, record.pairedToken, block);
    } catch {
      quote = { symbol: `${record.pairedToken.slice(0, 8)}…`, decimals: 18 };
    }
  }
  const restrictionBlocksLeft = Math.max(0, Number(record.restrictionsEndBlock) - block);
  const launch: V1Launch = { factory, record, quote, status: { pairedPrincipal, threshold, graduated }, config, locker, restrictionBlocksLeft, rules: [] };
  launch.rules = v1RulesInWords(launch, block);
  return launch;
}

export function v1RulesInWords(l: V1Launch, block: number): string[] {
  const out: string[] = [];
  const q = l.quote;
  out.push(`Pons V1 launch: the whole supply of ${formatUnits(l.record.supply, 18, 0)} tokens was paired into a Uniswap V3 pool (fee ${Number(l.record.poolFee) / 10_000}%) at launch. There is no bonding curve; it has traded in the pool from the first block.`);
  if (l.config) {
    out.push(
      l.restrictionBlocksLeft > 0
        ? `Launch caps are still on for ${l.restrictionBlocksLeft} more blocks (until block ${l.record.restrictionsEndBlock}): no wallet may hold more than ${formatBps(l.config.maxWalletBps)} of supply and no single trade may move more than ${formatBps(l.config.maxTxBps)}.`
        : `The launch caps (max ${formatBps(l.config.maxWalletBps)} per wallet, ${formatBps(l.config.maxTxBps)} per trade for ${l.config.restrictionBlocks} blocks) lifted at block ${l.record.restrictionsEndBlock}.`,
    );
  }
  out.push(
    l.status.graduated
      ? `Graduated: the pool holds ${formatUnits(l.status.pairedPrincipal, q.decimals)} ${q.symbol} of principal, past the ${formatUnits(l.status.threshold, q.decimals)} ${q.symbol} threshold.`
      : `Not graduated yet: ${formatUnits(l.status.pairedPrincipal, q.decimals)} of the ${formatUnits(l.status.threshold, q.decimals)} ${q.symbol} threshold is in the pool.`,
  );
  out.push(`The liquidity position (#${l.record.positionId}) is held by the launchpad's locker${l.locker ? ` ${l.locker}` : ""}; the creator cannot pull it.`);
  if (l.record.initialBuyAmount > 0n) out.push(`The deployer bought ${formatUnits(l.record.initialBuyAmount, q.decimals)} ${q.symbol} worth in the launch transaction.`);
  out.push(`Read at block ${block}. V1 has no creator tax and no door tax; V2 tools (curve, cover charge, exit door) do not apply.`);
  return out;
}
