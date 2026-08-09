import { inArray } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import { achievements } from '@/db/schema';
import { definitionFor, type AchievementProgress } from '@/domain/achievements';

import type { AchievementRepository } from './types';

export function createAchievementRepository(db: AppDatabase): AchievementRepository {
  return {
    all(): AchievementProgress[] {
      return db
        .select()
        .from(achievements)
        .all()
        .map((row) => ({
          key: row.key,
          progress: row.progress,
          target: definitionFor(row.key)?.target ?? 0,
          unlockedAt: row.unlockedAt,
          revealedAt: row.revealedAt,
        }));
    },

    save(progress: readonly AchievementProgress[]): void {
      if (progress.length === 0) return;
      const now = Date.now();
      db.transaction((tx) => {
        for (const item of progress) {
          tx.insert(achievements)
            .values({
              key: item.key,
              progress: item.progress,
              unlockedAt: item.unlockedAt,
              revealedAt: item.revealedAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: achievements.key,
              set: {
                progress: item.progress,
                unlockedAt: item.unlockedAt,
                revealedAt: item.revealedAt,
                updatedAt: now,
              },
            })
            .run();
        }
      });
    },

    markRevealed(keys: readonly string[]): void {
      if (keys.length === 0) return;
      const now = Date.now();
      db.update(achievements)
        .set({ revealedAt: now, updatedAt: now })
        .where(inArray(achievements.key, [...keys]))
        .run();
    },
  };
}
