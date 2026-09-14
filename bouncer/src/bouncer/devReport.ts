/**
 * DEV REPORT CARD: what this deployer did before. Every launch the factory
 * recorded for the address inside the window (the deployer is an indexed
 * topic of TokenLaunched, so the read is narrow), each with its phase today,
 * its creator tax, its symbol and, for graduates, seconds from launch to
 * sweep. Counts and a median; no score, no label for the person.
 */
import { decodeOutputs, encodeCall, normalizeAddress } from "../chain/abi.js";
import { ERC20_FUNCTIONS, FACTORY_EVENTS, FACTORY_FUNCTIONS, GraduationPhase, PONS_V2_FACTORY, decodeLaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, readTapeAdaptive, type AdaptiveChunking } from "../chain/tape.js";

export interface DevLaunch {
  token: string;
  curve: string;
  symbol: string;
  launchedBlock: number;
  launchedAt: number;
  phase: GraduationPhase;
  creatorTaxBps: bigint;
  /** Unix timestamp of the sweep, from the factory record; 0 when not swept. */
  sweptAt: number;
  secondsToSweep: number | null;
}

export interface DevReport {
  deployer: string;
  window: { fromBlock: number; toBlock: number };
  /** Newest first. Capped; `truncated` says whether older launches were left out. */
  launches: DevLaunch[];
  truncated: boolean;
  counts: { launched: number; graduated: number; swept: number; onCurve: number };
  medianSecondsToSweep: number | null;
  /** Symbols this deployer launched more than once inside the window. */
  repeatedSymbols: string[];
  taxRangeBps: [bigint, bigint] | null;
}

export interface DevReportOptions {
  fromBlock: number;
  toBlock: number;
  /** Most launches to detail; the count still covers the whole window. */
  limit?: number;
  chunking?: AdaptiveChunking;
  factory?: string;
}

export async function readDevReport(rpc: RpcClient, deployer: string, options: DevReportOptions): Promise<DevReport> {
  const address = normalizeAddress(deployer);
  const factory = options.factory ?? PONS_V2_FACTORY;
  const tape = await readTapeAdaptive(
    rpc,
    { fromBlock: options.fromBlock, toBlock: options.toBlock, address: factory, events: [FACTORY_EVENTS.TokenLaunched], topics: [null, null, addressTopic(address)] },
    options.chunking,
  );
  const all = tape.logs.slice().reverse();
  const limit = options.limit ?? 40;
  const detailed = all.slice(0, limit);

  const records = detailed.length
    ? await rpc.callBatch(
        detailed.map((l) => ({ to: factory, data: encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [String(l.args.token)]) })),
        options.toBlock,
      )
    : [];
  const symbols = detailed.length
    ? await rpc.callBatch(detailed.map((l) => ({ to: String(l.args.token), data: encodeCall(ERC20_FUNCTIONS.symbol, []) })), options.toBlock)
    : [];

  const launches: DevLaunch[] = [];
  for (let i = 0; i < detailed.length; i++) {
    const log = detailed[i];
    const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, records[i]));
    let symbol = "?";
    try {
      symbol = (decodeOutputs(ERC20_FUNCTIONS.symbol, symbols[i]) as [string])[0];
    } catch {
      symbol = "?";
    }
    const header = await rpc.getBlock(log.blockNumber);
    const sweptAt = Number(record.sweptAt);
    launches.push({
      token: String(log.args.token).toLowerCase(),
      curve: String(log.args.curve).toLowerCase(),
      symbol,
      launchedBlock: log.blockNumber,
      launchedAt: header.timestamp,
      phase: record.phase,
      creatorTaxBps: record.creatorTaxBps,
      sweptAt,
      secondsToSweep: sweptAt > 0 ? Math.max(0, sweptAt - header.timestamp) : null,
    });
  }

  const counts = { launched: all.length, graduated: 0, swept: 0, onCurve: 0 };
  for (const l of launches) {
    if (l.phase === GraduationPhase.PoolCreated || l.phase === GraduationPhase.Rescued) counts.graduated++;
    else if (l.phase === GraduationPhase.Swept) counts.swept++;
    else counts.onCurve++;
  }
  const sweeps = launches.map((l) => l.secondsToSweep).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const seen = new Map<string, number>();
  for (const l of launches) seen.set(l.symbol.toUpperCase(), (seen.get(l.symbol.toUpperCase()) ?? 0) + 1);
  const taxes = launches.map((l) => l.creatorTaxBps);

  return {
    deployer: address,
    window: { fromBlock: options.fromBlock, toBlock: options.toBlock },
    launches,
    truncated: all.length > detailed.length,
    counts,
    medianSecondsToSweep: sweeps.length ? sweeps[Math.floor(sweeps.length / 2)] : null,
    repeatedSymbols: [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s),
    taxRangeBps: taxes.length ? [taxes.reduce((a, b) => (a < b ? a : b)), taxes.reduce((a, b) => (a > b ? a : b))] : null,
  };
}

export function devReportLine(d: DevReport): string {
  const c = d.counts;
  if (c.launched === 0) return "first launch from this address in the window";
  const parts = [`${c.launched} launch${c.launched === 1 ? "" : "es"}`, `${c.graduated} graduated`];
  if (c.swept) parts.push(`${c.swept} swept, no pool`);
  if (c.onCurve) parts.push(`${c.onCurve} still on the curve`);
  if (d.repeatedSymbols.length) parts.push(`same ticker ${d.repeatedSymbols.length}×`);
  return parts.join(" · ");
}
