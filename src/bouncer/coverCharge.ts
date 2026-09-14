/**
 * COVER CHARGE: the anti-snipe tax at the door. Every Pons V2 launch
 * snapshots two factory terms at creation: the tax charged on a buy in the
 * launch second (99% by default) and the window across which the curve
 * decays it to zero (15 s by default). The deployer and their fee recipient
 * never pay it; wallets the creator declared at launch never pay it; anyone
 * else buying inside the window does.
 *
 * This module reads the factory terms, proves they have not been retuned
 * since the launch (the factory emits an event when they are), reads the
 * launch block's timestamp, and reports whether the window is still open.
 * It then reads every buy the curve recorded inside the window and shows
 * what each one actually paid, as the curve's own CurveBuy event reports it.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { CURVE_EVENTS, FACTORY_EVENTS, FACTORY_FUNCTIONS, PONS_V2_FACTORY, type LaunchedToken } from "../chain/pons.js";
import type { BlockHeader, RpcClient } from "../chain/rpc.js";
import { readTape } from "../chain/tape.js";

export interface ObservedBuy {
  block: number;
  /** Seconds after the launch block, interpolated from block headers. */
  secondsAfterLaunch: number;
  buyer: string;
  recipient: string;
  quoteIn: bigint;
  fee: bigint;
  tax: bigint;
  /** (fee + tax) / quoteIn in basis points: what the buy actually paid at the door. */
  chargeBps: number;
  /** True when the buyer is the deployer or the creator fee recipient (exempt by construction). */
  creatorWallet: boolean;
}

export interface CoverCharge {
  terms: { startBps: bigint; seconds: number };
  /** True when the factory retuned either term between the launch block and `head`. */
  termsChangedSinceLaunch: boolean;
  launch: { block: number; timestamp: number };
  head: { block: number; timestamp: number };
  windowEndsAt: number;
  status: "open" | "closed" | "disabled";
  secondsLeft: number;
  secondsSinceLaunch: number;
  observed: ObservedBuy[];
}

export interface CoverChargeOptions {
  launchBlock: number;
  head: BlockHeader;
  chunkSize?: number;
  factory?: string;
}

export async function readCoverCharge(rpc: RpcClient, launch: LaunchedToken, options: CoverChargeOptions): Promise<CoverCharge> {
  const factory = options.factory ?? PONS_V2_FACTORY;
  const head = options.head;
  const [startRaw, secondsRaw] = await rpc.callBatch(
    [
      { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxStartBps, []) },
      { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxSeconds, []) },
    ],
    head.number,
  );
  const startBps = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxStartBps, startRaw)[0] as bigint;
  const seconds = Number(decodeOutputs(FACTORY_FUNCTIONS.snipeTaxSeconds, secondsRaw)[0] as bigint);

  const launchHeader = await rpc.getBlock(options.launchBlock);
  const secondsSinceLaunch = Math.max(0, head.timestamp - launchHeader.timestamp);
  const windowEndsAt = launchHeader.timestamp + seconds;
  const status: CoverCharge["status"] = startBps === 0n ? "disabled" : head.timestamp < windowEndsAt ? "open" : "closed";
  const secondsLeft = status === "open" ? windowEndsAt - head.timestamp : 0;

  // Term changes are rare factory-owner actions; the tape over the launch→head
  // span is tiny because only two event shapes are requested.
  const retunes = await readTape(rpc, {
    fromBlock: options.launchBlock,
    toBlock: head.number,
    address: factory,
    events: [FACTORY_EVENTS.SnipeTaxStartBpsUpdated, FACTORY_EVENTS.SnipeTaxSecondsUpdated],
    chunkSize: options.chunkSize ?? 100_000,
  });

  // Buys inside the window. Robinhood blocks are ~100 ms, so the window is a
  // few hundred blocks; read a generous span and interpolate seconds from
  // the two headers at its ends rather than fetching one header per buy.
  const blocksPerSecond = blockRate(launchHeader, head);
  const spanBlocks = Math.max(1, Math.ceil(seconds * blocksPerSecond * 2) + 10);
  const spanEnd = Math.min(head.number, options.launchBlock + spanBlocks);
  const spanHeader = spanEnd === head.number ? head : await rpc.getBlock(spanEnd);
  const secondsPerBlock = spanEnd > options.launchBlock ? (spanHeader.timestamp - launchHeader.timestamp) / (spanEnd - options.launchBlock) : 0;
  const tape = await readTape(rpc, {
    fromBlock: options.launchBlock,
    toBlock: spanEnd,
    address: launch.curve,
    events: [CURVE_EVENTS.CurveBuy],
    chunkSize: options.chunkSize ?? 100_000,
  });
  const creatorWallets = new Set([launch.deployer.toLowerCase(), launch.creatorFeeRecipient.toLowerCase()]);
  const observed: ObservedBuy[] = [];
  for (const log of tape.logs) {
    const secondsAfterLaunch = (log.blockNumber - options.launchBlock) * secondsPerBlock;
    if (secondsAfterLaunch > seconds) continue;
    const quoteIn = log.args.quoteIn as bigint;
    const fee = log.args.fee as bigint;
    const tax = log.args.tax as bigint;
    const buyer = String(log.args.buyer).toLowerCase();
    observed.push({
      block: log.blockNumber,
      secondsAfterLaunch: Math.round(secondsAfterLaunch * 10) / 10,
      buyer,
      recipient: String(log.args.recipient).toLowerCase(),
      quoteIn,
      fee,
      tax,
      chargeBps: quoteIn === 0n ? 0 : Number(((fee + tax) * 10_000n) / quoteIn),
      creatorWallet: creatorWallets.has(buyer),
    });
  }

  return {
    terms: { startBps, seconds },
    termsChangedSinceLaunch: retunes.logs.length > 0,
    launch: { block: launchHeader.number, timestamp: launchHeader.timestamp },
    head: { block: head.number, timestamp: head.timestamp },
    windowEndsAt,
    status,
    secondsLeft,
    secondsSinceLaunch,
    observed,
  };
}

function blockRate(a: BlockHeader, b: BlockHeader): number {
  const blocks = b.number - a.number;
  const seconds = b.timestamp - a.timestamp;
  if (blocks <= 0 || seconds <= 0) return 10;
  return blocks / seconds;
}

/** One line for the slip: "open · 6 s left · up to 99%" or "closed 41 min ago · 3 buys in the window, 1 paid 61%". */
export function coverChargeLine(c: CoverCharge): string {
  if (c.status === "disabled") return "disabled at the factory when this launch was created";
  if (c.status === "open") return `open · ${c.secondsLeft} s left · up to ${Number(c.terms.startBps) / 100}% on a buy right now`;
  const taxed = c.observed.filter((b) => !b.creatorWallet);
  const paid = taxed.length ? ` · ${taxed.length} paid at the door, highest ${(Math.max(...taxed.map((b) => b.chargeBps)) / 100).toFixed(1)}%` : "";
  return `closed · ${c.observed.length} buy${c.observed.length === 1 ? "" : "s"} inside the ${c.terms.seconds} s window${paid}`;
}
