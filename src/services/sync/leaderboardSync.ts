import { isClockTrustworthy } from '@/domain/integrity';
import { computeWeeklyScore, type ProgressPayload } from '@/domain/scoring';
import { computeStreak } from '@/domain/streak';
import { currentIsoWeekDays, isoWeekKey } from '@/domain/time';
import type { Repositories } from '@/repositories';

import {
  LeaderboardError,
  deleteRemoteAccount,
  ensureAnonymousSession,
  setNickname,
  submitProgress,
} from '../supabase/api';
import { isLeaderboardConfigured } from '../supabase/client';

/**
 * Builds the *entire* payload that is allowed to leave the device.
 *
 * Read it as the privacy contract: an ISO week string, a capped count, a streak length,
 * and the timestamp of the latest event. There is deliberately no code path that can add
 * a tag, a note, a meal or a symptom to this object.
 */
export function buildProgressPayload(repos: Repositories): ProgressPayload {
  const weekDays = currentIsoWeekDays();
  const counts = repos.stats.weeklyCounts(weekDays);
  const streak = computeStreak(repos.events.activeDays());

  return {
    isoWeek: isoWeekKey(),
    weekScore: computeWeeklyScore(counts),
    streakDays: streak.current,
    lastEventAt: repos.stats.lastNonSuspectEventAt(),
  };
}

/** Queues a progress update. Safe to call after every write — the outbox collapses duplicates. */
export function enqueueProgress(repos: Repositories): void {
  if (!repos.settings.get('leaderboardOptIn')) return;
  repos.outbox.enqueue('progress', buildProgressPayload(repos));
}

export interface FlushResult {
  sent: number;
  failed: number;
  skipped: boolean;
}

/**
 * Drains the outbox. Every failure path is non-destructive: the item stays queued with an
 * exponential backoff, so a flight, a dead server or a rate limit costs nothing but time.
 */
export async function flushOutbox(repos: Repositories, now = Date.now()): Promise<FlushResult> {
  if (!repos.settings.get('leaderboardOptIn') || !isLeaderboardConfigured()) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const items = repos.outbox.due(now);
  if (items.length === 0) return { sent: 0, failed: 0, skipped: false };

  let sent = 0;
  let failed = 0;

  try {
    const userId = await ensureAnonymousSession();
    repos.settings.set('anonUserId', userId);
  } catch {
    return { sent: 0, failed: items.length, skipped: false };
  }

  for (const item of items) {
    try {
      if (item.kind === 'progress') {
        const result = await submitProgress(item.payload as ProgressPayload);
        // The server's clock is the reference. A device that disagrees badly stops
        // contributing scores until it agrees again — its local data is untouched.
        const serverNow = Date.parse(result.serverTime);
        if (Number.isFinite(serverNow)) {
          repos.settings.set('clockTrusted', isClockTrustworthy(Date.now(), serverNow));
        }
        repos.settings.set('lastProgressSubmitAt', Date.now());
      } else if (item.kind === 'nickname') {
        const { nickname } = item.payload as { nickname: string };
        const accepted = await setNickname(nickname);
        repos.settings.set('nickname', accepted);
      } else {
        await deleteRemoteAccount();
      }

      repos.outbox.remove(item.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      const message =
        error instanceof LeaderboardError ? `${error.code}: ${error.message}` : String(error);
      repos.outbox.markFailed(item.id, message, Date.now());
    }
  }

  return { sent, failed, skipped: false };
}

/** Opting out removes the server record first, then forgets everything locally. */
export async function optOutOfLeaderboards(repos: Repositories): Promise<void> {
  repos.settings.patch({ leaderboardOptIn: false });
  repos.outbox.clear();
  if (!isLeaderboardConfigured()) return;
  try {
    await deleteRemoteAccount();
  } catch {
    // If the network is down the deletion is retried from the outbox on next launch.
    repos.outbox.enqueue('opt_out', {});
  }
}
