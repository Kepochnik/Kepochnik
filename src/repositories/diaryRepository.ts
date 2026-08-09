import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import { bristolEntries, dailyLogs, mealTriggers, meals } from '@/db/schema';
import { newId } from '@/domain/ids';
import type { BristolType, MealTrigger, SymptomLevel } from '@/domain/taxonomy';
import { currentTzOffset, deriveLocalFields, type LocalDay } from '@/domain/time';

import type {
  BristolEntry,
  DailyLog,
  DiaryDay,
  DiaryRepository,
  Meal,
  MealInput,
} from './types';

export function createDiaryRepository(db: AppDatabase): DiaryRepository {
  function triggersFor(mealIds: readonly string[]): Map<string, MealTrigger[]> {
    const map = new Map<string, MealTrigger[]>();
    if (mealIds.length === 0) return map;
    const rows = db
      .select()
      .from(mealTriggers)
      .where(inArray(mealTriggers.mealId, [...mealIds]))
      .all();
    for (const row of rows) {
      const list = map.get(row.mealId) ?? [];
      list.push(row.trigger);
      map.set(row.mealId, list);
    }
    return map;
  }

  function loadMeals(from: LocalDay, to: LocalDay): Meal[] {
    const rows = db
      .select()
      .from(meals)
      .where(and(gte(meals.localDay, from), lte(meals.localDay, to), isNull(meals.deletedAt)))
      .orderBy(asc(meals.occurredAt))
      .all();
    const triggers = triggersFor(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      localDay: row.localDay,
      title: row.title,
      note: row.note ?? null,
      triggers: triggers.get(row.id) ?? [],
    }));
  }

  return {
    getDay(day: LocalDay): DiaryDay {
      const logRow = db.select().from(dailyLogs).where(eq(dailyLogs.localDay, day)).get();
      const bristol = db
        .select()
        .from(bristolEntries)
        .where(and(eq(bristolEntries.localDay, day), isNull(bristolEntries.deletedAt)))
        .orderBy(asc(bristolEntries.occurredAt))
        .all()
        .map<BristolEntry>((row) => ({
          id: row.id,
          occurredAt: row.occurredAt,
          localDay: row.localDay,
          type: row.type as BristolType,
        }));

      return {
        localDay: day,
        meals: loadMeals(day, day),
        bristol,
        log: logRow
          ? {
              localDay: logRow.localDay,
              bloating: (logRow.bloating as SymptomLevel | null) ?? null,
              pain: (logRow.pain as SymptomLevel | null) ?? null,
              note: logRow.note ?? null,
            }
          : null,
      };
    },

    addMeal(input: MealInput): Meal {
      const now = Date.now();
      const tzOffset = currentTzOffset(new Date(input.occurredAt));
      const local = deriveLocalFields(input.occurredAt, tzOffset);
      const id = newId();

      db.transaction((tx) => {
        tx.insert(meals)
          .values({
            id,
            occurredAt: input.occurredAt,
            localDay: local.localDay,
            localHour: local.localHour,
            tzOffset,
            title: input.title,
            note: input.note ?? null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        if (input.triggers.length > 0) {
          tx.insert(mealTriggers)
            .values(input.triggers.map((trigger) => ({ mealId: id, trigger })))
            .run();
        }
      });

      return {
        id,
        occurredAt: input.occurredAt,
        localDay: local.localDay,
        title: input.title,
        note: input.note ?? null,
        triggers: [...input.triggers],
      };
    },

    updateMeal(id: string, input: Partial<MealInput>): void {
      const now = Date.now();
      db.transaction((tx) => {
        const patch: Record<string, unknown> = { updatedAt: now };
        if (input.title !== undefined) patch.title = input.title;
        if (input.note !== undefined) patch.note = input.note;
        if (input.occurredAt !== undefined) {
          const tzOffset = currentTzOffset(new Date(input.occurredAt));
          const local = deriveLocalFields(input.occurredAt, tzOffset);
          patch.occurredAt = input.occurredAt;
          patch.localDay = local.localDay;
          patch.localHour = local.localHour;
          patch.tzOffset = tzOffset;
        }
        tx.update(meals).set(patch).where(eq(meals.id, id)).run();

        if (input.triggers) {
          tx.delete(mealTriggers).where(eq(mealTriggers.mealId, id)).run();
          if (input.triggers.length > 0) {
            tx.insert(mealTriggers)
              .values(input.triggers.map((trigger) => ({ mealId: id, trigger })))
              .run();
          }
        }
      });
    },

    deleteMeal(id: string): void {
      const now = Date.now();
      db.update(meals).set({ deletedAt: now, updatedAt: now }).where(eq(meals.id, id)).run();
    },

    upsertDailyLog(day: LocalDay, patch): DailyLog {
      const now = Date.now();
      const existing = db.select().from(dailyLogs).where(eq(dailyLogs.localDay, day)).get();
      const next: DailyLog = {
        localDay: day,
        bloating: patch.bloating !== undefined ? patch.bloating : ((existing?.bloating as SymptomLevel | null) ?? null),
        pain: patch.pain !== undefined ? patch.pain : ((existing?.pain as SymptomLevel | null) ?? null),
        note: patch.note !== undefined ? patch.note : (existing?.note ?? null),
      };

      db.insert(dailyLogs)
        .values({
          localDay: day,
          bloating: next.bloating,
          pain: next.pain,
          note: next.note,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: dailyLogs.localDay,
          set: { bloating: next.bloating, pain: next.pain, note: next.note, updatedAt: now },
        })
        .run();

      return next;
    },

    addBristol(occurredAt: number, type: BristolType): BristolEntry {
      const now = Date.now();
      const tzOffset = currentTzOffset(new Date(occurredAt));
      const local = deriveLocalFields(occurredAt, tzOffset);
      const id = newId();

      db.insert(bristolEntries)
        .values({
          id,
          occurredAt,
          localDay: local.localDay,
          localHour: local.localHour,
          tzOffset,
          type,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return { id, occurredAt, localDay: local.localDay, type };
    },

    deleteBristol(id: string): void {
      const now = Date.now();
      db.update(bristolEntries)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(bristolEntries.id, id))
        .run();
    },

    daysWithContent(from: LocalDay, to: LocalDay): LocalDay[] {
      const rows = db.all<{ local_day: LocalDay }>(sql`
        select local_day from meals
          where deleted_at is null and local_day between ${from} and ${to}
        union
        select local_day from bristol_entries
          where deleted_at is null and local_day between ${from} and ${to}
        union
        select local_day from daily_logs
          where local_day between ${from} and ${to}
            and (bloating is not null or pain is not null or (note is not null and note <> ''))
        order by local_day
      `);
      return rows.map((row) => row.local_day);
    },
  };
}
