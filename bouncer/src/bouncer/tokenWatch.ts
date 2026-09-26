/**
 * The tape for a token with no Pons V2 curve behind it: a Pons V1 launch, an
 * ordinary ERC-20 on Base or BNB Chain, anything a person can paste.
 *
 * There is no curve to read, so the only honest source is the token's own
 * Transfer log plus the addresses of its pools. That is enough to answer the
 * question BOUNCER exists to answer — is somebody heading for the exit — and
 * it is exact: tokens into a pool is a sale, tokens out of a pool is a
 * purchase, and everything else is a move between wallets.
 *
 * What it deliberately does NOT do is put a quote price on those trades. The
 * pool's own Swap log carries that number and the Transfer log does not, so
 * multiplying by the current spot would be an invented figure that is worst
 * exactly when it matters most, on the large sale that moved the price. The
 * share of supply is printed instead, which is read, not estimated.
 */
import { ERC20_EVENTS } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { readTapeAdaptive } from "../chain/tape.js";
import { formatUnits, shortAddress } from "../format.js";

export type TokenWatchKind = "sold-into-pool" | "bought-from-pool" | "moved" | "minted" | "burned";

export interface TokenWatchEvent {
  block: number;
  kind: TokenWatchKind;
  text: string;
  tx: string;
  wallets: string[];
  tokens: bigint;
  /** Share of total supply in basis points, or null when the supply could not be read. */
  shareBps: number | null;
  /** True when this wallet is one the caller asked to be told about whatever the size. */
  watched: boolean;
}

export interface TokenWatchOptions {
  fromBlock: number;
  toBlock: number;
  /** Pool addresses, so a transfer into one can be called a sale rather than a move. */
  pools?: string[];
  /** Wallets reported at any size: the deployer, the owner, a crew. */
  watch?: string[];
  /** Total supply, for the share column. Pass 0n when it could not be read. */
  supply?: bigint;
  decimals?: number;
  /** Smallest move worth a line, in basis points of supply. Default 25 (0.25%). */
  minShareBps?: number;
  /** First block span to ask for. It halves on refusal and grows on success. */
  chunkSize?: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

export async function readTokenWatchEvents(rpc: RpcClient, token: string, options: TokenWatchOptions): Promise<TokenWatchEvent[]> {
  const decimals = options.decimals ?? 18;
  const supply = options.supply ?? 0n;
  const minShareBps = options.minShareBps ?? 25;
  const pools = new Set((options.pools ?? []).map((p) => p.toLowerCase()));
  const watched = new Set((options.watch ?? []).map((w) => w.toLowerCase()));

  // A fixed chunk size cannot work here. This reads every Transfer of one
  // token, and a busy one — USDC on Base — puts more logs in a few hundred
  // blocks than any public endpoint will return, which comes back as a flat
  // 400 rather than as a partial answer. So the span adapts, and its floor is
  // a single block: one block always fits, and stopping at a thousand would
  // mean the busiest tokens are exactly the ones that cannot be watched.
  const tape = await readTapeAdaptive(
    rpc,
    { address: token.toLowerCase(), events: [ERC20_EVENTS.Transfer], fromBlock: options.fromBlock, toBlock: options.toBlock },
    { minChunk: 1, startChunk: options.chunkSize ?? 200, maxChunk: 5_000 },
  );

  const events: TokenWatchEvent[] = [];
  for (const log of tape.logs) {
    const from = String(log.args.from).toLowerCase();
    const to = String(log.args.to).toLowerCase();
    const tokens = log.args.value as bigint;
    const shareBps = supply > 0n ? Number((tokens * 10_000n) / supply) : null;
    const isWatched = watched.has(from) || watched.has(to);
    // A wallet the caller named is reported however small; everything else has
    // to clear the threshold, or a busy token is a wall of dust. When the supply
    // could not be read there is no threshold to apply, so everything is
    // reported: an unreadable number must not quietly empty the tape.
    if (!isWatched && shareBps !== null && shareBps < minShareBps) continue;

    // A watched wallet is reported at any size, so this line has to be able
    // to print a size below the threshold — and "(0.00% of supply)" reads as
    // a measurement of nothing rather than as a move too small to round.
    const share = shareBps === null ? "" : shareBps === 0 ? " (under 0.01% of supply)" : ` (${(shareBps / 100).toFixed(2)}% of supply)`;
    const amount = `${formatUnits(tokens, decimals, 0)} tokens${share}`;
    let kind: TokenWatchKind;
    let text: string;
    if (from === ZERO) {
      kind = "minted";
      text = `${amount} minted to ${shortAddress(to)}`;
    } else if (to === ZERO || to === DEAD) {
      kind = "burned";
      text = `${amount} burned by ${shortAddress(from)}`;
    } else if (pools.has(to)) {
      kind = "sold-into-pool";
      text = `${shortAddress(from)} sent ${amount} into the pool`;
    } else if (pools.has(from)) {
      kind = "bought-from-pool";
      text = `${shortAddress(to)} took ${amount} out of the pool`;
    } else {
      kind = "moved";
      text = `${shortAddress(from)} moved ${amount} to ${shortAddress(to)}`;
    }
    if (isWatched) text += watched.has(from) ? "  ← watched wallet" : "  ← to a watched wallet";
    events.push({ block: log.blockNumber, kind, text, tx: log.transactionHash, wallets: [from, to], tokens, shareBps, watched: isWatched });
  }
  events.sort((a, b) => a.block - b.block);
  return events;
}

export interface TokenWatchLoopOptions extends Omit<TokenWatchOptions, "fromBlock" | "toBlock"> {
  fromBlock: number;
  intervalMs: number;
  onEvent: (event: TokenWatchEvent) => void | Promise<void>;
  onRound?: (head: number) => void;
  maxRounds?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls the head and reports new transfers; returns the last block scanned. */
export async function watchToken(rpc: RpcClient, token: string, options: TokenWatchLoopOptions): Promise<number> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let cursor = options.fromBlock;
  for (let round = 0; options.maxRounds === undefined || round < options.maxRounds; round++) {
    const head = await rpc.blockNumber();
    if (head >= cursor) {
      const events = await readTokenWatchEvents(rpc, token, { ...options, fromBlock: cursor, toBlock: head });
      for (const e of events) await options.onEvent(e);
      cursor = head + 1;
    }
    options.onRound?.(head);
    if (options.maxRounds !== undefined && round + 1 >= options.maxRounds) break;
    await sleep(options.intervalMs);
  }
  return cursor;
}
