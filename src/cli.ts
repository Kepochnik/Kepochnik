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
import { decodeOutputs, encodeCall } from "./chain/abi.js";
import { readMarket, readPools } from "./chain/market.js";
import { ERC20_FUNCTIONS, GraduationPhase, PHASE_LABEL, type LaunchedToken } from "./chain/pons.js";
import { NotAPonsLaunch, PonsReader, readTokenMeta } from "./chain/reader.js";
import { RpcClient } from "./chain/rpc.js";
import { SolanaRpc } from "./chain/solana.js";
import { findBlockByTimestamp } from "./chain/tape.js";
import { flagNumber, flagString, parseArgs, type ParsedArgs } from "./cli/args.js";
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
import { readSplDoor, splReceipt } from "./bouncer/spl.js";
import { readBoard } from "./bouncer/leaderboard.js";
import { readOneCrew } from "./bouncer/oneCrew.js";
import { readRoom } from "./bouncer/room.js";
import { watchToken } from "./bouncer/tokenWatch.js";
import { watchLaunch } from "./bouncer/watch.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "./format.js";

export const REPO = "github.com/Kepochnik/bouncer";
export const MARK = "$BOUNCER";
const HELP = `bouncer — read-only door check for any token: Robinhood Chain, Base, BNB Chain, Solana, Arc

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

    // Solana is read through a different client against different account
    // layouts, so it forks here rather than pretending to be an EVM chain.
    if (chain.family === "solana") return await runSolana(command, args, chain, format, emit, write);

    const factory = (flagString(args.flags, "factory") ?? chain.factory ?? "").toLowerCase();
    const rpc = demo ? demoRpc() : liveRpc(chain, flagString(args.flags, "rpc"));
    const chunk = demo ? 100_000 : flagNumber(args.flags, "chunk", 0) || undefined;
    const hours = flagNumber(args.flags, "hours", 24);
    const noBlockscout = args.flags["no-blockscout"] === true;
    const blockscout = demo
      ? noBlockscout ? null : new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() })
      : chain.blockscout && !noBlockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null;
    const requireFactory = () => {
      if (factory) return factory;
      // Only the launchpad commands land here, so the message names the command's
      // problem rather than reprinting the chain's description as an error.
      throw new Error(
        chain.launchpad
          ? `"${command}" needs the ${chain.launchpad} factory address, which is not published for ${chain.name} yet. Pass --factory 0x… once it is.`
          : `"${command}" reads a launchpad, and none that BOUNCER knows runs on ${chain.name}. Use "bouncer door <address> --chain ${chain.key}", which answers for any token.`,
      );
    };
    const doorOptions = (): DoorOptions => ({
      chain,
      // Not requireFactory(): a chain with no launchpad still has tokens on it,
      // and the door answers every question that needs no factory.
      factory: factory || undefined,
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
        const report = await runDoctor(rpc, undefined, factory || null);
        emit(renderReceipt(doctorReceipt(report, "bouncer", chain.name, factory || null), asReceiptFormat(format)));
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
        // Ask for the factory before touching the network: a command that cannot
        // be answered on this chain should say so at once, not after a round trip
        // that may itself fail and hide the real reason.
        requireFactory();
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
        const amountFlag = flagString(args.flags, "amount");
        const launch = await launchOrNull(rpc, token, head, chain, args);
        if (!launch) {
          // Not a launchpad launch: price the sale on whatever pool the chain's
          // dex table can find. Refusing to answer would be the wrong answer to
          // the question people actually ask about a token they hold.
          return await marketExit(rpc, token, head, chain, amountFlag, format, emit);
        }
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
        const maybeLaunch = await launchOrNull(rpc, token, head, chain, args);
        if (!maybeLaunch) {
          // An ordinary token: the curve trade history does not exist, but the
          // balance and what it would fetch do, and those are the two numbers
          // a holder came for.
          return await marketBag(rpc, token, wallet, head, chain, format, emit);
        }
        const launch = maybeLaunch;
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
        requireFactory();
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
        requireFactory();
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
        const maybeLaunch = await launchOrNull(rpc, token, head, chain, args);
        if (!maybeLaunch) {
          // A Pons V1 launch, an ordinary ERC-20, a token on a chain with no
          // launchpad at all. There is no curve tape, but the token's own
          // Transfer log and the addresses of its pools say the same thing:
          // who is moving, and which way. Refusing here would mean the
          // launchpad's own $PONS could not be watched.
          return await watchMarketToken(rpc, token, head, chain, args, write);
        }
        const launch = maybeLaunch;
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
        requireFactory();
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

/**
 * The launch record when this token is one, null when it is not. An ordinary
 * token is the common case on most chains, and on a chain with no launchpad at
 * all it is the only case, so "not a launch" is an answer, not an error.
 */
async function launchOrNull(rpc: RpcClient, token: string, block: number, chain: ChainConfig, args: ParsedArgs): Promise<LaunchedToken | null> {
  const factory = (flagString(args.flags, "factory") ?? chain.factory ?? "").toLowerCase();
  if (!factory) return null;
  try {
    return await new PonsReader(rpc, factory).launchedToken(token, block);
  } catch (error) {
    if (error instanceof NotAPonsLaunch) return null;
    throw error;
  }
}

/** What selling this token would pay, for a token with no curve behind it. */
async function marketExit(
  rpc: RpcClient,
  token: string,
  head: number,
  chain: ChainConfig,
  amountFlag: string | undefined,
  format: string,
  emit: (text: string) => void,
): Promise<number> {
  if (!chain.dex) throw new Error(`${token} is not a launch on ${chain.name}, and ${chain.name} has no DEX table to price a sale with`);
  const meta = await readTokenMeta(rpc, token, head).catch(() => null);
  const decimals = meta?.decimals ?? 18;
  const pools = await readPools(rpc, token.toLowerCase(), chain.dex, head, decimals);
  const supply = await readSupply(rpc, token, head).catch(() => 0n);
  const position = amountFlag ? BigInt(Math.round(Number(amountFlag))) * 10n ** BigInt(decimals) : supply > 0n ? supply / 100n : 0n;
  const market = readMarket(pools, position, decimals, chain.dex.wethSymbol);
  if (format === "json") return emit(slipJson({ token: token.toLowerCase(), block: head, position: position.toString(), market })), 0;
  const q = chain.native;
  emit(
    renderReceipt(
      {
        title: `BOUNCER · exit door${meta ? ` · ${meta.symbol}` : ""}`,
        subtitle: `${token.toLowerCase()} · ${market.best ? `${market.best.dex} ${market.best.kind}` : "no pool"} · block ${head}`,
        sections: [
          {
            title: "walk out now",
            rows: [
              { label: "position", value: `${formatUnits(position, decimals, 0)} tokens`, note: amountFlag ? "as asked" : "1% of supply unless you pass --amount" },
              { label: "spot", value: market.spot === null ? "unknown" : `${formatUnits(market.spot, q.decimals, 12)} ${chain.dex.wethSymbol} per token` },
              ...market.quotes.map((x) => ({
                label: `sell ${x.shareBps / 100}%`,
                value: `${formatUnits(x.out, q.decimals, 6)} ${chain.dex!.wethSymbol}`,
                note: `${(x.realisedBps / 100).toFixed(1)}% of spot${x.beyondTick ? " · leaves the current tick" : ""}`,
              })),
            ],
          },
          {
            title: "pools",
            rows: pools.length
              ? pools.map((p) => ({
                  label: `${p.dex} ${p.kind}`,
                  value: `${p.quoteReserve === null ? "unread" : formatUnits(p.quoteReserve, q.decimals, 3)} ${chain.dex!.wethSymbol} · fee ${(p.feeBps / 100).toFixed(2)}%`,
                  note: p.address,
                }))
              : [{ label: "pools", value: `none against ${chain.dex.wethSymbol} on the chain's known DEX factories` }],
          },
        ],
        footnotes: [market.note],
        meta: { pools: pools.length, priced: market.best !== null },
      },
      asReceiptFormat(format),
    ),
  );
  return 0;
}

