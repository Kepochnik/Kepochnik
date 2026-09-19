/**
 * THE DOOR: one address in, one slip out. Runs the ID check, then, for a
 * registered launch, the cover charge, the house rules, the room, the exit
 * door, the dev report card and, when the chain has an explorer, the crew
 * check and the lookalikes; for any other token, the open-door check (who
 * controls it, can holders move it, who holds it); all pinned to one head
 * block, then turned into door notes. A note is a fact with a level: STOP (the address is not what
 * it claims or its code can change), WATCH (a term worth reading before
 * buying) or INFO. The slip never says buy or sell. It says what is true
 * at the door.
 */
import type { BlockscoutClient } from "../chain/blockscout.js";
import { DEFAULT_CHAIN, type ChainConfig } from "../chain/chains.js";
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { FACTORY_EVENTS, FACTORY_FUNCTIONS, GraduationPhase, PHASE_LABEL, V1_FACTORY_FUNCTIONS, ZERO_ADDRESS, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, findBlockByTimestamp, readTapeAdaptive } from "../chain/tape.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "../format.js";
import type { Receipt } from "../receipt.js";
import { coverChargeLine, readCoverCharge, type CoverCharge } from "./coverCharge.js";
import { devReportLine, readDevReport, type DevReport } from "./devReport.js";
import { readExitDoor, type ExitDoor } from "./exitDoor.js";
import { readHouseRules, type HouseRules } from "./houseRules.js";
import { idFindings, readIdCheck, type IdCheck } from "./idCheck.js";
import { lookalikeLine, readLookalikes, registeredLookalikes, type Lookalike, type LookalikeReport } from "./lookalike.js";
import { oneCrewLine, readOneCrew, type OneCrew } from "./oneCrew.js";
import { controlLine, moveProbes, POWER_MEANING, powerKinds, readOpenDoor, sellProbes, type OpenDoor, type TransferProbe } from "./openDoor.js";
import { readRoom, roomLine, type Room } from "./room.js";

export type NoteLevel = "stop" | "watch" | "info";

export interface DoorNote {
  level: NoteLevel;
  code: string;
  text: string;
}

/**
 * ON THE LIST: the launchpad's factory made it. NOT A LAUNCH: a contract
 * the factory did not make, checked as an ordinary token. NOT ON THE LIST:
 * nothing there, or a token wearing the ticker of a real launch.
 */
export type Stamp = "ON THE LIST" | "NOT A LAUNCH" | "NOT ON THE LIST";

export interface DoorSlip {
  chain: { key: string; name: string; chainId: number; launchpad: string | null; native: { symbol: string; decimals: number } };
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
  /** The ordinary-token check, for a contract the launchpad did not make. */
  open: OpenDoor | null;
  notes: DoorNote[];
  /** Sections that were asked for but could not be read, with the reason. */
  skipped: { section: string; reason: string }[];
  /** What the chain table says this address is, when it is a well-known non-launch contract. */
  known: string | null;
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
  /** Skip reading who holds the pool's liquidity; it costs a log scan. */
  skipLiquidity?: boolean;
  /** How far back to look for the mints that opened the pool's positions. */
  liquidityBlocks?: number;
  /** Token amount the exit door prices; default 1% of supply. */
  position?: bigint;
}

