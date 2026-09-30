/**
 * THE FEED: the launches that just happened, newest first.
 *
 * The board (leaderboard.ts) answers "who ran the door tonight" and returns
 * sums — how many launches, which deployers, how much cover was paid. It
 * cannot serve a live column, because a column needs the rows themselves and
 * the board throws them away as it counts.
 *
 * So this walks the same factory events the other way round: from the tip
 * backwards, a slice at a time, and stops the moment it has enough rows. A
 * feed of thirty launches on a busy day is four hundred blocks of reading,
 * not a day of it, and the difference is the difference between a column
 * that keeps up with the chain and one that arrives a minute late.
 *
 * What it will not do is pretend. When the row limit stops the walk with
 * blocks still unopened, `unread` names them, because "the newest thirty"
 * and "every launch today" are different claims and only one of them is
 * true. A block header that will not load leaves `ageSeconds` null rather
 * than a number worked out from an assumed block time: an age is read here
 * or it is absent.
 */
import { decodeOutputs, encodeCall, type Hex } from "../chain/abi.js";
import type { ChainConfig } from "../chain/chains.js";
import { featureBlocker } from "../chain/chains.js";
import { CURVE_FUNCTIONS, ERC20_FUNCTIONS, FACTORY_EVENTS, PONS_V2_FACTORY } from "../chain/pons.js";
import { RpcError, type RpcClient } from "../chain/rpc.js";
import { readTapeAdaptive } from "../chain/tape.js";

export interface FeedRow {
  token: string;
  curve: string;
  deployer: string;
  block: number;
  tx: string;
  /** Block time of the launch, or null when the header could not be read. */
  timestamp: number | null;
  /** Seconds between the launch and the feed's head block; null when the timestamp is. */
  ageSeconds: number | null;
  symbol: string | null;
  name: string | null;
  pairToken: string;
  graduationThreshold: bigint;
  /** How many launches this deployer made inside the blocks actually read. 1 is the ordinary case. */
  deployerLaunches: number;
  /** The launch graduated to a real pool inside the blocks read. */
  graduated: boolean;
  /** The launch was swept — the deployer took the curve's money back out. */
  swept: boolean;
  /**
   * How far the curve is to graduating: the real quote it holds against the
   * threshold it needs. Null when the curve could not be read, and null for a
   * graduated or swept launch, whose curve no longer means anything.
   */
  fill: { real: bigint; bps: number } | null;
}

export interface Feed {
  rows: FeedRow[];
  /** The blocks this feed actually read, which is the tail of the window when the limit hit first. */
  window: { fromBlock: number; toBlock: number };
  /** The older end of the asked-for window that was never opened, or null when all of it was. */
  unread: { fromBlock: number; toBlock: number } | null;
  /** Head block the ages are measured against. */
  head: { block: number; timestamp: number };
  chunks: number;
  /** Rows whose symbol or name could not be read, by address. */
  namesUnread: string[];
  /**
   * Every token that graduated or was swept inside the blocks read, whether or
   * not its launch is in `rows`. A refreshing column reads only the new blocks,
   * so a launch already on screen learns it graduated from these, not from a
   * row it will never be handed again.
   */
  graduated: string[];
  swept: string[];
}

export interface FeedOptions {
  /** Oldest block worth walking back to. */
  fromBlock: number;
  /** Newest block to read, normally the head. */
  toBlock: number;
  /** Time the head block was sealed, for the age column. */
  headTimestamp: number;
  factory?: string;
  /** Rows wanted. The walk stops once it has this many. Default 30. */
  limit?: number;
  /** Blocks per backward slice. Halves on refusal inside each slice. Default 2,000. */
  sliceSize?: number;
  /** Most slices to open before giving up on a quiet stretch of chain. Default 12. */
  maxSlices?: number;
  /** Skip the symbol/name read; the addresses alone are enough for a count. */
  skipNames?: boolean;
  /** Skip the curve read that fills the graduation bar. */
  skipFill?: boolean;
}

/** Why this chain has no feed, or null when it has one. A feed is the board's rows, so it needs the board's factory. */
export function feedBlocker(chain: ChainConfig): string | null {
  return featureBlocker(chain, "board");
}

