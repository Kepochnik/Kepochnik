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
  /** The last block actually covered, which is short of the one asked for when a budget ran out. */
  toBlock: number;
  chunks: number;
  /** False when a request budget stopped the walk before the whole window was read. */
  complete?: boolean;
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

export interface AdaptiveChunking {
  /** First chunk to try; grows after each success, halves after each range error. */
  startChunk?: number;
  minChunk?: number;
  maxChunk?: number;
  /**
   * Most requests this walk may spend. Without one the loop has no upper
   * bound at all: a busy contract makes the endpoint refuse every wide chunk,
   * the span halves to minChunk, and a window of three hundred thousand
   * blocks becomes three hundred thousand requests. That is not a slow read,
   * it is a read that never finishes, and on Base it turned a door that took
   * seconds into one that took ten minutes and then gave up.
   */
  maxRequests?: number;
}

/**
 * Same tape, but the chunk size adapts to what the endpoint accepts. A
 * narrowly filtered read (one deployer's launches over a day) returns few
 * logs, so the only limit that matters is the block span the endpoint
 * allows per request, and that is not published. Start wide, halve on a
 * range error, grow again after success. A chunk that still fails at the
 * minimum size is an error, never a gap.
 */
export async function readTapeAdaptive(rpc: RpcClient, request: TapeRequest, chunking: AdaptiveChunking = {}): Promise<TapeResult> {
  const byTopic = new Map<string, EventAbi>();
  for (const event of request.events) byTopic.set(eventTopic(event), event);
  const topic0 = [...byTopic.keys()];
  const filterTopics: (string | string[] | null)[] = [topic0.length === 1 ? topic0[0] : topic0, ...(request.topics ?? [])];
  const minChunk = chunking.minChunk ?? 1_000;
  const maxChunk = chunking.maxChunk ?? 200_000;
  let chunk = Math.min(maxChunk, Math.max(minChunk, chunking.startChunk ?? 50_000));

  const maxRequests = chunking.maxRequests ?? Infinity;
  const logs: DecodedLog[] = [];
  let chunks = 0;
  let requests = 0;
  let from = request.fromBlock;
  let complete = true;
  while (from <= request.toBlock) {
    if (requests >= maxRequests) {
      // Out of budget with window left. Returning what was read, and saying so,
      // beats both alternatives: carrying on for minutes, or throwing away
      // logs that were paid for.
      complete = false;
      break;
    }
    const to = Math.min(from + chunk - 1, request.toBlock);
    try {
      requests++;
      const raw = await rpc.getLogs({ address: request.address, topics: filterTopics, fromBlock: from, toBlock: to });
      chunks++;
      for (const log of raw) logs.push(decodeRaw(byTopic, log));
      from = to + 1;
      chunk = Math.min(maxChunk, chunk * 2);
    } catch (error) {
      if (chunk <= minChunk) throw error;
      chunk = Math.max(minChunk, Math.floor(chunk / 2));
    }
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { logs, fromBlock: request.fromBlock, toBlock: complete ? request.toBlock : Math.max(request.fromBlock, from - 1), chunks, complete };
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
