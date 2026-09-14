/**
 * THE DOOR: one address in, one slip out. Runs the ID check, then, for a
 * registered launch, the cover charge, the house rules and the dev report
 * card, all pinned to one head block, and turns the facts into door notes.
 * A note is a fact with a level: STOP (the address is not what it claims or
 * its code can change), WATCH (a term worth reading before buying) or INFO.
 * The slip never says buy or sell. It says what is true at the door.
 */
import { GraduationPhase, PHASE_LABEL, type LaunchedToken } from "../chain/pons.js";
import { FACTORY_EVENTS, PONS_V2_FACTORY } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, estimateBlocksAgo, findBlockByTimestamp, readTapeAdaptive } from "../chain/tape.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "../format.js";
import type { Receipt } from "../receipt.js";
import { coverChargeLine, readCoverCharge, type CoverCharge } from "./coverCharge.js";
import { devReportLine, readDevReport, type DevReport } from "./devReport.js";
import { readHouseRules, type HouseRules } from "./houseRules.js";
import { idFindings, readIdCheck, type IdCheck } from "./idCheck.js";

export type NoteLevel = "stop" | "watch" | "info";

export interface DoorNote {
  level: NoteLevel;
  code: string;
  text: string;
}

export type Stamp = "ON THE LIST" | "NOT ON THE LIST";

export interface DoorSlip {
  chainId: number;
  at: { block: number; timestamp: number };
  subject: string;
  stamp: Stamp;
  id: IdCheck;
  launchBlock: number | null;
  cover: CoverCharge | null;
  rules: HouseRules | null;
  dev: DevReport | null;
  notes: DoorNote[];
}

export interface DoorOptions {
  /** How far back the dev report card looks, in hours. */
  devHours?: number;
  /** How far back to search for the launch event, in blocks. */
  launchSearchBlocks?: number;
  chunkSize?: number;
  factory?: string;
  /** Skip the dev report (fewer requests). */
  skipDev?: boolean;
}

export async function readDoor(rpc: RpcClient, input: string, options: DoorOptions = {}): Promise<DoorSlip> {
  await rpc.assertChain();
  const chainId = await rpc.chainId();
  const headNumber = await rpc.blockNumber();
  const head = await rpc.getBlock(headNumber);
  const factory = options.factory ?? PONS_V2_FACTORY;

  const id = await readIdCheck(rpc, input, head.number, factory);
  const slip: DoorSlip = {
    chainId,
    at: { block: head.number, timestamp: head.timestamp },
    subject: id.launch ? id.launch.token.toLowerCase() : id.input,
    stamp: id.registered ? "ON THE LIST" : "NOT ON THE LIST",
    id,
    launchBlock: null,
    cover: null,
    rules: null,
    dev: null,
    notes: [],
  };
  if (!id.launch) {
    slip.notes = doorNotes(slip);
    return slip;
  }

  const launch = id.launch;
  slip.launchBlock = await findLaunchBlock(rpc, launch.token, head.number, options.launchSearchBlocks ?? estimateBlocksAgo(7 * 86_400), factory, options.chunkSize);
  if (slip.launchBlock !== null) {
    slip.cover = await readCoverCharge(rpc, launch, { launchBlock: slip.launchBlock, head, chunkSize: options.chunkSize, factory });
  }
  slip.rules = await readHouseRules(rpc, launch, { launchBlock: slip.launchBlock ?? Math.max(0, head.number - (options.launchSearchBlocks ?? estimateBlocksAgo(7 * 86_400))), head: head.number, chunkSize: options.chunkSize, factory });
  if (!options.skipDev) {
    const hours = options.devHours ?? 24;
    const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
    slip.dev = await readDevReport(rpc, launch.deployer, { fromBlock, toBlock: head.number, factory, chunking: options.chunkSize ? { startChunk: options.chunkSize, maxChunk: options.chunkSize } : undefined });
  }
  slip.notes = doorNotes(slip);
  return slip;
}

/**
 * Walks backwards from the head in growing chunks until the token's
 * TokenLaunched log appears. Fresh launches are found in the first chunk.
 */
export async function findLaunchBlock(rpc: RpcClient, token: string, head: number, maxBlocks: number, factory: string = PONS_V2_FACTORY, chunkSize?: number): Promise<number | null> {
  let to = head;
  let chunk = chunkSize ?? 20_000;
  const floor = Math.max(0, head - maxBlocks);
  while (to >= floor) {
    const from = Math.max(floor, to - chunk + 1);
    const tape = await readTapeAdaptive(
      rpc,
      { fromBlock: from, toBlock: to, address: factory, events: [FACTORY_EVENTS.TokenLaunched], topics: [addressTopic(token)] },
      { startChunk: chunk, maxChunk: chunk, minChunk: Math.min(1_000, chunk) },
    );
    if (tape.logs.length) return tape.logs[0].blockNumber;
    if (from === floor) break;
    to = from - 1;
    chunk = Math.min(chunk * 2, chunkSize ?? 400_000);
  }
  return null;
}

