/**
 * Local integrity checks — layer one of the anti-cheat flow.
 *
 * Guiding rule: the user's own data is never censored. A flagged event is still saved,
 * still shown on Track, still counted in Stats and still printed in the PDF. Flagging
 * only removes it from the aggregate that may be uploaded to the leaderboard.
 */

/** Two writes closer than this are a double-fire from one physical tap, not two events. */
export const DOUBLE_FIRE_WINDOW_MS = 350;

/** Rolling window used for burst detection. */
export const BURST_WINDOW_MS = 60_000;

/** Events past this many inside the burst window are recorded but flagged. */
export const BURST_LIMIT = 12;

/** Device clock going backwards by more than this is treated as tampering, not drift. */
export const CLOCK_REWIND_TOLERANCE_MS = 60_000;

/** Skew against server time above which pending events stop being leaderboard-eligible. */
export const CLOCK_SKEW_LIMIT_MS = 10 * 60_000;

export type IntegrityReason = 'double_fire' | 'burst' | 'clock_rewind' | 'future_event';

export interface IntegrityInput {
  occurredAt: number;
  /** Epoch ms of recent events, newest first. Only the burst window is inspected. */
  recentEventTimes: readonly number[];
  /** Latest `occurredAt` ever written, used to detect the clock moving backwards. */
  highWaterMark: number | null;
  now?: number;
}

export interface IntegrityVerdict {
  /** False means "do not write a row at all" — reserved for double-fire. */
  accept: boolean;
  /** True means "write it, show it, but keep it out of the leaderboard score". */
  suspect: boolean;
  reason: IntegrityReason | null;
}

export function assessEvent(input: IntegrityInput): IntegrityVerdict {
  const now = input.now ?? Date.now();
  const { occurredAt, recentEventTimes, highWaterMark } = input;

  const newest = recentEventTimes[0];
  if (newest !== undefined && Math.abs(occurredAt - newest) < DOUBLE_FIRE_WINDOW_MS) {
    return { accept: false, suspect: false, reason: 'double_fire' };
  }

  if (occurredAt > now + CLOCK_SKEW_LIMIT_MS) {
    return { accept: true, suspect: true, reason: 'future_event' };
  }

  if (highWaterMark !== null && occurredAt < highWaterMark - CLOCK_REWIND_TOLERANCE_MS) {
    return { accept: true, suspect: true, reason: 'clock_rewind' };
  }

  const windowStart = occurredAt - BURST_WINDOW_MS;
  const inWindow = recentEventTimes.filter((time) => time >= windowStart).length;
  if (inWindow >= BURST_LIMIT) {
    return { accept: true, suspect: true, reason: 'burst' };
  }

  return { accept: true, suspect: false, reason: null };
}

/**
 * Server time is sampled on every leaderboard sync. A device whose clock is wildly off
 * keeps working offline, but its score stops being uploaded until the clock agrees again.
 */
export function isClockTrustworthy(deviceNow: number, serverNow: number): boolean {
  return Math.abs(deviceNow - serverNow) <= CLOCK_SKEW_LIMIT_MS;
}
