/**
 * `diploma odds <token>`: one curve, one block, one grade. Reads the factory
 * record and curve state pinned to a block, then the curve's own
 * CurveBuy / CurveSell logs over a trailing window for pace and silence.
 */
import { CURVE_EVENTS, GraduationPhase, PHASE_LABEL } from "../chain/pons.js";
import { PonsReader, type LaunchSnapshot } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { estimateBlocksAgo, readTape } from "../chain/tape.js";
import { formatDuration, formatUnits, isoUtc } from "../format.js";
import type { Receipt } from "../receipt.js";
import { grade, type Activity, type Report } from "./grades.js";

export interface OddsResult {
  snapshot: LaunchSnapshot;
  activity: Activity | null;
  report: Report;
  quoteSymbol: string;
  quoteDecimals: number;
  window: { fromBlock: number; toBlock: number; seconds: number };
}

export async function readOdds(rpc: RpcClient, token: string, windowSeconds = 3600, chunkSize = 1_500): Promise<OddsResult> {
  const reader = new PonsReader(rpc);
  const snapshot = await reader.snapshot(token);
  const toBlock = snapshot.block.number;
  const fromBlock = Math.max(0, toBlock - estimateBlocksAgo(windowSeconds));
  const fromHeader = await rpc.getBlock(fromBlock);
  const seconds = Math.max(1, snapshot.block.timestamp - fromHeader.timestamp);

  let activity: Activity | null = null;
  if (snapshot.launch.phase === GraduationPhase.NotGraduated) {
    const tape = await readTape(rpc, {
      fromBlock,
      toBlock,
      address: snapshot.launch.curve,
      events: [CURVE_EVENTS.CurveBuy, CURVE_EVENTS.CurveSell],
      chunkSize,
    });
    let netQuoteIn = 0n;
    let buys = 0;
    let sells = 0;
    let lastBuyBlock: number | null = null;
    for (const log of tape.logs) {
      if (log.name === "CurveBuy") {
        buys++;
        netQuoteIn += (log.args.quoteIn as bigint) - (log.args.fee as bigint) - (log.args.tax as bigint);
        lastBuyBlock = log.blockNumber;
      } else {
        sells++;
        netQuoteIn -= log.args.quoteOut as bigint;
      }
    }
    const secondsPerBlock = seconds / Math.max(1, toBlock - fromBlock);
    activity = {
      netQuoteIn,
      buys,
      sells,
      windowSeconds: seconds,
      secondsSinceLastBuy: lastBuyBlock === null ? null : Math.round((toBlock - lastBuyBlock) * secondsPerBlock),
    };
  }

  const isNative = snapshot.launch.pairToken === "0x0000000000000000000000000000000000000000";
  const quoteSymbol = isNative ? "ETH" : `quote ${snapshot.launch.pairToken.slice(0, 8)}…`;
  const quoteDecimals = 18; // ERC-20 quote decimals are read lazily in v0.2; ETH launches dominate.

  const report = grade(
    {
      realQuoteReserve: snapshot.curve?.realQuoteReserve ?? 0n,
      graduationThreshold: snapshot.curve?.graduationThreshold ?? snapshot.launch.graduationThreshold,
      sellableTokens: snapshot.curve ? snapshot.curve.tokenReserve : 0n,
      graduated: snapshot.curve?.graduated ?? true,
      phase: snapshot.launch.phase,
    },
    activity,
  );

  return { snapshot, activity, report, quoteSymbol, quoteDecimals, window: { fromBlock, toBlock, seconds } };
}

export function oddsReceipt(result: OddsResult): Receipt {
  const { snapshot, activity, report, quoteSymbol, quoteDecimals } = result;
  const bar = progressBar(report.progressBps, 30);
  return {
    title: `ODDS · $${snapshot.token.symbol} · ${report.grade}`,
    subtitle: `${snapshot.token.name} · ${snapshot.launch.token}`,
    sections: [
      {
        title: "curve",
        rows: [
          { label: "phase", value: PHASE_LABEL[snapshot.launch.phase] },
          { label: "fill", value: `${bar} ${(report.progressBps / 100).toFixed(1)}%`, note: "real quote vs threshold" },
          { label: "raised so far", value: snapshot.curve ? `${formatUnits(snapshot.curve.realQuoteReserve, quoteDecimals)} ${quoteSymbol}` : null },
          { label: "threshold", value: `${formatUnits(snapshot.launch.graduationThreshold, quoteDecimals)} ${quoteSymbol}` },
          { label: "remaining", value: `${formatUnits(report.remainingQuote, quoteDecimals)} ${quoteSymbol}` },
          { label: "tokens left on curve", value: snapshot.curve ? formatUnits(snapshot.curve.tokenReserve, snapshot.token.decimals, 0) : null },
          { label: "creator tax", value: `${Number(snapshot.launch.creatorTaxBps) / 100}%` },
          { label: "deployer holds", value: formatUnits(snapshot.deployerBalance, snapshot.token.decimals, 0), note: `of ${formatUnits(snapshot.token.totalSupply, snapshot.token.decimals, 0)}` },
        ],
      },
      {
        title: `pace · last ${formatDuration(result.window.seconds)}`,
        rows: activity
          ? [
              { label: "buys / sells", value: `${activity.buys} / ${activity.sells}` },
              { label: "net inflow", value: `${formatUnits(activity.netQuoteIn, quoteDecimals)} ${quoteSymbol}` },
              { label: "pace", value: `${formatUnits(report.paceQuotePerHour, quoteDecimals)} ${quoteSymbol}/h` },
              { label: "last buy", value: activity.secondsSinceLastBuy === null ? "none in window" : `${formatDuration(activity.secondsSinceLastBuy)} ago` },
              { label: "eta at this pace", value: report.etaSeconds === null ? "n/a" : formatDuration(report.etaSeconds), note: "arithmetic, not a forecast" },
            ]
          : [{ label: "pace", value: "curve is closed" }],
      },
      {
        title: "verdict",
        rows: [
          { label: "grade", value: report.grade, note: report.reason },
          { label: "read at block", value: snapshot.block.number, note: isoUtc(snapshot.block.timestamp) },
        ],
      },
    ],
    footnotes: [
      "FRESHMAN < 25% · SOPHOMORE < 50% · JUNIOR < 75% · SENIOR ≥ 75% of the curve's own threshold. DROPOUT = no buy for 6h under 50%.",
      "No key. No signer. No transaction path. A grade is arithmetic on one block, not advice.",
    ],
    meta: { token: snapshot.launch.token, block: snapshot.block.number, grade: report.grade },
  };
}

export function progressBar(bps: number, width: number): string {
  const filled = Math.round((Math.min(10_000, Math.max(0, bps)) / 10_000) * width);
  return `[${"█".repeat(filled)}${"·".repeat(width - filled)}]`;
}