export function doorNotes(slip: DoorSlip): DoorNote[] {
  const notes: DoorNote[] = [];
  const t = slip.id.token;
  const findings = idFindings(slip.id);
  if (!slip.id.registered) {
    notes.push({
      level: "stop",
      code: "not-registered",
      text: t.code.empty
        ? "No contract at this address on Robinhood Chain."
        : "Not a Pons V2 launch: the factory has no record of this address, so nothing below about curves, taxes or graduation applies to it.",
    });
    for (const f of findings) if (!f.startsWith("no bytecode")) notes.push({ level: "stop", code: "code", text: `Code can change or vanish: ${f}.` });
    return notes;
  }
  if (slip.id.resolvedAs === "curve") notes.push({ level: "info", code: "curve-input", text: `You pasted the curve; the slip is for its token ${slip.subject}.` });
  for (const f of findings) notes.push({ level: "watch", code: "code", text: `Unexpected for a Pons token: ${f}.` });

  const c = slip.cover;
  if (c) {
    if (c.status === "open") {
      notes.push({ level: "watch", code: "cover-open", text: `Cover charge is open for ${c.secondsLeft} more s: a buy right now pays up to ${formatBps(c.terms.startBps)} of its quote to the creator on top of the fees. Wait for the door.` });
    } else if (c.status === "closed") {
      const taxed = c.observed.filter((b) => !b.creatorWallet && b.chargeBps > 0);
      const highest = taxed.length ? Math.max(...taxed.map((b) => b.chargeBps)) : 0;
      notes.push({
        level: "info",
        code: "cover-closed",
        text: `Cover charge closed ${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago. ${c.observed.length} buy${c.observed.length === 1 ? "" : "s"} landed inside the ${c.terms.seconds} s window${taxed.length ? `, the highest paid ${(highest / 100).toFixed(1)}% at the door` : ""}.`,
      });
    }
    if (c.termsChangedSinceLaunch) notes.push({ level: "watch", code: "terms-retuned", text: "The factory retuned its anti-snipe terms after this launch; the curve keeps the terms it launched under, which are not the ones shown." });
  } else {
    notes.push({ level: "info", code: "launch-older", text: "Launch is older than the search window, so the cover charge window is long closed and was not read." });
  }

  const r = slip.rules;
  if (r) {
    if (r.totalTradeBps >= 1_000n) notes.push({ level: "watch", code: "high-tax", text: `Every curve trade pays ${formatBps(r.totalTradeBps)} of its quote leg (${formatBps(r.creatorTaxBps)} of it to the creator).` });
    if (r.creatorFeeRecipientChanges.length) notes.push({ level: "watch", code: "fee-recipient-moved", text: `The creator moved the tax recipient ${r.creatorFeeRecipientChanges.length}× since launch, last to ${shortAddress(r.creatorFeeRecipientChanges[r.creatorFeeRecipientChanges.length - 1].to)}.` });
    if (r.deployerShareBps >= 2_000) notes.push({ level: "watch", code: "dev-holds", text: `The deployer holds ${(r.deployerShareBps / 100).toFixed(1)}% of supply.` });
    if (r.buybackEnabled) notes.push({ level: "info", code: "buyback-vests", text: "Buyback is on. Bought-back tokens are locked and vest to the creator and protocol over five years; they are not burned." });
    if (r.phase === GraduationPhase.Swept) notes.push({ level: "info", code: "swept-no-pool", text: "Swept but no pool yet: the curve is closed and the Uniswap pool has not been created." });
    if (r.phase === GraduationPhase.PoolCreated || r.phase === GraduationPhase.Rescued) notes.push({ level: "info", code: "graduated", text: "Graduated. The pool position is held by the Pons locker; the creator cannot pull it." });
  }

  const d = slip.dev;
  if (d) {
    if (d.counts.launched === 0) notes.push({ level: "info", code: "dev-first", text: "First launch from this deployer in the window." });
    if (d.counts.launched >= 5 && d.counts.graduated === 0) notes.push({ level: "watch", code: "dev-serial", text: `This deployer launched ${d.counts.launched} tokens in the window and none graduated.` });
    if (d.repeatedSymbols.length) notes.push({ level: "watch", code: "dev-repeat", text: `Same ticker launched more than once by this deployer: ${d.repeatedSymbols.join(", ")}.` });
    if (d.counts.graduated > 0) notes.push({ level: "info", code: "dev-graduated", text: `This deployer has ${d.counts.graduated} graduation${d.counts.graduated === 1 ? "" : "s"} in the window${d.medianSecondsToSweep !== null ? `, median ${formatDuration(d.medianSecondsToSweep)} from launch to sweep` : ""}.` });
  }
  return notes;
}

