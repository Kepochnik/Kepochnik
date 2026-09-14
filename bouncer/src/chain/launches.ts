/**
 * Launch ledger: every Pons V2 launch, sweep and graduation the factory
 * emitted inside a block window, joined per token. This is the shared spine
 * for anything that reasons about "what launched, what graduated, what died".
 */
import { FACTORY_EVENTS, PONS_V2_FACTORY } from "./pons.js";
import type { RpcClient } from "./rpc.js";
import { readTape, type TapeRequest } from "./tape.js";

export interface LaunchRecord {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  launchedAt: { block: number; logIndex: number; tx: string };
  sweptAt?: { block: number; quoteOut: bigint; tokenOut: bigint };
  graduatedAt?: { block: number; positionId: bigint; tokenAmount: bigint; pairTokenAmount: bigint; poolId: string | null };
}

export interface LaunchLedger {
  fromBlock: number;
  toBlock: number;
  launches: LaunchRecord[];
  /** Graduations whose launch happened before the window (still useful as events). */
  graduationsOutsideWindow: { token: string; block: number }[];
  chunks: number;
}

export async function readLaunchLedger(
  rpc: RpcClient,
  window: { fromBlock: number; toBlock: number; chunkSize?: number },
  factory: string = PONS_V2_FACTORY,
): Promise<LaunchLedger> {
  const request: TapeRequest = {
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    chunkSize: window.chunkSize,
    address: factory,
    events: [FACTORY_EVENTS.TokenLaunched, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy],
  };
  const tape = await readTape(rpc, request);
  const byToken = new Map<string, LaunchRecord>();
  const outside: { token: string; block: number }[] = [];

  for (const log of tape.logs) {
    const token = String(log.args.token);
    if (log.name === "TokenLaunched") {
      byToken.set(token, {
        token,
        curve: String(log.args.curve),
        deployer: String(log.args.deployer),
        pairToken: String(log.args.pairToken),
        launchConfigId: log.args.launchConfigId as bigint,
        graduationThreshold: log.args.graduationThreshold as bigint,
        launchedAt: { block: log.blockNumber, logIndex: log.logIndex, tx: log.transactionHash },
      });
    } else if (log.name === "LaunchSwept") {
      const record = byToken.get(token);
      if (record) record.sweptAt = { block: log.blockNumber, quoteOut: log.args.quoteOut as bigint, tokenOut: log.args.tokenOut as bigint };
      else outside.push({ token, block: log.blockNumber });
    } else if (log.name === "PoolGraduated") {
      const record = byToken.get(token);
      const legacy = "poolId" in log.args;
      const graduatedAt = {
        block: log.blockNumber,
        positionId: legacy ? 0n : (log.args.positionId as bigint),
        tokenAmount: legacy ? (record?.sweptAt?.tokenOut ?? 0n) : (log.args.tokenAmount as bigint),
        pairTokenAmount: legacy ? (record?.sweptAt?.quoteOut ?? 0n) : (log.args.pairTokenAmount as bigint),
        poolId: legacy ? String(log.args.poolId) : null,
      };
      if (record) record.graduatedAt = graduatedAt;
      else outside.push({ token, block: log.blockNumber });
    }
  }

  return {
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    launches: [...byToken.values()],
    graduationsOutsideWindow: outside,
    chunks: tape.chunks,
  };
}

/** Whole-number share, e.g. 2 of 3 -> "66.7%". Denominator zero -> "n/a". */
export function share(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
