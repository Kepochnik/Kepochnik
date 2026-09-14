/**
 * bouncer — read-only door check for Pons V2 launches (and its ports) on
 * Robinhood Chain and Arc.
 *
 *   bouncer doctor                       prove the read path works
 *   bouncer door <token|curve>           the slip: ID check, cover charge, house rules, the room, exit door, one crew, lookalikes, dev report card
 *   bouncer dev <address>                the dev report card alone
 *   bouncer exit <token> [--amount n]    the exit door alone
 *   bouncer wallet <token> <wallet>      one wallet's position on one launch
 *   bouncer receipt <txhash>             one trade, itemised
 *   bouncer plan [--tax 100] [--quote 0x…]   the launch planner
 *   bouncer demo                         offline walkthrough, no network
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BlockscoutClient } from "./chain/blockscout.js";
import { CHAINS, chainByKey, type ChainConfig } from "./chain/chains.js";
import { GraduationPhase, PHASE_LABEL } from "./chain/pons.js";
import { PonsReader } from "./chain/reader.js";
import { RpcClient } from "./chain/rpc.js";
import { findBlockByTimestamp } from "./chain/tape.js";
import { flagNumber, flagString, parseArgs } from "./cli/args.js";
import { doctorReceipt, runDoctor } from "./cli/doctor.js";
import { renderReceipt, type Receipt, type ReceiptFormat } from "./receipt.js";
import { doorCard } from "./bouncer/card.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, demoBlockscoutFetch, demoRpc } from "./bouncer/demo.js";
import { devReportLine, readDevReport } from "./bouncer/devReport.js";
import { doorReceipt, findLaunchBlock, readDoor, slipJson, type DoorOptions } from "./bouncer/door.js";
import { readExitDoor } from "./bouncer/exitDoor.js";
import { MASCOT_SVG_INNER } from "./bouncer/mascot.js";
import { readLaunchPlan } from "./bouncer/planner.js";
import { readPosition } from "./bouncer/position.js";
import { readTradeReceipt } from "./bouncer/txReceipt.js";
import { readBoard } from "./bouncer/leaderboard.js";
import { readOneCrew } from "./bouncer/oneCrew.js";
import { readRoom } from "./bouncer/room.js";
import { watchLaunch } from "./bouncer/watch.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "./format.js";

export const REPO = "github.com/Kepochnik/bouncer";
export const MARK = "$BOUNCER";
const HELP = `bouncer — read-only door check for Pons V2 launches on Robinhood Chain and Arc

  bouncer doctor                        rpc, chain id, factory bytecode, anti-snipe terms
  bouncer door <token|curve>            the slip: ID check, cover charge, house rules, the room, exit door, one crew, lookalikes, dev report card
  bouncer door <token> --format svg     the same slip as a 1200×630 card
  bouncer dev <address> [--hours 24]    the dev report card on its own
  bouncer exit <token> [--amount 1000]  what selling 10 / 25 / 50 / 100% of a position pays right now
  bouncer wallet <token> <wallet>       one wallet's buys, sells, balance, cost basis and exit value on one launch
  bouncer receipt <txhash>              one trade itemised: quote, fee, creator tax, cover charge
  bouncer plan [--config 0] [--tax 100] [--quote 0x…] [--buy 0.1]   what a launch looks like under today's factory terms
  bouncer watch <token> [--interval 5] [--crew]   DEV MOVED / CREW EXIT: one line per event, until you stop it
  bouncer board [--hours 1] [--top 10]  the board: deployers, serial launchers, cover charge collected and paid
  bouncer demo                          offline walkthrough (synthetic, labelled DEMO)

  --chain ${Object.keys(CHAINS).join("|")}   which chain (default robinhood)
  --factory <address>                   launchpad factory override (Arc mainnet until Radian publishes it)
  --rpc <url>                           override the chain's RPC
  --demo                                run any command against the synthetic chain
  --format text|markdown|json           output format (default text); door also takes svg
  --output <file>                       write to a new file (refuses to overwrite)
  --hours <n>                           dev report window in hours (default 24)
  --launch-blocks <n>                   how far back to search for the launch (default 7 days of blocks)
  --no-dev --no-room --no-crew --no-lookalikes --no-blockscout   skip sections (faster)

No key. No signer. No transaction path.`;

export async function main(argv: string[], write: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command ?? "help";
  const demo = args.flags.demo === true || command === "demo";
  const format = (flagString(args.flags, "format") ?? "text") as ReceiptFormat | "svg";
  const output = flagString(args.flags, "output");
  const emit = (text: string) => {
    if (output) {
      if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, text);
      write(`wrote ${output}\n`);
    } else {
      write(text.endsWith("\n") ? text : text + "\n");
    }
  };
  const json = (value: unknown) => emit(slipJson(value));

  try {
    if (command === "help" || command === "--help") {
      write(HELP + "\n");
      return 0;
    }
    const chain = demo ? CHAINS.robinhood : chainByKey(flagString(args.flags, "chain"));
    const factory = (flagString(args.flags, "factory") ?? chain.factory ?? "").toLowerCase();
    const rpc = demo ? demoRpc() : liveRpc(chain, flagString(args.flags, "rpc"));
    const chunk = demo ? 100_000 : flagNumber(args.flags, "chunk", 0) || undefined;
    const hours = flagNumber(args.flags, "hours", 24);
    const noBlockscout = args.flags["no-blockscout"] === true;
    const blockscout = demo
      ? noBlockscout ? null : new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() })
      : chain.blockscout && !noBlockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null;
    const requireFactory = () => {
      if (!factory) throw new Error(`${chain.name}: ${chain.notes ?? "no factory known; pass --factory 0x…"}`);
      return factory;
    };
    const doorOptions = (): DoorOptions => ({
      chain,
      factory: requireFactory(),
      blockscout,
      devHours: hours,
      chunkSize: chunk,
      skipDev: args.flags["no-dev"] === true,
      skipRoom: args.flags["no-room"] === true,
      skipCrew: args.flags["no-crew"] === true,
      skipLookalikes: args.flags["no-lookalikes"] === true,
      launchSearchBlocks: demo ? 400_000 : flagNumber(args.flags, "launch-blocks", 0) || undefined,
    });
    if (demo && command !== "demo") write("DEMO · synthetic chain, every address below is invented\n");

    switch (command) {
      case "doctor": {
        const report = await runDoctor(rpc, undefined, factory || undefined);
        emit(renderReceipt(doctorReceipt(report, "bouncer", chain.name, factory || undefined), asReceiptFormat(format)));
        return report.ok ? 0 : 2;
      }

      case "door":
      case "check": {
        const input = args.positionals[0] ?? (demo ? DEMO.tokens.fresh.token : undefined);
        if (!input) throw new Error("usage: bouncer door <token|curve>");
        const slip = await readDoor(rpc, input, doorOptions());
        if (format === "svg") emit(doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER }));
        else if (format === "json") json(slip);
        else emit(renderReceipt(doorReceipt(slip), format));
        return 0;
      }

      case "dev": {
        const address = args.positionals[0] ?? (demo ? DEMO.tokens.slow.deployer : undefined);
        if (!address) throw new Error("usage: bouncer dev <address> [--hours 24]");
        const head = await rpc.getBlock("latest");
        const fromBlock = demo ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
        const report = await readDevReport(rpc, address, { fromBlock, toBlock: head.number, factory: requireFactory(), chunking: chunk ? { startChunk: chunk, maxChunk: chunk } : undefined });
        if (format === "json") return json(report), 0;
        emit(
          renderReceipt(
            {
              title: "BOUNCER · dev report card",
              subtitle: `${report.deployer} · ${chain.name} · blocks ${report.window.fromBlock}–${report.window.toBlock}`,
              sections: [
                {
                  title: "in window",
                  rows: [
                    { label: "summary", value: devReportLine(report) },
                    ...report.launches.map((l) => ({ label: l.symbol, value: `${PHASE_LABEL[l.phase]} · tax ${formatBps(l.creatorTaxBps)}${l.secondsToSweep !== null ? ` · swept in ${formatDuration(l.secondsToSweep)}` : ""} · ${l.token}` })),
                  ],
                },
              ],
              footnotes: [report.truncated ? `${report.counts.launched - report.launches.length} older launches counted but not listed.` : "Every launch in the window is listed."],
              meta: { launched: report.counts.launched, graduated: report.counts.graduated },
            },
            asReceiptFormat(format),
          ),
        );
        return 0;
      }

      case "exit": {
        const token = args.positionals[0] ?? (demo ? DEMO.tokens.late.token : undefined);
        if (!token) throw new Error("usage: bouncer exit <token> [--amount tokens]");
        const head = await rpc.blockNumber();
        const launch = await new PonsReader(rpc, requireFactory()).launchedToken(token, head);
        const amountFlag = flagString(args.flags, "amount");
        const position = amountFlag ? BigInt(Math.round(Number(amountFlag))) * 10n ** 18n : 10n ** 25n;
        const exit = await readExitDoor(rpc, launch, { position, block: head, factory: requireFactory() });
        if (format === "json") return json(exit), 0;
        const q = chain.native;
        emit(
          renderReceipt(
            {
              title: "BOUNCER · exit door",
              subtitle: `${launch.token.toLowerCase()} · ${exit.venue} · block ${head}`,
              sections: [
                {
                  title: "walk out now",
                  rows: [
                    { label: "position", value: `${formatUnits(position, 18, 0)} tokens` },
                    { label: "spot", value: `${formatUnits(exit.spot, q.decimals, 12)} ${q.symbol} per token` },
                    ...exit.quotes.map((x) => ({ label: `sell ${x.shareBps / 100}%`, value: `${formatUnits(x.net, q.decimals)} ${q.symbol} net`, note: `${(x.realisedBps / 100).toFixed(1)}% of spot · fee ${formatUnits(x.fee, q.decimals)} · creator ${formatUnits(x.tax, q.decimals)}` })),
                  ],
                },
              ],
              footnotes: [exit.note],
              meta: { venue: exit.venue },
            },
            asReceiptFormat(format),
          ),
        );
        return 0;
      }

      case "wallet":
      case "position": {
        const token = args.positionals[0] ?? (demo ? DEMO.tokens.late.token : undefined);
        const wallet = args.positionals[1] ?? (demo ? DEMO.tokens.late.buys[1][1] : undefined);
        if (!token || !wallet) throw new Error("usage: bouncer wallet <token> <wallet>");
        const head = await rpc.blockNumber();
        const launch = await new PonsReader(rpc, requireFactory()).launchedToken(token, head);
        const launchBlock = await findLaunchBlock(rpc, launch.token, head, demo ? 400_000 : flagNumber(args.flags, "launch-blocks", 0) || Math.round(30 * 86_400 * chain.blocksPerSecond), requireFactory(), chunk);
        const position = await readPosition(rpc, launch, wallet, launchBlock ?? 0, head, requireFactory(), chunk);
        if (format === "json") return json(position), 0;
        const q = chain.native;
        const whole = position.exit.quotes.find((x) => x.shareBps === 10_000);
        emit(
          renderReceipt(
            {
              title: "BOUNCER · position",
              subtitle: `${position.wallet} on ${position.token} · block ${head}`,
              sections: [
                {
                  title: "the bag",
                  rows: [
                    { label: "balance", value: `${formatUnits(position.balance, 18, 0)} tokens` },
                    { label: "spent", value: `${formatUnits(position.spentQuote, q.decimals)} ${q.symbol}`, note: `${position.trades.filter((t) => t.kind === "buy").length} buys` },
                    { label: "received", value: `${formatUnits(position.receivedQuote, q.decimals)} ${q.symbol}`, note: `${position.trades.filter((t) => t.kind === "sell").length} sells` },
                    { label: "fees paid", value: `${formatUnits(position.feesPaid, q.decimals)} ${q.symbol}` },
                    { label: "taxes paid", value: `${formatUnits(position.taxesPaid, q.decimals)} ${q.symbol}`, note: "creator tax plus any cover charge" },
                    { label: "cost basis", value: `${formatUnits(position.costBasis, q.decimals)} ${q.symbol}` },
                    { label: "exit now", value: whole ? `${formatUnits(whole.net, q.decimals)} ${q.symbol}` : "n/a", note: position.exit.venue },
                    { label: "unrealised", value: `${position.unrealised < 0n ? "-" : "+"}${formatUnits(position.unrealised < 0n ? -position.unrealised : position.unrealised, q.decimals)} ${q.symbol}` },
                  ],
                },
                { title: "trades", rows: position.trades.slice(0, 12).map((t) => ({ label: `${t.kind} @${t.block}`, value: `${formatUnits(t.quote, q.decimals)} ${q.symbol} · ${formatUnits(t.tokens, 18, 0)} tokens`, note: `fee ${formatUnits(t.fee, q.decimals)} · tax ${formatUnits(t.tax, q.decimals)}` })) },
              ],
              footnotes: [position.exit.note],
              meta: { balance: position.balance, unrealised: position.unrealised },
            },
            asReceiptFormat(format),
          ),
        );
        return 0;
      }

      case "receipt": {
        const hash = args.positionals[0] ?? (demo ? `0xdemoFRESH${DEMO.tokens.fresh.launched + 22}` : undefined);
        if (!hash) throw new Error("usage: bouncer receipt <txhash>");
        const receipts = await readTradeReceipt(rpc, hash, requireFactory());
        if (format === "json") return json(receipts), 0;
        const q = chain.native;
        for (const r of receipts) {
          emit(
            renderReceipt(
              {
                title: `BOUNCER · receipt · ${r.kind}`,
                subtitle: `${r.hash} · block ${r.block}`,
                sections: [
                  {
                    title: "itemised",
                    rows: [
                      { label: "token", value: r.launch ? r.launch.token.toLowerCase() : `curve ${r.curve} (no factory record)` },
                      { label: "wallet", value: r.wallet },
                      { label: r.kind === "buy" ? "paid" : "received", value: `${formatUnits(r.quote, q.decimals)} ${q.symbol}` },
                      { label: "tokens", value: formatUnits(r.tokens, 18, 0) },
                      { label: "protocol fee", value: `${formatUnits(r.fee, q.decimals)} ${q.symbol}` },
                      { label: "creator tax", value: `${formatUnits(r.creatorTaxPart, q.decimals)} ${q.symbol}`, note: r.launch ? formatBps(r.launch.creatorTaxBps) : undefined },
                      { label: "cover charge", value: `${formatUnits(r.coverChargePart, q.decimals)} ${q.symbol}`, note: r.coverChargePart > 0n ? `${(Number((r.coverChargePart * 10_000n) / (r.quote || 1n)) / 100).toFixed(1)}% of the buy, paid at the door` : "none" },
                      { label: "effective price", value: `${formatUnits(r.effectivePrice, q.decimals, 12)} ${q.symbol} per token`, note: "fees included" },
                      { label: "curve price after", value: r.marginalPriceAfter === null ? null : `${formatUnits(r.marginalPriceAfter, q.decimals, 12)} ${q.symbol} per token` },
                    ],
                  },
                ],
                footnotes: ["Decoded from the transaction's own CurveBuy/CurveSell log. The cover charge is the part of the tax above the creator's rate."],
                meta: { kind: r.kind, block: r.block },
              },
              asReceiptFormat(format),
            ),
          );
        }
        return 0;
      }

      case "plan": {
        const head = await rpc.blockNumber();
        const buyFlag = flagString(args.flags, "buy");
        const plan = await readLaunchPlan(rpc, {
          configId: flagNumber(args.flags, "config", 0),
          pairToken: flagString(args.flags, "quote"),
          creatorTaxBps: BigInt(flagNumber(args.flags, "tax", 100)),
          sampleBuy: buyFlag ? BigInt(Math.round(Number(buyFlag) * 1e6)) * 10n ** 12n : undefined,
          factory: requireFactory(),
          block: head,
          nativeSymbol: chain.native.symbol,
        });
        if (format === "json") return json(plan), 0;
        const q = plan.quote;
        const u = (v: bigint, f = 4) => `${formatUnits(v, q.decimals, f)} ${q.symbol}`;
        emit(
          renderReceipt(
            {
              title: "BOUNCER · launch planner",
              subtitle: `${chain.name} · config ${plan.configId}${plan.configEnabled ? "" : " (disabled)"} · block ${plan.block}`,
              sections: [
                {
                  title: "terms today",
                  rows: [
                    { label: "launch fee", value: `${formatUnits(plan.launchFee, chain.native.decimals)} ${chain.native.symbol}`, note: "paid to the protocol at launch" },
                    { label: "supply", value: formatUnits(plan.supply, 18, 0) },
                    { label: "quote", value: q.symbol, note: `phantom ${u(plan.phantomQuote)} · graduates at ${u(plan.graduationThreshold)}` },
                    { label: "creator tax", value: formatBps(plan.creatorTaxBps), note: `ceiling ${formatBps(plan.maxCreatorTaxBps)}` },
                    { label: "curve fee", value: formatBps(plan.curveFeeBps), note: `split protocol ${formatBps(plan.protocolFeeShareBps)} / buyback ${formatBps(plan.buybackBurnBps)} of the rest / creator` },
                    { label: "pool fee", value: `${Number(plan.poolFeePpm) / 10_000}%`, note: `hook fee ${formatBps(plan.hookFeeBps)} after graduation` },
                    { label: "cover charge", value: `${formatBps(plan.snipe.startBps)} in the launch second, 0 after ${plan.snipe.seconds} s` },
                  ],
                },
                {
                  title: "what the curve does",
                  rows: [
                    { label: "start price", value: `${formatUnits(plan.startPrice, q.decimals, 12)} ${q.symbol} per token` },
                    { label: "graduation price", value: `${formatUnits(plan.graduationPrice, q.decimals, 12)} ${q.symbol} per token`, note: `${(Number((plan.graduationPrice * 100n) / (plan.startPrice || 1n)) / 100).toFixed(2)}× the start` },
                    { label: "sold on the curve", value: `${formatUnits(plan.tokensSoldOnCurve, 18, 0)} tokens`, note: `${(Number((plan.tokensSoldOnCurve * 10_000n) / (plan.supply || 1n)) / 100).toFixed(1)}% of supply` },
                    { label: "seeded into the pool", value: `${formatUnits(plan.tokensToPool, 18, 0)} tokens + ${u(plan.graduationThreshold)}`, note: "locked, not the creator's" },
                    { label: "FDV at graduation", value: u(plan.fdvAtGraduation, 2) },
                    { label: "creator earns", value: `${formatBps(plan.creatorPerVolumeBps)} of every trade`, note: `${u((plan.graduationThreshold * plan.creatorTaxBps) / 10_000n)} if the curve fills with no sells` },
                    { label: `a ${u(plan.sampleBuy)} buy at second 0`, value: `pays ${u(plan.sampleDoorCharge)} to the creator as cover charge`, note: "unless the wallet is on the exemption list" },
                  ],
                },
              ],
              footnotes: ["Read from the factory and the hook at the block shown; the curve arithmetic is the contract's own. Terms can be retuned by the factory owner before you launch."],
              meta: { configId: plan.configId },
            },
            asReceiptFormat(format),
          ),
        );
        return 0;
      }

      case "watch": {
        const token = args.positionals[0] ?? (demo ? DEMO.tokens.late.token : undefined);
        if (!token) throw new Error("usage: bouncer watch <token> [--interval 5] [--crew] [--rounds n]");
        const head = await rpc.blockNumber();
        const launch = await new PonsReader(rpc, requireFactory()).launchedToken(token, head);
        const backfill = demo ? 300_000 : flagNumber(args.flags, "backfill", Math.round(3600 * chain.blocksPerSecond));
        let crew: string[] = [];
        if (args.flags.crew === true && blockscout) {
          const launchBlock = await findLaunchBlock(rpc, launch.token, head, demo ? 400_000 : Math.round(7 * 86_400 * chain.blocksPerSecond), requireFactory(), chunk);
          if (launchBlock !== null) {
            const room = await readRoom(rpc, launch, launchBlock, head, chunk, Math.round(60 * chain.blocksPerSecond));
            const oneCrew = await readOneCrew(blockscout, room, launchBlock, [launch.deployer, launch.creatorFeeRecipient]);
            crew = oneCrew.crews.flatMap((c) => c.wallets);
            write(`crew: ${crew.length ? crew.map(shortAddress).join(", ") : "none found"}\n`);
          }
        }
        write(`watching ${launch.token.toLowerCase()} on ${chain.name} from block ${Math.max(0, head - backfill)} · deployer ${shortAddress(launch.deployer)}\n`);
        await watchLaunch(rpc, launch, {
          fromBlock: Math.max(0, head - backfill),
          intervalMs: flagNumber(args.flags, "interval", demo ? 0 : 5) * 1000,
          crew,
          factory: requireFactory(),
          chunkSize: chunk,
          quote: chain.native,
          maxRounds: demo ? 1 : flagNumber(args.flags, "rounds", 0) || undefined,
          onEvent: (e) => write(`${String(e.block).padStart(10)}  ${e.kind.padEnd(19)} ${e.text}  ${e.tx}\n`),
          onRound: (h) => { if (args.flags.quiet !== true) write(`  · block ${h}\n`); },
          sleep: demo ? async () => {} : undefined,
        });
        return 0;
      }

      case "board": {
        const head = await rpc.getBlock("latest");
        const fromBlock = demo ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - flagNumber(args.flags, "hours", 1) * 3600, head.number);
        const board = await readBoard(rpc, { fromBlock, toBlock: head.number, factory: requireFactory(), top: flagNumber(args.flags, "top", 10), chunkSize: chunk, skipCover: args.flags["no-cover"] === true });
        if (format === "json") return json(board), 0;
        const q = chain.native;
        emit(
          renderReceipt(
            {
              title: "BOUNCER · the board",
              subtitle: `${chain.name} · blocks ${board.window.fromBlock}–${board.window.toBlock} · ${board.chunks} log reads`,
              sections: [
                { title: "tonight", rows: [{ label: "launches", value: board.launches }, { label: "graduations", value: board.graduations }, { label: "deployers", value: board.deployers }, { label: "cover collected", value: `${formatUnits(board.coverTotal, q.decimals)} ${q.symbol}`, note: `${board.taxedBuys} buys paid at the door` }] },
                { title: "deployers", rows: board.topDeployers.map((r) => ({ label: shortAddress(r.deployer), value: `${r.launched} launched · ${r.graduated} graduated${r.swept - r.graduated > 0 ? ` · ${r.swept - r.graduated} swept without a pool` : ""}` })) },
                { title: "serial, no graduation", rows: board.serial.length ? board.serial.map((r) => ({ label: shortAddress(r.deployer), value: `${r.launched} launched, none graduated` })) : [{ label: "none", value: "no deployer with 5+ launches and 0 graduations in the window" }] },
                { title: "cover charge by curve", rows: board.topCurves.length ? board.topCurves.map((r) => ({ label: shortAddress(r.token ?? r.curve), value: `${formatUnits(r.coverCollected, q.decimals)} ${q.symbol} over ${r.taxedBuys} buys`, note: `highest ${(r.highestBps / 100).toFixed(1)}% · creator tax ${formatBps(r.creatorTaxBps)}` })) : [{ label: "none", value: board.chunks ? "no buy in the window paid above the creator rate" : "skipped" }] },
                { title: "cover charge by wallet", rows: board.topPayers.length ? board.topPayers.map((r) => ({ label: shortAddress(r.wallet), value: `${formatUnits(r.coverPaid, q.decimals)} ${q.symbol} over ${r.buys} buys` })) : [{ label: "none", value: "nobody paid at the door in the window" }] },
              ],
              footnotes: ["Cover charge = the part of a buy's tax above the curve's own creator rate, as the curve's CurveBuy event reports it. Counts, not scores."],
              meta: { launches: board.launches, graduations: board.graduations },
            },
            asReceiptFormat(format),
          ),
        );
        return 0;
      }

      case "demo": {
        write("DEMO · synthetic chain, every address below is invented · no network\n\n");
        for (const input of [DEMO.tokens.fresh.token, DEMO.tokens.sprint.token, DEMO_IMPOSTOR.token]) {
          const slip = await readDoor(rpc, input, { ...doorOptions(), devHours: 8 });
          write(renderReceipt(doorReceipt(slip), "text") + "\n\n");
        }
        return 0;
      }

      default:
        write(`unknown command ${command}\n\n${HELP}\n`);
        return 1;
    }
  } catch (error) {
    write(`bouncer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function liveRpc(chain: ChainConfig, override?: string): RpcClient {
  const primary = override ?? process.env.RPC_URL ?? chain.rpc[0];
  const fallbacks = [...(process.env.RPC_FALLBACK_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean), ...(override ? [] : chain.rpc.slice(1))];
  return new RpcClient({ urls: [primary, ...fallbacks], expectedChainId: chain.chainId });
}

function asReceiptFormat(format: string): ReceiptFormat {
  if (format === "text" || format === "markdown" || format === "json") return format;
  throw new Error(`--format ${format} is only valid for door`);
}

export type { Receipt, GraduationPhase };