export function doorReceipt(slip: DoorSlip): Receipt {
  const meta = slip.id.meta;
  const launch = slip.id.launch;
  const title = meta ? `${meta.symbol} · ${meta.name}` : slip.subject;
  const sections: Receipt["sections"] = [];
  sections.push({
    title: "ID check",
    rows: [
      { label: "address", value: slip.subject },
      { label: "stamp", value: slip.stamp },
      { label: "factory record", value: slip.id.registered, note: slip.id.resolvedAs === "curve" ? "resolved from the curve" : undefined },
      { label: "token code", value: `${slip.id.token.code.bytes} bytes`, note: codeNote(slip.id.token.code.opcodes, slip.id.token.proxyImplementation) },
      ...(slip.id.curve ? [{ label: "curve code", value: `${slip.id.curve.code.bytes} bytes`, note: codeNote(slip.id.curve.code.opcodes, slip.id.curve.proxyImplementation) }] : []),
      ...(launch ? [{ label: "deployer", value: launch.deployer.toLowerCase() }, { label: "phase", value: PHASE_LABEL[launch.phase] }] : []),
    ],
  });
  if (slip.cover) {
    const c = slip.cover;
    sections.push({
      title: "Cover charge",
      rows: [
        { label: "terms", value: `${formatBps(c.terms.startBps)} in the launch second, decaying to 0 over ${c.terms.seconds} s`, note: c.termsChangedSinceLaunch ? "retuned since launch" : "unchanged since launch" },
        { label: "launched", value: isoUtc(c.launch.timestamp), note: `block ${c.launch.block}` },
        { label: "door", value: coverChargeLine(c) },
        ...c.observed.slice(0, 8).map((b, i) => ({
          label: `buy ${i + 1}`,
          value: `${b.secondsAfterLaunch.toFixed(1)} s · ${shortAddress(b.buyer)} · paid ${(b.chargeBps / 100).toFixed(1)}%`,
          note: b.creatorWallet ? "creator wallet, exempt" : undefined,
        })),
      ],
    });
  }
  if (slip.rules) {
    sections.push({ title: "House rules", rows: slip.rules.rules.map((text, i) => ({ label: `${i + 1}`, value: text })) });
  }
  if (slip.dev) {
    const d = slip.dev;
    sections.push({
      title: "Dev report card",
      rows: [
        { label: "deployer", value: d.deployer },
        { label: "in window", value: devReportLine(d) },
        ...d.launches.slice(0, 8).map((l) => ({
          label: l.symbol,
          value: `${PHASE_LABEL[l.phase]} · tax ${formatBps(l.creatorTaxBps)}${l.secondsToSweep !== null ? ` · swept in ${formatDuration(l.secondsToSweep)}` : ""}`,
          note: l.token === slip.subject ? "this one" : undefined,
        })),
        ...(d.truncated ? [{ label: "…", value: `${d.counts.launched - d.launches.length} older launches not listed` }] : []),
      ],
    });
  }
  sections.push({
    title: "Door notes",
    rows: slip.notes.map((n) => ({ label: n.level.toUpperCase(), value: n.text })),
  });
  return {
    title: `BOUNCER · ${title}`,
    subtitle: `${slip.stamp} · block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}`,
    sections,
    footnotes: [
      "Every value was read from Robinhood Chain at the block shown. Nothing is scored, predicted or advised: the slip says what is true at the door.",
      ...(slip.rules ? [`Amounts in ${slip.rules.quote.symbol}; ${formatUnits(slip.rules.snapshot.token.totalSupply, slip.rules.snapshot.token.decimals, 0)} total supply.`] : []),
    ],
    meta: { stamp: slip.stamp, block: slip.at.block, subject: slip.subject, notes: slip.notes.length },
  };
}

function codeNote(op: { selfdestruct: number; delegatecall: number; callcode: number; create: number; create2: number }, proxy: string | null): string {
  const flags: string[] = [];
  if (proxy) flags.push("proxy");
  if (op.selfdestruct) flags.push("SELFDESTRUCT");
  if (op.delegatecall) flags.push("DELEGATECALL");
  if (op.callcode) flags.push("CALLCODE");
  if (op.create || op.create2) flags.push("CREATE");
  return flags.length ? flags.join(", ") : "no SELFDESTRUCT, no DELEGATECALL, no proxy";
}

/** JSON-safe copy of the slip (bigints as decimal strings). */
export function slipJson(slip: DoorSlip): string {
  return JSON.stringify(slip, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export type { LaunchedToken };
