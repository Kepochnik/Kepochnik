import { asc, eq, lte } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import { leaderboardOutbox } from '@/db/schema';

import type { OutboxItem, OutboxKind, OutboxRepository } from './types';

/** Exponential backoff with a ceiling, so a dead server costs one request per 10 minutes. */
const BACKOFF_STEPS_MS = [5_000, 30_000, 120_000, 600_000];

function backoffFor(attempts: number): number {
  return BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];
}

export function createOutboxRepository(db: AppDatabase): OutboxRepository {
  return {
    enqueue(kind: OutboxKind, payload: OutboxItem['payload']): void {
      const now = Date.now();
      db.transaction((tx) => {
        // Progress is a snapshot, not a delta: a newer one makes the older one worthless.
        if (kind === 'progress') {
          tx.delete(leaderboardOutbox).where(eq(leaderboardOutbox.kind, 'progress')).run();
        }
        tx.insert(leaderboardOutbox)
          .values({
            kind,
            payload: JSON.stringify(payload),
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
          })
          .run();
      });
    },

    due(now: number): OutboxItem[] {
      return db
        .select()
        .from(leaderboardOutbox)
        .where(lte(leaderboardOutbox.nextAttemptAt, now))
        .orderBy(asc(leaderboardOutbox.id))
        .all()
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          payload: JSON.parse(row.payload) as OutboxItem['payload'],
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt,
        }));
    },

    markFailed(id: number, error: string, now: number): void {
      const row = db
        .select({ attempts: leaderboardOutbox.attempts })
        .from(leaderboardOutbox)
        .where(eq(leaderboardOutbox.id, id))
        .get();
      const attempts = (row?.attempts ?? 0) + 1;
      db.update(leaderboardOutbox)
        .set({
          attempts,
          lastError: error.slice(0, 300),
          nextAttemptAt: now + backoffFor(attempts - 1),
        })
        .where(eq(leaderboardOutbox.id, id))
        .run();
    },

    remove(id: number): void {
      db.delete(leaderboardOutbox).where(eq(leaderboardOutbox.id, id)).run();
    },

    clear(): void {
      db.delete(leaderboardOutbox).run();
    },
  };
}

export { backoffFor };
