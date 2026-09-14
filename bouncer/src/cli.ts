/**
 * bouncer — read-only door check for Pons V2 launches on Robinhood Chain.
 *
 *   bouncer doctor                    prove the read path works
 *   bouncer door <token|curve>        the slip: ID check, cover charge, house rules, dev report card
 *   bouncer cover <token>             just the cover charge (fast: for the launch minute)
 *   bouncer dev <address>             just the dev report card
 *   bouncer demo                      offline walkthrough, no network
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC } from "./chain/pons.js";
import { RpcClient } from "./chain/rpc.js";
import { findBlockByTimestamp } from "./chain/tape.js";
import { flagNumber, flagString, parseArgs } from "./cli/args.js";
import { doctorReceipt, runDoctor } from "./cli/doctor.js";
import { renderReceipt, type ReceiptFormat } from "./receipt.js";
import { doorCard } from "./bouncer/card.js";
import { DEMO, DEMO_IMPOSTOR, demoRpc } from "./bouncer/demo.js";
import { devReportLine, readDevReport } from "./bouncer/devReport.js";
import { doorReceipt, readDoor, slipJson } from "./bouncer/door.js";
import { MASCOT_SVG_INNER } from "./bouncer/mascot.js";
import { formatBps, formatDuration } from "./format.js";
import { PHASE_LABEL } from "./chain/pons.js";

export const REPO = "github.com/Kepochnik/bouncer";
export const MARK = "$BOUNCER";
const HELP = `bouncer — read-only door check for Pons V2 launches on Robinhood Chain (${ROBINHOOD_CHAIN_ID})

  bouncer doctor                      rpc, chain id, factory bytecode, anti-snipe terms
  bouncer door <token|curve>          the slip: ID check, cover charge, house rules, dev report card
  bouncer door <token> --format svg   the same slip as a 1200×630 card
  bouncer dev <address> [--hours 24]  the dev report card on its own
  bouncer demo                        offline walkthrough (synthetic, labelled DEMO)

  --demo                              run any command against the synthetic chain
  --format text|markdown|json         output format (default text); door also takes svg
  --output <file>                     write to a new file (refuses to overwrite)
  --hours <n>                         dev report window in hours (default 24)
  --no-dev                            door: skip the dev report card
  --launch-blocks <n>                 door: how far back to search for the launch (default 7 days of blocks)
  --rpc <url>                         override RPC_URL

No key. No signer. No transaction path.`;

export async function main(argv: string[], write: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command ?? "help";
  const demo = args.flags.demo === true || command === "demo";
  const format = (flagString(args.flags, "format") ?? "text") as ReceiptFormat | "svg";
  const output = flagString(args.flags, "output");
  const rpc = demo ? demoRpc() : liveRpc(flagString(args.flags, "rpc"));
  const chunk = demo ? 100_000 : flagNumber(args.flags, "chunk", 0) || undefined;
  const hours = flagNumber(args.flags, "hours", 24);
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

  try {
    switch (command) {
      case "help":
      case "--help":
        write(HELP + "\n");
        return 0;

      case "doctor": {
        const report = await runDoctor(rpc);
        emit(renderReceipt(doctorReceipt(report, "bouncer"), asReceiptFormat(format)));
        return report.ok ? 0 : 2;
      }

      case "door":
      case "check": {
        const input = args.positionals[0] ?? (demo ? DEMO.tokens.fresh.token : undefined);
        if (!input) throw new Error("usage: bouncer door <token|curve>");
        if (demo) write("DEMO · synthetic chain, every address below is invented\n");
        const slip = await readDoor(rpc, input, { devHours: hours, chunkSize: chunk, skipDev: args.flags["no-dev"] === true, launchSearchBlocks: demo ? 400_000 : flagNumber(args.flags, "launch-blocks", 0) || undefined });
        if (format === "svg") emit(doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER }));
        else if (format === "json") emit(slipJson(slip));
        else emit(renderReceipt(doorReceipt(slip), format));
        return 0;
      }

      case "dev": {
        const address = args.positionals[0] ?? (demo ? DEMO.tokens.slow.deployer : undefined);
        if (!address) throw new Error("usage: bouncer dev <address> [--hours 24]");
        if (demo) write("DEMO · synthetic chain, every address below is invented\n");
        const head = await rpc.getBlock("latest");
        const fromBlock = demo ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
        const report = await readDevReport(rpc, address, { fromBlock, toBlock: head.number, chunking: chunk ? { startChunk: chunk, maxChunk: chunk } : undefined });
        if (format === "json") {
          emit(JSON.stringify(report, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
        } else {
          emit(
            renderReceipt(
              {
                title: `BOUNCER · dev report card`,
                subtitle: `${report.deployer} · blocks ${report.window.fromBlock}–${report.window.toBlock}`,
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
        }
        return 0;
      }

      case "demo": {
        write("DEMO · synthetic chain, every address below is invented · no network\n\n");
        for (const input of [DEMO.tokens.fresh.token, DEMO.tokens.sprint.token, DEMO_IMPOSTOR.token]) {
          const slip = await readDoor(rpc, input, { devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 });
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

function liveRpc(override?: string): RpcClient {
  const primary = override ?? process.env.RPC_URL ?? ROBINHOOD_PUBLIC_RPC;
  const fallbacks = (process.env.RPC_FALLBACK_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return new RpcClient({ urls: [primary, ...fallbacks], expectedChainId: ROBINHOOD_CHAIN_ID });
}

function asReceiptFormat(format: string): ReceiptFormat {
  if (format === "text" || format === "markdown" || format === "json") return format;
  throw new Error(`--format ${format} is only valid for door`);
}
