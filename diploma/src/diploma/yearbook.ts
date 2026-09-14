/**
 * The yearbook: one window of the launch ledger summarised as a class.
 * Launched, graduated, graduation rate, time-to-graduate distribution,
 * and the split by quote asset. Pure functions over the ledger.
 */
import type { LaunchLedger, LaunchRecord } from "../chain/launches.js";
import { share } from "../chain/launches.js";
import type { Receipt } from "../receipt.js";
import { formatDuration, formatUnits } from "../format.js";

function human(seconds: number): string {
  return seconds < 90 ? `${seconds} s` : formatDuration(seconds);
}

export interface Yearbook {
  window: { fromBlock: number; toBlock: number; fromTimestamp: number; toTimestamp: number };
  launched: number;
  graduated: number;
  graduatedWithinWindow: number;
  graduationRate: string;
  medianSecondsToGraduate: number | null;
  fastestSeconds: number | null;
  slowestSeconds: number | null;
  byQuote: { pairToken: string; launched: number; graduated: number }[];
  topRaised: { token: string; pairToken: string; pairTokenAmount: bigint }[];
  secondsPerBlock: number;
}

export function buildYearbook(ledger: LaunchLedger, fromTimestamp: number, toTimestamp: number): Yearbook {
  const blocks = Math.max(1, ledger.toBlock - ledger.fromBlock);
  const secondsPerBlock = Math.max(0.01, (toTimestamp - fromTimestamp) / blocks);
  const graduatedRecords = ledger.launches.filter((l) => l.graduatedAt);
  const seconds = graduatedRecords
    .map((l) => (l.graduatedAt!.block - l.launchedAt.block) * secondsPerBlock)
    .sort((a, b) => a - b);

  const quoteMap = new Map<string, { launched: number; graduated: number }>();
  for (const l of ledger.launches) {
    const entry = quoteMap.get(l.pairToken) ?? { launched: 0, graduated: 0 };
    entry.launched++;
    if (l.graduatedAt) entry.graduated++;
    quoteMap.set(l.pairToken, entry);
  }

  const topRaised = [...graduatedRecords]
    .sort((a, b) => (b.graduatedAt!.pairTokenAmount > a.graduatedAt!.pairTokenAmount ? 1 : -1))
    .slice(0, 5)
    .map((l) => ({ token: l.token, pairToken: l.pairToken, pairTokenAmount: l.graduatedAt!.pairTokenAmount }));

  return {
    window: { fromBlock: ledger.fromBlock, toBlock: ledger.toBlock, fromTimestamp, toTimestamp },
    launched: ledger.launches.length,
    graduated: graduatedRecords.length + ledger.graduationsOutsideWindow.length,
    graduatedWithinWindow: graduatedRecords.length,
    graduationRate: share(graduatedRecords.length, ledger.launches.length),
    medianSecondsToGraduate: seconds.length ? Math.round(seconds[Math.floor(seconds.length / 2)]) : null,
    fastestSeconds: seconds.length ? Math.round(seconds[0]) : null,
    slowestSeconds: seconds.length ? Math.round(seconds[seconds.length - 1]) : null,
    byQuote: [...quoteMap.entries()].map(([pairToken, v]) => ({ pairToken, ...v })).sort((a, b) => b.launched - a.launched),
    topRaised,
    secondsPerBlock,
  };
}

export function yearbookReceipt(book: Yearbook, labelOf: (pairToken: string) => string): Receipt {
  const from = new Date(book.window.fromTimestamp * 1000).toISOString().replace(".000Z", "Z");
  const to = new Date(book.window.toTimestamp * 1000).toISOString().replace(".000Z", "Z");
  const dropout = book.launched > 0 ? share(book.launched - book.graduatedWithinWindow, book.launched) : "n/a";
  return {
    title: `YEARBOOK · class of ${to.slice(0, 10)}`,
    subtitle: `${from} → ${to} · blocks ${book.window.fromBlock}–${book.window.toBlock}`,
    sections: [
      {
        title: "the class",
        rows: [
          { label: "launched", value: book.launched },
          { label: "graduated", value: book.graduatedWithinWindow, note: book.graduated !== book.graduatedWithinWindow ? `+${book.graduated - book.graduatedWithinWindow} launched before the window` : undefined },
          { label: "graduation rate", value: book.graduationRate, note: "launched in window that graduated in window" },
          { label: "dropout rate", value: dropout, note: "still on the curve or dead" },
        ],
      },
      {
        title: "time to graduate (launch → pool)",
        rows: [
          { label: "median", value: book.medianSecondsToGraduate === null ? null : human(book.medianSecondsToGraduate) },
          { label: "fastest", value: book.fastestSeconds === null ? null : human(book.fastestSeconds) },
          { label: "slowest", value: book.slowestSeconds === null ? null : human(book.slowestSeconds) },
          { label: "block time", value: `${book.secondsPerBlock.toFixed(3)} s`, note: "measured across the window" },
        ],
      },
      {
        title: "by quote asset",
        rows: book.byQuote.slice(0, 8).map((q) => ({ label: labelOf(q.pairToken), value: `${q.launched} launched · ${q.graduated} graduated`, note: share(q.graduated, q.launched) })),
      },
      {
        title: "most raised",
        rows: book.topRaised.length
          ? book.topRaised.map((t) => ({ label: t.token.slice(0, 10) + "…", value: `${formatUnits(t.pairTokenAmount, 18)} ${labelOf(t.pairToken)}` }))
          : [{ label: "none", value: "no graduations in window" }],
      },
    ],
    footnotes: ["Counts come from the Pons V2 factory events TokenLaunched, LaunchSwept and PoolGraduated inside the block window. Nothing is sampled or extrapolated."],
    meta: { fromBlock: book.window.fromBlock, toBlock: book.window.toBlock },
  };
}
