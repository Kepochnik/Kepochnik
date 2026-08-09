/**
 * Achievement catalog.
 *
 * The catalog is code, not data: 24 rules over a single snapshot that the stats
 * repository computes in one pass. The database only stores progress, so adding an
 * achievement in a later release re-evaluates retroactively and unlocks correctly.
 *
 * Copy lives in i18n under `achievements:<key>.title` / `.description`; nothing here is
 * user-visible text. `icon` names a doodle in the illustration set, never an emoji.
 */

export type AchievementCategory = 'volume' | 'streak' | 'timing' | 'diary' | 'explorer';

export interface AchievementSnapshot {
  totalEvents: number;
  currentStreak: number;
  bestStreak: number;
  maxEventsInDay: number;
  maxEventsInHour: number;
  nightEvents: number; // 00:00–04:59
  earlyEvents: number; // 05:00–07:59
  weekendEvents: number;
  widgetEvents: number;
  silentEvents: number;
  loudEvents: number;
  lethalEvents: number;
  fullyTaggedEvents: number;
  distinctContexts: number;
  distinctVolumes: number;
  distinctSmells: number;
  mealsLogged: number;
  distinctTriggers: number;
  distinctBristolTypes: number;
  completeDiaryDays: number;
  daysWithAnyEvent: number;
  /** Longest run of missed days that was followed by another logged day. */
  longestGapDays: number;
}

export interface AchievementDefinition {
  key: string;
  category: AchievementCategory;
  icon: string;
  target: number;
  /** Hidden in the grid until unlocked; shown as a silhouette with a teasing label. */
  secret?: boolean;
  measure: (snapshot: AchievementSnapshot) => number;
}

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  // volume
  { key: 'first_note', category: 'volume', icon: 'spark-single', target: 1, measure: (s) => s.totalEvents },
  { key: 'ten_club', category: 'volume', icon: 'spark-triple', target: 10, measure: (s) => s.totalEvents },
  { key: 'century', category: 'volume', icon: 'medal-line', target: 100, measure: (s) => s.totalEvents },
  { key: 'five_hundred', category: 'volume', icon: 'wave-stack', target: 500, measure: (s) => s.totalEvents },
  { key: 'four_digits', category: 'volume', icon: 'crown-line', target: 1000, measure: (s) => s.totalEvents },
  { key: 'double_digit_day', category: 'volume', icon: 'burst-lines', target: 10, measure: (s) => s.maxEventsInDay },
  { key: 'rush_hour', category: 'volume', icon: 'clock-fast', target: 5, measure: (s) => s.maxEventsInHour },

  // streak
  { key: 'three_in_a_row', category: 'streak', icon: 'chain-short', target: 3, measure: (s) => s.bestStreak },
  { key: 'seven_day_run', category: 'streak', icon: 'chain-long', target: 7, measure: (s) => s.bestStreak },
  { key: 'month_of_honesty', category: 'streak', icon: 'calendar-ring', target: 30, measure: (s) => s.bestStreak },
  { key: 'hundred_days', category: 'streak', icon: 'mountain-line', target: 100, measure: (s) => s.bestStreak },
  { key: 'comeback', category: 'streak', icon: 'arrow-return', target: 7, secret: true, measure: (s) => s.longestGapDays },

  // timing
  { key: 'night_shift', category: 'timing', icon: 'moon-line', target: 10, measure: (s) => s.nightEvents },
  { key: 'dawn_patrol', category: 'timing', icon: 'sun-rise', target: 10, measure: (s) => s.earlyEvents },
  { key: 'weekend_form', category: 'timing', icon: 'deck-chair', target: 20, measure: (s) => s.weekendEvents },
  { key: 'pocket_scientist', category: 'timing', icon: 'widget-tap', target: 25, measure: (s) => s.widgetEvents },

  // explorer
  { key: 'quiet_type', category: 'explorer', icon: 'feather-line', target: 25, measure: (s) => s.silentEvents },
  { key: 'brass_section', category: 'explorer', icon: 'horn-line', target: 25, measure: (s) => s.loudEvents },
  { key: 'field_researcher', category: 'explorer', icon: 'map-pins', target: 5, measure: (s) => s.distinctContexts },
  { key: 'full_spectrum', category: 'explorer', icon: 'prism-line', target: 50, measure: (s) => s.fullyTaggedEvents },
  { key: 'hazard_pay', category: 'explorer', icon: 'flask-line', target: 10, secret: true, measure: (s) => s.lethalEvents },

  // diary
  { key: 'first_meal', category: 'diary', icon: 'plate-line', target: 1, measure: (s) => s.mealsLogged },
  { key: 'trigger_hunter', category: 'diary', icon: 'target-line', target: 8, measure: (s) => s.distinctTriggers },
  { key: 'careful_keeper', category: 'diary', icon: 'notebook-line', target: 7, measure: (s) => s.completeDiaryDays },
] as const;

export const ACHIEVEMENT_KEYS = ACHIEVEMENTS.map((a) => a.key);

export interface AchievementProgress {
  key: string;
  progress: number;
  target: number;
  unlockedAt: number | null;
  revealedAt: number | null;
}

export function evaluate(
  snapshot: AchievementSnapshot,
  stored: ReadonlyMap<string, AchievementProgress>,
  now = Date.now(),
): AchievementProgress[] {
  return ACHIEVEMENTS.map((definition) => {
    const previous = stored.get(definition.key);
    const progress = Math.min(definition.measure(snapshot), definition.target);
    const unlockedAt =
      previous?.unlockedAt ?? (progress >= definition.target ? now : null);
    return {
      key: definition.key,
      progress,
      target: definition.target,
      unlockedAt,
      revealedAt: previous?.revealedAt ?? null,
    };
  });
}

/** Unlocked but not yet celebrated — drives the reveal queue after an app restart. */
export function pendingReveals(progress: readonly AchievementProgress[]): AchievementProgress[] {
  return progress.filter((item) => item.unlockedAt !== null && item.revealedAt === null);
}

export function definitionFor(key: string): AchievementDefinition | undefined {
  return ACHIEVEMENTS.find((a) => a.key === key);
}
