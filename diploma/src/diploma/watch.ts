/**
 * `diploma watch`: graduations after the fact. Every sweep reads the
 * factory's TokenLaunched, LaunchSwept and PoolGraduated logs since the last
 * sweep and prints one line per event. A graduation prints its transcript
 * line. It never ranks live curves, so it is not a sniper feed.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { readLaunchLedger, type LaunchRecord } from "../chain/launches.js";
import { ERC20_FUNCTIONS, FACTORY_FUNCTIONS, PONS_V2_FACTORY, ZERO_ADDRESS, decodeLaunchedToken } from "../chain/pons.js";
import { readTokenMeta } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { shortAddress } from "../format.js";
import { confettiBlock, playConfetti } from "./confetti.js";
import { diplomaLine, type DiplomaFacts } from "./diploma.js";
import { readTranscript } from "./transcript.js";

export interface WatchOptions {
  intervalMs: number;
  /** How far back the first sweep looks. */
  backfillBlocks: number;
  chunkSize: number;
  /** The easter egg: fire the deterministic confetti on a graduation. Off by default. */
  party: boolean;
  animate: boolean;
  color: boolean;
  /** Stop after this many sweeps (tests / recordings); undefined = forever. */
  maxSweeps?: number;
  write: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface SweepStats {
  sweeps: number;
  launched: number;
  swept: number;
  graduated: number;
  lastBlock: number;
}

export async function watch(rpc: RpcClient, options: WatchOptions): Promise<SweepStats> {
  await rpc.assertChain();
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const stats: SweepStats = { sweeps: 0, launched: 0, swept: 0, graduated: 0, lastBlock: 0 };
  const printed = new Set<string>();

  let from = Math.max(0, (await rpc.blockNumber()) - options.backfillBlocks);
  options.write(`diploma watch · factory ${PONS_V2_FACTORY} · from block ${from}\n`);

  for (;;) {
    const head = await rpc.blockNumber();
    if (head >= from) {
      const ledger = await readLaunchLedger(rpc, { fromBlock: from, toBlock: head, chunkSize: options.chunkSize });
      const events = flatten(ledger.launches, ledger.graduationsOutsideWindow);
      for (const event of events) {
        if (event.kind === "launched") {
          stats.launched++;
          options.write(`${event.block}  LAUNCH   ${shortAddress(event.record!.token)}  quote ${event.record!.pairToken === ZERO_ADDRESS ? "ETH" : shortAddress(event.record!.pairToken)}  by ${shortAddress(event.record!.deployer)}\n`);
        } else if (event.kind === "swept") {
          stats.swept++;
          options.write(`${event.block}  SWEPT    ${shortAddress(event.token)}  curve drained, seeding pool\n`);
        } else if (event.kind === "graduated" && !printed.has(event.token)) {
          printed.add(event.token);
          stats.graduated++;
          const facts = await graduationFacts(rpc, event.token, event.block, event.record, head, options.chunkSize);
          const banner = diplomaLine(facts);
          if (options.party && options.animate) await playConfetti(event.block, banner, options.write, 70, { width: 64, height: 6, color: options.color });
          else if (options.party) options.write(confettiBlock(event.block, banner, { width: 64, height: 6 }) + "\n");
          else options.write(`${event.block}  GRADUATE ${banner}\n`);
        }
      }
      stats.lastBlock = head;
      from = head + 1;
    }
    stats.sweeps++;
    options.write(`— sweep ${stats.sweeps} · head ${head} · launched ${stats.launched} · graduated ${stats.graduated}${stats.launched ? ` · rate ${((stats.graduated / stats.launched) * 100).toFixed(2)}%` : ""}\n`);
    if (options.maxSweeps !== undefined && stats.sweeps >= options.maxSweeps) return stats;
    await sleep(options.intervalMs);
  }
}

interface FlatEvent {
  kind: "launched" | "swept" | "graduated";
  block: number;
  token: string;
  record?: LaunchRecord;
}

function flatten(launches: LaunchRecord[], outside: { token: string; block: number }[]): FlatEvent[] {
  const events: FlatEvent[] = [];
  for (const record of launches) {
    events.push({ kind: "launched", block: record.launchedAt.block, token: record.token, record });
    if (record.sweptAt) events.push({ kind: "swept", block: record.sweptAt.block, token: record.token, record });
    if (record.graduatedAt) events.push({ kind: "graduated", block: record.graduatedAt.block, token: record.token, record });
  }
  for (const o of outside) events.push({ kind: "graduated", block: o.block, token: o.token });
  return events.sort((a, b) => a.block - b.block || rank(a.kind) - rank(b.kind));
}

function rank(kind: FlatEvent["kind"]): number {
  return kind === "launched" ? 0 : kind === "swept" ? 1 : 2;
}

/**
 * Reads what the diploma needs. The transcript is only read when the launch
 * block is known (the launch was inside the window); otherwise it is null and
 * the diploma says so instead of guessing.
 */
export async function graduationFacts(
  rpc: RpcClient,
  token: string,
  graduationBlock: number,
  record: LaunchRecord | undefined,
  observedAtBlock: number,
  chunkSize = 2_000,
): Promise<DiplomaFacts> {
  const [nameRaw, symbolRaw, decimalsRaw, launchedRaw] = await rpc.callBatch(
    [
      { to: token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
      { to: token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
      { to: token, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
      { to: PONS_V2_FACTORY, data: encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [token]) },
    ],
    observedAtBlock,
  );
  const [name] = decodeOutputs(ERC20_FUNCTIONS.name, nameRaw) as [string];
  const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, symbolRaw) as [string];
  const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, decimalsRaw) as [bigint];
  const launched = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, launchedRaw));
  const header = await rpc.getBlock(graduationBlock);
  const pair = launched.pairToken === ZERO_ADDRESS ? { symbol: "ETH", decimals: 18 } : await readTokenMeta(rpc, launched.pairToken, observedAtBlock);

  const launchBlock = record?.launchedAt.block ?? null;
  const sweepBlock = record?.sweptAt?.block ?? (launched.sweptAt !== 0n ? null : null);
  const launchHeader = launchBlock === null ? null : await rpc.getBlock(launchBlock);
  const transcript = launchBlock === null ? null : await readTranscript(rpc, launched.curve, launched.deployer, launchBlock, sweepBlock ?? graduationBlock, chunkSize);

  return {
    name,
    symbol,
    token,
    deployer: launched.deployer,
    pairToken: launched.pairToken,
    pairSymbol: pair.symbol,
    pairDecimals: pair.decimals,
    graduationBlock,
    graduationTimestamp: header.timestamp,
    sweepBlock,
    launchBlock,
    launchTimestamp: launchHeader?.timestamp ?? null,
    quoteRaised: record?.graduatedAt?.pairTokenAmount ?? launched.sweptQuote,
    tokensToPool: record?.graduatedAt?.tokenAmount ?? launched.sweptTokens,
    tokenDecimals: Number(decimals),
    positionId: record?.graduatedAt ? record.graduatedAt.positionId : null,
    poolId: record?.graduatedAt?.poolId ?? null,
    creatorTaxBps: launched.creatorTaxBps,
    buybackEnabled: launched.buybackEnabled,
    observedAtBlock,
    transcript,
  };
}
