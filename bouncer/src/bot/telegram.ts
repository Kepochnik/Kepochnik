/**
 * The Telegram bot: long polling against api.telegram.org with fetch, no
 * library, no webhook, no state. Commands map one-to-one onto the CLI's
 * read path and answer with the same receipts in a code block. It holds
 * one secret, the bot token, and it can only read chains.
 *
 *   /ca <token|curve>          the slip
 *   /dev <address>             the dev report card
 *   /exit <token> [tokens]     the exit door
 *   /wallet <token> <wallet>   a position
 *   /receipt <txhash>          a trade itemised
 *   /watch <token>             alerts here: dev and crew on a launch, transfers on any other token
 *   /unwatch [token]           stop one or all
 *   /board [hours]             the board
 *   /chain [key]               show or switch the chain for this chat
 */
import { BlockscoutClient } from "../chain/blockscout.js";
import { CHAINS, chainByKey, type ChainConfig } from "../chain/chains.js";
import { RpcClient } from "../chain/rpc.js";
import { NotAPonsLaunch, PonsReader, readSupply, readTokenMeta } from "../chain/reader.js";
import { findBlockByTimestamp } from "../chain/tape.js";
import { renderReceipt } from "../receipt.js";
import { devReportLine, readDevReport } from "../bouncer/devReport.js";
import { doorReceipt, readDoor } from "../bouncer/door.js";
import { readExitDoor } from "../bouncer/exitDoor.js";
import { readBoard } from "../bouncer/leaderboard.js";
import { readOneCrew } from "../bouncer/oneCrew.js";
import { readRoom } from "../bouncer/room.js";
import { readWatchEvents } from "../bouncer/watch.js";
import { readTokenWatchEvents } from "../bouncer/tokenWatch.js";
import { readPools } from "../chain/market.js";
import { findLaunchBlock } from "../bouncer/door.js";
import type { LaunchedToken } from "../chain/pons.js";
import { formatBps, formatDuration, formatUnits } from "../format.js";
import { PHASE_LABEL } from "../chain/pons.js";

export interface Watch {
  chatId: number;
  chainKey: string;
  token: string;
  /**
   * The launchpad's launch record, or null for an ordinary token.
   *
   * It used to be required, and `/watch` read it by calling the factory —
   * which throws for anything the factory did not make. So the bot could
   * watch launchpad tokens and nothing else, and every memecoin anybody
   * actually pastes is an ordinary ERC-20. Null means the transfer tape
   * below is what gets read instead.
   */
  launch: LaunchedToken | null;
  crew: string[];
  cursor: number;
  symbol: string;
  /** What the transfer tape needs, when there is no launch record to read. */
  tape?: { pools: string[]; wallets: string[]; supply: bigint; decimals: number };
}

export interface BotOptions {
  token: string;
  /** Path of a JSON file to persist watches across restarts. */
  stateFile?: string;
  /** Seconds between watch polls (default 15). */
  watchIntervalSeconds?: number;
  /** Long-poll timeout for getUpdates in seconds (default 10). */
  pollTimeoutSeconds?: number;
  /** Site URL for slip links, e.g. https://kepochnik.github.io/bouncer */
  siteUrl?: string;
  fetchImpl?: typeof fetch;
  rpcFor?: (chain: ChainConfig) => RpcClient;
  /** Stop after this many polls (tests). */
  maxPolls?: number;
  log?: (line: string) => void;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/**
 * One reply, cut into messages Telegram will take.
 *
 * Telegram's hard limit is 4096 characters and a door slip is around ten
 * thousand, so this has to split. It used to split on character count
 * alone, which cut a 124-column box drawing mid-row: the first message
 * ended "...LETE CHECK" and the second began with the rest of that line,
 * each wrapped in its own code fence. Three messages of broken table, for
 * the bot's main command.
 *
 * Lines are never split. A line longer than the budget on its own is the
 * one case that must be, and it is hard-wrapped rather than dropped.
 */
export function chunksFor(text: string, budget = 3_800): string[] {
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current) out.push(current);
    current = "";
  };
  for (const raw of text.split("\n")) {
    // A code fence inside the content would close the one this is wrapped
    // in and let Telegram interpret the rest as markup. Nothing in a slip
    // produces one today; a token can be named anything.
    const line = raw.split(FENCE).join(FENCE_SAFE);
    if (line.length > budget) {
      push();
      for (let i = 0; i < line.length; i += budget) out.push(line.slice(i, i + budget));
      continue;
    }
    if (current.length + line.length + 1 > budget) push();
    current = current ? current + "\n" + line : line;
  }
  push();
  return out.length ? out : [text];
}