/** One wallet's balance in an ordinary token, and what it would fetch right now. */
async function marketBag(rpc: RpcClient, token: string, wallet: string, head: number, chain: ChainConfig, format: string, emit: (text: string) => void): Promise<number> {
  const meta = await readTokenMeta(rpc, token, head).catch(() => null);
  const decimals = meta?.decimals ?? 18;
  const balance = await readBalanceOf(rpc, token, wallet, head);
  const pools = chain.dex ? await readPools(rpc, token.toLowerCase(), chain.dex, head, decimals) : [];
  const market = chain.dex ? readMarket(pools, balance, decimals, chain.dex.wethSymbol) : null;
  const whole = market?.quotes.find((x) => x.shareBps === 10_000) ?? null;
  if (format === "json") return emit(slipJson({ token: token.toLowerCase(), wallet: wallet.toLowerCase(), block: head, balance: balance.toString(), market })), 0;
  const q = chain.native;
  emit(
    renderReceipt(
      {
        title: `BOUNCER · the bag${meta ? ` · ${meta.symbol}` : ""}`,
        subtitle: `${wallet.toLowerCase()} on ${token.toLowerCase()} · block ${head}`,
        sections: [
          {
            title: "holding",
            rows: [
              { label: "balance", value: `${formatUnits(balance, decimals, 4)} tokens` },
              { label: "worth now", value: whole ? `${formatUnits(whole.out, q.decimals, 6)} ${chain.dex?.wethSymbol ?? q.symbol}` : "not priced", note: whole ? `${(whole.realisedBps / 100).toFixed(1)}% of the marginal price` : market?.note },
              { label: "cost basis", value: "not read", note: "this token has no launchpad curve, so there is no trade history to total up here" },
            ],
          },
        ],
        footnotes: [market?.note ?? `${chain.name} has no DEX table, so nothing could be priced.`],
        meta: { balance: balance.toString() },
      },
      asReceiptFormat(format),
    ),
  );
  return 0;
}

/**
 * The tape for a token with no V2 curve: its own transfers, with the pools
 * named so a transfer into one reads as a sale.
 */
