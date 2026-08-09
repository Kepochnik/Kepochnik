import { create } from 'zustand';

import { BURST_LIMIT, assessEvent } from '@/domain/integrity';
import { computeStreak, type StreakState } from '@/domain/streak';
import { currentIsoWeekDays, todayLocalDay, type LocalDay } from '@/domain/time';
import { getRepositories, type EventTagPatch, type GasEvent } from '@/repositories';

/** How long the optional tag panel stays up after a log. It never blocks anything. */
export const TAG_PANEL_TIMEOUT_MS = 4000;

interface EventState {
  today: LocalDay;
  events: GasEvent[];
  todayCount: number;
  streak: StreakState;
  weekAverage: number;
  /** The event the tag panel is currently offering to annotate. */
  pendingTagEventId: string | null;
  /** Bumped on every mutation; Stats and the widget snapshot listen to this. */
  dataVersion: number;

  hydrate: () => void;
  /** Returns null when the write was rejected as a double-fire from a single tap. */
  log: (at?: number) => GasEvent | null;
  applyTags: (id: string, patch: EventTagPatch) => void;
  dismissTagPanel: () => void;
  remove: (id: string) => void;
  undoRemove: (id: string) => void;
  /** Called when the app comes back to the foreground and the calendar day changed. */
  rollover: () => void;
  /** Used after the widget drain, which writes rows behind the store's back. */
  reload: () => void;
}

function readDerived(today: LocalDay) {
  const repos = getRepositories();
  const events = repos.events.listForDay(today);
  const weekDays = currentIsoWeekDays();
  const weekCounts = repos.stats.weeklyCounts(weekDays);
  const elapsed = weekCounts.filter((day) => day.localDay <= today).length || 1;
  const weekTotal = weekCounts.reduce((sum, day) => sum + day.count, 0);

  return {
    events,
    todayCount: events.length,
    streak: computeStreak(repos.events.activeDays(), today),
    weekAverage: Math.round((weekTotal / elapsed) * 10) / 10,
  };
}

export const useEventStore = create<EventState>((set, get) => ({
  today: todayLocalDay(),
  events: [],
  todayCount: 0,
  streak: { current: 0, best: 0, atRisk: false, lastActiveDay: null },
  weekAverage: 0,
  pendingTagEventId: null,
  dataVersion: 0,

  hydrate: () => {
    const today = todayLocalDay();
    set({ today, ...readDerived(today), dataVersion: get().dataVersion + 1 });
  },

  log: (at) => {
    const repos = getRepositories();
    const state = get();
    const occurredAt = at ?? Date.now();

    const verdict = assessEvent({
      occurredAt,
      recentEventTimes: state.events.slice(0, BURST_LIMIT + 1).map((event) => event.occurredAt),
      highWaterMark: state.events[0]?.occurredAt ?? repos.events.highWaterMark(),
    });
    if (!verdict.accept) return null;

    const event = repos.events.log({
      occurredAt,
      source: at === undefined ? 'app' : 'backfill',
      suspect: verdict.suspect,
    });

    const today = todayLocalDay();
    // Optimistic, synchronous update: the counter must move in the same frame as the tap.
    const isToday = event.localDay === today;
    set({
      today,
      events: isToday ? [event, ...state.events] : state.events,
      todayCount: isToday ? state.todayCount + 1 : state.todayCount,
      pendingTagEventId: event.id,
      dataVersion: state.dataVersion + 1,
    });

    // Streak and weekly average involve extra queries, so they settle a beat later.
    queueMicrotask(() => {
      const derived = readDerived(todayLocalDay());
      set({ streak: derived.streak, weekAverage: derived.weekAverage });
    });

    return event;
  },

  applyTags: (id, patch) => {
    getRepositories().events.updateTags(id, patch);
    set((state) => ({
      events: state.events.map((event) => (event.id === id ? { ...event, ...patch } : event)),
      dataVersion: state.dataVersion + 1,
    }));
  },

  dismissTagPanel: () => set({ pendingTagEventId: null }),

  remove: (id) => {
    getRepositories().events.softDelete(id);
    set((state) => {
      const events = state.events.filter((event) => event.id !== id);
      return {
        events,
        todayCount: events.length,
        pendingTagEventId: state.pendingTagEventId === id ? null : state.pendingTagEventId,
        dataVersion: state.dataVersion + 1,
      };
    });
    queueMicrotask(() => {
      const derived = readDerived(get().today);
      set({ streak: derived.streak, weekAverage: derived.weekAverage });
    });
  },

  undoRemove: (id) => {
    getRepositories().events.restore(id);
    get().reload();
  },

  rollover: () => {
    const today = todayLocalDay();
    if (today === get().today) return;
    set({ today, pendingTagEventId: null, ...readDerived(today) });
    set((state) => ({ dataVersion: state.dataVersion + 1 }));
  },

  reload: () => {
    const today = todayLocalDay();
    set((state) => ({ today, ...readDerived(today), dataVersion: state.dataVersion + 1 }));
  },
}));

export const selectTodayCount = (state: EventState) => state.todayCount;
export const selectStreak = (state: EventState) => state.streak;
export const selectTodayEvents = (state: EventState) => state.events;
export const selectPendingTagEvent = (state: EventState) =>
  state.events.find((event) => event.id === state.pendingTagEventId) ?? null;