export async function readFeed(rpc: RpcClient, options: FeedOptions): Promise<Feed> {
  const factory = options.factory ?? PONS_V2_FACTORY;
  const limit = options.limit ?? 30;
  const slice = Math.max(1, options.sliceSize ?? 2_000);
  const maxSlices = options.maxSlices ?? 12;
  const head = { block: options.toBlock, timestamp: options.headTimestamp };

  const launches: FeedRow[] = [];
  const graduated = new Set<string>();
  const swept = new Set<string>();
  const byDeployer = new Map<string, number>();
  let chunks = 0;
  let readFrom = options.toBlock + 1;
  let slices = 0;

  // Backwards, a slice at a time. Forward is what the board does and it is
  // the wrong direction here: the newest launch is at the far end of the
  // window, so a forward walk reads the whole day to show the last minute.
  for (let to = options.toBlock; to >= options.fromBlock && launches.length < limit && slices < maxSlices; to -= slice) {
    const from = Math.max(options.fromBlock, to - slice + 1);
    const tape = await readTapeAdaptive(
      rpc,
      {
        fromBlock: from,
        toBlock: to,
        address: factory,
        events: [FACTORY_EVENTS.TokenLaunched, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy],
      },
      { startChunk: slice, maxChunk: slice },
    );
    chunks += tape.chunks;
    slices++;
    readFrom = from;

    const here: FeedRow[] = [];
    for (const log of tape.logs) {
      const token = String(log.args.token).toLowerCase();
      if (log.name === "TokenLaunched") {
        const deployer = String(log.args.deployer).toLowerCase();
        byDeployer.set(deployer, (byDeployer.get(deployer) ?? 0) + 1);
        here.push({
          token,
          curve: String(log.args.curve).toLowerCase(),
          deployer,
          block: log.blockNumber,
          tx: log.transactionHash,
          timestamp: null,
          ageSeconds: null,
          symbol: null,
          name: null,
          pairToken: String(log.args.pairToken).toLowerCase(),
          graduationThreshold: log.args.graduationThreshold as bigint,
          deployerLaunches: 1,
          graduated: false,
          swept: false,
          fill: null,
        });
      } else if (log.name === "PoolGraduated") {
        graduated.add(token);
      } else if (log.name === "LaunchSwept") {
        swept.add(token);
      }
    }
    // The tape sorts oldest first; the feed is the other way round, and each
    // slice sits wholly older than the ones already collected.
    here.reverse();
    launches.push(...here);
  }

  const rows = launches.slice(0, limit);
  for (const row of rows) {
    row.graduated = graduated.has(row.token);
    row.swept = swept.has(row.token);
    row.deployerLaunches = byDeployer.get(row.deployer) ?? 1;
  }

  await stampTimes(rpc, rows, head.timestamp);
  if (!options.skipFill) await stampFill(rpc, rows, head.block);
  const namesUnread = options.skipNames ? rows.map((r) => r.token) : await stampNames(rpc, rows, head.block);

  // Everything below what was opened is unread, whether the limit stopped the
  // walk or the slice budget did. A feed that says "the newest thirty" while
  // the page reads "every launch today" is the same lie either way.
  const unread = readFrom > options.fromBlock ? { fromBlock: options.fromBlock, toBlock: readFrom - 1 } : null;
  return { rows, window: { fromBlock: readFrom, toBlock: options.toBlock }, unread, head, chunks, namesUnread, graduated: [...graduated], swept: [...swept] };
}

/**
 * The graduation bar for every live curve in the column, in one batch.
 *
 * The threshold came with the launch event, so this is one call a row: the
 * quote the curve really holds, never the pricing reserve with its virtual
 * part. Exported so a refreshing column can move its bars without walking
 * the factory again. A curve that will not answer keeps a null bar rather
 * than an empty one — an unread curve is not a curve nobody bought.
 */
export async function stampFill(rpc: RpcClient, rows: FeedRow[], blockNumber: number): Promise<void> {
  const live = rows.filter((r) => !r.graduated && !r.swept && r.graduationThreshold > 0n);
  for (const r of rows) if (r.graduated || r.swept) r.fill = null;
  if (!live.length) return;
  const answers = await rpc.callBatchSettled(
    live.map((r) => ({ to: r.curve, data: encodeCall(CURVE_FUNCTIONS.realQuoteReserve, []) })),
    blockNumber,
  );
  live.forEach((row, i) => {
    const answer = answers[i];
    if (answer === undefined || answer instanceof RpcError) return;
    try {
      const [real] = decodeOutputs(CURVE_FUNCTIONS.realQuoteReserve, answer) as [bigint];
      row.fill = { real, bps: Math.min(10_000, Number((real * 10_000n) / row.graduationThreshold)) };
    } catch {
      /* an answer that is not a number leaves the bar unread */
    }
  });
}

/** One batched header read per distinct block. An age is read or it is absent. */
async function stampTimes(rpc: RpcClient, rows: FeedRow[], headTimestamp: number): Promise<void> {
  const blocks = [...new Set(rows.map((r) => r.block))];
  if (blocks.length === 0) return;
  const answers = await rpc.sendBatchSettled(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: [`0x${b.toString(16)}`, false] })));
  const times = new Map<number, number>();
  answers.forEach((answer, i) => {
    if (answer instanceof RpcError || !answer) return;
    const raw = (answer as { timestamp?: string }).timestamp;
    if (typeof raw !== "string") return;
    times.set(blocks[i], Number(BigInt(raw)));
  });
  for (const row of rows) {
    const t = times.get(row.block);
    if (t === undefined) continue;
    row.timestamp = t;
    row.ageSeconds = Math.max(0, headTimestamp - t);
  }
}

/**
 * Symbol and name for the rows, settled per call. A token whose symbol()
 * reverts or answers in bytes32 is a row with a blank ticker, not a feed
 * that fails: half the point of the column is seeing the launch land, and
 * the address is the part that matters.
 */
async function stampNames(rpc: RpcClient, rows: FeedRow[], blockNumber: number): Promise<string[]> {
  if (rows.length === 0) return [];
  const calls = rows.flatMap((row) => [
    { to: row.token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
    { to: row.token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
  ]);
  const answers = await rpc.callBatchSettled(calls, blockNumber);
  const unread: string[] = [];
  rows.forEach((row, i) => {
    row.symbol = readString(answers[i * 2]);
    row.name = readString(answers[i * 2 + 1]);
    if (row.symbol === null && row.name === null) unread.push(row.token);
  });
  return unread;
}

function readString(answer: Hex | RpcError | undefined): string | null {
  if (answer === undefined || answer instanceof RpcError) return null;
  try {
    const [value] = decodeOutputs(ERC20_FUNCTIONS.symbol, answer) as [string];
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}
