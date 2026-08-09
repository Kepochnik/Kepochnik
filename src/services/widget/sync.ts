import type { Repositories } from '@/repositories';
import { currentLocale } from '@/i18n';
import { computeStreak } from '@/domain/streak';
import { currentIsoWeekDays, todayLocalDay } from '@/domain/time';
import { WIDGET_PROTOCOL_VERSION, parsePendingQueue, type WidgetSnapshot } from './protocol';
import { getWidgetBridge } from './bridge';

export interface DrainResult {
  imported: number;
  malformed: number;
}

/**
 * Moves everything the widget recorded into SQLite.
 *
 * Ordering matters and is the whole reliability story:
 *   1. read the queue (non-destructive)
 *   2. insert inside one transaction, `on conflict do nothing`
 *   3. only then acknowledge, which truncates exactly what was read
 *
 * A crash at any point replays step 1–2 harmlessly. A crash after step 2 but before
 * step 3 re-inserts nothing, because ids are stable. The one thing this can never do is
 * lose an event, which is the promise the widget makes to the user.
 */
export async function drainWidgetEvents(repos: Repositories): Promise<DrainResult> {
  const bridge = getWidgetBridge();
  if (!bridge) return { imported: 0, malformed: 0 };

  const { raw, cursor } = await bridge.readPending();
  if (!raw || cursor === 0) return { imported: 0, malformed: 0 };

  const { events, malformed } = parsePendingQueue(raw);
  const imported = repos.events.importMany(
    events.map((event) => ({
      id: event.id,
      occurredAt: event.at,
      tzOffset: event.tz,
      source: 'widget' as const,
    })),
  );

  await bridge.acknowledgePending(cursor);
  repos.settings.set('lastWidgetDrainAt', Date.now());

  return { imported, malformed };
}

/** Recomputes what the widget shows. Cheap enough to call after every single write. */
export function buildSnapshot(repos: Repositories): WidgetSnapshot {
  const today = todayLocalDay();
  const weekDays = currentIsoWeekDays();
  const weekCounts = repos.stats.weeklyCounts(weekDays);
  const elapsedDays = weekCounts.filter((day) => day.localDay <= today).length || 1;
  const weekTotal = weekCounts.reduce((sum, day) => sum + day.count, 0);

  return {
    v: WIDGET_PROTOCOL_VERSION,
    day: today,
    todayCount: repos.events.countForDay(today),
    streakDays: computeStreak(repos.events.activeDays(), today).current,
    weekAverage: Math.round((weekTotal / elapsedDays) * 10) / 10,
    locale: currentLocale(),
    updatedAt: Date.now(),
  };
}

export async function publishSnapshot(repos: Repositories): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge) return;
  await bridge.writeSnapshot(buildSnapshot(repos));
}

/** Full reconciliation: import anything pending, then republish. Runs on every foreground. */
export async function reconcileWidget(repos: Repositories): Promise<DrainResult> {
  const result = await drainWidgetEvents(repos);
  await publishSnapshot(repos);
  return result;
}

export async function clearWidgetData(): Promise<void> {
  await getWidgetBridge()?.clearAll();
}
