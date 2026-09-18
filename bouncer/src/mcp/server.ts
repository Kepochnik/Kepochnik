/**
 * A read-only MCP server with no dependencies: JSON-RPC 2.0 over stdio,
 * one message per line, the subset of the Model Context Protocol an agent
 * needs to list and call tools. Every tool is one of BOUNCER's reads; there
 * is no tool that signs, sends or holds a key, and the RPC client underneath
 * refuses every write method by construction. Agents trading through
 * Robinhood's or anyone else's rails can ask the door before they buy.
 */
import { BlockscoutClient } from "../chain/blockscout.js";
import { CHAINS, chainByKey, type ChainConfig } from "../chain/chains.js";
import { NotAPonsLaunch, PonsReader, readTokenMeta } from "../chain/reader.js";
import { RpcClient } from "../chain/rpc.js";
import { findBlockByTimestamp } from "../chain/tape.js";
import { readMarket, readPools } from "../chain/market.js";
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { ERC20_FUNCTIONS } from "../chain/pons.js";
import { renderReceipt } from "../receipt.js";
import { SolanaRpc } from "../chain/solana.js";
import { readSplDoor, splReceipt } from "../bouncer/spl.js";
import { readCoverCharge } from "../bouncer/coverCharge.js";
import { devReportLine, readDevReport } from "../bouncer/devReport.js";
import { doorReceipt, findLaunchBlock, readDoor, slipJson } from "../bouncer/door.js";
import { readExitDoor } from "../bouncer/exitDoor.js";
import { readBoard } from "../bouncer/leaderboard.js";
import { readOneCrew } from "../bouncer/oneCrew.js";
import { readLaunchPlan } from "../bouncer/planner.js";
import { readPosition } from "../bouncer/position.js";
import { readRoom } from "../bouncer/room.js";
import { readTradeReceipt } from "../bouncer/txReceipt.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_VERSION = "0.3.0";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpDeps {
  rpcFor: (chain: ChainConfig) => RpcClient;
  blockscoutFor?: (chain: ChainConfig) => BlockscoutClient | null;
  factoryFor?: (chain: ChainConfig) => string | null;
  /** Supplied when the server should answer for Solana as well; omitted, Solana requests say so. */
  solanaRpcFor?: (chain: ChainConfig) => SolanaRpc;
  /** Demo-sized windows for tests. */
  demo?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ text: string; structured?: unknown }>;
}

const CHAIN_PROP = { type: "string", enum: Object.keys(CHAINS), description: "Chain key; default robinhood." };
const ADDRESS_PROP = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "20-byte hex address." };
/** bouncer_check takes either, because the chain list offers both kinds. */
const ANY_ADDRESS_PROP = { type: "string", description: "A 20-byte hex address on an EVM chain, or a base58 mint address on Solana." };

