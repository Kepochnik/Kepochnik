/**
 * THE DOOR: one address in, one slip out. Runs the ID check, then, for a
 * registered launch, the cover charge, the house rules, the room, the exit
 * door, the dev report card and, when the chain has an explorer, the crew
 * check and the lookalikes; all pinned to one head block, then turned into
 * door notes. A note is a fact with a level: STOP (the address is not what
 * it claims or its code can change), WATCH (a term worth reading before
 * buying) or INFO. The slip never says buy or sell. It says what is true
 * at the door.
 */
import type { BlockscoutClient } from "../chain/blockscout.js";
import { DEFAULT_CHAIN, type ChainConfig } from "../chain/chains.js";
import { FACTORY_EVENTS, GraduationPhase, PHASE_LABEL, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, findBlockByTimestamp, readTapeAdaptive } from "../chain/tape.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "../format.js";
import type { Receipt } from "../receipt.js";
import { coverChargeLine, readCoverCharge, type CoverCharge } from "./coverCharge.js";
import { devReportLine, readDevReport, type DevReport } from "./devReport.js";
import { readExitDoor, type ExitDoor } from "./exitDoor.js";
import { readHouseRules, type HouseRules } from "./houseRules.js";
import { idFindings, readIdCheck, type IdCheck } from "./idCheck.js";
import { lookalikeLine, readLookalikes, type LookalikeReport } from "./lookalike.js";
import { oneCrewLine, readOneCrew, type OneCrew } from "./oneCrew.js";
import { readRoom, roomLine, type Room } from "./room.js";

export type NoteLevel = "stop" | "watch" | "info";

export interface DoorNote {
  level: NoteLevel;
  code: string;
  text: string;
}

export type Stamp = "ON THE LIST" | "NOT ON THE LIST";

export interface DoorSlip {
  chain: { key: string; name: string; chainId: number; launchpad: string; native: { symbol: string; decimals: number } };
  at: { block: number; timestamp: number };
  subject: string;
  stamp: Stamp;
  id: IdCheck;
  launchBlock: number | null;
  cover: CoverCharge | null;
  rules: HouseRules | null;
  room: Room | null;
  exit: ExitDoor | null;
  crew: OneCrew | null;
  lookalikes: LookalikeReport | null;
  dev: DevReport | null;
  notes: DoorNote[];
  /** Sections that were asked for but could not be read, with the reason. */
  skipped: { section: string; reason: string }[];
}

export interface DoorOptions {
  chain?: ChainConfig;
  /** Factory override (needed on chains whose factory is not published yet). */
  factory?: string;
  /** Explorer client for the crew check and lookalikes; null disables both. */
  blockscout?: BlockscoutClient | null;
  /** How far back the dev report card looks, in hours. */
  devHours?: number;
  /** How far back to search for the launch event, in blocks. */
  launchSearchBlocks?: number;
  chunkSize?: number;
  skipDev?: boolean;
  skipRoom?: boolean;
  skipCrew?: boolean;
  skipLookalikes?: boolean;
  /** Token amount the exit door prices; default 1% of supply. */
  position?: bigint;
}

