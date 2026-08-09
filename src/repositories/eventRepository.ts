import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import { gasEvents, type GasEventRow } from '@/db/schema';
import { newId } from '@/domain/ids';
import { currentTzOffset, deriveLocalFields, type LocalDay } from '@/domain/time';

import type {
  EventRepository,
  EventTagPatch,
  GasEvent,
  ImportedEvent,
  LogEventInput,
} from './types';

function toModel(row: GasEventRow): GasEvent {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    localDay: row.localDay,
    localHour: row.localHour,
    localDow: row.localDow,
    source: row.source,
    volume: row.volume ?? null,
    smell: row.smell ?? null,
    context: row.context ?? null,
    note: row.note ?? null,
    suspect: row.suspect,
  };
}

export function createEventRepository(db: AppDatabase): EventRepository {
  return {
    log(input: LogEventInput = {}): GasEvent {
      const now = Date.now();
      const occurredAt = input.occurredAt ?? now;
      const tzOffset = input.tzOffset ?? currentTzOffset(new Date(occurredAt));
      const local = deriveLocalFields(occurredAt, tzOffset);

      const row: GasEventRow = {
        id: newId(),
        occurredAt,
        localDay: local.localDay,
        localHour: local.localHour,
        localDow: local.localDow,
        tzOffset,
        source: input.source ?? 'app',
        volume: input.volume ?? null,
        smell: input.smell ?? null,
        context: input.context ?? null,
        note: input.note ?? null,
        suspect: input.suspect ?? false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      db.insert(gasEvents).values(row).run();
      return toModel(row);
    },

    importMany(events: readonly ImportedEvent[]): number {
      if (events.length === 0) return 0;
      const now = Date.now();

      return db.transaction((tx) => {
        let inserted = 0;
        for (const event of events) {
          const local = deriveLocalFields(event.occurredAt, event.tzOffset);
          const result = tx
            .insert(gasEvents)
            .values({
              id: event.id,
              occurredAt: event.occurredAt,
              localDay: local.localDay,
              localHour: local.localHour,
              localDow: local.localDow,
              tzOffset: event.tzOffset,
              source: event.source,
              volume: null,
              smell: null,
              context: null,
              note: null,
              suspect: false,
              deletedAt: null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: gasEvents.id })
            .run();
          inserted += result.changes;
        }
        return inserted;
      });
    },

    listForDay(day: LocalDay): GasEvent[] {
      return db
        .select()
        .from(gasEvents)
        .where(and(eq(gasEvents.localDay, day), isNull(gasEvents.deletedAt)))
        .orderBy(desc(gasEvents.occurredAt))
        .all()
        .map(toModel);
    },

    listRange(from: LocalDay, to: LocalDay): GasEvent[] {
      return db
        .select()
        .from(gasEvents)
        .where(
          and(gte(gasEvents.localDay, from), lte(gasEvents.localDay, to), isNull(gasEvents.deletedAt)),
        )
        .orderBy(desc(gasEvents.occurredAt))
        .all()
        .map(toModel);
    },

    countForDay(day: LocalDay): number {
      const row = db
        .select({ count: sql<number>`count(*)` })
        .from(gasEvents)
        .where(and(eq(gasEvents.localDay, day), isNull(gasEvents.deletedAt)))
        .get();
      return row?.count ?? 0;
    },

    recentTimes(limit: number): number[] {
      return db
        .select({ occurredAt: gasEvents.occurredAt })
        .from(gasEvents)
        .where(isNull(gasEvents.deletedAt))
        .orderBy(desc(gasEvents.occurredAt))
        .limit(limit)
        .all()
        .map((row) => row.occurredAt);
    },

    highWaterMark(): number | null {
      const row = db
        .select({ value: sql<number | null>`max(${gasEvents.occurredAt})` })
        .from(gasEvents)
        .get();
      return row?.value ?? null;
    },

    activeDays(from?: LocalDay): LocalDay[] {
      const where = from
        ? and(isNull(gasEvents.deletedAt), gte(gasEvents.localDay, from))
        : isNull(gasEvents.deletedAt);
      return db
        .selectDistinct({ localDay: gasEvents.localDay })
        .from(gasEvents)
        .where(where)
        .orderBy(gasEvents.localDay)
        .all()
        .map((row) => row.localDay);
    },

    updateTags(id: string, patch: EventTagPatch): void {
      db.update(gasEvents)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(gasEvents.id, id))
        .run();
    },

    softDelete(id: string): void {
      const now = Date.now();
      db.update(gasEvents)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(gasEvents.id, id))
        .run();
    },

    restore(id: string): void {
      db.update(gasEvents)
        .set({ deletedAt: null, updatedAt: Date.now() })
        .where(eq(gasEvents.id, id))
        .run();
    },

    purgeDeletedBefore(timestamp: number): number {
      const result = db
        .delete(gasEvents)
        .where(and(sql`${gasEvents.deletedAt} is not null`, lte(gasEvents.deletedAt, timestamp)))
        .run();
      return result.changes;
    },
  };
}
