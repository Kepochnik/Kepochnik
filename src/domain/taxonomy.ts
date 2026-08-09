/**
 * The closed vocabularies of the product.
 *
 * These tuples are the single source of truth: the SQLite schema derives its
 * CHECK-style `enum` columns from them, the UI derives its chip lists from them,
 * and the i18n keys are built as `<namespace>.<group>.<value>` so a new value
 * cannot be shipped without a translation existing for it.
 */

export const GAS_VOLUMES = ['silent', 'normal', 'loud'] as const;
export type GasVolume = (typeof GAS_VOLUMES)[number];

export const GAS_SMELLS = ['none', 'mild', 'lethal'] as const;
export type GasSmell = (typeof GAS_SMELLS)[number];

export const GAS_CONTEXTS = ['home', 'work', 'public', 'bed', 'gym'] as const;
export type GasContext = (typeof GAS_CONTEXTS)[number];

/** How an event entered the database. Drives widget reconciliation and anti-cheat. */
export const EVENT_SOURCES = ['app', 'widget', 'backfill'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Meal trigger chips. Order here is the order rendered in the Diary. */
export const MEAL_TRIGGERS = [
  'dairy',
  'beans',
  'gluten',
  'beer',
  'fast_food',
  'carbonated',
  'onion_garlic',
  'sweeteners',
] as const;
export type MealTrigger = (typeof MEAL_TRIGGERS)[number];

/** Bristol stool scale, 1..7. Rendered as abstract forms, never literal imagery. */
export const BRISTOL_TYPES = [1, 2, 3, 4, 5, 6, 7] as const;
export type BristolType = (typeof BRISTOL_TYPES)[number];

/** Symptom intensity, 1..5, used by both bloating and pain. */
export const SYMPTOM_LEVELS = [1, 2, 3, 4, 5] as const;
export type SymptomLevel = (typeof SYMPTOM_LEVELS)[number];

export const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const LEADERBOARD_BOARDS = ['streak', 'volume'] as const;
export type LeaderboardBoard = (typeof LEADERBOARD_BOARDS)[number];

export function isGasVolume(value: unknown): value is GasVolume {
  return typeof value === 'string' && (GAS_VOLUMES as readonly string[]).includes(value);
}

export function isGasSmell(value: unknown): value is GasSmell {
  return typeof value === 'string' && (GAS_SMELLS as readonly string[]).includes(value);
}

export function isGasContext(value: unknown): value is GasContext {
  return typeof value === 'string' && (GAS_CONTEXTS as readonly string[]).includes(value);
}

export function isMealTrigger(value: unknown): value is MealTrigger {
  return typeof value === 'string' && (MEAL_TRIGGERS as readonly string[]).includes(value);
}

export function isBristolType(value: unknown): value is BristolType {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

export function isSymptomLevel(value: unknown): value is SymptomLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}
