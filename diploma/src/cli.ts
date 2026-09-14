/**
 * diploma — read-only graduation desk for Pons V2 curves on Robinhood Chain.
 *
 *   diploma doctor                  prove the read path works
 *   diploma watch                   graduations after the fact, one line each
 *   diploma grade <token>           one curve, one block, one grade
 *   diploma print <token>           the diploma: a transcript of the graduation
 *   diploma print <token> --holder  a holder stub: "buyer #12 of 41"
 *   diploma class [--hours 24]      the yearbook: launched, graduated, split by quote asset
 *   diploma demo                    offline walkthrough, no network
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readLaunchLedger } from "./chain/launches.js";
import { GraduationPhase, ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC, ZERO_ADDRESS } from "./chain/pons.js";
import { PonsReader, readTokenMeta } from "./chain/reader.js";
import { RpcClient } from "./chain/rpc.js";
import { estimateBlocksAgo, findBlockByTimestamp } from "./chain/tape.js";
import { flagNumber, flagString, parseArgs } from "./cli/args.js";
import { doctorReceipt, runDoctor } from "./cli/doctor.js";
import { renderReceipt, type ReceiptFormat } from "./receipt.js";
import { DEMO, demoRpc } from "./diploma/demo.js";
import { diplomaReceipt, diplomaSvg, holderStub } from "./diploma/diploma.js";
import { oddsReceipt, readOdds } from "./diploma/odds.js";
import { graduationFacts, watch } from "./diploma/watch.js";
import { buildYearbook, yearbookReceipt } from "./diploma/yearbook.js";
import { MASCOT_SVG_INNER } from "./diploma/mascot.js";

const REPO = "github.com/Kepochnik/diploma";
const MARK = "$DIPLOMA";
const HELP = `diploma — read-only graduation desk for Pons V2 on Robinhood Chain (${ROBINHOOD_CHAIN_ID})

  diploma doctor                  rpc, chain id, factory bytecode, snipe tax terms
  diploma watch [--interval 10]   graduations after the fact, one transcript line each
  diploma grade <token>           one curve, one block: FRESHMAN / SOPHOMORE / JUNIOR / SENIOR / DROPOUT
  diploma print <token>           the diploma: seconds to graduate, buyers, dev share, first minute
  diploma print <token> --holder <address>   a holder stub: buyer #k of N
  diploma class [--hours 24]      the yearbook: launched, graduated, rate, split by quote asset
  diploma demo                    offline walkthrough (synthetic, labelled DEMO)

  --demo                          run any command against the synthetic chain
  --format text|markdown|json     output format (default text); print also takes svg
  --output <file>                 write the output to a new file (refuses to overwrite)
  --hours <n>                     how far back print/class look (default 72 / 24)
  --party                         watch: fire the deterministic confetti on a graduation
  --rpc <url>                     override RPC_URL

No key. No signer. No transaction path.`;

export async function main(argv: string[], write: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command ?? "help";
  const demo = args.flags.demo === true || command === "demo";
  const format = (flagString(args.flags, "format") ?? "text") as ReceiptFormat | "svg";
  const output = flagString(args.flags, "output");
  const rpc = demo ? demoRpc() : liveRpc(flagString(args.flags, "rpc"));
  const chunk = flagNumber(args.flags, "chunk", demo ? 100_000 : 4_000);
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
        emit(renderReceipt(doctorReceipt(report, "diploma"), asReceiptFormat(format)));
        return report.ok ? 0 : 2;
      }

      case "watch": {
        if (demo) write("DEMO · synthetic chain, every address below is invented\n");
        const interval = flagNumber(args.flags, "interval", demo ? 1 : 10);
        await watch(rpc, {
          intervalMs: interval * 1000,
          backfillBlocks: flagNumber(args.flags, "backfill", demo ? 300_000 : estimateBlocksAgo(600)),
          chunkSize: chunk,
          party: args.flags.party === true,
          animate: Boolean(process.stdout.isTTY) && args.flags.static !== true,
          color: Boolean(process.stdout.isTTY),
          maxSweeps: args.flags.once === true || demo ? flagNumber(args.flags, "sweeps", demo ? 2 : 1) : undefined,
          write,
          sleep: demo ? (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 400))) : undefined,
        });
        return 0;
      }

      case "grade":
      case "odds": {
        const token = args.positionals[0] ?? (demo ? DEMO.tokens.late.token : undefined);
        if (!token) throw new Error("usage: diploma grade <token>");
        const result = await readOdds(rpc, token, flagNumber(args.flags, "window", 3600), demo ? 100_000 : Math.min(chunk, 1_500));
        emit(renderReceipt(oddsReceipt(result), asReceiptFormat(format)));
        return 0;
      }

      case "print":
      case "diploma": {
        const token = (args.positionals[0] ?? (demo ? DEMO.tokens.sprint.token : undefined))?.toLowerCase();
        if (!token) throw new Error("usage: diploma print <token> [--holder <address>] [--format svg]");
        const reader = new PonsReader(rpc);
        const head = await rpc.blockNumber();
        const launched = await reader.launchedToken(token, head);
        if (launched.phase !== GraduationPhase.PoolCreated && launched.phase !== GraduationPhase.Rescued) {
          throw new Error(`${token} has not graduated (phase ${launched.phase}); run \`diploma grade ${token}\``);
        }
        const hours = flagNumber(args.flags, "hours", 72);
        const fromBlock = demo ? Math.max(0, head - 300_000) : Math.max(0, head - estimateBlocksAgo(hours * 3600));
        const ledger = await readLaunchLedger(rpc, { fromBlock, toBlock: head, chunkSize: chunk });
        const record = ledger.launches.find((l) => l.token === token);
        const outside = ledger.graduationsOutsideWindow.find((g) => g.token === token);
        const graduationBlock = record?.graduatedAt?.block ?? outside?.block;
        if (!graduationBlock) throw new Error(`no PoolGraduated event for ${token} in the last ${hours}h; pass --hours to widen the window`);
        const facts = await graduationFacts(rpc, token, graduationBlock, record, head, demo ? 100_000 : 2_000);
        const holder = flagString(args.flags, "holder");
        if (holder) emit(renderReceipt(holderStub(facts, holder), asReceiptFormat(format)));
        else if (format === "svg") emit(diplomaSvg(facts, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER }));
        else emit(renderReceipt(diplomaReceipt(facts), format));
        return 0;
      }

      case "class": {
        const hours = flagNumber(args.flags, "hours", 24);
        const head = await rpc.blockNumber();
        const headHeader = await rpc.getBlock(head);
        const fromBlock = demo ? Math.max(0, head - 300_000) : await findBlockByTimestamp(rpc, headHeader.timestamp - hours * 3600, head);
        const fromHeader = await rpc.getBlock(fromBlock);
        const ledger = await readLaunchLedger(rpc, { fromBlock, toBlock: head, chunkSize: chunk });
        const book = buildYearbook(ledger, fromHeader.timestamp, headHeader.timestamp);
        const labels = new Map<string, string>([[ZERO_ADDRESS, "ETH"]]);
        for (const q of book.byQuote) {
          if (!labels.has(q.pairToken)) {
            try {
              const meta = await readTokenMeta(rpc, q.pairToken, head);
              labels.set(q.pairToken, meta.symbol);
            } catch {
              labels.set(q.pairToken, `${q.pairToken.slice(0, 8)}…`);
            }
          }
        }
        emit(renderReceipt(yearbookReceipt(book, (p) => labels.get(p) ?? `${p.slice(0, 8)}…`), asReceiptFormat(format)));
        return 0;
      }

      case "demo": {
        write("DEMO · synthetic chain, every address below is invented · no network\n\n");
        const head = await rpc.blockNumber();
        const ledger = await readLaunchLedger(rpc, { fromBlock: head - 300_000, toBlock: head, chunkSize: 100_000 });
        for (const key of ["sprint", "slow"] as const) {
          const record = ledger.launches.find((l) => l.token === DEMO.tokens[key].token)!;
          const facts = await graduationFacts(rpc, DEMO.tokens[key].token, record.graduatedAt!.block, record, head, 100_000);
          write(renderReceipt(diplomaReceipt(facts), "text") + "\n\n");
        }
        const slowRecord = ledger.launches.find((l) => l.token === DEMO.tokens.slow.token)!;
        const slowFacts = await graduationFacts(rpc, DEMO.tokens.slow.token, slowRecord.graduatedAt!.block, slowRecord, head, 100_000);
        write(renderReceipt(holderStub(slowFacts, DEMO.tokens.slow.buys[12][1]), "text") + "\n\n");
        write(renderReceipt(oddsReceipt(await readOdds(rpc, DEMO.tokens.late.token, 3600, 100_000)), "text") + "\n\n");
        write(renderReceipt(oddsReceipt(await readOdds(rpc, DEMO.tokens.nap.token, 24 * 3600, 100_000)), "text") + "\n\n");
        await watch(rpc, { intervalMs: 0, backfillBlocks: 300_000, chunkSize: 100_000, party: args.flags.party === true, animate: Boolean(process.stdout.isTTY), color: Boolean(process.stdout.isTTY), maxSweeps: 1, write, sleep: async () => {} });
        write("\n");
        const book = buildYearbook(ledger, (await rpc.getBlock(head - 300_000)).timestamp, (await rpc.getBlock(head)).timestamp);
        write(renderReceipt(yearbookReceipt(book, () => "ETH"), "text") + "\n");
        return 0;
      }

      default:
        write(`unknown command ${command}\n\n${HELP}\n`);
        return 1;
    }
  } catch (error) {
    write(`diploma: ${error instanceof Error ? error.message : String(error)}\n`);
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
  throw new Error(`--format ${format} is only valid for print`);
}