export async function readDoor(rpc: RpcClient, input: string, options: DoorOptions = {}): Promise<DoorSlip> {
  const chain = options.chain ?? DEFAULT_CHAIN;
  const factory = (options.factory ?? chain.factory ?? "").toLowerCase();
  if (!factory) throw new Error(`${chain.name}: the launchpad factory address is not published yet; pass --factory 0x…`);
  await rpc.assertChain();
  const headNumber = await rpc.blockNumber();
  const head = await rpc.getBlock(headNumber);
  const searchBlocks = options.launchSearchBlocks ?? Math.round(7 * 86_400 * chain.blocksPerSecond);

  const id = await readIdCheck(rpc, input, head.number, factory, { factoryV1: chain.factoryV1, native: chain.native });
  const slip: DoorSlip = {
    chain: { key: chain.key, name: chain.name, chainId: chain.chainId, launchpad: chain.launchpad, native: chain.native },
    at: { block: head.number, timestamp: head.timestamp },
    subject: id.launch ? id.launch.token.toLowerCase() : id.input,
    stamp: id.registered ? "ON THE LIST" : "NOT ON THE LIST",
    id,
    launchBlock: null,
    cover: null,
    rules: null,
    room: null,
    exit: null,
    crew: null,
    lookalikes: null,
    dev: null,
    notes: [],
    skipped: [],
  };
  if (!id.launch) {
    // A V1 token is on the list with its own rules; the V2 sections do not apply.
    slip.notes = doorNotes(slip);
    return slip;
  }
  const launch = id.launch;
  const attempt = async (section: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      slip.skipped.push({ section, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  slip.launchBlock = await findLaunchBlock(rpc, launch.token, head.number, searchBlocks, factory, options.chunkSize);
  if (slip.launchBlock !== null) {
    await attempt("cover charge", async () => {
      slip.cover = await readCoverCharge(rpc, launch, { launchBlock: slip.launchBlock!, head, chunkSize: options.chunkSize, factory });
    });
  }
  const rulesFrom = slip.launchBlock ?? Math.max(0, head.number - searchBlocks);
  await attempt("house rules", async () => {
    slip.rules = await readHouseRules(rpc, launch, { launchBlock: rulesFrom, head: head.number, chunkSize: options.chunkSize, factory, native: chain.native });
  });
  if (!options.skipRoom && slip.launchBlock !== null) {
    await attempt("the room", async () => {
      slip.room = await readRoom(rpc, launch, slip.launchBlock!, head.number, options.chunkSize, Math.round(60 * chain.blocksPerSecond));
    });
  }
  await attempt("exit door", async () => {
    const supply = slip.rules?.snapshot.token.totalSupply ?? slip.id.meta?.totalSupply ?? 0n;
    slip.exit = await readExitDoor(rpc, launch, { position: options.position ?? supply / 100n, block: head.number, factory });
  });
  if (options.blockscout && !options.skipCrew && slip.room && slip.launchBlock !== null) {
    await attempt("one crew", async () => {
      slip.crew = await readOneCrew(options.blockscout!, slip.room!, slip.launchBlock!, [launch.deployer, launch.creatorFeeRecipient]);
    });
  }
  if (options.blockscout && !options.skipLookalikes && slip.id.meta) {
    await attempt("lookalikes", async () => {
      slip.lookalikes = await readLookalikes(rpc, options.blockscout!, launch.token, slip.id.meta!.symbol, head.number, factory, searchBlocks);
    });
  }
  if (!options.skipDev) {
    await attempt("dev report card", async () => {
      const hours = options.devHours ?? 24;
      const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
      slip.dev = await readDevReport(rpc, launch.deployer, { fromBlock, toBlock: head.number, factory, chunking: options.chunkSize ? { startChunk: options.chunkSize, maxChunk: options.chunkSize } : undefined });
    });
  }
  slip.notes = doorNotes(slip);
  return slip;
}

/**
 * Walks backwards from the head in growing chunks until the token's
 * TokenLaunched log appears. Fresh launches are found in the first chunk.
 */
export async function findLaunchBlock(rpc: RpcClient, token: string, head: number, maxBlocks: number, factory: string, chunkSize?: number): Promise<number | null> {
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
  const q = slip.chain.native;
  if (slip.id.v1) {
    const v = slip.id.v1;
    notes.push({ level: "info", code: "v1-launch", text: `This is a Pons V1 token: fixed supply, traded in a Uniswap V3 pool from the first block. There is no bonding curve, no creator tax and no door tax, so those sections are not shown.` });
    if (v.restrictionBlocksLeft > 0 && v.config) notes.push({ level: "watch", code: "v1-caps", text: `Launch caps are still on for ${v.restrictionBlocksLeft} blocks: max ${formatBps(v.config.maxWalletBps)} of supply per wallet, ${formatBps(v.config.maxTxBps)} per trade. A buy above the cap reverts.` });
    if (!v.status.graduated) notes.push({ level: "info", code: "v1-not-graduated", text: `Not graduated: ${formatUnits(v.status.pairedPrincipal, v.quote.decimals)} of ${formatUnits(v.status.threshold, v.quote.decimals)} ${v.quote.symbol} in the pool.` });
    for (const f of findings) notes.push({ level: "watch", code: "code", text: `Unexpected for a launchpad token: ${f}.` });
    return notes;
  }
  if (!slip.id.registered) {
    notes.push({
      level: "stop",
      code: "not-registered",
      text: t.code.empty
        ? `No contract at this address on ${slip.chain.name}.`
        : `Not a ${slip.chain.launchpad} launch: neither the ${slip.chain.launchpad} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} has a record of this address. If it was launched elsewhere (another launchpad, or by hand), it is not a Pons token, whatever its name says.`,
    });
    for (const f of findings) if (!f.startsWith("no bytecode")) notes.push({ level: "stop", code: "code", text: `Code can change or vanish: ${f}.` });
    return notes;
  }
  if (slip.id.resolvedAs === "curve") notes.push({ level: "info", code: "curve-input", text: `You pasted the curve; the slip is for its token ${slip.subject}.` });
  for (const f of findings) notes.push({ level: "watch", code: "code", text: `Unexpected for a launchpad token: ${f}.` });

  const c = slip.cover;
  if (c) {
    if (c.status === "open") {
      notes.push({ level: "watch", code: "cover-open", text: `The door tax is still on for ${c.secondsLeft} s: buying now hands up to ${formatBps(c.terms.startBps)} of your money to the creator on top of the fees. Wait for it to end.` });
    } else if (c.status === "closed") {
      const taxed = c.observed.filter((b) => !b.creatorWallet && b.chargeBps > 0);
      const highest = taxed.length ? Math.max(...taxed.map((b) => b.chargeBps)) : 0;
      notes.push({
        level: "info",
        code: "cover-closed",
        text: `The door tax ended ${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago. ${c.observed.length} buy${c.observed.length === 1 ? "" : "s"} landed in the first ${c.terms.seconds} s${taxed.length ? `; the highest paid ${(highest / 100).toFixed(1)}% at the door` : ""}.`,
      });
    }
    if (c.termsChangedSinceLaunch) notes.push({ level: "watch", code: "terms-retuned", text: "The factory changed its door-tax settings after this launch; this token keeps the settings it launched under, which are not the ones shown." });
  } else if (slip.launchBlock === null) {
    notes.push({ level: "info", code: "launch-older", text: "This launch is older than the search window, so the door tax ended long ago and was not read." });
  }

  const r = slip.rules;
  if (r) {
    if (r.totalTradeBps >= 1_000n) notes.push({ level: "watch", code: "high-tax", text: `Every trade pays ${formatBps(r.totalTradeBps)} in fees, ${formatBps(r.creatorTaxBps)} of it to the creator.` });
    if (r.creatorFeeRecipientChanges.length) notes.push({ level: "watch", code: "fee-recipient-moved", text: `The creator changed where their cut is paid ${r.creatorFeeRecipientChanges.length}× since launch, last to ${shortAddress(r.creatorFeeRecipientChanges[r.creatorFeeRecipientChanges.length - 1].to)}.` });
    if (r.deployerShareBps >= 2_000) notes.push({ level: "watch", code: "dev-holds", text: `The deployer holds ${(r.deployerShareBps / 100).toFixed(1)}% of supply.` });
    if (r.buybackEnabled) notes.push({ level: "info", code: "buyback-vests", text: "Buyback is on. It does not burn anything: bought-back tokens are locked and released to the creator and the protocol over five years." });
    if (r.phase === GraduationPhase.Swept) notes.push({ level: "info", code: "swept-no-pool", text: "The curve is closed and the Uniswap pool has not been created yet, so nothing trades right now." });
    if (r.phase === GraduationPhase.PoolCreated || r.phase === GraduationPhase.Rescued) notes.push({ level: "info", code: "graduated", text: "Graduated: it trades in a Uniswap pool whose liquidity is locked by the launchpad. The creator cannot pull it." });
  }

  const room = slip.room;
  if (room && room.buys > 0) {
    if (room.devShareBps >= 5_000) notes.push({ level: "watch", code: "dev-funded", text: `The creator's own wallets paid for ${(room.devShareBps / 100).toFixed(0)}% of everything bought so far.` });
    if (room.sharedBlocks.length >= 3) notes.push({ level: "watch", code: "bundled-blocks", text: `${room.sharedBlocks.length} times, several different wallets bought in the very same block: the shape of a bundled launch.` });
    if (room.buyers >= 25 && room.devShareBps < 2_000) notes.push({ level: "info", code: "room-wide", text: `${room.buyers} distinct buyers and the creator funded ${(room.devShareBps / 100).toFixed(0)}%.` });
  }

  const crew = slip.crew;
  if (crew) {
    if (crew.largestCrewShareBps >= 2_500) notes.push({ level: "watch", code: "one-crew", text: `${crew.crews[0].wallets.length} of the first buyers got their money from the same address (${shortAddress(crew.crews[0].funder)}) and together bought ${(crew.largestCrewShareBps / 100).toFixed(0)}% of everything.` });
    if (crew.fundedByCreator.length) notes.push({ level: "watch", code: "crew-creator", text: `${crew.fundedByCreator.length} of the first buyers got their ${q.symbol} from the creator's wallets right before buying.` });
    if (!crew.crews.length && crew.checked >= 5 && !crew.fundedByCreator.length) notes.push({ level: "info", code: "crew-clean", text: `${crew.checked} first buyers checked, no shared funder.` });
  }

  const l = slip.lookalikes;
  if (l) {
    const others = l.candidates.filter((x) => x.address !== l.subject);
    if (l.subjectIsEarliest === false) notes.push({ level: "watch", code: "lookalike-later", text: `Another token called ${l.query} launched before this one (${shortAddress(l.earliest!.address)}, block ${l.earliest!.launchBlock}). A name is not an identity; check which address the team posted.` });
    else if (others.length) notes.push({ level: "info", code: "lookalikes", text: `${others.length} other token${others.length === 1 ? "" : "s"} called ${l.query} exist on this chain${l.subjectIsEarliest ? "; this one launched first" : ""}.` });
  }

  const e = slip.exit;
  if (e) {
    const whole = e.quotes.find((x) => x.shareBps === 10_000);
    if (e.venue === "closed") notes.push({ level: "info", code: "exit-closed", text: e.note });
    else if (whole && whole.realisedBps > 0 && whole.realisedBps < 5_000) notes.push({ level: "info", code: "exit-thin", text: `Selling 1% of supply now would get only ${(whole.realisedBps / 100).toFixed(0)}% of the quoted price: liquidity is thin.` });
  }

  const d = slip.dev;
  if (d) {
    if (d.counts.launched === 0) notes.push({ level: "info", code: "dev-first", text: "First launch from this dev in the window." });
    if (d.counts.launched >= 5 && d.counts.graduated === 0) notes.push({ level: "watch", code: "dev-serial", text: `This dev launched ${d.counts.launched} tokens in the window and none of them graduated.` });
    if (d.repeatedSymbols.length) notes.push({ level: "watch", code: "dev-repeat", text: `This dev launched the same ticker more than once: ${d.repeatedSymbols.join(", ")}.` });
    if (d.counts.graduated > 0) notes.push({ level: "info", code: "dev-graduated", text: `This dev has ${d.counts.graduated} graduation${d.counts.graduated === 1 ? "" : "s"} in the window${d.medianSecondsToSweep !== null ? `, typically ${formatDuration(d.medianSecondsToSweep)} from launch to a full curve` : ""}.` });
  }
  for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
  return notes;
}

export function doorReceipt(slip: DoorSlip): Receipt {
  const meta = slip.id.meta;
  const launch = slip.id.launch;
  const title = meta ? `${meta.symbol} · ${meta.name}` : slip.subject;
  const q = slip.rules?.quote ?? { symbol: slip.chain.native.symbol, decimals: slip.chain.native.decimals };
  const amt = (v: bigint) => `${formatUnits(v, q.decimals)} ${q.symbol}`;
  const sections: Receipt["sections"] = [];
  sections.push({
    title: "ID check",
    rows: [
      { label: "address", value: slip.subject },
      { label: "chain", value: `${slip.chain.name} (${slip.chain.chainId}) · ${slip.chain.launchpad}` },
      { label: "stamp", value: slip.stamp },
      { label: "factory record", value: slip.id.registered, note: slip.id.resolvedAs === "curve" ? "resolved from the curve" : undefined },
      { label: "token code", value: `${slip.id.token.code.bytes} bytes`, note: codeNote(slip.id.token.code.opcodes, slip.id.token.proxyImplementation) },
      ...(slip.id.curve ? [{ label: "curve code", value: `${slip.id.curve.code.bytes} bytes`, note: codeNote(slip.id.curve.code.opcodes, slip.id.curve.proxyImplementation) }] : []),
      ...(launch ? [{ label: "deployer", value: launch.deployer.toLowerCase() }, { label: "phase", value: PHASE_LABEL[launch.phase] }] : []),
      ...(slip.id.v1 ? [{ label: "launchpad", value: "Pons V1" }, { label: "deployer", value: slip.id.v1.record.deployer.toLowerCase() }, { label: "pool", value: `Uniswap V3 position #${slip.id.v1.record.positionId}` }] : []),
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
          value: `${b.secondsAfterLaunch.toFixed(1)} s · ${shortAddress(b.buyer)} · ${amt(b.quoteIn)} · paid ${(b.chargeBps / 100).toFixed(1)}%`,
          note: b.creatorWallet ? "creator wallet, exempt" : undefined,
        })),
      ],
    });
  }
  if (slip.rules) sections.push({ title: "House rules", rows: slip.rules.rules.map((text, i) => ({ label: `${i + 1}`, value: text })) });
  if (slip.id.v1) sections.push({ title: "House rules (Pons V1)", rows: slip.id.v1.rules.map((text, i) => ({ label: `${i + 1}`, value: text })) });
  if (slip.room) {
    const r = slip.room;
    sections.push({
      title: "The room",
      rows: [
        { label: "since launch", value: roomLine(r) },
        { label: "bought", value: `${amt(r.totalQuoteIn)} net of fees over ${r.buys} buys, ${r.sells} sells` },
        ...r.wallets.slice(0, 6).map((w, i) => ({ label: `#${i + 1}`, value: `${shortAddress(w.address)} · in ${amt(w.quoteIn)}${w.quoteOut ? ` · out ${amt(w.quoteOut)}` : ""}`, note: w.creatorWallet ? "creator wallet" : undefined })),
      ],
    });
  }
  if (slip.exit) {
    const e = slip.exit;
    sections.push({
      title: "Exit door",
      rows: [
        { label: "venue", value: e.venue, note: e.venue === "closed" ? undefined : `fee ${formatBps(e.feeBps)} + creator ${formatBps(e.creatorTaxBps)}` },
        { label: "for", value: `${formatUnits(e.position, 18, 0)} tokens`, note: "1% of supply unless you passed --amount" },
        ...e.quotes.map((x) => ({ label: `sell ${x.shareBps / 100}%`, value: `${amt(x.net)} net`, note: `${(x.realisedBps / 100).toFixed(1)}% of spot` })),
        { label: "method", value: e.note },
      ],
    });
  }
  if (slip.crew) {
    const c = slip.crew;
    sections.push({
      title: "One crew",
      rows: [
        { label: "first buyers", value: oneCrewLine(c) },
        ...c.crews.slice(0, 3).map((cr, i) => ({ label: `crew ${i + 1}`, value: `${cr.wallets.length} wallets funded by ${shortAddress(cr.funder)} · ${(cr.shareBps / 100).toFixed(1)}% of the curve` })),
        ...c.wallets.slice(0, 8).map((w) => ({ label: shortAddress(w.address), value: w.creatorWallet ? "creator wallet" : w.funder ? `funded by ${shortAddress(w.funder)} at block ${w.fundedAtBlock}` : "funding not found" })),
      ],
    });
  }
  if (slip.lookalikes) {
    const l = slip.lookalikes;
    sections.push({
      title: "Lookalikes",
      rows: [
        { label: l.query, value: lookalikeLine(l) },
        ...l.candidates.slice(0, 8).map((x) => ({ label: shortAddress(x.address), value: `${x.registered ? "on the list" : "not on the list"}${x.phase !== null ? ` · ${PHASE_LABEL[x.phase]}` : ""}${x.launchBlock !== null ? ` · block ${x.launchBlock}` : ""}`, note: x.address === l.subject ? "this one" : undefined })),
      ],
    });
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
  sections.push({ title: "Door notes", rows: slip.notes.map((n) => ({ label: n.level.toUpperCase(), value: n.text })) });
  return {
    title: `BOUNCER · ${title}`,
    subtitle: `${slip.stamp} · ${slip.chain.name} · block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}`,
    sections,
    footnotes: [
      `Every value was read from ${slip.chain.name} at the block shown. Nothing is scored, predicted or advised: the slip says what is true at the door.`,
      ...(slip.rules ? [`Amounts in ${slip.rules.quote.symbol}; ${formatUnits(slip.rules.snapshot.token.totalSupply, slip.rules.snapshot.token.decimals, 0)} total supply.`] : []),
    ],
    meta: { stamp: slip.stamp, block: slip.at.block, subject: slip.subject, notes: slip.notes.length, chain: slip.chain.key },
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

/** JSON-safe copy of anything with bigints (decimal strings). */
export function slipJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export type { LaunchedToken };
