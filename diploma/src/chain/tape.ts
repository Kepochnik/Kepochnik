/**
 * Event tape: decoded Pons V2 logs over a block window, read in chunks the
 * public RPC tolerates. Nothing is inferred; a chunk that fails is reported,
 * not skipped, so a gap in the tape is always visible.
 */
import { decodeLog, eventTopic, type DecodedLog, type EventAbi, type RawLog } from "./abi.js";
import type { RpcClient } from "./rpc.js";

export interface TapeRequest {
  fromBlock: number;
  toBlock: number;
  events: EventAbi[];
  /** Contract address(es) to filter on; omit to read every emitter. */
  address?: string | string[];
  /** Extra topic filters after topic0 (e.g. an indexed wallet); null = any. */
  topics?: (string | string[] | null)[];
  chunkSize?: number;
}

export interface TapeResult {
  logs: DecodedLog[];
  fromBlock: number;
  toBlock: number;
  chunks: number;
}

export async function readTape(rpc: RpcClient, request: TapeRequest): Promise<TapeResult> {
  const byTopic = new Map<string, EventAbi>();
  for (const event of request.events) byTopic.set(eventTopic(event), event);
  const topic0 = [...byTopic.keys()];
  const chunkSize = request.chunkSize ?? 2_000;
  const filterTopics: (string | string[] | null)[] = [topic0.length === 1 ? topic0[0] : topic0, ...(request.topics ?? [])];

  const logs: DecodedLog[] = [];
  let chunks = 0;
  for (let from = request.fromBlock; from <= request.toBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, request.toBlock);
    const raw = await rpc.getLogs({ address: request.address, topics: filterTopics, fromBlock: from, toBlock: to });
    chunks++;
    for (const log of raw) logs.push(decodeRaw(byTopic, log));
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { logs, fromBlock: request.fromBlock, toBlock: request.toBlock, chunks };
}

function decodeRaw(byTopic: Map<string, EventAbi>, log: RawLog): DecodedLog {
  const event = byTopic.get((log.topics[0] ?? "").toLowerCase());
  if (!event) throw new Error(`tape received a log with an unexpected topic ${log.topics[0]}`);
  return decodeLog(event, log);
}

/** Pad a 20-byte address to a 32-byte topic for indexed-address filters. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Robinhood Chain produces a block roughly every 100 ms, so "the last N
 * hours" is a large block span. Callers should always pin the span to the
 * timestamps of its first and last block rather than trust this estimate.
 */
export const BLOCKS_PER_SECOND_ESTIMATE = 10;

export function estimateBlocksAgo(seconds: number): number {
  return Math.max(1, Math.round(seconds * BLOCKS_PER_SECOND_ESTIMATE));
}

/**
 * Binary-search the first block whose timestamp is >= `targetTimestamp`.
 * Uses eth_getBlockByNumber only; O(log n) calls.
 */
export async function findBlockByTimestamp(rpc: RpcClient, targetTimestamp: number, latest?: number): Promise<number> {
  let high = latest ?? (await rpc.blockNumber());
  let low = 0;
  const latestHeader = await rpc.getBlock(high);
  if (latestHeader.timestamp <= targetTimestamp) return high;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const header = await rpc.getBlock(mid);
    if (header.timestamp < targetTimestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}
