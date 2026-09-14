/**
 * The transcript: what actually happened on a curve between its launch
 * and its sweep. Read from the curve's own CurveBuy / CurveSell logs, so it
 * can be re-run by anyone at the same blocks and come out identical.
 *
 *   seconds to graduate   sweep timestamp - launch timestamp
 *   buyers                distinct buyer addresses on the curve
 *   dev share             quote bought by the deployer / total quote in
 *   first-minute share    quote bought within 60 s of launch / total quote in
 *   roster                buyers in order of first buy, with ordinal
 */
import { CURVE_EVENTS } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { readTape } from "../chain/tape.js";

export interface RosterEntry {
  ordinal: number; // 1-based, order of first buy
  address: string;
  quoteIn: bigint; // total quote spent on the curve (net of fees and tax)
  buys: number;
  firstBlock: number;
  isDeployer: boolean;
}

export interface Transcript {
  launchBlock: number;
  sweepBlock: number;
  launchTimestamp: number;
  sweepTimestamp: number;
  secondsToGraduate: number;
  totalQuoteIn: bigint; // sum of CurveBuy.quoteIn - fee - tax
  totalQuoteOut: bigint; // sum of CurveSell.quoteOut
  buys: number;
  sells: number;
  buyers: number;
  devQuoteIn: bigint;
  devShareBps: number;
  firstMinuteQuoteIn: bigint;
  firstMinuteShareBps: number;
  roster: RosterEntry[];
  chunks: number;
}

export async function readTranscript(
  rpc: RpcClient,
  curve: string,
  deployer: string,
  launchBlock: number,
  sweepBlock: number,
  chunkSize = 2_000,
): Promise<Transcript> {
  const [launchHeader, sweepHeader] = await Promise.all([rpc.getBlock(launchBlock), rpc.getBlock(sweepBlock)]);
  const seconds = Math.max(0, sweepHeader.timestamp - launchHeader.timestamp);
  const blocks = Math.max(1, sweepBlock - launchBlock);
  const secondsPerBlock = seconds / blocks;
  const firstMinuteBlock = launchBlock + Math.ceil(60 / Math.max(secondsPerBlock, 0.001));

  const tape = await readTape(rpc, {
    fromBlock: launchBlock,
    toBlock: sweepBlock,
    address: curve,
    events: [CURVE_EVENTS.CurveBuy, CURVE_EVENTS.CurveSell],
    chunkSize,
  });

  const byBuyer = new Map<string, RosterEntry>();
  let totalQuoteIn = 0n;
  let totalQuoteOut = 0n;
  let buys = 0;
  let sells = 0;
  let devQuoteIn = 0n;
  let firstMinuteQuoteIn = 0n;
  const dev = deployer.toLowerCase();

  for (const log of tape.logs) {
    if (log.name === "CurveBuy") {
      buys++;
      const buyer = String(log.args.buyer);
      const recipient = String(log.args.recipient);
      const net = (log.args.quoteIn as bigint) - (log.args.fee as bigint) - (log.args.tax as bigint);
      totalQuoteIn += net;
      const who = recipient !== buyer && recipient === dev ? dev : buyer;
      if (who === dev || buyer === dev || recipient === dev) devQuoteIn += net;
      if (log.blockNumber <= firstMinuteBlock) firstMinuteQuoteIn += net;
      const entry = byBuyer.get(who);
      if (entry) {
        entry.quoteIn += net;
        entry.buys++;
      } else {
        byBuyer.set(who, { ordinal: byBuyer.size + 1, address: who, quoteIn: net, buys: 1, firstBlock: log.blockNumber, isDeployer: who === dev });
      }
    } else if (log.name === "CurveSell") {
      sells++;
      totalQuoteOut += log.args.quoteOut as bigint;
    }
  }

  const bps = (part: bigint) => (totalQuoteIn === 0n ? 0 : Number((part * 10_000n) / totalQuoteIn));
  return {
    launchBlock,
    sweepBlock,
    launchTimestamp: launchHeader.timestamp,
    sweepTimestamp: sweepHeader.timestamp,
    secondsToGraduate: seconds,
    totalQuoteIn,
    totalQuoteOut,
    buys,
    sells,
    buyers: byBuyer.size,
    devQuoteIn,
    devShareBps: bps(devQuoteIn),
    firstMinuteQuoteIn,
    firstMinuteShareBps: bps(firstMinuteQuoteIn),
    roster: [...byBuyer.values()].sort((a, b) => a.ordinal - b.ordinal),
    chunks: tape.chunks,
  };
}

/** Plain words for the transcript, no adjectives, so nobody can say we editorialised. */
export function transcriptSummary(t: Transcript): string {
  const s = t.secondsToGraduate;
  const time = s < 600 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  return `graduated in ${time} · ${t.buyers} buyer${t.buyers === 1 ? "" : "s"} · dev funded ${(t.devShareBps / 100).toFixed(0)}% · ${(t.firstMinuteShareBps / 100).toFixed(0)}% bought in the first minute`;
}