export function createMcpServer(deps: McpDeps): { tools: ToolDef[]; handle: (message: JsonRpcRequest) => Promise<JsonRpcResponse | null> } {
  const ctx = (args: Record<string, unknown>) => {
    const chain = chainByKey(typeof args.chain === "string" ? args.chain : undefined);
    const factory = (deps.factoryFor ? deps.factoryFor(chain) : chain.factory) ?? "";
    const rpc = deps.rpcFor(chain);
    const blockscout = deps.blockscoutFor ? deps.blockscoutFor(chain) : chain.blockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null;
    return { chain, factory, rpc, blockscout };
  };
  /** The launchpad tools cannot answer without a factory, and say which chain has none. */
  const needFactory = (chain: { name: string; launchpad: string | null }, factory: string): string => {
    if (factory) return factory;
    throw new Error(chain.launchpad ? `${chain.name}: the ${chain.launchpad} factory address is not published yet` : `${chain.name}: no launchpad runs here, so there is no launch to read. Use bouncer_check, which answers for any token.`);
  };
  const demoWindow = deps.demo ? { chunkSize: 100_000, launchSearchBlocks: 400_000 } : {};
  /**
   * The launch behind an address, or null when the chain has no launchpad or
   * the address is an ordinary token. The market tools answer either way, so
   * they ask this rather than refusing.
   */
  const launchOrNull = async (rpc: RpcClient, factory: string, token: string, block: number) => {
    if (!factory) return null;
    try {
      return await new PonsReader(rpc, factory).launchedToken(token, block);
    } catch (error) {
      if (error instanceof NotAPonsLaunch) return null;
      throw error;
    }
  };

  const erc20 = async (rpc: RpcClient, token: string, fn: (typeof ERC20_FUNCTIONS)[keyof typeof ERC20_FUNCTIONS], args: unknown[], block: number): Promise<bigint> => {
    const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(fn, args) }], block);
    return decodeOutputs(fn, raw)[0] as bigint;
  };

  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
    return v;
  };

  const tools: ToolDef[] = [
    {
      name: "bouncer_check",
      description: "The full door slip for any token. On a chain with a launchpad: the factory record, the anti-snipe window and what buys inside it paid, house rules, the room, the exit door, one crew, lookalikes and the dev report card. On any other token: which switches its code carries, who holds the keys, whether a holder could sell into the pool right now, who holds the supply and where it trades. On Solana: whether anyone can print more or freeze your account, and the Token-2022 rules on every transfer. Door notes at STOP / WATCH / INFO. Read-only; nothing is scored or advised.",
      inputSchema: { type: "object", properties: { address: ANY_ADDRESS_PROP, chain: CHAIN_PROP, dev_hours: { type: "number", description: "Dev report window in hours (default 24)." } }, required: ["address"] },
      run: async (args) => {
        const chain = chainByKey(typeof args.chain === "string" ? args.chain : undefined);
        if (chain.family === "solana") {
          if (!deps.solanaRpcFor) throw new Error("this server was started without a Solana endpoint");
          const slip = await readSplDoor(deps.solanaRpcFor(chain), str(args.address, "address"), chain);
          return { text: renderReceipt(splReceipt(slip), "markdown"), structured: JSON.parse(slipJson({ stamp: slip.stamp, subject: slip.subject, chain: slip.chain, at: slip.at, notes: slip.notes, skipped: slip.skipped })) };
        }
        const { factory, rpc, blockscout } = ctx(args);
        const slip = await readDoor(rpc, str(args.address, "address"), { chain, factory, blockscout, devHours: typeof args.dev_hours === "number" ? args.dev_hours : deps.demo ? 8 : 24, ...demoWindow });
        return { text: renderReceipt(doorReceipt(slip), "markdown"), structured: JSON.parse(slipJson({ stamp: slip.stamp, subject: slip.subject, chain: slip.chain, at: slip.at, notes: slip.notes, skipped: slip.skipped })) };
      },
    },
    {
      name: "bouncer_tax_now",
      description: "The cover charge right now for one launch: the anti-snipe terms it launched under, whether the window is still open and for how many seconds, and every buy that landed inside the window with what it actually paid at the door.",
      inputSchema: { type: "object", properties: { address: ADDRESS_PROP, chain: CHAIN_PROP }, required: ["address"] },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        needFactory(chain, factory);
        const head = await rpc.getBlock("latest");
        const launch = await new PonsReader(rpc, factory).launchedToken(str(args.address, "address"), head.number);
        const launchBlock = await findLaunchBlock(rpc, launch.token, head.number, deps.demo ? 400_000 : Math.round(7 * 86_400 * chain.blocksPerSecond), factory, deps.demo ? 100_000 : undefined);
        if (launchBlock === null) return { text: "launch older than the search window; the cover charge window is long closed", structured: { status: "closed", secondsLeft: 0 } };
        const c = await readCoverCharge(rpc, launch, { launchBlock, head, factory, chunkSize: deps.demo ? 100_000 : undefined });
        const lines = [`status: ${c.status}`, `seconds left: ${c.secondsLeft}`, `terms: ${Number(c.terms.startBps) / 100}% in the launch second, 0 after ${c.terms.seconds} s${c.termsChangedSinceLaunch ? " (factory retuned since launch)" : ""}`, `launched: block ${c.launch.block}`, ...c.observed.map((b) => `buy at +${b.secondsAfterLaunch}s by ${b.buyer}: paid ${(b.chargeBps / 100).toFixed(1)}%${b.creatorWallet ? " (creator wallet, exempt)" : ""}`)];
        return { text: lines.join("\n"), structured: JSON.parse(slipJson(c)) };
      },
    },
    {
      name: "bouncer_crew",
      description: "The room and the crew for one launch: distinct buyers, the share the creator funded, buys landing in the same block, and which of the first buyers were funded by the same address before the launch (needs the chain's Blockscout).",
      inputSchema: { type: "object", properties: { address: ADDRESS_PROP, chain: CHAIN_PROP }, required: ["address"] },
      run: async (args) => {
        const { factory, rpc, chain, blockscout } = ctx(args);
        needFactory(chain, factory);
        const head = await rpc.blockNumber();
        const launch = await new PonsReader(rpc, factory).launchedToken(str(args.address, "address"), head);
        const launchBlock = await findLaunchBlock(rpc, launch.token, head, deps.demo ? 400_000 : Math.round(7 * 86_400 * chain.blocksPerSecond), factory, deps.demo ? 100_000 : undefined);
        if (launchBlock === null) throw new Error("launch older than the search window");
        const room = await readRoom(rpc, launch, launchBlock, head, deps.demo ? 100_000 : undefined, Math.round(60 * chain.blocksPerSecond));
        const crew = blockscout ? await readOneCrew(blockscout, room, launchBlock, [launch.deployer, launch.creatorFeeRecipient]) : null;
        const lines = [`buyers: ${room.buyers}`, `dev funded: ${(room.devShareBps / 100).toFixed(1)}%`, `first minute: ${(room.firstMinuteShareBps / 100).toFixed(1)}%`, `shared blocks: ${room.sharedBlocks.length}`, crew ? `crews: ${crew.crews.map((c) => `${c.wallets.length} wallets funded by ${c.funder} (${(c.shareBps / 100).toFixed(1)}%)`).join("; ") || "none"}` : "crew check unavailable on this chain (no explorer)"];
        return { text: lines.join("\n"), structured: JSON.parse(slipJson({ room: { ...room, wallets: room.wallets.slice(0, 20) }, crew })) };
      },
    },
    {
      name: "bouncer_dev",
      description: "The dev report card: every launch this deployer made in the window, with phase, creator tax and seconds from launch to sweep.",
      inputSchema: { type: "object", properties: { address: ADDRESS_PROP, hours: { type: "number", description: "Window in hours (default 24)." }, chain: CHAIN_PROP }, required: ["address"] },
      run: async (args) => {
        const { chain, factory, rpc } = ctx(args);
        needFactory(chain, factory);
        const head = await rpc.getBlock("latest");
        const hours = typeof args.hours === "number" ? args.hours : 24;
        const fromBlock = deps.demo ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
        const d = await readDevReport(rpc, str(args.address, "address"), { fromBlock, toBlock: head.number, factory, chunking: deps.demo ? { startChunk: 100_000, maxChunk: 100_000 } : undefined });
        return { text: [devReportLine(d), ...d.launches.map((l) => `${l.symbol}: ${["curve", "swept", "pool", "rescued"][l.phase]} · tax ${Number(l.creatorTaxBps) / 100}%${l.secondsToSweep !== null ? ` · swept in ${l.secondsToSweep}s` : ""} · ${l.token}`)].join("\n"), structured: JSON.parse(slipJson(d)) };
      },
    },
    {
      name: "bouncer_receipt",
      description: "One trade itemised from its transaction hash: quote paid or received, tokens, protocol fee, creator tax, and the cover charge (the part of the tax above the creator's rate).",
      inputSchema: { type: "object", properties: { tx: { type: "string", description: "Transaction hash." }, chain: CHAIN_PROP }, required: ["tx"] },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        needFactory(chain, factory);
        const rs = await readTradeReceipt(rpc, str(args.tx, "tx"), factory);
        const q = chain.native;
        const f = (v: bigint) => `${Number(v) / 10 ** q.decimals} ${q.symbol}`;
        return { text: rs.map((r) => `${r.kind} by ${r.wallet} at block ${r.block}: ${f(r.quote)}, fee ${f(r.fee)}, creator tax ${f(r.creatorTaxPart)}, cover charge ${f(r.coverChargePart)}, ${Number(r.tokens) / 1e18} tokens`).join("\n"), structured: JSON.parse(slipJson(rs)) };
      },
    },
    {
      name: "bouncer_exit",
      description: "The exit door: what selling 10 / 25 / 50 / 100% of a holding pays right now. On a launchpad launch that is the curve's own sell arithmetic or the graduated pool; on any other token it is the deepest DEX pool the chain's table can find. Answers on every chain BOUNCER reads.",
      inputSchema: { type: "object", properties: { address: ADDRESS_PROP, amount: { type: "number", description: "Token amount in whole tokens (default 1% of supply)." }, chain: CHAIN_PROP }, required: ["address"] },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        const token = str(args.address, "address");
        const head = await rpc.blockNumber();
        const launch = await launchOrNull(rpc, factory, token, head);
        const q = chain.native;
        if (launch) {
          const position = typeof args.amount === "number" ? BigInt(Math.round(args.amount)) * 10n ** 18n : 10n ** 25n;
          const e = await readExitDoor(rpc, launch, { position, block: head, factory });
          return { text: [`venue: ${e.venue}`, ...e.quotes.map((x) => `sell ${x.shareBps / 100}%: ${Number(x.net) / 10 ** q.decimals} ${q.symbol} net (${(x.realisedBps / 100).toFixed(1)}% of spot)`), e.note].join("\n"), structured: JSON.parse(slipJson(e)) };
        }
        // Not a launch, or a chain with no launchpad at all. Refusing here would
        // be the wrong answer to the question a holder actually asked.
        const dex = chain.dex;
        if (!dex) throw new Error(`${chain.name} has no DEX table, so a sale cannot be priced there`);
        const meta = await readTokenMeta(rpc, token, head).catch(() => null);
        const decimals = meta?.decimals ?? 18;
        const supply = await erc20(rpc, token, ERC20_FUNCTIONS.totalSupply, [], head).catch(() => 0n);
        const position = typeof args.amount === "number" ? BigInt(Math.round(args.amount)) * 10n ** BigInt(decimals) : supply / 100n;
        const pools = await readPools(rpc, token.toLowerCase(), dex, head, decimals);
        const market = readMarket(pools, position, decimals, dex.wethSymbol);
        const lines = [
          `venue: ${market.best ? `${market.best.dex} ${market.best.kind}` : "no pool found"}`,
          `position: ${Number(position) / 10 ** decimals} ${meta?.symbol ?? "tokens"}`,
          ...market.quotes.map((x) => `sell ${x.shareBps / 100}%: ${Number(x.out) / 10 ** q.decimals} ${dex.wethSymbol} (${(x.realisedBps / 100).toFixed(1)}% of spot)${x.beyondTick ? " · leaves the current tick" : ""}`),
          market.note,
        ];
        return { text: lines.join("\n"), structured: JSON.parse(slipJson({ token: token.toLowerCase(), block: head, position: position.toString(), market })) };
      },
    },
    {
      name: "bouncer_wallet",
      description: "What one wallet holds of one token and what that holding would fetch if sold now. On a launchpad launch it also totals the wallet's own buys and sells: spent, received, fees, taxes, cost basis and unrealised.",
      inputSchema: { type: "object", properties: { address: ADDRESS_PROP, wallet: ADDRESS_PROP, chain: CHAIN_PROP }, required: ["address", "wallet"] },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        const token = str(args.address, "address");
        const wallet = str(args.wallet, "wallet");
        const head = await rpc.blockNumber();
        const q = chain.native;
        const launch = await launchOrNull(rpc, factory, token, head);
        if (launch) {
          const launchBlock = await findLaunchBlock(rpc, launch.token, head, deps.demo ? 400_000 : Math.round(30 * 86_400 * chain.blocksPerSecond), factory, deps.demo ? 100_000 : undefined);
          const p = await readPosition(rpc, launch, wallet, launchBlock ?? 0, head, factory, deps.demo ? 100_000 : undefined);
          const whole = p.exit.quotes.find((x) => x.shareBps === 10_000);
          const f = (v: bigint) => `${Number(v) / 10 ** q.decimals} ${q.symbol}`;
          const lines = [
            `balance: ${Number(p.balance) / 1e18} tokens`,
            `spent: ${f(p.spentQuote)} · received: ${f(p.receivedQuote)}`,
            `fees: ${f(p.feesPaid)} · taxes: ${f(p.taxesPaid)}`,
            `cost basis: ${f(p.costBasis)}`,
            `exit now: ${whole ? f(whole.net) : "n/a"} (${p.exit.venue})`,
            `unrealised: ${p.unrealised < 0n ? "-" : "+"}${f(p.unrealised < 0n ? -p.unrealised : p.unrealised)}`,
          ];
          return { text: lines.join("\n"), structured: JSON.parse(slipJson(p)) };
        }
        const meta = await readTokenMeta(rpc, token, head).catch(() => null);
        const decimals = meta?.decimals ?? 18;
        const balance = await erc20(rpc, token, ERC20_FUNCTIONS.balanceOf, [wallet], head);
        const pools = chain.dex ? await readPools(rpc, token.toLowerCase(), chain.dex, head, decimals) : [];
        const market = chain.dex ? readMarket(pools, balance, decimals, chain.dex.wethSymbol) : null;
        const whole = market?.quotes.find((x) => x.shareBps === 10_000) ?? null;
        const lines = [
          `balance: ${Number(balance) / 10 ** decimals} ${meta?.symbol ?? "tokens"}`,
          `worth now: ${whole ? `${Number(whole.out) / 10 ** q.decimals} ${chain.dex?.wethSymbol}` : "not priced"}`,
          "cost basis: not read — this token has no launchpad curve, so there is no trade history to total up",
          market?.note ?? `${chain.name} has no DEX table, so nothing could be priced.`,
        ];
        return { text: lines.join("\n"), structured: JSON.parse(slipJson({ token: token.toLowerCase(), wallet: wallet.toLowerCase(), block: head, balance: balance.toString(), market })) };
      },
    },
    {
      name: "bouncer_plan",
      description: "The launch planner: under today's factory terms, the start and graduation price, the curve/pool split, FDV at graduation, what the creator earns, and what a buy pays at the door in the launch second.",
      inputSchema: { type: "object", properties: { tax_bps: { type: "number", description: "Creator tax in basis points (default 100)." }, config: { type: "number", description: "Launch config id (default 0)." }, quote: { type: "string", description: "Quote token address; omit for the native asset." }, chain: CHAIN_PROP } },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        needFactory(chain, factory);
        const plan = await readLaunchPlan(rpc, { factory, block: await rpc.blockNumber(), nativeSymbol: chain.native.symbol, creatorTaxBps: BigInt(typeof args.tax_bps === "number" ? args.tax_bps : 100), configId: typeof args.config === "number" ? args.config : 0, pairToken: typeof args.quote === "string" ? args.quote : undefined });
        const d = plan.quote.decimals;
        return { text: [`quote ${plan.quote.symbol}, supply ${Number(plan.supply) / 1e18}, graduates at ${Number(plan.graduationThreshold) / 10 ** d} ${plan.quote.symbol}`, `start price ${Number(plan.startPrice) / 10 ** d}, graduation price ${Number(plan.graduationPrice) / 10 ** d} (${(Number(plan.graduationPrice) / Number(plan.startPrice || 1n)).toFixed(2)}x)`, `sold on curve ${Number(plan.tokensSoldOnCurve) / 1e18}, to pool ${Number(plan.tokensToPool) / 1e18}, FDV at graduation ${Number(plan.fdvAtGraduation) / 10 ** d} ${plan.quote.symbol}`, `creator tax ${Number(plan.creatorTaxBps) / 100}% (ceiling ${Number(plan.maxCreatorTaxBps) / 100}%), launch fee ${Number(plan.launchFee) / 10 ** chain.native.decimals} ${chain.native.symbol}`, `cover charge ${Number(plan.snipe.startBps) / 100}% in the launch second, 0 after ${plan.snipe.seconds} s`].join("\n"), structured: JSON.parse(slipJson(plan)) };
      },
    },
    {
      name: "bouncer_board",
      description: "The board for a window: launches and graduations, top deployers, serial launchers with no graduation, and the cover charge collected per curve and paid per wallet.",
      inputSchema: { type: "object", properties: { hours: { type: "number", description: "Window in hours (default 1)." }, top: { type: "number", description: "Rows per board (default 10)." }, chain: CHAIN_PROP } },
      run: async (args) => {
        const { factory, rpc, chain } = ctx(args);
        needFactory(chain, factory);
        const head = await rpc.getBlock("latest");
        const hours = typeof args.hours === "number" ? args.hours : 1;
        const fromBlock = deps.demo ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
        const b = await readBoard(rpc, { fromBlock, toBlock: head.number, factory, top: typeof args.top === "number" ? args.top : 10, chunkSize: deps.demo ? 100_000 : undefined });
        const q = chain.native;
        return { text: [`launches ${b.launches}, graduations ${b.graduations}, deployers ${b.deployers}`, `cover charge collected ${Number(b.coverTotal) / 10 ** q.decimals} ${q.symbol} over ${b.taxedBuys} taxed buys`, ...b.topDeployers.map((r) => `dev ${r.deployer}: ${r.launched} launched, ${r.graduated} graduated`), ...b.topCurves.map((r) => `curve ${r.curve}: ${Number(r.coverCollected) / 10 ** q.decimals} ${q.symbol} cover over ${r.taxedBuys} buys`)].join("\n"), structured: JSON.parse(slipJson(b)) };
      },
    },
  ];

  const handle = async (message: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    const id = message.id ?? null;
    const isNotification = message.id === undefined;
    const reply = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code: number, msg: string, data?: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg, data } });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "bouncer", version: SERVER_VERSION },
          instructions: "Read-only checks on any token: Robinhood Chain, Base, BNB Chain, Solana and Arc. Every tool reads the chain at one block; none can sign, send or hold a key, and a read that fails is reported as unread rather than as a finding. Call bouncer_check before a trade; on a chain with a launchpad, bouncer_tax_now during a launch's first seconds and bouncer_exit before a sell.",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } })) });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const tool = tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `unknown tool ${name}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = await tool.run(args);
          return reply({ content: [{ type: "text", text: out.text }], structuredContent: out.structured, isError: false });
        } catch (error) {
          return reply({ content: [{ type: "text", text: `bouncer: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${message.method}`);
    }
  };
  return { tools, handle };
}

/** Newline-delimited JSON over stdio: one request per line in, one response per line out. */
export async function serveStdio(server: { handle: (m: JsonRpcRequest) => Promise<JsonRpcResponse | null> }, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let buffer = "";
  const process_ = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const response = await server.handle(message);
    if (response) output.write(JSON.stringify(response) + "\n");
  };
  for await (const chunk of input) {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      await process_(line);
    }
  }
  if (buffer.trim()) await process_(buffer);
}
