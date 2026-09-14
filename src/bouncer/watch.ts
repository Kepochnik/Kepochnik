/**
 * DEV MOVED and CREW EXIT: what changed on one launch since the last look.
 * Reads a block window and returns events, never a verdict: the deployer
 * sold on the curve or moved tokens out, the creator moved the tax
 * recipient or flipped buyback, the curve was swept or graduated, and, when
 * a crew is known, crew wallets leaving within the same window. One
 * address, a handful of narrow log reads, cheap enough to poll every few
 * seconds from a bot, a terminal or a browser tab.
 */
import { CURVE_EVENTS, ERC20_EVENTS, FACTORY_EVENTS, PONS_V2_FACTORY, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, readTape } from "../chain/tape.js";
import { formatUnits, shortAddress } from "../format.js";

export type WatchKind = "dev-sold" | "dev-transferred" | "fee-recipient-moved" | "buyback-changed" | "swept" | "graduated" | "crew-exit";

export interface WatchEvent {
  block: number;
  kind: WatchKind;
  text: string;
  tx: string;
  /** Wallets involved (the deployer, the crew members that left). */
  wallets: string[];
  quote?: bigint;
  tokens?: bigint;
}

export interface WatchOptions {
  fromBlock: number;
  toBlock: number;
  /** Crew wallets (from ONE CREW) whose exits are reported together. */
  crew?: string[];
  factory?: string;
  chunkSize?: number;
  quote?: { symbol: string; decimals: number };
}

export async function readWatchEvents(rpc: RpcClient, launch: LaunchedToken, options: WatchOptions): Promise<WatchEvent[]> {
  const factory = options.factory ?? PONS_V2_FACTORY;
  const q = options.quote ?? { symbol: "ETH", decimals: 18 };
  const chunkSize = options.chunkSize ?? 5_000;
  const window = { fromBlock: options.fromBlock, toBlock: options.toBlock, chunkSize };
  const deployer = launch.deployer.toLowerCase();
  const curve = launch.curve.toLowerCase();
  const token = launch.token.toLowerCase();
  const crew = (options.crew ?? []).map((w) => w.toLowerCase()).filter((w) => w !== deployer);
  const events: WatchEvent[] = [];

  // The deployer on the curve, and the deployer moving tokens anywhere.
  const devSells = await readTape(rpc, { ...window, address: curve, events: [CURVE_EVENTS.CurveSell], topics: [addressTopic(deployer)] });
  for (const l of devSells.logs) {
    events.push({ block: l.blockNumber, kind: "dev-sold", tx: l.transactionHash, wallets: [deployer], quote: l.args.quoteOut as bigint, tokens: l.args.tokensIn as bigint, text: `deployer sold ${formatUnits(l.args.tokensIn as bigint, 18, 0)} tokens on the curve for ${formatUnits(l.args.quoteOut as bigint, q.decimals)} ${q.symbol}` });
  }
  const devTransfers = await readTape(rpc, { ...window, address: token, events: [ERC20_EVENTS.Transfer], topics: [addressTopic(deployer)] });
  for (const l of devTransfers.logs) {
    const to = String(l.args.to).toLowerCase();
    if (to === curve) continue; // that is the sell above
    events.push({ block: l.blockNumber, kind: "dev-transferred", tx: l.transactionHash, wallets: [deployer, to], tokens: l.args.value as bigint, text: `deployer moved ${formatUnits(l.args.value as bigint, 18, 0)} tokens to ${shortAddress(to)}` });
  }

  // The creator's levers and the launch's phase, all factory events keyed by token.
  const factoryTape = await readTape(rpc, { ...window, address: factory, events: [FACTORY_EVENTS.CreatorFeeRecipientUpdated, FACTORY_EVENTS.BuybackEnabledUpdated, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy], topics: [addressTopic(token)] });
  for (const l of factoryTape.logs) {
    if (l.name === "CreatorFeeRecipientUpdated") events.push({ block: l.blockNumber, kind: "fee-recipient-moved", tx: l.transactionHash, wallets: [String(l.args.newRecipient).toLowerCase()], text: `creator tax recipient moved to ${shortAddress(String(l.args.newRecipient))}` });
    else if (l.name === "BuybackEnabledUpdated") events.push({ block: l.blockNumber, kind: "buyback-changed", tx: l.transactionHash, wallets: [], text: `buyback turned ${l.args.enabled ? "on" : "off"}` });
    else if (l.name === "LaunchSwept") events.push({ block: l.blockNumber, kind: "swept", tx: l.transactionHash, wallets: [], quote: l.args.quoteOut as bigint, text: `curve swept: ${formatUnits(l.args.quoteOut as bigint, q.decimals)} ${q.symbol} on the way to the pool` });
    else if (l.name === "PoolGraduated") events.push({ block: l.blockNumber, kind: "graduated", tx: l.transactionHash, wallets: [], text: "graduated: the pool exists and the position is locked" });
  }

  // Crew wallets leaving: sells on the curve, or tokens moved out.
  if (crew.length) {
    const crewTopics = crew.map(addressTopic);
    const sells = await readTape(rpc, { ...window, address: curve, events: [CURVE_EVENTS.CurveSell], topics: [crewTopics] });
    const moves = await readTape(rpc, { ...window, address: token, events: [ERC20_EVENTS.Transfer], topics: [crewTopics] });
    const left = new Map<string, { block: number; quote: bigint; tx: string }>();
    for (const l of sells.logs) {
      const who = String(l.args.seller).toLowerCase();
      const prev = left.get(who);
      left.set(who, { block: Math.min(prev?.block ?? l.blockNumber, l.blockNumber), quote: (prev?.quote ?? 0n) + (l.args.quoteOut as bigint), tx: prev?.tx ?? l.transactionHash });
    }
    for (const l of moves.logs) {
      if (String(l.args.to).toLowerCase() === curve) continue;
      const who = String(l.args.from).toLowerCase();
      if (!left.has(who)) left.set(who, { block: l.blockNumber, quote: 0n, tx: l.transactionHash });
    }
    if (left.size >= 2) {
      const wallets = [...left.keys()];
      const quote = [...left.values()].reduce((a, v) => a + v.quote, 0n);
      const first = Math.min(...[...left.values()].map((v) => v.block));
      events.push({ block: first, kind: "crew-exit", tx: [...left.values()][0].tx, wallets, quote, text: `${wallets.length} of ${crew.length} crew wallets left in the same window${quote ? `, ${formatUnits(quote, q.decimals)} ${q.symbol} out` : ""}` });
    }
  }
  events.sort((a, b) => a.block - b.block);
  return events;
}

export interface WatchLoopOptions extends Omit<WatchOptions, "fromBlock" | "toBlock"> {
  fromBlock: number;
  intervalMs: number;
  onEvent: (event: WatchEvent) => void | Promise<void>;
  onRound?: (head: number) => void;
  maxRounds?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls the head and reports new events; returns the last block scanned. */
export async function watchLaunch(rpc: RpcClient, launch: LaunchedToken, options: WatchLoopOptions): Promise<number> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let cursor = options.fromBlock;
  for (let round = 0; options.maxRounds === undefined || round < options.maxRounds; round++) {
    const head = await rpc.blockNumber();
    if (head >= cursor) {
      const events = await readWatchEvents(rpc, launch, { ...options, fromBlock: cursor, toBlock: head });
      for (const e of events) await options.onEvent(e);
      cursor = head + 1;
    }
    options.onRound?.(head);
    if (options.maxRounds !== undefined && round + 1 >= options.maxRounds) break;
    await sleep(options.intervalMs);
  }
  return cursor;
}