const FENCE = "`" + "`" + "`";
const FENCE_SAFE = "'" + "'" + "'";

export async function runBot(options: BotOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const api = `https://api.telegram.org/bot${options.token}`;
  const log = options.log ?? ((l) => process.stderr.write(l + "\n"));
  const chatChain = new Map<number, string>();
  const watches: Watch[] = loadWatches(options.stateFile);
  let offset = 0;
  let polls = 0;
  let lastWatchTick = 0;
  const send = async (chatId: number, text: string) => {
    for (const chunk of chunksFor(text)) {
      await fetchImpl(`${api}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk.startsWith("```") ? chunk : `\`\`\`\n${chunk}\n\`\`\``, parse_mode: "Markdown", disable_web_page_preview: true }),
      });
    }
  };
  while (options.maxPolls === undefined || polls < options.maxPolls) {
    polls++;
    let updates: Update[] = [];
    try {
      const response = await fetchImpl(`${api}/getUpdates?timeout=${options.pollTimeoutSeconds ?? 10}&offset=${offset}`);
      const body = (await response.json()) as { ok: boolean; result: Update[] };
      updates = body.result ?? [];
    } catch (error) {
      log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const text = update.message?.text?.trim();
      const chatId = update.message?.chat.id;
      if (!text || chatId === undefined) continue;
      try {
        const reply = await handleCommand(text, chatByKey(chatChain.get(chatId)), (key) => chatChain.set(chatId, key), options, { chatId, watches });
        if (reply) await send(chatId, reply);
        saveWatches(options.stateFile, watches);
      } catch (error) {
        await send(chatId, `bouncer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const now = Date.now();
    if (watches.length && now - lastWatchTick >= (options.watchIntervalSeconds ?? 15) * 1000) {
      lastWatchTick = now;
      await tickWatches(watches, options, send, log);
      saveWatches(options.stateFile, watches);
    }
  }
}

/** One poll of every watch: new events since each cursor go to their chat. */
export async function tickWatches(watches: Watch[], options: BotOptions, send: (chatId: number, text: string) => Promise<void>, log: (line: string) => void): Promise<void> {
  const heads = new Map<string, number>();
  for (const w of watches) {
    try {
      const chain = chainByKey(w.chainKey);
      const rpc = options.rpcFor ? options.rpcFor(chain) : new RpcClient({ urls: chain.rpc, expectedChainId: chain.chainId });
      let head = heads.get(w.chainKey);
      if (head === undefined) heads.set(w.chainKey, (head = await rpc.blockNumber()));
      if (head < w.cursor) continue;
      const events: { block: number; kind: string; text: string; tx: string }[] = w.launch
        ? await readWatchEvents(rpc, w.launch, { fromBlock: w.cursor, toBlock: head, crew: w.crew, factory: chain.factory ?? undefined, quote: chain.native })
        : await readTokenWatchEvents(rpc, w.token, { fromBlock: w.cursor, toBlock: head, pools: w.tape?.pools ?? [], watch: w.tape?.wallets ?? [], supply: w.tape?.supply ?? 0n, decimals: w.tape?.decimals ?? 18 });
      w.cursor = head + 1;
      for (const e of events) await send(w.chatId, `${w.symbol} · ${e.kind}\n${e.text}\nblock ${e.block} · ${e.tx}${options.siteUrl ? `\n${options.siteUrl}#/t/${w.token}` : ""}`);
      if (events.some((e) => e.kind === "graduated")) log(`${w.symbol} graduated; watch stays on for the pool`);
    } catch (error) {
      log(`watch ${w.symbol} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Register a watch on a token no launchpad made.
 *
 * Reads the three things the transfer tape needs and says out loud what it
 * will therefore be blind to — no pool means a sale reads as an ordinary
 * move, no supply means every transfer is reported. The CLI has printed
 * those two sentences since it learned the same trick; a bot that stayed
 * silent about them would have people reading "moved" for a dump.
 */
async function watchTape(rpc: RpcClient, address: string, head: number, chain: ChainConfig, context: CommandContext): Promise<string> {
  const token = address.toLowerCase();
  if (context.watches.some((w) => w.chatId === context.chatId && w.token === token)) return `already watching ${token}`;
  const meta = await readTokenMeta(rpc, token, head).catch(() => null);
  if (!meta) return `${token} does not answer symbol() and decimals(), so it is not an ERC-20 this can follow`;
  const supply = await readSupply(rpc, token, head).catch(() => 0n);
  const pools = chain.dex ? await readPools(rpc, token, chain.dex, head, meta.decimals).catch(() => []) : [];
  context.watches.push({
    chatId: context.chatId,
    chainKey: chain.key,
    token,
    launch: null,
    crew: [],
    cursor: head + 1,
    symbol: meta.symbol || token.slice(0, 8),
    tape: { pools: pools.map((x) => x.address), wallets: [], supply, decimals: meta.decimals },
  });
  const blind = [
    pools.length ? null : "no pool was found, so a sale will read as an ordinary move",
    supply > 0n ? null : "total supply could not be read, so every transfer is reported",
  ].filter((x): x is string => Boolean(x));
  return [
    `watching ${meta.symbol || token} (${token}) on ${chain.name} from block ${head + 1}: tokens into a pool (a sale), tokens out of a pool (a purchase), minting, burning, and any move of 0.25% of supply or more.`,
    "no launchpad made this token, so there is no curve, no dev tax and no graduation to report.",
    ...blind.map((b) => `· ${b}`),
  ].join("\n");
}

function loadWatches(file?: string): Watch[] {
  if (!file) return [];
  try {
    const raw = JSON.parse(require_fs().readFileSync(file, "utf8")) as (Omit<Watch, "launch" | "tape"> & { launch: Record<string, unknown> | null; tape?: { pools: string[]; wallets: string[]; supply: string | number; decimals: number } })[];
    return raw.map((w) => ({
      ...w,
      launch: w.launch ? reviveLaunch(w.launch) : null,
      // Only this one field, not a reviver over the whole file: a token whose
      // symbol is "420n" would come back from a blanket reviver as a BigInt
      // and break the first line that prints it.
      tape: w.tape ? { ...w.tape, supply: BigInt(String(w.tape.supply).replace(/n$/, "")) } : undefined,
    }));
  } catch {
    return [];
  }
}

function saveWatches(file: string | undefined, watches: Watch[]): void {
  if (!file) return;
  try {
    require_fs().writeFileSync(file, JSON.stringify(watches, (_k, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v), 2));
  } catch {
    /* a failed save costs a restart its watches, nothing else */
  }
}

function reviveLaunch(raw: Record<string, unknown>): LaunchedToken {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
  return out as unknown as LaunchedToken;
}

// node:fs is loaded lazily so the command handler stays importable in the browser bundle.
function require_fs(): { readFileSync: (p: string, e: string) => string; writeFileSync: (p: string, d: string) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (globalThis as unknown as { process?: { getBuiltinModule?: (n: string) => unknown } }).process?.getBuiltinModule?.("node:fs") as ReturnType<typeof require_fs>;
}

function decodeString(raw: string): string {
  const hex = raw.replace(/^0x/, "");
  if (hex.length < 128) return "";
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  const bytes = hex.slice(128, 128 + length * 2);
  return new TextDecoder().decode(new Uint8Array((bytes.match(/../g) ?? []).map((b) => parseInt(b, 16))));
}

function chatByKey(key: string | undefined): ChainConfig {
  return key ? chainByKey(key) : CHAINS.robinhood;
}

export interface CommandContext {
  chatId: number;
  watches: Watch[];
}

export async function handleCommand(text: string, chain: ChainConfig, setChain: (key: string) => void, options: BotOptions, context: CommandContext = { chatId: 0, watches: [] }): Promise<string | null> {
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@\w+$/, "").toLowerCase();
  const rpc = options.rpcFor ? options.rpcFor(chain) : new RpcClient({ urls: chain.rpc, expectedChainId: chain.chainId });
  const factory = chain.factory ?? "";
  const blockscout = chain.blockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null;
  const link = (path: string) => (options.siteUrl ? `\n${options.siteUrl}#${path}` : "");
  switch (cmd) {
    case "/start":
    case "/help":
      return [
        "BOUNCER · read-only door check",
        "/ca <token|curve>         the slip",
        "/dev <address>            dev report card",
        "/exit <token> [tokens]    exit door",
        "/wallet <token> <wallet>  a position",
        "/receipt <txhash>         a trade itemised",
        "/watch <token>            dev and crew on a launch, transfers on any other token",
        "/unwatch [token]          stop one or all",
        "/board [hours]            the board",
        `/chain [${Object.keys(CHAINS).join("|")}]  current: ${chain.key}`,
        "no key. no signer. no transaction path.",
      ].join("\n");
    case "/chain": {
      if (rest[0]) {
        const next = chainByKey(rest[0]);
        setChain(next.key);
        return `chain set to ${next.name} (${next.chainId}) · ${next.launchpad}${next.notes ? `\n${next.notes}` : ""}`;
      }
      return `chain: ${chain.name} (${chain.chainId}) · ${chain.launchpad}`;
    }
    case "/ca":
    case "/door":
    case "/check": {
      if (!rest[0]) return "usage: /ca <token|curve>";
      if (!factory) return `${chain.name}: ${chain.notes ?? "factory not known"}`;
      const slip = await readDoor(rpc, rest[0], { chain, factory, blockscout, devHours: 24 });
      return renderReceipt(doorReceipt(slip), "text") + link(`/t/${slip.subject}`);
    }
    case "/dev": {
      if (!rest[0]) return "usage: /dev <address>";
      if (!factory) return `${chain.name}: ${chain.notes ?? "factory not known"}`;
      const head = await rpc.getBlock("latest");
      const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - 24 * 3600, head.number);
      const d = await readDevReport(rpc, rest[0], { fromBlock, toBlock: head.number, factory });
      return [`dev ${d.deployer} · ${chain.name} · last 24 h`, devReportLine(d), ...d.launches.map((l) => `${l.symbol.padEnd(10)} ${PHASE_LABEL[l.phase].padEnd(6)} tax ${formatBps(l.creatorTaxBps)}${l.secondsToSweep !== null ? ` · swept in ${formatDuration(l.secondsToSweep)}` : ""}`)].join("\n") + link(`/dev/${d.deployer}`);
    }
    case "/exit": {
      if (!rest[0]) return "usage: /exit <token> [tokens]";
      if (!factory) return `${chain.name}: ${chain.notes ?? "factory not known"}`;
      const head = await rpc.blockNumber();
      const launch = await new PonsReader(rpc, factory).launchedToken(rest[0], head);
      const position = rest[1] ? BigInt(Math.round(Number(rest[1]))) * 10n ** 18n : 10n ** 25n;
      const e = await readExitDoor(rpc, launch, { position, block: head, factory });
      const q = chain.native;
      return [`exit door · ${launch.token.toLowerCase()} · ${e.venue} · block ${head}`, `for ${formatUnits(position, 18, 0)} tokens`, ...e.quotes.map((x) => `sell ${String(x.shareBps / 100).padStart(3)}%  ${formatUnits(x.net, q.decimals)} ${q.symbol} net  (${(x.realisedBps / 100).toFixed(1)}% of spot)`), e.note].join("\n");
    }
    case "/watch": {
      if (!rest[0]) return "usage: /watch <token>";
      const head = await rpc.blockNumber();
      // The factory first, because its events say more — but "not a launch"
      // is an answer here, not an error. Without this fallback the bot
      // answered /watch BRETT with a raw NotAPonsLaunch, and the website now
      // points people here for exactly that token.
      let launch: LaunchedToken | null = null;
      if (factory) {
        try {
          launch = await new PonsReader(rpc, factory).launchedToken(rest[0], head);
        } catch (error) {
          if (!(error instanceof NotAPonsLaunch)) throw error;
        }
      }
      if (!launch) return await watchTape(rpc, rest[0], head, chain, context);
      const token = launch.token.toLowerCase();
      if (context.watches.some((w) => w.chatId === context.chatId && w.token === token)) return `already watching ${token}`;
      let crew: string[] = [];
      let symbol = token.slice(0, 8);
      try {
        const [symRaw] = await rpc.callBatch([{ to: token, data: "0x95d89b41" }], head);
        symbol = String(decodeString(symRaw) || symbol);
      } catch { /* keep the address */ }
      if (blockscout) {
        const launchBlock = await findLaunchBlock(rpc, token, head, Math.round(7 * 86_400 * chain.blocksPerSecond), factory);
        if (launchBlock !== null) {
          const room = await readRoom(rpc, launch, launchBlock, head, undefined, Math.round(60 * chain.blocksPerSecond));
          const c = await readOneCrew(blockscout, room, launchBlock, [launch.deployer, launch.creatorFeeRecipient]);
          crew = c.crews.flatMap((x) => x.wallets);
        }
      }
      context.watches.push({ chatId: context.chatId, chainKey: chain.key, token, launch, crew, cursor: head + 1, symbol });
      return `watching ${symbol} (${token}) on ${chain.name} from block ${head + 1}: deployer sells or moves tokens, tax recipient moves, buyback flips, sweep, graduation${crew.length ? `, and ${crew.length} crew wallets leaving together` : ""}.`;
    }
    case "/unwatch": {
      const before = context.watches.length;
      const target = rest[0]?.toLowerCase();
      for (let i = context.watches.length - 1; i >= 0; i--) {
        const w = context.watches[i];
        if (w.chatId === context.chatId && (!target || w.token === target)) context.watches.splice(i, 1);
      }
      const removed = before - context.watches.length;
      return removed ? `stopped ${removed} watch${removed === 1 ? "" : "es"}` : "nothing was being watched here";
    }
    case "/watches":
      return context.watches.filter((w) => w.chatId === context.chatId).map((w) => `${w.symbol} · ${w.token} · ${w.chainKey} · from block ${w.cursor}`).join("\n") || "no watches in this chat";
    case "/board": {
      if (!factory) return `${chain.name}: ${chain.notes ?? "factory not known"}`;
      const head = await rpc.getBlock("latest");
      const hours = Number(rest[0] ?? 1) || 1;
      const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
      const b = await readBoard(rpc, { fromBlock, toBlock: head.number, factory, top: 8 });
      const q = chain.native;
      return [`the board · ${chain.name} · last ${hours} h`, `${b.launches} launches · ${b.graduations} graduations · ${b.deployers} deployers`, `cover collected ${formatUnits(b.coverTotal, q.decimals)} ${q.symbol} over ${b.taxedBuys} buys`, "", "deployers", ...b.topDeployers.map((r) => `${r.deployer.slice(0, 10)}… ${r.launched} launched · ${r.graduated} graduated`), "", "cover charge by curve", ...(b.topCurves.length ? b.topCurves.map((r) => `${(r.token ?? r.curve).slice(0, 10)}… ${formatUnits(r.coverCollected, q.decimals)} ${q.symbol} over ${r.taxedBuys} buys`) : ["none"])].join("\n");
    }
    case "/wallet":
    case "/receipt":
      return `${cmd} is in the CLI (bouncer ${cmd.slice(1)} …) and on the site; the bot keeps to the four quick reads.` + link("/");
    default:
      return null;
  }
}
