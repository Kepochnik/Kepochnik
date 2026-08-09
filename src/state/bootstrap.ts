import { openDatabase, runMigrations } from '@/db/client';
import { todayLocalDay } from '@/domain/time';
import { initI18n } from '@/i18n';
import { getRepositories } from '@/repositories';
import { flushOutbox, enqueueProgress } from '@/services/sync/leaderboardSync';
import { publishSnapshot, reconcileWidget } from '@/services/widget/sync';

import { useDiaryStore } from './diaryStore';
import { useEventStore } from './eventStore';
import { useProfileStore } from './profileStore';
import { useSettingsStore } from './settingsStore';
import { useStatsStore } from './statsStore';

/** Soft-deleted rows are kept this long so undo works even across a restart, then purged. */
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

let wired = false;

/**
 * Everything that must be true before the first frame of Track can be trusted.
 *
 * The ordering is chosen so the fast path stays fast: migrations and the local reads are
 * synchronous and finish in a few milliseconds, while the widget drain, achievement
 * re-evaluation and any network work are deliberately pushed past first paint.
 */
export async function bootstrap(): Promise<void> {
  openDatabase();
  await runMigrations();

  const repos = getRepositories();

  useSettingsStore.getState().hydrate();
  await initI18n(useSettingsStore.getState().locale);

  useEventStore.getState().hydrate();
  useDiaryStore.getState().selectDay(todayLocalDay());
  useProfileStore.getState().hydrate();
  useStatsStore.getState().refresh(useEventStore.getState().dataVersion);

  wireReactions();

  // Deferred work: none of it gates the first render.
  void (async () => {
    const drained = await reconcileWidget(repos);
    if (drained.imported > 0) useEventStore.getState().reload();

    repos.events.purgeDeletedBefore(Date.now() - PURGE_AFTER_MS);
    useProfileStore.getState().recompute();
    await flushOutbox(repos);
  })();
}

/**
 * One subscription is the entire invalidation strategy: a write bumps `dataVersion`, and
 * everything downstream of the event log recomputes from it. No screen ever has to
 * remember to refresh a sibling screen.
 */
function wireReactions(): void {
  if (wired) return;
  wired = true;

  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  useEventStore.subscribe((state, previous) => {
    if (state.dataVersion === previous.dataVersion) return;

    useStatsStore.getState().refresh(state.dataVersion);

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const repos = getRepositories();
      useProfileStore.getState().recompute();
      void publishSnapshot(repos);
      enqueueProgress(repos);
      void flushOutbox(repos);
    }, 800);
  });
}

/** Called when the app returns to the foreground. */
export async function onAppForeground(): Promise<void> {
  const repos = getRepositories();
  useEventStore.getState().rollover();
  const drained = await reconcileWidget(repos);
  if (drained.imported > 0) {
    useEventStore.getState().reload();
    useProfileStore.getState().recompute();
  }
  await flushOutbox(repos);
}
