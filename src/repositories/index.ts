import { getDatabase, type AppDatabase } from '@/db/client';

import { createAchievementRepository } from './achievementRepository';
import { createDiaryRepository } from './diaryRepository';
import { createEventRepository } from './eventRepository';
import { createOutboxRepository } from './outboxRepository';
import { createSettingsRepository } from './settingsRepository';
import { createStatsRepository } from './statsRepository';
import type { Repositories } from './types';

/**
 * The single seam between storage and everything above it.
 *
 * Rule enforced by review (and by lint config): nothing outside `src/repositories`
 * imports `drizzle-orm` or `@/db/*`. Stores and screens only ever see this container,
 * which is also what makes them trivially testable against an in-memory database.
 */
export function createRepositories(db: AppDatabase = getDatabase()): Repositories {
  return {
    events: createEventRepository(db),
    diary: createDiaryRepository(db),
    stats: createStatsRepository(db),
    achievements: createAchievementRepository(db),
    settings: createSettingsRepository(db),
    outbox: createOutboxRepository(db),
  };
}

let container: Repositories | null = null;

export function getRepositories(): Repositories {
  if (!container) container = createRepositories();
  return container;
}

/** Called after a destructive wipe, which replaces the underlying database handle. */
export function resetRepositories(): void {
  container = null;
}

export * from './types';
export { DEFAULT_SETTINGS } from './settingsRepository';
