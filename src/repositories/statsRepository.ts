import { sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import type { AchievementSnapshot } from '@/domain/achievements';
import { computeStreak } from '@/domain/streak';
import type { StatsRange, SymptomLevel } from '@/domain/taxonomy';
import {
  addLocalDays,
  localDayDiff,
  localDayRange,
  todayLocalDay,
  type LocalDay,
} from '@/domain/time';

import type {
  CsvExport,
  DayBucket,
  DoctorReportData,
  DowBucket,
  HourBucket,
  Meal,
  RangeBounds,
  StatsRepository,
  StatsSummary,
  TagBucket,
  TagDimension,
} from './types';

/** RFC 4180 field escaping. Excel-safe because the file also carries a UTF-8 BOM. */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function createStatsRepository(db: AppDatabase): StatsRepository {
  const countRows = (from: LocalDay, to: LocalDay) =>
    db.get<{ total: number }>(sql`
      select count(*) as total from gas_events
      where deleted_at is null and local_day between ${from} and ${to}
    `);

  const repository: StatsRepository = {
    boundsForRange(range: StatsRange): RangeBounds {
      const to = todayLocalDay();
      return { from: addLocalDays(to, -(range - 1)), to };
    },

    summary({ from, to }: RangeBounds): StatsSummary {
      const total = countRows(from, to)?.total ?? 0;
      const daysCovered = localDayDiff(from, to) + 1;

      const activeRow = db.get<{ days: number }>(sql`
        select count(distinct local_day) as days from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
      `);
      const daysWithEvents = activeRow?.days ?? 0;

      const busiestHourRow = db.get<{ local_hour: number }>(sql`
        select local_hour from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by local_hour order by count(*) desc, local_hour asc limit 1
      `);
      const busiestDowRow = db.get<{ local_dow: number }>(sql`
        select local_dow from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by local_dow order by count(*) desc, local_dow asc limit 1
      `);

      const previousTo = addLocalDays(from, -1);
      const previousFrom = addLocalDays(previousTo, -(daysCovered - 1));
      const previousTotal = countRows(previousFrom, previousTo)?.total ?? 0;

      return {
        total,
        daysCovered,
        daysWithEvents,
        averagePerDay: daysCovered > 0 ? round(total / daysCovered, 1) : 0,
        averagePerActiveDay: daysWithEvents > 0 ? round(total / daysWithEvents, 1) : 0,
        busiestHour: busiestHourRow?.local_hour ?? null,
        busiestDow: busiestDowRow?.local_dow ?? null,
        deltaVsPreviousWindow:
          previousTotal > 0 ? round((total - previousTotal) / previousTotal, 3) : null,
      };
    },

    byHour({ from, to }: RangeBounds): HourBucket[] {
      const rows = db.all<{ local_hour: number; count: number }>(sql`
        select local_hour, count(*) as count from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by local_hour
      `);
      const counts = new Map(rows.map((row) => [row.local_hour, row.count]));
      return Array.from({ length: 24 }, (_, hour) => ({ hour, count: counts.get(hour) ?? 0 }));
    },

    byDayOfWeek({ from, to }: RangeBounds): DowBucket[] {
      const rows = db.all<{ local_dow: number; count: number }>(sql`
        select local_dow, count(*) as count from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by local_dow
      `);
      const counts = new Map(rows.map((row) => [row.local_dow, row.count]));
      return Array.from({ length: 7 }, (_, dow) => ({ dow, count: counts.get(dow) ?? 0 }));
    },

    trend({ from, to }: RangeBounds): DayBucket[] {
      const rows = db.all<{ local_day: LocalDay; count: number }>(sql`
        select local_day, count(*) as count from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by local_day
      `);
      const counts = new Map(rows.map((row) => [row.local_day, row.count]));
      // Dense series: a day with no events is a real zero, not a missing point.
      return localDayRange(from, to).map((localDay) => ({
        localDay,
        count: counts.get(localDay) ?? 0,
      }));
    },

    byTag({ from, to }: RangeBounds, dimension: TagDimension): TagBucket[] {
      const column =
        dimension === 'volume'
          ? sql`volume`
          : dimension === 'smell'
            ? sql`smell`
            : sql`context`;
      const rows = db.all<{ value: string | null; count: number }>(sql`
        select ${column} as value, count(*) as count from gas_events
        where deleted_at is null and local_day between ${from} and ${to}
        group by ${column} order by count desc
      `);
      return rows.map((row) => ({ value: row.value ?? null, count: row.count }));
    },

    weeklyCounts(days: readonly LocalDay[]) {
      if (days.length === 0) return [];
      const from = days[0];
      const to = days[days.length - 1];
      // Suspect events are excluded here and only here: they stay in every personal view.
      const rows = db.all<{ local_day: LocalDay; count: number }>(sql`
        select local_day, count(*) as count from gas_events
        where deleted_at is null and suspect = 0 and local_day between ${from} and ${to}
        group by local_day
      `);
      const counts = new Map(rows.map((row) => [row.local_day, row.count]));
      return days.map((localDay) => ({ localDay, count: counts.get(localDay) ?? 0 }));
    },

    lastNonSuspectEventAt(): number | null {
      const row = db.get<{ value: number | null }>(sql`
        select max(occurred_at) as value from gas_events where deleted_at is null and suspect = 0
      `);
      return row?.value ?? null;
    },

    achievementSnapshot(): AchievementSnapshot {
      const totals = db.get<{
        total: number;
        night: number;
        early: number;
        weekend: number;
        widget: number;
        silent: number;
        loud: number;
        lethal: number;
        fully_tagged: number;
        contexts: number;
        volumes: number;
        smells: number;
        active_days: number;
      }>(sql`
        select
          count(*) as total,
          sum(case when local_hour < 5 then 1 else 0 end) as night,
          sum(case when local_hour between 5 and 7 then 1 else 0 end) as early,
          sum(case when local_dow in (0, 6) then 1 else 0 end) as weekend,
          sum(case when source = 'widget' then 1 else 0 end) as widget,
          sum(case when volume = 'silent' then 1 else 0 end) as silent,
          sum(case when volume = 'loud' then 1 else 0 end) as loud,
          sum(case when smell = 'lethal' then 1 else 0 end) as lethal,
          sum(case when volume is not null and smell is not null and context is not null then 1 else 0 end) as fully_tagged,
          count(distinct context) as contexts,
          count(distinct volume) as volumes,
          count(distinct smell) as smells,
          count(distinct local_day) as active_days
        from gas_events where deleted_at is null
      `);

      const maxDay = db.get<{ value: number }>(sql`
        select coalesce(max(c), 0) as value from (
          select count(*) as c from gas_events where deleted_at is null group by local_day
        )
      `);
      const maxHour = db.get<{ value: number }>(sql`
        select coalesce(max(c), 0) as value from (
          select count(*) as c from gas_events where deleted_at is null group by local_day, local_hour
        )
      `);
      const diary = db.get<{ meals: number; triggers: number; bristol_types: number; complete_days: number }>(sql`
        select
          (select count(*) from meals where deleted_at is null) as meals,
          (select count(distinct trigger) from meal_triggers) as triggers,
          (select count(distinct type) from bristol_entries where deleted_at is null) as bristol_types,
          (select count(*) from daily_logs where bloating is not null and pain is not null) as complete_days
      `);

      const activeDays = db
        .all<{ local_day: LocalDay }>(
          sql`select distinct local_day from gas_events where deleted_at is null order by local_day`,
        )
        .map((row) => row.local_day);

      const streak = computeStreak(activeDays);
      let longestGapDays = 0;
      for (let i = 1; i < activeDays.length; i += 1) {
        longestGapDays = Math.max(longestGapDays, localDayDiff(activeDays[i - 1], activeDays[i]) - 1);
      }

      return {
        totalEvents: totals?.total ?? 0,
        currentStreak: streak.current,
        bestStreak: streak.best,
        maxEventsInDay: maxDay?.value ?? 0,
        maxEventsInHour: maxHour?.value ?? 0,
        nightEvents: totals?.night ?? 0,
        earlyEvents: totals?.early ?? 0,
        weekendEvents: totals?.weekend ?? 0,
        widgetEvents: totals?.widget ?? 0,
        silentEvents: totals?.silent ?? 0,
        loudEvents: totals?.loud ?? 0,
        lethalEvents: totals?.lethal ?? 0,
        fullyTaggedEvents: totals?.fully_tagged ?? 0,
        distinctContexts: totals?.contexts ?? 0,
        distinctVolumes: totals?.volumes ?? 0,
        distinctSmells: totals?.smells ?? 0,
        mealsLogged: diary?.meals ?? 0,
        distinctTriggers: diary?.triggers ?? 0,
        distinctBristolTypes: diary?.bristol_types ?? 0,
        completeDiaryDays: diary?.complete_days ?? 0,
        daysWithAnyEvent: totals?.active_days ?? 0,
        longestGapDays,
      };
    },

    doctorReport(bounds: RangeBounds): DoctorReportData {
      const { from, to } = bounds;
      const eventCount = countRows(from, to)?.total ?? 0;
      const daysCovered = localDayDiff(from, to) + 1;

      const symptoms = db.get<{ bloating: number | null; pain: number | null }>(sql`
        select avg(bloating) as bloating, avg(pain) as pain from daily_logs
        where local_day between ${from} and ${to}
      `);

      const bristolRows = db.all<{ type: number; count: number }>(sql`
        select type, count(*) as count from bristol_entries
        where deleted_at is null and local_day between ${from} and ${to}
        group by type order by type
      `);
      const bristolCounts: Record<number, number> = {};
      let bristolTotal = 0;
      for (const row of bristolRows) {
        bristolCounts[row.type] = row.count;
        bristolTotal += row.count;
      }

      const mealRows = db.all<{
        id: string;
        occurred_at: number;
        local_day: LocalDay;
        title: string;
        note: string | null;
        triggers: string | null;
      }>(sql`
        select m.id, m.occurred_at, m.local_day, m.title, m.note,
               group_concat(t.trigger) as triggers
        from meals m left join meal_triggers t on t.meal_id = m.id
        where m.deleted_at is null and m.local_day between ${from} and ${to}
        group by m.id order by m.occurred_at asc
      `);
      const meals: Meal[] = mealRows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        localDay: row.local_day,
        title: row.title,
        note: row.note ?? null,
        triggers: row.triggers ? (row.triggers.split(',') as Meal['triggers']) : [],
      }));

      const logRows = db.all<{
        local_day: LocalDay;
        bloating: number | null;
        pain: number | null;
        note: string | null;
      }>(sql`
        select local_day, bloating, pain, note from daily_logs
        where local_day between ${from} and ${to} order by local_day asc
      `);

      return {
        from,
        to,
        eventCount,
        eventsPerDay: daysCovered > 0 ? round(eventCount / daysCovered, 1) : 0,
        averageBloating: symptoms?.bloating != null ? round(symptoms.bloating, 1) : null,
        averagePain: symptoms?.pain != null ? round(symptoms.pain, 1) : null,
        bristolCounts,
        bristolTotal,
        meals,
        dailyLogs: logRows.map((row) => ({
          localDay: row.local_day,
          bloating: (row.bloating as SymptomLevel | null) ?? null,
          pain: (row.pain as SymptomLevel | null) ?? null,
          note: row.note ?? null,
        })),
        dailyCounts: repository.trend(bounds),
      };
    },

    buildCsv({ from, to }: RangeBounds): CsvExport {
      const header = [
        'record_type',
        'timestamp_iso',
        'local_day',
        'local_time',
        'volume',
        'smell',
        'context',
        'bristol_type',
        'bloating',
        'pain',
        'meal_title',
        'meal_triggers',
        'note',
      ];
      const lines: string[] = [header.join(',')];

      const events = db.all<{
        occurred_at: number;
        local_day: LocalDay;
        local_hour: number;
        tz_offset: number;
        volume: string | null;
        smell: string | null;
        context: string | null;
        note: string | null;
      }>(sql`
        select occurred_at, local_day, local_hour, tz_offset, volume, smell, context, note
        from gas_events where deleted_at is null and local_day between ${from} and ${to}
        order by occurred_at asc
      `);
      for (const row of events) {
        const local = new Date(row.occurred_at + row.tz_offset * 60_000);
        lines.push(
          [
            'gas',
            new Date(row.occurred_at).toISOString(),
            row.local_day,
            local.toISOString().slice(11, 19),
            row.volume,
            row.smell,
            row.context,
            '',
            '',
            '',
            '',
            '',
            row.note,
          ]
            .map(csvField)
            .join(','),
        );
      }

      const bristol = db.all<{
        occurred_at: number;
        local_day: LocalDay;
        tz_offset: number;
        type: number;
      }>(sql`
        select occurred_at, local_day, tz_offset, type from bristol_entries
        where deleted_at is null and local_day between ${from} and ${to} order by occurred_at asc
      `);
      for (const row of bristol) {
        const local = new Date(row.occurred_at + row.tz_offset * 60_000);
        lines.push(
          [
            'bristol',
            new Date(row.occurred_at).toISOString(),
            row.local_day,
            local.toISOString().slice(11, 19),
            '',
            '',
            '',
            row.type,
            '',
            '',
            '',
            '',
            '',
          ]
            .map(csvField)
            .join(','),
        );
      }

      const mealRows = db.all<{
        occurred_at: number;
        local_day: LocalDay;
        tz_offset: number;
        title: string;
        note: string | null;
        triggers: string | null;
      }>(sql`
        select m.occurred_at, m.local_day, m.tz_offset, m.title, m.note,
               group_concat(t.trigger) as triggers
        from meals m left join meal_triggers t on t.meal_id = m.id
        where m.deleted_at is null and m.local_day between ${from} and ${to}
        group by m.id order by m.occurred_at asc
      `);
      for (const row of mealRows) {
        const local = new Date(row.occurred_at + row.tz_offset * 60_000);
        lines.push(
          [
            'meal',
            new Date(row.occurred_at).toISOString(),
            row.local_day,
            local.toISOString().slice(11, 19),
            '',
            '',
            '',
            '',
            '',
            '',
            row.title,
            row.triggers ?? '',
            row.note,
          ]
            .map(csvField)
            .join(','),
        );
      }

      const logRows = db.all<{
        local_day: LocalDay;
        bloating: number | null;
        pain: number | null;
        note: string | null;
      }>(sql`
        select local_day, bloating, pain, note from daily_logs
        where local_day between ${from} and ${to} order by local_day asc
      `);
      for (const row of logRows) {
        lines.push(
          [
            'daily',
            '',
            row.local_day,
            '',
            '',
            '',
            '',
            '',
            row.bloating,
            row.pain,
            '',
            '',
            row.note,
          ]
            .map(csvField)
            .join(','),
        );
      }

      return {
        filename: `squeakly-${from}_${to}.csv`,
        // BOM so Cyrillic notes open correctly in Excel; CRLF per RFC 4180.
        content: `﻿${lines.join('\r\n')}\r\n`,
      };
    },
  };

  return repository;
}
