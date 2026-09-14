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
 *   /chain [key]               show or switch the chain for this chat
 */
import { BlockscoutClient } from "../chain/blockscout.js";
import { CHAINS, chainByKey, type ChainConfig } from "../chain/chains.js";
import { RpcClient } from "../chain/rpc.js";
import { PonsReader } from "../chain/reader.js";
import { findBlockByTimestamp } from "../chain/tape.js";
import { renderReceipt } from "../receipt.js";
import { devReportLine, readDevReport } from "../bouncer/devReport.js";
import { doorReceipt, readDoor } from "../bouncer/door.js";
import { readExitDoor } from "../bouncer/exitDoor.js";
import { formatBps, formatDuration, formatUnits } from "../format.js";
import { PHASE_LABEL } from "../chain/pons.js";

export interface BotOptions {
  token: string;
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

export async function runBot(options: BotOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const api = `https://api.telegram.org/bot${options.token}`;
  const log = options.log ?? ((l) => process.stderr.write(l + "\n"));
  const chatChain = new Map<number, string>();
  let offset = 0;
  let polls = 0;
  const send = async (chatId: number, text: string) => {
    const chunks = text.match(/[\s\S]{1,3800}/g) ?? [text];
    for (const chunk of chunks) {
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
      const response = await fetchImpl(`${api}/getUpdates?timeout=25&offset=${offset}`);
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
        const reply = await handleCommand(text, chatByKey(chatChain.get(chatId)), (key) => chatChain.set(chatId, key), options);
        if (reply) await send(chatId, reply);
      } catch (error) {
        await send(chatId, `bouncer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function chatByKey(key: string | undefined): ChainConfig {
  return key ? chainByKey(key) : CHAINS.robinhood;
}

export async function handleCommand(text: string, chain: ChainConfig, setChain: (key: string) => void, options: BotOptions): Promise<string | null> {
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
    case "/wallet":
    case "/receipt":
      return `${cmd} is in the CLI (bouncer ${cmd.slice(1)} …) and on the site; the bot keeps to the four quick reads.` + link("/");
    default:
      return null;
  }
}
