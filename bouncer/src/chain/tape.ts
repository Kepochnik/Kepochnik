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
  /**
   * Wall-clock budget in milliseconds, which is the bound the request count
   * cannot give. Measured on BNB Chain: five log requests, all five refused,
   * a hundred and seventy seconds. The budget of requests was never spent —
   * each request took thirty-four seconds to fail, because a refusal travels
   * through a fifteen-second timeout on each endpoint in turn. A read before
   * a trade cannot be bounded by counting requests when one request can cost
   * more than the whole read is worth.
   */
  budgetMs?: number;
  /**
   * How many chunks may be in flight at once, once a working size is known.
   *
   * The walk has to start sequentially: nobody publishes the block span an
   * endpoint will serve, so the first request is a question as much as a
   * read. But once one span comes back, the rest of the window is the same
   * question already answered, and asking it one chunk at a time turns a
   * window into a queue — the whole reason the full pass took nineteen
   * seconds while the chain answered every request in under two hundred
   * milliseconds.
   *
   * Six is polite. It is a public endpoint, and a fan-out wide enough to
   * finish instantly is also wide enough to get this caller rate limited,
   * which costs more than it saves.
   */
  lanes?: number;
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
  // A span this endpoint already refused is one this walk should not open
  // with. Measured on Base: five refusals at about 2.4 seconds each, twelve
  // seconds spent rediscovering a limit the previous walk had just been
  // taught. Only refusals cap it — see RpcClient.logSpanCeiling.
  // Optional on purpose. This walk needs an object that can getLogs and
  // nothing else, and the tests hand it exactly that — a four-line double,
  // not a client. Requiring the whole class here would make every stub carry
  // machinery it has no use for.
  const ceiling = rpc.logSpanCeiling?.() ?? null;
  let chunk = Math.min(maxChunk, ceiling ?? Infinity, Math.max(minChunk, chunking.startChunk ?? 50_000));
  chunk = Math.max(minChunk, chunk);

  const maxRequests = chunking.maxRequests ?? Infinity;
  const deadline = chunking.budgetMs === undefined ? Infinity : Date.now() + chunking.budgetMs;
  const logs: DecodedLog[] = [];
  let chunks = 0;
  let requests = 0;
  const lanes = Math.max(1, chunking.lanes ?? 6);
  let from = request.fromBlock;
  let complete = true;
  // Only after a span has come back does the walk know one the endpoint
  // accepts; until then every request is a question and they have to be
  // asked one at a time.
  let proven = false;
  while (from <= request.toBlock) {
    if (Date.now() >= deadline) {
      // Out of time with window left. Same trade as running out of requests:
      // what was read is kept and the walk says it is incomplete.
      complete = false;
      break;
    }
    if (requests >= maxRequests) {
      // Out of budget with window left. Returning what was read, and saying so,
      // beats both alternatives: carrying on for minutes, or throwing away
      // logs that were paid for.
      complete = false;
      break;
    }

    // One round. Sequential until a span is proven, then as many as the lane
    // count and the remaining request budget allow.
    const remaining = request.toBlock - from + 1;
    const width = proven ? Math.min(lanes, Math.ceil(remaining / chunk), Math.max(1, maxRequests - requests)) : 1;
    const spans: { fromBlock: number; toBlock: number }[] = [];
    for (let i = 0; i < width; i++) {
      const start = from + i * chunk;
      if (start > request.toBlock) break;
      spans.push({ fromBlock: start, toBlock: Math.min(start + chunk - 1, request.toBlock) });
    }
    requests += spans.length;
    const answers = await Promise.all(
      spans.map((span) =>
        rpc
          .getLogs({ address: request.address, topics: filterTopics, fromBlock: span.fromBlock, toBlock: span.toBlock })
          .then((raw) => ({ ok: true as const, raw }))
          .catch((error) => ({ ok: false as const, error })),
      ),
    );

    // Only a run of successes from the start of the round can be kept. A gap
    // in the middle is a gap in the tape, and this file's whole contract is
    // that a gap is reported rather than skipped — so the walk resumes at the
    // first failure with a smaller span.
    let advanced = 0;
    for (const answer of answers) {
      if (!answer.ok) break;
      chunks++;
      for (const log of answer.raw) logs.push(decodeRaw(byTopic, log));
      advanced++;
    }
    if (advanced) {
      from = spans[advanced - 1].toBlock + 1;
      proven = true;
      chunk = Math.min(maxChunk, chunk * 2);
      if (advanced === answers.length) continue;
    }

    // Nothing more got through this round; the first failure decides.
    const failure = answers[advanced];
    if (chunk <= minChunk) {
      // Cannot ask for less than the floor. Throwing here discards every log
      // already paid for — on Base that was sixty-three seconds of reading
      // thrown away to report nothing — so the walk stops and says it is
      // incomplete. Only a walk that read nothing at all is an error, since
      // there is then no answer to give.
      if (!chunks) throw failure.ok ? new Error("log walk made no progress") : failure.error;
      complete = false;
      break;
    }
    // Eighths, not halves. The endpoint's real limit is usually far below
    // the opening guess, and halving from five thousand to one costs twelve
    // refused requests before the first useful one; this costs four.
    chunk = Math.max(minChunk, Math.floor(chunk / 8));
    // A span that just failed is not proven, whatever succeeded before it.
    proven = false;
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
