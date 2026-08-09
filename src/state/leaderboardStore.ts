import { create } from 'zustand';

import type { LeaderboardBoard } from '@/domain/taxonomy';
import { isoWeekKey } from '@/domain/time';
import { getRepositories } from '@/repositories';
import { fetchLeaderboard, type LeaderboardRow } from '@/services/supabase/api';
import { isLeaderboardConfigured } from '@/services/supabase/client';
import { enqueueProgress, flushOutbox } from '@/services/sync/leaderboardSync';

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'opted_out' | 'unavailable';

interface LeaderboardState {
  board: LeaderboardBoard;
  status: Status;
  rows: LeaderboardRow[];
  self: LeaderboardRow | null;
  errorCode: string | null;
  lastLoadedAt: number | null;

  setBoard: (board: LeaderboardBoard) => void;
  load: (force?: boolean) => Promise<void>;
  /** Pushes local progress, then reloads — used by pull-to-refresh. */
  syncAndLoad: () => Promise<void>;
}

const STALE_AFTER_MS = 60_000;

export const useLeaderboardStore = create<LeaderboardState>((set, get) => ({
  board: 'streak',
  status: 'idle',
  rows: [],
  self: null,
  errorCode: null,
  lastLoadedAt: null,

  setBoard: (board) => {
    set({ board, rows: [], self: null, status: 'idle' });
    void get().load(true);
  },

  load: async (force = false) => {
    const repos = getRepositories();
    if (!repos.settings.get('leaderboardOptIn')) {
      set({ status: 'opted_out', rows: [], self: null });
      return;
    }
    if (!isLeaderboardConfigured()) {
      set({ status: 'unavailable' });
      return;
    }

    const { lastLoadedAt, status } = get();
    if (!force && status === 'ready' && lastLoadedAt && Date.now() - lastLoadedAt < STALE_AFTER_MS) {
      return;
    }

    set({ status: 'loading', errorCode: null });
    try {
      const { board } = get();
      const { rows, self } = await fetchLeaderboard(board, isoWeekKey());
      set({ rows, self, status: 'ready', lastLoadedAt: Date.now() });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      set({ status: 'error', errorCode: code });
    }
  },

  syncAndLoad: async () => {
    const repos = getRepositories();
    enqueueProgress(repos);
    await flushOutbox(repos);
    await get().load(true);
  },
}));
