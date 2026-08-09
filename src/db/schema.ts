import { relations, sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import {
  EVENT_SOURCES,
  GAS_CONTEXTS,
  GAS_SMELLS,
  GAS_VOLUMES,
  MEAL_TRIGGERS,
} from '@/domain/taxonomy';

/**
 * Local database — the only place health data ever lives.
 *
 * Conventions:
 * - ids are v4 UUIDs generated on the device (or by the widget), never autoincrement,
 *   so a row written by the widget while the app is dead can be inserted later with
 *   `on conflict do nothing` and replayed safely any number of times.
 * - timestamps are epoch milliseconds.
 * - `localDay` / `localHour` / `localDow` are denormalised at write time so every chart
 *   is a single indexed GROUP BY with no date arithmetic in SQL.
 * - user-destroyable rows are soft-deleted (`deletedAt`) to power undo, then purged.
 */

const timestamps = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
};

/* ------------------------------------------------------------------ events */

export const gasEvents = sqliteTable(
  'gas_events',
  {
    id: text('id').primaryKey(),
    occurredAt: integer('occurred_at').notNull(),
    localDay: text('local_day').notNull(),
    localHour: integer('local_hour').notNull(),
    localDow: integer('local_dow').notNull(),
    tzOffset: integer('tz_offset').notNull(),
    source: text('source', { enum: EVENT_SOURCES }).notNull().default('app'),
    volume: text('volume', { enum: GAS_VOLUMES }),
    smell: text('smell', { enum: GAS_SMELLS }),
    context: text('context', { enum: GAS_CONTEXTS }),
    note: text('note'),
    /**
     * Set when local integrity checks distrust the event (burst spam, device clock
     * moved backwards). Suspect events remain fully visible in the user's own stats —
     * they are only excluded from the score that leaves the device.
     */
    suspect: integer('suspect', { mode: 'boolean' }).notNull().default(false),
    deletedAt: integer('deleted_at'),
    ...timestamps,
  },
  (table) => [
    index('idx_events_day').on(table.localDay),
    index('idx_events_occurred').on(table.occurredAt),
    index('idx_events_live').on(table.deletedAt, table.occurredAt),
    index('idx_events_hour').on(table.deletedAt, table.localHour),
    index('idx_events_dow').on(table.deletedAt, table.localDow),
  ],
);

/* ------------------------------------------------------------------- meals */

export const meals = sqliteTable(
  'meals',
  {
    id: text('id').primaryKey(),
    occurredAt: integer('occurred_at').notNull(),
    localDay: text('local_day').notNull(),
    localHour: integer('local_hour').notNull(),
    tzOffset: integer('tz_offset').notNull(),
    title: text('title').notNull().default(''),
    note: text('note'),
    deletedAt: integer('deleted_at'),
    ...timestamps,
  },
  (table) => [
    index('idx_meals_day').on(table.localDay),
    index('idx_meals_live').on(table.deletedAt, table.occurredAt),
  ],
);

export const mealTriggers = sqliteTable(
  'meal_triggers',
  {
    mealId: text('meal_id')
      .notNull()
      .references(() => meals.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: MEAL_TRIGGERS }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mealId, table.trigger] }),
    index('idx_meal_triggers_trigger').on(table.trigger),
  ],
);

/* --------------------------------------------------------- daily symptoms */

/**
 * One row per local day. Bloating and pain are day-level ratings (1..5); the free-text
 * note is the Diary's "how was today" field.
 */
export const dailyLogs = sqliteTable('daily_logs', {
  localDay: text('local_day').primaryKey(),
  bloating: integer('bloating'),
  pain: integer('pain'),
  note: text('note'),
  ...timestamps,
});

/**
 * Bristol is an *event*, not a daily value: several bowel movements a day are normal and
 * collapsing them to one number would make the doctor-facing PDF wrong.
 */
export const bristolEntries = sqliteTable(
  'bristol_entries',
  {
    id: text('id').primaryKey(),
    occurredAt: integer('occurred_at').notNull(),
    localDay: text('local_day').notNull(),
    localHour: integer('local_hour').notNull(),
    tzOffset: integer('tz_offset').notNull(),
    type: integer('type').notNull(),
    deletedAt: integer('deleted_at'),
    ...timestamps,
  },
  (table) => [
    index('idx_bristol_day').on(table.localDay),
    index('idx_bristol_live').on(table.deletedAt, table.occurredAt),
  ],
);

/* ------------------------------------------------------------ achievements */

/**
 * Catalog (title, icon, target, humour) lives in code; only user progress is persisted.
 * `revealedAt` is null while an unlock is still waiting for its reveal animation, which
 * survives an app kill between unlocking and celebrating.
 */
export const achievements = sqliteTable('achievements', {
  key: text('key').primaryKey(),
  progress: integer('progress').notNull().default(0),
  unlockedAt: integer('unlocked_at'),
  revealedAt: integer('revealed_at'),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------------------------------------------------- meta */

/** Typed key/value store for settings, identity and sync cursors. Values are JSON. */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ---------------------------------------------------------------- outbox */

/**
 * Durable queue for the *only* things that may leave the device, and only while the
 * leaderboard is opted in. Payloads are aggregates — never events, tags or symptoms.
 */
export const leaderboardOutbox = sqliteTable(
  'leaderboard_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['progress', 'nickname', 'opt_out'] }).notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_outbox_due').on(table.nextAttemptAt)],
);

/* --------------------------------------------------------------- relations */

export const mealsRelations = relations(meals, ({ many }) => ({
  triggers: many(mealTriggers),
}));

export const mealTriggersRelations = relations(mealTriggers, ({ one }) => ({
  meal: one(meals, { fields: [mealTriggers.mealId], references: [meals.id] }),
}));

/** Pragmas applied on every open; WAL keeps one-tap writes off the UI thread's critical path. */
export const OPEN_PRAGMAS = sql`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
`;

export type GasEventRow = typeof gasEvents.$inferSelect;
export type NewGasEventRow = typeof gasEvents.$inferInsert;
export type MealRow = typeof meals.$inferSelect;
export type MealTriggerRow = typeof mealTriggers.$inferSelect;
export type DailyLogRow = typeof dailyLogs.$inferSelect;
export type BristolRow = typeof bristolEntries.$inferSelect;
export type AchievementRow = typeof achievements.$inferSelect;
export type AppMetaRow = typeof appMeta.$inferSelect;
export type OutboxRow = typeof leaderboardOutbox.$inferSelect;
