import type { LocalDay } from './time';

/**
 * Leaderboard scoring, and the caps that make it not worth cheating.
 *
 * Every constant here has an exact twin in the Postgres function `submit_progress`.
 * The client computes a score, the server independently re-derives the *maximum
 * plausible* score and clamps to it — so tampering with the client changes nothing.
 */

/** Events beyond this on a single day stop adding to the leaderboard score. */
export const LEADERBOARD_DAILY_CAP = 100;

/** Weekly ceiling implied by the daily cap. */
export const LEADERBOARD_WEEKLY_CAP = LEADERBOARD_DAILY_CAP * 7;

/** Sustained rate the server will accept between two submissions. */
export const MAX_SCORE_PER_MINUTE = 2;

/** Slack on top of the sustained rate, so a genuine burst is never clamped. */
export const SCORE_BURST_ALLOWANCE = 40;

/** Minimum gap between two accepted submissions from one account. */
export const SUBMISSION_COOLDOWN_MS = 60_000;

/** A streak cannot grow faster than one day per calendar day. */
export const MAX_STREAK_DAYS = 3650;

export interface DailyCount {
  localDay: LocalDay;
  /** Events that passed local integrity checks. Suspect events are already excluded. */
  count: number;
}

/** Weekly score: capped per day, so one frantic afternoon cannot buy the top spot. */
export function computeWeeklyScore(days: readonly DailyCount[]): number {
  const total = days.reduce((sum, day) => sum + Math.min(day.count, LEADERBOARD_DAILY_CAP), 0);
  return Math.min(total, LEADERBOARD_WEEKLY_CAP);
}

/**
 * Largest score increase the server will accept given the time since the previous
 * accepted submission. Mirrored verbatim in SQL.
 */
export function maxScoreDelta(msSinceLastSubmission: number): number {
  const minutes = Math.max(0, msSinceLastSubmission) / 60_000;
  return Math.ceil(minutes * MAX_SCORE_PER_MINUTE) + SCORE_BURST_ALLOWANCE;
}

/** Largest streak the server will accept given the days since the previous submission. */
export function maxStreakValue(previousStreak: number, daysSinceLastSubmission: number): number {
  return Math.min(previousStreak + Math.max(1, Math.floor(daysSinceLastSubmission) + 1), MAX_STREAK_DAYS);
}

export interface ProgressPayload {
  isoWeek: string;
  weekScore: number;
  streakDays: number;
  /** Epoch ms of the most recent non-suspect event. No tags, no notes, no health data. */
  lastEventAt: number | null;
}
