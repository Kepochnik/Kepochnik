import { z } from 'zod';

/**
 * The contract between the native widgets and the app.
 *
 * Both sides append to an append-only JSONL queue and read a small JSON snapshot.
 * Keeping the format this dumb is deliberate: the widget must be able to record an
 * event while the app is not running, has no database handle, and may be killed a
 * millisecond later.
 *
 * iOS   — files live in the App Group container `group.com.kepochnik.gutlog`.
 * Android — files live in the app's own `filesDir/squeakly/`, since a Glance widget
 *           runs in the app's process and needs no shared container.
 */

export const WIDGET_PROTOCOL_VERSION = 1;

export const PENDING_EVENTS_FILE = 'pending-events.jsonl';
export const SNAPSHOT_FILE = 'snapshot.json';

/** One line of the queue. Written natively, parsed here. */
export const pendingEventSchema = z.object({
  v: z.literal(WIDGET_PROTOCOL_VERSION),
  /** UUID minted natively — this is what makes the drain idempotent. */
  id: z.string().uuid(),
  /** Epoch milliseconds. */
  at: z.number().int().positive(),
  /** Minutes ahead of UTC at the moment of the tap. */
  tz: z.number().int().min(-840).max(840),
  src: z.literal('widget'),
});

export type PendingEvent = z.infer<typeof pendingEventSchema>;

/**
 * What the widget renders between drains. The app rewrites it after every change so the
 * widget can show a truthful count without ever touching SQLite.
 */
export const widgetSnapshotSchema = z.object({
  v: z.literal(WIDGET_PROTOCOL_VERSION),
  /** 'YYYY-MM-DD' the counts belong to, so a stale snapshot renders as zero after midnight. */
  day: z.string(),
  todayCount: z.number().int().nonnegative(),
  streakDays: z.number().int().nonnegative(),
  weekAverage: z.number().nonnegative(),
  /** Locale the widget should render its labels in. */
  locale: z.string(),
  updatedAt: z.number().int().nonnegative(),
});

export type WidgetSnapshot = z.infer<typeof widgetSnapshotSchema>;

export interface ParsedQueue {
  events: PendingEvent[];
  /** Lines that failed validation. Counted, reported, and dropped — never retried forever. */
  malformed: number;
}

/** Tolerant line parser: one corrupt line from a half-finished write cannot block the rest. */
export function parsePendingQueue(raw: string): ParsedQueue {
  const events: PendingEvent[] = [];
  let malformed = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const result = pendingEventSchema.safeParse(JSON.parse(trimmed));
      if (result.success) {
        events.push(result.data);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }

  return { events, malformed };
}

export function serializeSnapshot(snapshot: WidgetSnapshot): string {
  return JSON.stringify(snapshot);
}
