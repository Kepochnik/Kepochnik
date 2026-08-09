import { addLocalDays, localDayDiff, todayLocalDay, type LocalDay } from './time';

export interface StreakState {
  /** Consecutive days ending today (or yesterday, while today is still unlogged). */
  current: number;
  best: number;
  /** True when today has no event yet but yesterday did — the "don't break it" nudge. */
  atRisk: boolean;
  lastActiveDay: LocalDay | null;
}

/**
 * A day counts toward the streak if it has at least one gas event.
 *
 * The streak is *not* broken the moment midnight passes: a user who has logged
 * yesterday but not yet today still shows yesterday's number with `atRisk`. It only
 * resets once a full day has been skipped. This is the difference between a streak
 * that motivates and a streak that punishes people for sleeping in.
 */
export function computeStreak(activeDays: readonly LocalDay[], today = todayLocalDay()): StreakState {
  if (activeDays.length === 0) {
    return { current: 0, best: 0, atRisk: false, lastActiveDay: null };
  }

  const sorted = [...new Set(activeDays)].sort();
  const lastActiveDay = sorted[sorted.length - 1];

  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (localDayDiff(sorted[i - 1], sorted[i]) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
  }

  const gapFromToday = localDayDiff(lastActiveDay, today);
  if (gapFromToday > 1) {
    return { current: 0, best, atRisk: false, lastActiveDay };
  }

  // Walk backwards from the last active day to size the live run.
  let current = 1;
  let cursor = lastActiveDay;
  const activeSet = new Set(sorted);
  while (activeSet.has(addLocalDays(cursor, -1))) {
    current += 1;
    cursor = addLocalDays(cursor, -1);
  }

  return { current, best: Math.max(best, current), atRisk: gapFromToday === 1, lastActiveDay };
}
