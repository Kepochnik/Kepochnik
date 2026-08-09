import { create } from 'zustand';

import {
  ACHIEVEMENTS,
  evaluate,
  pendingReveals,
  type AchievementProgress,
} from '@/domain/achievements';
import { getRepositories } from '@/repositories';

interface ProfileState {
  achievements: AchievementProgress[];
  unlockedCount: number;
  /** Unlocked but not yet celebrated. Drained one at a time by the reveal overlay. */
  revealQueue: AchievementProgress[];

  hydrate: () => void;
  /** Re-evaluates the whole catalog against a fresh snapshot. Cheap: one aggregate pass. */
  recompute: () => AchievementProgress[];
  consumeReveal: () => AchievementProgress | null;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  achievements: [],
  unlockedCount: 0,
  revealQueue: [],

  hydrate: () => {
    const stored = getRepositories().achievements.all();
    set({
      achievements: stored,
      unlockedCount: stored.filter((item) => item.unlockedAt !== null).length,
      revealQueue: pendingReveals(stored),
    });
  },

  recompute: () => {
    const repos = getRepositories();
    const snapshot = repos.stats.achievementSnapshot();
    const stored = new Map(repos.achievements.all().map((item) => [item.key, item]));
    const next = evaluate(snapshot, stored);

    repos.achievements.save(next);
    const newlyUnlocked = next.filter(
      (item) => item.unlockedAt !== null && stored.get(item.key)?.unlockedAt == null,
    );

    set({
      achievements: next,
      unlockedCount: next.filter((item) => item.unlockedAt !== null).length,
      revealQueue: [...get().revealQueue, ...newlyUnlocked],
    });

    return newlyUnlocked;
  },

  consumeReveal: () => {
    const [next, ...rest] = get().revealQueue;
    if (!next) return null;
    getRepositories().achievements.markRevealed([next.key]);
    set({ revealQueue: rest });
    return next;
  },
}));

export const selectAchievementTotal = () => ACHIEVEMENTS.length;