export async function readDoor(rpc: RpcClient, input: string, options: DoorOptions = {}): Promise<DoorSlip> {
  const chain = options.chain ?? DEFAULT_CHAIN;
  const factory = (options.factory ?? chain.factory ?? "").toLowerCase();
  // A chain whose launchpad factory is not published yet still has tokens on
  // it, and the open-door check needs no factory at all. Only the launch
  // sections do, so the slip says the launch question could not be asked
  // rather than refusing to answer any question.
  const launchpadKnown = Boolean(factory);
  await rpc.assertChain();
  const headNumber = await rpc.blockNumber();
  const head = await rpc.getBlock(headNumber);
  const searchBlocks = options.launchSearchBlocks ?? Math.round(7 * 86_400 * chain.blocksPerSecond);

  const id = await readIdCheck(rpc, input, head.number, factory || undefined, {
    factoryV1: chain.factoryV1,
    olderFactoriesV1: chain.olderFactoriesV1,
    native: chain.native,
    skipLaunchLookup: !launchpadKnown,
  });
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
    open: null,
    notes: [],
    skipped: [],
    known: chain.known?.[id.input.toLowerCase()] ?? null,
  };
  const attempt = async (section: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      slip.skipped.push({ section, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  if (!launchpadKnown) {
    slip.skipped.push({
      section: "launch record",
      reason: chain.launchpad
        ? `the ${chain.launchpad} factory address is not published for ${chain.name} yet; pass --factory 0x… to check launches here`
        : `no launchpad BOUNCER knows runs on ${chain.name}, so there is no launch record to look for; every address here is checked as an ordinary token`,
    });
  }
  if (!id.launch && !id.token.code.empty) {
    // Not a V2 launch: a V1 token or an ordinary token. Either way the open-door
    // questions apply (who controls it, can holders move it, who holds it, where
    // it trades); an ordinary token is also stamped as such.
    if (!id.registered) slip.stamp = "NOT A LAUNCH";
    await attempt("open door", async () => {
      slip.open = await readOpenDoor(rpc, id.token, id.meta, head.number, {
        blockscout: options.blockscout ?? null,
        dex: chain.dex,
        lockers: await resolveLockers(rpc, chain, factory, id.v1?.factory, head.number),
        liquidity: options.skipLiquidity !== true,
        // A day, not a week. This is read before a trade, and the measured
        // cost of a week on Base was the better part of a minute for a section
        // that then reported nothing. What matters for "can they pull it now"
        // is who holds the liquidity now; --liquidity-blocks widens it for
        // anyone who wants the longer history and will wait for it.
        liquidityFromBlock: head.number - (options.liquidityBlocks ?? Math.min(200_000, Math.round(86_400 * chain.blocksPerSecond))),
        v4PoolManager: await resolveV4Manager(rpc, chain, options.factory, head.number),
      });
    });
    if (!id.registered && launchpadKnown && options.blockscout && !options.skipLookalikes && id.meta?.symbol) {
      await attempt("lookalikes", async () => {
        slip.lookalikes = await readLookalikes(rpc, options.blockscout!, id.input, id.meta!.symbol, head.number, factory, searchBlocks, 8, false);
      });
    }
    // The stamp is decided once, after both reads, from the one thing that
    // justifies it: a registered launch with this ticker that is older than
    // this contract. Deciding it inside a read would make the stamp depend on
    // whether the explorer happened to answer.
    if (!id.registered && impostorOf(slip)) slip.stamp = "NOT ON THE LIST";
  }
  if (!id.launch) {
    // A V1 token is on the list with its own rules; the V2 sections do not apply.
    slip.notes = doorNotes(slip);
    return slip;
  }
  const launch = id.launch;

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
    if (slip.open) notes.push(...openDoorFactNotes(slip, slip.open));
    return notes;
  }
  if (!slip.id.registered) return openDoorNotes(slip, findings);
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
  return withSkipped(slip, notes);
}

/**
 * Whether a registered launch with the same ticker predates this address.
 * Sharing a ticker is not impersonation: the real USDC shares its ticker with
 * every scam launch that copies it, and the scam is the newer one. So the
 * claim is only made when the registered launch is demonstrably older, and
 * never for an address the chain table already names.
 */
export function impostorOf(slip: DoorSlip): Lookalike | null {
  if (slip.known || !slip.lookalikes) return null;
  const subjectBlock = slip.open?.deployer?.createdAtBlock ?? null;
  if (subjectBlock === null) return null;
  for (const candidate of registeredLookalikes(slip.lookalikes)) {
    if (candidate.launchBlock !== null && candidate.launchBlock < subjectBlock) return candidate;
  }
  return null;
}

/**
 * Notes for a contract the launchpad did not make. Facts about the code
 * come first, then what the chain and the explorer say about control,
 * transfers, holders and age.
 */
function openDoorNotes(slip: DoorSlip, findings: string[]): DoorNote[] {
  const notes: DoorNote[] = [];
  const t = slip.id.token;
  const factories = slip.chain.launchpad ? `the ${slip.chain.launchpad} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""}` : "";
  if (t.code.empty) {
    notes.push({ level: "stop", code: "not-registered", text: `No contract at this address on ${slip.chain.name}.` });
    return withSkipped(slip, notes);
  }
  if (t.code.delegatedTo) {
    notes.push({ level: "info", code: "delegated-wallet", text: `This is a wallet, not a token: its code is an EIP-7702 delegation to ${shortAddress(t.code.delegatedTo)}, which its owner signed. There is nothing at this address to check for launch terms.` });
    return withSkipped(slip, notes);
  }
  const named = slip.id.meta ? `"${slip.id.meta.name}" (${slip.id.meta.symbol})` : "this contract";
  const impostor = impostorOf(slip);
  if (impostor) {
    notes.push({
      level: "stop",
      code: "lookalike-impostor",
      text: `A real ${slip.chain.launchpad} launch is called ${slip.lookalikes!.query} (${shortAddress(impostor.address)}, block ${impostor.launchBlock}) and it is older than this contract. This address is not it. If someone is selling this as that launch, it is not one.`,
    });
  } else if (slip.lookalikes && registeredLookalikes(slip.lookalikes).length) {
    notes.push({
      level: "watch",
      code: "lookalike-shared-ticker",
      text: `${registeredLookalikes(slip.lookalikes).length} launchpad token${registeredLookalikes(slip.lookalikes).length === 1 ? " carries" : "s carry"} the ticker ${slip.lookalikes.query} as well. Which came first could not be established, so neither is called a copy here; check the address the team posted.`,
    });
  }
  if (slip.id.claimedFactory) notes.push({ level: "watch", code: "claimed-factory", text: `The token names ${shortAddress(slip.id.claimedFactory)} as its launch factory (launchFactory()), but that factory is not one BOUNCER knows or its record does not confirm this token. A contract can claim any factory; only a known factory's record counts.` });
  if (slip.known) notes.push({ level: "info", code: "known-address", text: `This is ${slip.known}` });
  else if (slip.open) {
    notes.push({
      level: "info",
      code: "not-registered",
      text: factories
        ? `Not a launchpad token: neither ${factories} deployed ${named}, so curves, door tax and locked pools do not apply. Checked instead as an ordinary token on ${slip.chain.name}: who can change its rules, whether a holder can sell right now, who holds it.`
        : `No launchpad BOUNCER knows runs on ${slip.chain.name}, so ${named} is checked as what it is: an ordinary token. Who can change its rules, whether a holder can sell right now, who holds it, where it trades.`,
    });
  } else {
    notes.push({
      level: "watch",
      code: "not-registered",
      text: factories ? `Not a launchpad token: neither ${factories} deployed ${named}. The ordinary-token check could not be run, so nothing below was read.` : `${named} could not be checked: the ordinary-token read failed, so nothing below was read.`,
    });
  }

  const o = slip.open;
  for (const f of findings) {
    if (f.startsWith("SELFDESTRUCT") || f.startsWith("CALLCODE")) notes.push({ level: "stop", code: "code", text: `Code can vanish: ${f}.` });
    else if (f.startsWith("upgradeable proxy") || f.startsWith("beacon proxy") || f.startsWith("minimal proxy")) notes.push({ level: "watch", code: "code", text: `Code can be replaced: ${f}. Whoever controls the proxy decides what this token does tomorrow${o?.surfaceFrom === "implementation" ? "; the functions below were read from the current implementation" : ""}.` });
    else if (f.startsWith("DELEGATECALL")) notes.push({ level: "watch", code: "code", text: `Runs other contracts' code in its own storage: ${f}.` });
    else notes.push({ level: "info", code: "code", text: `${f.charAt(0).toUpperCase()}${f.slice(1)}.` });
  }
  if (!o) return withSkipped(slip, notes);
  notes.push(...openDoorFactNotes(slip, o));
  return withSkipped(slip, notes);
}

/** Appends one note per section that was asked for and could not be read. */
function withSkipped(slip: DoorSlip, notes: DoorNote[]): DoorNote[] {
  for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
  return notes;
}

/** A share of supply as a percentage, or the honest word when the supply is unknown. */
function pct(bps: number | null): string {
  return bps === null ? "an unknown share" : `${(bps / 100).toFixed(1)}%`;
}

/**
 * Where Uniswap V4 lives on this chain. The launchpad's factory answers it on
 * chain, which beats an address written down here: a recalled one would have
 * this read reporting another contract's storage with total confidence.
 */
async function resolveV4Manager(rpc: RpcClient, chain: ChainConfig, factory: string | undefined, block: number): Promise<string | undefined> {
  const configured = chain.dex?.v4PoolManager;
  if (!configured) return undefined;
  if (configured !== "from-launchpad") return configured;
  if (!factory) return undefined;
  try {
    const [raw] = await rpc.callBatch([{ to: factory, data: encodeCall(FACTORY_FUNCTIONS.poolManager, []) }], block);
    const address = (decodeOutputs(FACTORY_FUNCTIONS.poolManager, raw)[0] as string).toLowerCase();
    return address && address !== ZERO_ADDRESS ? address : undefined;
  } catch {
    return undefined; // V4 simply goes unread, which the pools note already covers
  }
}

/**
 * The lockers on this chain that BOUNCER can actually verify.
 *
 * A table of locker addresses written from memory is the one thing this
 * codebase refuses to ship, because a wrong entry tells somebody their money
 * is safe. But a launchpad publishes its own locker: both the V1 and the V2
 * factory answer `locker()`, and that answer is read from the chain at this
 * block. It is the same kind of fact as the factory record itself.
 *
 * It matters on exactly the token the tool was built for. $PONS keeps its
 * liquidity position in the launchpad's locker, and the liquidity section
 * reported "100% withdrawable" because it had no way to know the name of the
 * contract holding it. That is the most reassuring wrong sentence available,
 * printed on the chain's own flagship token.
 */
export async function resolveLockers(rpc: RpcClient, chain: ChainConfig, factory: string | undefined, v1Factory: string | undefined, block: number): Promise<ChainConfig["lockers"]> {
  const family = chain.launchpad ? chain.launchpad.replace(/ V\d+$/, "") : "launchpad";
  const factories = [
    { address: factory, name: `the ${chain.launchpad ?? "launchpad"} locker` },
    // The V1 factory that registered THIS token where the identify step found
    // one, because a chain can have had more than one, and a locker read off
    // the wrong factory is exactly the kind of near-miss this file exists to
    // avoid. The configured address is the fallback.
    { address: v1Factory ?? chain.factoryV1, name: `the ${family} V1 locker` },
  ].filter((f): f is { address: string; name: string } => Boolean(f.address));
  if (!factories.length) return chain.lockers;

  const table: Record<string, string> = { ...(chain.lockers ?? {}) };
  try {
    const raws = await rpc.callBatchSettled(factories.map((f) => ({ to: f.address, data: encodeCall(V1_FACTORY_FUNCTIONS.locker, []) })), block);
    raws.forEach((raw, i) => {
      if (raw instanceof Error) return;
      try {
        const address = (decodeOutputs(V1_FACTORY_FUNCTIONS.locker, raw)[0] as string).toLowerCase();
        if (address && address !== ZERO_ADDRESS) table[address] = factories[i].name;
      } catch {
        // a factory without this view; the others are unaffected
      }
    });
  } catch {
    // No locker is verified, so none is claimed. The liquidity read then says
    // "withdrawable", which is the safe direction to be wrong in.
    return chain.lockers;
  }
  return Object.keys(table).length ? table : chain.lockers;
}

/** What the open-door read found, as notes: control, transfers, holders, pools, age. Shared by ordinary and V1 tokens. */
function openDoorFactNotes(slip: DoorSlip, o: OpenDoor): DoorNote[] {
  const notes: DoorNote[] = [];

  // ---- what could not be read at all
  if (o.surfaceFrom === "implementation-unreadable") {
    notes.push({ level: "watch", code: "surface-unreadable", text: "This address is a proxy and the code it points at could not be read, so nothing below about its functions is a finding: the switches it carries are unknown, not absent." });
  }
  if (o.explorer?.tokenType && o.explorer.tokenType !== "ERC-20") {
    notes.push({ level: "info", code: "not-erc20", text: `The explorer indexes this as ${o.explorer.tokenType}, not ERC-20. The questions below are asked of fungible tokens; read them with that in mind.` });
  }
  if (o.explorerError) notes.push({ level: "info", code: "explorer-unread", text: `The explorer could not be read, so holders, the deployer and recent trades are missing: ${o.explorerError}` });

  // ---- control. A selector in the dispatcher is a function name, not a
  // permission: who may call it is not readable from bytes, and saying "the
  // owner can mint" when the code guards mint with a role would be a guess.
  const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
  const owner = o.owner;
  const movesWork = o.probes.length > 0 && o.probes.every((p) => p.status === "ok");
  if (o.paused === true) {
    notes.push(
      movesWork
        ? { level: "watch", code: "paused", text: "paused() returns true, yet every simulated transfer went through. Either the pause does not gate transfers in this contract or it exempts the wallets that were tried; read the source before trusting either reading." }
        : { level: "stop", code: "paused", text: "Transfers are paused right now: paused() returns true, so nobody can move this token until whoever holds that switch unpauses it." },
    );
  }
  if (o.tradingOpen && !o.tradingOpen.open) {
    notes.push(
      movesWork
        ? { level: "watch", code: "trading-closed", text: `${o.tradingOpen.view} returns false, yet every simulated transfer went through: the switch exists but is not stopping the wallets that were tried.` }
        : { level: "stop", code: "trading-closed", text: `Trading is switched off: ${o.tradingOpen.view} returns false, so only wallets that are exempted can trade until it is switched on.` },
    );
  }
  if (kinds.length) {
    const what = kinds.map((k) => `${k} (${POWER_MEANING[k]})`).join("; ");
    const who = o.ownerUnread
      ? "owner() is in the code but the chain would not answer it, so who holds those keys is unknown"
      : owner === null
        ? "there is no owner() view, so who may call them cannot be read off the chain"
        : owner.renounced
          ? "ownership is renounced, so any function guarded by the owner has nobody left to call it; a separate admin role, if the code has one, is not covered by this check"
          : `ownership is not renounced: ${shortAddress(owner.address)}${owner.isContract ? ", a contract," : ""} holds it`;
    notes.push({ level: owner?.renounced ? "info" : "watch", code: "powers", text: `The code carries ${what}. Which of them is guarded, and by whom, is not readable from bytecode; what is readable is that ${who}.` });
  } else if (o.surfaceFrom !== "implementation-unreadable") {
    const tail = owner === null ? "and no owner() view either" : owner.renounced ? "and ownership is renounced" : `though ${shortAddress(owner.address)} is still its owner`;
    notes.push({ level: "info", code: "no-powers", text: `No mint, pause, blacklist, fee, limit, trading or upgrade function was seen among the ${o.selectors} functions in the code, ${tail}.` });
  }
  if (o.verified === false) notes.push({ level: "watch", code: "unverified", text: "Source code is not verified on the explorer: nobody can read what the contract does beyond what its bytes show here." });
  if (o.explorer?.isScam === true) notes.push({ level: "stop", code: "explorer-scam", text: "The explorer flags this address as a scam." });

  // ---- can holders move it, and can they sell it
  if (o.probesSkipped) notes.push({ level: "info", code: "no-probe", text: `No transfer was simulated: ${o.probesSkipped}.` });
  notes.push(...probeNotes(o, moveProbes(o), "move"));
  notes.push(...probeNotes(o, sellProbes(o), "sell"));

  // ---- who holds it
  const h = o.holders;
  if (h) {
    const over = h.rows >= 50 ? " (counted over the first 50 holders the explorer lists)" : "";
    if (h.top10WalletsBps !== null && h.top10WalletsBps >= 5_000) notes.push({ level: "watch", code: "concentrated", text: `The 10 largest wallets hold ${pct(h.top10WalletsBps)} of supply${over}. Contracts and burn addresses are not counted; wallets that delegated under EIP-7702 are.` });
    else if (h.count !== null && h.count >= 100 && h.top10WalletsBps !== null) notes.push({ level: "info", code: "spread", text: `${h.count} holders; the 10 largest wallets hold ${pct(h.top10WalletsBps)} of supply${over}.` });
    else if (h.count !== null && h.top10WalletsBps === null) notes.push({ level: "info", code: "shares-unknown", text: `${h.count} holders. What share each holds could not be worked out: totalSupply() did not read.` });
    if (h.contractsBps !== null && h.contractsBps >= 1_000) notes.push({ level: "info", code: "in-contracts", text: `${pct(h.contractsBps)} of supply sits in contracts (pools, lockers, vaults, the token itself).` });
    if (h.burnedBps !== null && h.burnedBps >= 100) notes.push({ level: "info", code: "burned", text: `${pct(h.burnedBps)} of supply sits at a burn address.` });
  }
  if (o.deployer && o.deployer.bps !== null && o.deployer.bps >= 2_000) notes.push({ level: "watch", code: "deployer-holds", text: `The deployer (${shortAddress(o.deployer.address)}) holds ${pct(o.deployer.bps)} of supply.` });
  if (o.ownerBalance && o.ownerBalance.bps !== null && o.ownerBalance.bps >= 2_000 && o.owner && o.owner.address !== o.deployer?.address) notes.push({ level: "watch", code: "owner-holds", text: `The owner holds ${pct(o.ownerBalance.bps)} of supply.` });

  // ---- where it trades
  if (o.pools) {
    const live = o.pools.filter((p) => (p.quoteReserve ?? 0n) > 0n);
    const q = slip.chain.native;
    if (live.length) notes.push({ level: "info", code: "pools", text: `Trades in ${live.length} ${live[0].dex} pool${live.length === 1 ? "" : "s"} against W${q.symbol}: the deepest (${(live[0].feeBps / 100).toFixed(2)}% fee) holds ${formatUnits(live[0].quoteReserve ?? 0n, q.decimals, 3)} W${q.symbol}. Pools on other venues or against other pairs are not counted.` });
    else if (o.pools.length) notes.push({ level: "watch", code: "pools-empty", text: `A ${o.pools[0].dex} pool exists but holds no W${q.symbol}: nothing to sell into there.` });
    else notes.push({ level: "info", code: "no-pool", text: `No W${q.symbol} pool found: none on the chain's known DEX factories, and none announced by the Uniswap V4 singleton where that is read. It may trade on another venue, against another pair, or not at all.` });

    // A V4 hook is code that runs on every swap. It is the one thing about a
    // pool that the pool's own arithmetic cannot tell you.
    const hooked = o.pools.filter((p) => p.kind === "v4" && p.hooks && p.hooks !== ZERO_ADDRESS);
    for (const p of hooked) {
      notes.push({
        level: "watch",
        code: "v4-hook",
        text: `The ${p.dex} pool runs a hook at ${shortAddress(p.hooks!)}: code that executes on every swap and can charge its own fee, decide who may trade, or refuse the swap outright. Any sale figure here is the pool's arithmetic and does not include whatever the hook does.`,
      });
    }
  }

  // ---- venues nobody wrote down
  const unidentified = (o.pools ?? []).filter((p) => p.kind === "unknown");
  if (unidentified.length) {
    notes.push({
      level: "watch",
      code: "venue-unidentified",
      text: `${unidentified.length} contract${unidentified.length === 1 ? "" : "s"} holding this token turned out to be a pool for it — ${unidentified.map((p) => `${p.dex} at ${shortAddress(p.address)}`).join(", ")} — found by asking the largest holders rather than from a list of factories. ${unidentified.length === 1 ? "It answers" : "They answer"} none of the pool shapes BOUNCER can price, so the balances are shown and no sale is priced from them: guessing the invariant is how a quote ends up flattering the exit.`,
    });
  }

  // ---- can they pull the liquidity out from under you
  if (o.liquidity) {
    const l = o.liquidity;
    const held = l.holders.filter((h) => h.kind === "wallet" || h.kind === "contract");
    // A name the explorer publishes tells the reader what is holding their
    // liquidity. It is not a verdict: a contract that calls itself a locker is
    // still a contract that can be told to release, so the name is shown and
    // its source is said out loud rather than folded into "locked".
    const shown = held.slice(0, 3);
    const heldBy = held.length
      ? `Held by ${shown.map((h) => (h.name ? `${h.name} (${shortAddress(h.address)})` : shortAddress(h.address))).join(", ")}${held.length > 3 ? ` and ${held.length - 3} more` : ""}.${shown.some((h) => h.namedByExplorer) ? " Those names come from the explorer's verified source, not from anything BOUNCER checked: a contract called a locker can still be told to release." : ""}`
      : "";
    // A pool holding a sliver of the token's liquidity is not what a sale goes
    // through, and shouting STOP about it teaches the reader to ignore the
    // word. Now that a V4 pool or an unidentified venue can be the deepest,
    // the pool this covers is not always the biggest one.
    const sliver = l.shareOfLiquidityBps < 1_000;
    const size = sliver ? ` That pool holds ${pct(l.shareOfLiquidityBps)} of this token's liquidity, so it is not where a sale of any size would go.` : "";
    if (l.partial) {
      // A share of what was sampled is not a share of the pool. Saying "all of
      // it can be withdrawn" after reading a tenth of the positions would be
      // the most confident wrong sentence on the slip.
      notes.push({
        level: "watch",
        code: "liquidity-partial",
        text: `Of the ${l.positionsRead} largest liquidity positions in the ${l.dex} pool (${l.positionsFound} were found), ${pct(l.freeBps)} can be withdrawn${l.burnedBps ? `, ${pct(l.burnedBps)} is burned` : ""}${l.lockedBps ? `, ${pct(l.lockedBps)} is locked` : ""}. ${heldBy} The rest of the pool's positions were not read, so this is not a statement about the whole pool.`,
      });
    } else if (l.burnedBps + l.lockedBps === 0 && l.freeBps > 0) {
      // "Nothing is locked" is not by itself the rug shape, and a live run
      // made that plain: USDT on BNB Chain got a STOP saying whoever holds
      // the PancakeSwap V2 pool can take it away. True of the pool, useless
      // as a warning — that pool's LP is spread over thousands of ordinary
      // providers, and no one of them can empty it. What makes an unlocked
      // pool dangerous is one address being able to, so that is what decides
      // how loudly this is said.
      //
      // Which of the two it is depends on whether the holders were
      // enumerated at all. A V3 read names the position owners, so the
      // concentration is a fact. A V2 read only asks the burn addresses and
      // the known lockers, so the withdrawable share is by definition held by
      // addresses nobody listed — and claiming either shape would be invented.
      const biggest = held.length ? Math.max(...held.map((h) => h.shareBps)) : 0;
      const enumerated = held.length > 0;
      const concentrated = enumerated && biggest >= 5_000;
      notes.push({
        level: sliver ? "info" : concentrated || !enumerated ? "stop" : "watch",
        code: "liquidity-free",
        text: enumerated
          ? concentrated
            ? `None of the ${l.dex} pool's liquidity is burned or in a locker BOUNCER knows, and one address holds ${pct(biggest)} of it. ${heldBy} That one address can take most of the pool away on its own, and then there is nothing to sell into.${size}`
            : `None of the ${l.dex} pool's liquidity is burned or in a locker BOUNCER knows, so all of it can be withdrawn — but it is spread across ${held.length} holders and the largest has ${pct(biggest)}, so no single one can empty the pool. ${heldBy} That is the ordinary shape of an unlocked pool, not by itself a trap.${size}`
          : `Every bit of the ${l.dex} pool's liquidity can be withdrawn: none of it is burned and none sits in a locker BOUNCER knows. Who holds the rest was not enumerated — this read asks the burn addresses and the lockers it knows, and everything else is the remainder — so whether that is one address or ten thousand is unknown, and one address would be enough.${size}`,
      });
    } else if (l.freeBps >= 2_000) {
      notes.push({
        level: sliver ? "info" : "watch",
        code: "liquidity-partly-free",
        text: `${pct(l.freeBps)} of the ${l.dex} pool's liquidity can be withdrawn${l.burnedBps ? `, ${pct(l.burnedBps)} is burned` : ""}${l.lockedBps ? `, ${pct(l.lockedBps)} is in ${l.holders.find((h) => h.kind === "locked")?.name ?? "a locker"}` : ""}. Taking out the withdrawable part would thin the pool by that much.${size}`,
      });
    } else if (l.burnedBps + l.lockedBps > 0) {
      notes.push({
        level: "info",
        code: "liquidity-held",
        text: `${pct(l.burnedBps + l.lockedBps)} of the ${l.dex} pool's liquidity cannot be withdrawn${l.burnedBps ? ` (${pct(l.burnedBps)} burned)` : ""}${l.lockedBps ? ` (${pct(l.lockedBps)} locked)` : ""}. A locked pool is not a promise about the price; it only means this liquidity stays put.`,
      });
    }
    if (l.unread) notes.push({ level: "info", code: "liquidity-unread", text: `About the liquidity read: ${l.unread}.` });
  }
  const m = o.market;
  if (m && m.quotes.length && m.best) {
    const q = slip.chain.native;
    const whole = m.quotes.find((x) => x.shareBps === 10_000);
    const dec = slip.id.meta?.decimals ?? 18;
    if (whole) {
      const thin = whole.realisedBps > 0 && whole.realisedBps < 5_000;
      notes.push({
        level: thin ? "watch" : "info",
        code: "sale-price",
        text:
          `Selling ${formatUnits(whole.tokensIn, dec, 0)} tokens into the ${m.best.dex} pool would quote ${formatUnits(whole.out, q.decimals, 4)} W${q.symbol}` +
          (thin ? `, which is ${(whole.realisedBps / 100).toFixed(0)}% of the marginal price: the pool is thin for a position that size.` : ".") +
          (whole.beyondTick ? " That size leaves the pool's current tick, so the real figure depends on liquidity this does not read." : "") +
          " The token's own transfer tax, if it has one, is not included.",
      });
    }
  }
  const price = o.explorer?.priceUsd;
  if (price !== null && price !== undefined) notes.push({ level: "info", code: "price", text: `The explorer's price feed says ${money(price)}${o.explorer!.volume24hUsd !== null ? `, ${usd(o.explorer!.volume24hUsd)} traded in 24 h` : ""}${o.explorer!.marketCapUsd !== null ? `, ${usd(o.explorer!.marketCapUsd)} market cap` : ""}. That feed is the explorer's, not the chain's.` });

  // ---- age and activity
  if (o.deployer?.createdAt) notes.push({ level: "info", code: "deployed", text: `Deployed ${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago by ${shortAddress(o.deployer.address)}.` });
  if (o.activity) {
    if (o.activity.lastTransferAt !== null) {
      const ago = Math.max(0, slip.at.timestamp - o.activity.lastTransferAt);
      if (ago > 7 * 86_400) notes.push({ level: "watch", code: "quiet", text: `No transfer for ${formatDuration(ago)}: nothing is trading here.` });
      else notes.push({ level: "info", code: "active", text: `Last transfer ${formatDuration(ago)} ago; ${o.activity.recentWallets} wallets in the last ${o.activity.recent} transfers.` });
    } else if (o.activity.recent === 0) notes.push({ level: "watch", code: "quiet", text: "The explorer has indexed no transfers of this token at all." });
  }
  return notes;
}

/**
 * Turns one set of simulations into notes. A "move" set proves only that
 * tokens can change hands; a "sell" set aimed at the pool is the one that
 * answers the question people are really asking. Calls the node refused to
 * run are counted separately and never reported as reverts.
 */
function probeNotes(o: OpenDoor, probes: TransferProbe[], kind: "move" | "sell"): DoorNote[] {
  if (!probes.length) return [];
  const reverted = probes.filter((p) => p.status === "reverts");
  const unread = probes.filter((p) => p.status === "unread");
  const ok = probes.filter((p) => p.status === "ok");
  const from = probes[0].source === "deployer" ? "the deployer's wallet" : probes.length === 1 ? "a wallet holding it" : `each of ${probes.length} wallets holding it`;
  const what = kind === "sell" ? "into the pool" : "to a fresh wallet";
  const why = reverted[0]?.reason ? ` ("${reverted[0].reason}")` : "";
  const notes: DoorNote[] = [];
  if (!ok.length && !reverted.length) {
    notes.push({ level: "info", code: `${kind}-unread`, text: `The ${kind === "sell" ? "sale" : "transfer"} simulation could not be run: the node would not answer${unread[0]?.reason ? ` (${unread[0].reason})` : ""}. Nothing is claimed either way.` });
    return notes;
  }
  if (reverted.length && !ok.length) {
    notes.push({
      level: "stop",
      code: `${kind}-reverts`,
      text:
        kind === "sell"
          ? `Sending 1 unit ${what} from ${from} reverts right now${why}. A sale is a transfer into the pool, so on this reading the token cannot be sold. Simulated on the chain, nothing was sent.`
          : `A transfer ${what} from ${from} reverts right now${why}. Simulated on the chain, nothing was sent. This is what a paused, closed or trapping token looks like from the outside.`,
    });
  } else if (reverted.length) {
    notes.push({
      level: "watch",
      code: `${kind}-some-revert`,
      text: `${reverted.length} of the ${probes.length} wallets tried cannot ${kind === "sell" ? "send tokens into the pool" : "transfer"} right now${why}; the others can. A blacklist or a lock on chosen wallets looks like this.`,
    });
  } else {
    notes.push({
      level: "info",
      code: `${kind}-ok`,
      text:
        kind === "sell"
          ? `Sending 1 unit ${what} from ${from} goes through. That is the shape of a sale and it is not blocked at this block. It is one unit, not a priced trade: a fee on transfer, a cap on size or a rule that changes tomorrow would not show up here.`
          : `Tokens can move: a 1-unit transfer ${what} from ${from} goes through (simulated on the chain, nothing sent).`,
    });
  }
  if (unread.length) notes.push({ level: "info", code: `${kind}-partial`, text: `${unread.length} further ${kind === "sell" ? "sale" : "transfer"} simulation${unread.length === 1 ? "" : "s"} could not be run and ${unread.length === 1 ? "is" : "are"} not counted above.` });
  return notes;
}

/** A price in dollars that stays readable below a cent and above a million. */
function money(value: number): string {
  if (!Number.isFinite(value)) return "an unreadable number";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  const digits = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(value)))));
  return `$${value.toFixed(digits)}`;
}

