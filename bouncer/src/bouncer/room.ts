/**
 * THE ROOM: who is inside. Every CurveBuy and CurveSell the curve logged
 * from the launch block to `toBlock`, folded per wallet: distinct buyers,
 * the share the deployer funded, the share bought in the first minute,
 * buys landing in the same block, and the top holders by net quote in.
 * Same arithmetic DIPLOMA prints after a graduation, here for a live curve
 * (and for the honest launch card a creator prints about their own).
 */
import { CURVE_EVENTS, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { readTapeAdaptive } from "../chain/tape.js";

export interface RoomWallet {
  address: string;
  firstBlock: number;
  buys: number;
  sells: number;
  quoteIn: bigint;
  quoteOut: bigint;
  creatorWallet: boolean;
}

export interface Room {
  fromBlock: number;
  toBlock: number;
  buys: number;
  sells: number;
  buyers: number;
  totalQuoteIn: bigint;
  devShareBps: number;
  firstMinuteShareBps: number;
  /** Blocks in which more than one distinct wallet bought. */
  sharedBlocks: { block: number; wallets: number }[];
  wallets: RoomWallet[];
  /** First buyers in order, capped. */
  first: string[];
}

export async function readRoom(rpc: RpcClient, launch: LaunchedToken, fromBlock: number, toBlock: number, chunkSize?: number, firstMinuteBlocks = 600): Promise<Room> {
  const tape = await readTapeAdaptive(
    rpc,
    { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveBuy, CURVE_EVENTS.CurveSell] },
    chunkSize ? { startChunk: chunkSize, maxChunk: chunkSize, minChunk: Math.min(1_000, chunkSize) } : { startChunk: 20_000 },
  );
  const creator = new Set([launch.deployer.toLowerCase(), launch.creatorFeeRecipient.toLowerCase()]);
  const wallets = new Map<string, RoomWallet>();
  const perBlock = new Map<number, Set<string>>();
  let buys = 0;
  let sells = 0;
  let totalQuoteIn = 0n;
  let devQuoteIn = 0n;
  let firstMinuteQuoteIn = 0n;
  const first: string[] = [];
  for (const log of tape.logs) {
    const isBuy = log.name === "CurveBuy";
    const who = String(isBuy ? log.args.buyer : log.args.seller).toLowerCase();
    let w = wallets.get(who);
    if (!w) {
      w = { address: who, firstBlock: log.blockNumber, buys: 0, sells: 0, quoteIn: 0n, quoteOut: 0n, creatorWallet: creator.has(who) };
      wallets.set(who, w);
    }
    if (isBuy) {
      const spent = (log.args.quoteIn as bigint) - (log.args.fee as bigint) - (log.args.tax as bigint);
      buys++;
      w.buys++;
      w.quoteIn += spent;
      totalQuoteIn += spent;
      if (w.creatorWallet) devQuoteIn += spent;
      if (log.blockNumber - fromBlock <= firstMinuteBlocks) firstMinuteQuoteIn += spent;
      if (w.buys === 1 && first.length < 25) first.push(who);
      let set = perBlock.get(log.blockNumber);
      if (!set) perBlock.set(log.blockNumber, (set = new Set()));
      set.add(who);
    } else {
      sells++;
      w.sells++;
      w.quoteOut += log.args.quoteOut as bigint;
    }
  }
  const list = [...wallets.values()].sort((a, b) => (b.quoteIn - b.quoteOut > a.quoteIn - a.quoteOut ? 1 : -1));
  return {
    fromBlock,
    toBlock,
    buys,
    sells,
    buyers: list.filter((w) => w.buys > 0).length,
    totalQuoteIn,
    devShareBps: totalQuoteIn === 0n ? 0 : Number((devQuoteIn * 10_000n) / totalQuoteIn),
    firstMinuteShareBps: totalQuoteIn === 0n ? 0 : Number((firstMinuteQuoteIn * 10_000n) / totalQuoteIn),
    sharedBlocks: [...perBlock.entries()].filter(([, s]) => s.size > 1).map(([block, s]) => ({ block, wallets: s.size })),
    wallets: list,
    first,
  };
}

export function roomLine(r: Room): string {
  if (r.buys === 0) return "empty: no buys yet";
  const parts = [`${r.buyers} buyer${r.buyers === 1 ? "" : "s"}`, `dev funded ${(r.devShareBps / 100).toFixed(0)}%`, `${(r.firstMinuteShareBps / 100).toFixed(0)}% in the first minute`];
  if (r.sharedBlocks.length) parts.push(`${r.sharedBlocks.length} block${r.sharedBlocks.length === 1 ? "" : "s"} with several wallets buying at once`);
  return parts.join(" · ");
}
