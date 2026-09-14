/**
 * Grades are arithmetic on a Pons V2 curve, nothing more.
 *
 * progress  = realQuoteReserve / graduationThreshold (quote-side fill)
 * remaining = graduationThreshold - realQuoteReserve
 * pace      = net quote inflow over the trailing window (buys minus sells)
 * eta       = remaining / pace, when pace is positive
 *
 * The contract graduates on the token side (sellableTokens() == 0), which
 * is equivalent to the quote side reaching the threshold; we show both.
 */

export type Grade = "FRESHMAN" | "SOPHOMORE" | "JUNIOR" | "SENIOR" | "GRADUATED" | "DROPOUT" | "SWEPT";

export interface CurveFacts {
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  sellableTokens: bigint;
  graduated: boolean;
  /** Launch phase from the factory record: 0 curve, 1 swept, 2 pool, 3 rescued. */
  phase: number;
}

export interface Activity {
  /** Net quote inflow (buys - sells, after fees) over the trailing window. */
  netQuoteIn: bigint;
  buys: number;
  sells: number;
  windowSeconds: number;
  /** Seconds since the last buy on this curve, or null if none seen in the window. */
  secondsSinceLastBuy: number | null;
}

export interface Report {
  grade: Grade;
  progressBps: number; // 0..10000
  remainingQuote: bigint;
  etaSeconds: number | null; // null when pace <= 0 or already graduated
  paceQuotePerHour: bigint; // may be negative
  reason: string;
}

export const GRADE_RULES = {
  senior: 7_500,
  junior: 5_000,
  sophomore: 2_500,
  /** No buy for this long while under this fill = DROPOUT. */
  dropoutSilenceSeconds: 6 * 3600,
  dropoutMaxBps: 5_000,
} as const;

export function progressBps(facts: CurveFacts): number {
  if (facts.graduationThreshold === 0n) return 0;
  const bps = (facts.realQuoteReserve * 10_000n) / facts.graduationThreshold;
  return Number(bps > 10_000n ? 10_000n : bps);
}

export function grade(facts: CurveFacts, activity: Activity | null): Report {
  const bps = progressBps(facts);
  const remaining = facts.graduationThreshold > facts.realQuoteReserve ? facts.graduationThreshold - facts.realQuoteReserve : 0n;
  const pace = activity && activity.windowSeconds > 0 ? (activity.netQuoteIn * 3600n) / BigInt(activity.windowSeconds) : 0n;

  if (facts.phase === 2 || facts.phase === 3) {
    return { grade: "GRADUATED", progressBps: 10_000, remainingQuote: 0n, etaSeconds: null, paceQuotePerHour: 0n, reason: "pool is live and locked" };
  }
  if (facts.phase === 1 || facts.graduated) {
    return { grade: "SWEPT", progressBps: 10_000, remainingQuote: 0n, etaSeconds: null, paceQuotePerHour: 0n, reason: "curve drained, pool not seeded yet" };
  }

  let etaSeconds: number | null = null;
  if (pace > 0n && remaining > 0n) {
    etaSeconds = Number((remaining * 3600n) / pace);
  }

  if (
    activity &&
    bps < GRADE_RULES.dropoutMaxBps &&
    (activity.secondsSinceLastBuy === null || activity.secondsSinceLastBuy >= GRADE_RULES.dropoutSilenceSeconds)
  ) {
    const silence = activity.secondsSinceLastBuy === null ? `no buy in ${Math.round(activity.windowSeconds / 3600)}h` : `last buy ${Math.round(activity.secondsSinceLastBuy / 3600)}h ago`;
    return { grade: "DROPOUT", progressBps: bps, remainingQuote: remaining, etaSeconds: null, paceQuotePerHour: pace, reason: `${silence} under ${GRADE_RULES.dropoutMaxBps / 100}% fill` };
  }

  let g: Grade = "FRESHMAN";
  if (bps >= GRADE_RULES.senior) g = "SENIOR";
  else if (bps >= GRADE_RULES.junior) g = "JUNIOR";
  else if (bps >= GRADE_RULES.sophomore) g = "SOPHOMORE";

  const paceText = pace > 0n ? "net inflow positive" : pace < 0n ? "net outflow" : "flat";
  return { grade: g, progressBps: bps, remainingQuote: remaining, etaSeconds, paceQuotePerHour: pace, reason: `${(bps / 100).toFixed(1)}% of threshold, ${paceText}` };
}