function usd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
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
      { label: "chain", value: `${slip.chain.name}${slip.chain.chainId ? ` (${slip.chain.chainId})` : ""}${slip.chain.launchpad ? ` · ${slip.chain.launchpad}` : ""}` },
      { label: "stamp", value: slip.stamp },
      ...(slip.known ? [{ label: "known as", value: slip.known }] : []),
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
  if (slip.open) {
    const o = slip.open;
    const amount = (v: bigint | null, decimals: number, fraction: number) => (v === null ? "unread" : formatUnits(v, decimals, fraction));
    const probeRow = (p: TransferProbe) => ({
      label: p.target === "pool" ? "sell into pool" : "transfer out",
      value: `${shortAddress(p.from)} → ${shortAddress(p.to)} · ${p.status === "ok" ? "goes through" : p.status === "reverts" ? "reverts" : "not run"}`,
      note: p.reason ?? "simulated with eth_call, nothing sent",
    });
    sections.push({
      title: "Who controls it",
      rows: [
        { label: "control", value: controlLine(o), note: o.surfaceFrom === "implementation" ? "read from the proxy implementation" : o.surfaceFrom === "implementation-unreadable" ? "the implementation could not be read" : `${o.selectors} four-byte selectors in the code` },
        ...(o.ownerUnread ? [{ label: "owner", value: "owner() did not answer" }] : o.owner ? [{ label: "owner", value: o.owner.renounced ? "renounced (zero address)" : o.owner.address, note: o.owner.isContract ? "a contract" : o.ownerBalance?.bps != null ? `holds ${pct(o.ownerBalance.bps)}` : undefined }] : []),
        ...(o.paused !== null ? [{ label: "paused", value: o.paused }] : []),
        ...(o.tradingOpen ? [{ label: o.tradingOpen.view, value: o.tradingOpen.open }] : []),
        ...o.powers.map((p) => ({ label: p.kind, value: p.signature, note: POWER_MEANING[p.kind] })),
        ...o.probes.map(probeRow),
        ...(o.probesSkipped ? [{ label: "no simulation", value: o.probesSkipped }] : []),
        { label: "verified source", value: o.verified === null ? "unknown" : o.verified },
      ],
    });
    if (o.pools || o.explorer) {
      const q = slip.chain.native;
      sections.push({
        title: "Where it trades",
        rows: [
          ...(o.pools ? (o.pools.length ? o.pools.map((p) => ({ label: `${p.dex} ${(p.feeBps / 100).toFixed(2)}%`, value: `${amount(p.quoteReserve, q.decimals, 3)} W${q.symbol} · ${amount(p.tokenReserve, slip.id.meta?.decimals ?? 18, 0)} tokens`, note: p.address })) : [{ label: "pools", value: `none against W${q.symbol} on the chain's known DEX factories` }]) : []),
          ...(o.market?.quotes ?? []).map((x) => ({
            label: `sell ${x.shareBps / 100}%`,
            value: `${formatUnits(x.out, q.decimals, 4)} W${q.symbol}`,
            note: `${(x.realisedBps / 100).toFixed(1)}% of the marginal price${x.beyondTick ? " · leaves the current tick" : ""}`,
          })),
          ...(o.liquidity
            ? [
                {
                  label: o.liquidity.partial ? `liquidity (${o.liquidity.positionsRead} of ${o.liquidity.positionsFound} positions)` : "liquidity held by",
                  // The flag, not the holder count. An unlocked V2 pool has
                  // no holders to list — the read asks the burn addresses and
                  // the lockers, and everything else is the remainder — so
                  // counting holders hid a real 100%-withdrawable reading
                  // behind "not read", and showed a read that never happened
                  // as three zeroes.
                  value: !o.liquidity.read
                    ? o.liquidity.unread || "not read"
                    : `${(o.liquidity.burnedBps / 100).toFixed(1)}% burned · ${(o.liquidity.lockedBps / 100).toFixed(1)}% locked · ${(o.liquidity.freeBps / 100).toFixed(1)}% withdrawable`,
                  note: o.liquidity.unread || undefined,
                },
                ...o.liquidity.holders.slice(0, 5).map((h) => ({
                  label: `  ${h.kind === "burned" ? "burned" : h.kind === "locked" ? (h.name ?? "locker") : h.kind}`,
                  value: `${(h.shareBps / 100).toFixed(1)}%`,
                  note: h.address,
                })),
              ]
            : []),
          ...(o.market?.note ? [{ label: "method", value: o.market.note }] : []),
          ...(o.explorer?.priceUsd != null ? [{ label: "explorer price", value: money(o.explorer.priceUsd), note: [o.explorer.volume24hUsd !== null ? `${usd(o.explorer.volume24hUsd)} 24 h volume` : "", o.explorer.marketCapUsd !== null ? `${usd(o.explorer.marketCapUsd)} market cap` : ""].filter(Boolean).join(" · ") || undefined }] : []),
          ...(o.explorer?.isScam === true ? [{ label: "explorer flag", value: "scam" }] : []),
        ],
      });
    }
    if (o.holders || o.deployer || o.activity) {
      const h = o.holders;
      sections.push({
        title: "Who holds it",
        rows: [
          ...(o.deployer ? [{ label: "deployer", value: o.deployer.address, note: `${o.deployer.createdAt ? `deployed ${isoUtc(o.deployer.createdAt)} · ` : ""}holds ${pct(o.deployer.bps)}` }] : []),
          ...(h ? [
            { label: "holders", value: h.count ?? "unknown", note: h.transfers !== null ? `${h.transfers} transfers indexed` : undefined },
            { label: "top 10 wallets", value: pct(h.top10WalletsBps), note: `contracts and burn addresses not counted, over ${h.rows} rows` },
            { label: "in contracts", value: pct(h.contractsBps) },
            ...(h.burnedBps ? [{ label: "burned", value: pct(h.burnedBps) }] : []),
            ...h.top.slice(0, 10).map((x, i) => ({ label: `#${i + 1}`, value: `${x.address} · ${pct(x.bps)}`, note: x.role ?? (x.delegated ? "wallet (7702)" : x.isContract ? x.name ?? "contract" : undefined) })),
          ] : []),
          ...(o.activity ? [{ label: "last transfer", value: o.activity.lastTransferAt ? isoUtc(o.activity.lastTransferAt) : "none indexed", note: o.activity.recent ? `${o.activity.recentWallets} wallets in the last ${o.activity.recent}` : undefined }] : []),
        ],
      });
    }
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

/** JSON-safe copy of anything with bigints (decimal strings); selector sets are left out, the open door reports their count. */
export function slipJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Set ? undefined : v), 2);
}

export type { LaunchedToken };