async function watchMarketToken(
  rpc: RpcClient,
  token: string,
  head: number,
  chain: ChainConfig,
  args: ParsedArgs,
  write: (text: string) => void,
): Promise<number> {
  const demo = args.flags.demo === true;
  const meta = await readTokenMeta(rpc, token, head).catch(() => null);
  const decimals = meta?.decimals ?? 18;
  const supply = await readSupply(rpc, token, head).catch(() => 0n);
  const pools = chain.dex ? await readPools(rpc, token.toLowerCase(), chain.dex, head, decimals) : [];
  const watch = (flagString(args.flags, "wallet") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  const minShareBps = Math.round(flagNumber(args.flags, "min", 0.25) * 100);
  // Ten minutes, not an hour: this tape is every transfer of the token, so on
  // a busy one an hour of backfill is a wall of history before the first live
  // line. --backfill takes it wider when that is what you want.
  const backfill = flagNumber(args.flags, "backfill", Math.round(600 * chain.blocksPerSecond));
  write(
    `watching ${token.toLowerCase()}${meta ? ` (${meta.symbol})` : ""} on ${chain.name} from block ${Math.max(0, head - backfill)}\n` +
      `${pools.length ? `${pools.length} pool${pools.length > 1 ? "s" : ""}: ${pools.map((p) => `${p.dex} ${p.kind} ${shortAddress(p.address)}`).join(", ")}` : "no pool found, so every line below is a move between wallets"}\n` +
      `${supply > 0n ? `reporting moves of ${(minShareBps / 100).toFixed(2)}% of supply or more` : "total supply could not be read, so every transfer is reported"}${watch.length ? `, and anything at all touching ${watch.map(shortAddress).join(", ")}` : ""}\n`,
  );
  await watchToken(rpc, token, {
    fromBlock: Math.max(0, head - backfill),
    intervalMs: flagNumber(args.flags, "interval", demo ? 0 : 5) * 1000,
    maxRounds: demo ? 1 : flagNumber(args.flags, "rounds", 0) || undefined,
    pools: pools.map((p) => p.address),
    watch,
    supply,
    decimals,
    minShareBps,
    chunkSize: flagNumber(args.flags, "chunk", 0) || undefined,
    onEvent: (e) => write(`${String(e.block).padStart(10)}  ${e.kind.padEnd(19)} ${e.text}  ${e.tx}\n`),
    onRound: (h) => { if (args.flags.quiet !== true) write(`  · block ${h}\n`); },
    sleep: demo ? async () => {} : undefined,
  });
  return 0;
}

async function readSupply(rpc: RpcClient, token: string, block: number): Promise<bigint> {
  const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) }], block);
  return decodeOutputs(ERC20_FUNCTIONS.totalSupply, raw)[0] as bigint;
}

async function readBalanceOf(rpc: RpcClient, token: string, who: string, block: number): Promise<bigint> {
  const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) }], block);
  return decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] as bigint;
}

/**
 * The Solana half of the CLI. Only the commands that mean something there are
 * offered: there is no launchpad to board or plan against, and pools are not
 * read yet, so a command that cannot be answered says so instead of pretending.
 */
async function runSolana(
  command: string,
  args: ParsedArgs,
  chain: ChainConfig,
  format: string,
  emit: (text: string) => void,
  write: (text: string) => void,
): Promise<number> {
  const urls = [flagString(args.flags, "rpc") ?? process.env.SOLANA_RPC_URL ?? chain.rpc[0], ...chain.rpc.slice(1)];
  const rpc = new SolanaRpc({ urls });

  if (command === "doctor") {
    const slot = await rpc.slot();
    const timestamp = await rpc.blockTime(slot);
    emit(
      renderReceipt(
        {
          title: "BOUNCER · doctor",
          subtitle: `${chain.name} · ${rpc.activeUrl}`,
          sections: [
            {
              title: chain.name.toUpperCase(),
              rows: [
                { label: "rpc", value: rpc.activeUrl },
                { label: "slot", value: slot },
                { label: "slot time", value: timestamp ? isoUtc(timestamp) : "unknown" },
                { label: "token programs", value: "SPL Token and Token-2022" },
              ],
            },
            { title: "BOUNDARIES", rows: [{ label: "keys", value: "none" }, { label: "signing", value: "none" }, { label: "transactions", value: "none" }] },
          ],
          footnotes: ["Every value above was read from the chain at the moment shown; nothing is cached or inferred."],
          meta: { slot },
        },
        asReceiptFormat(format),
      ),
    );
    return 0;
  }

  if (command === "door") {
    const mint = args.positionals[0];
    if (!mint) throw new Error("usage: bouncer door <mint> --chain solana");
    const slip = await readSplDoor(rpc, mint, chain);
    if (format === "json") return emit(slipJson(slip)), 0;
    emit(renderReceipt(splReceipt(slip), asReceiptFormat(format)));
    return 0;
  }

  write(
    `bouncer: "${command}" is not available on ${chain.name}. ` +
      `There is no launchpad registry here, and pools are not read yet, so the commands that depend on either are not offered rather than answered badly. ` +
      `Try: bouncer door <mint> --chain ${chain.key}\n`,
  );
  return 1;
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
