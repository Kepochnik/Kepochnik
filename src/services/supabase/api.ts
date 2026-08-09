import type { LeaderboardBoard } from '@/domain/taxonomy';
import type { ProgressPayload } from '@/domain/scoring';

import { getSupabase } from './client';

/**
 * Every call in this file goes through a `security definer` RPC. No table is readable or
 * writable directly, which is what lets the server be the sole authority on scores while
 * still exposing a public top-100.
 *
 * The full list of fields that ever leaves the device is visible in `ProgressPayload` and
 * `setNickname` below: a nickname, a streak length, a weekly count, and a timestamp.
 */

export class LeaderboardError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LeaderboardError';
  }
}

function requireClient() {
  const supabase = getSupabase();
  if (!supabase) throw new LeaderboardError('Leaderboards are not configured', 'not_configured');
  return supabase;
}

/** Anonymous sign-in. No email, no password, no profile beyond a generated nickname. */
export async function ensureAnonymousSession(): Promise<string> {
  const supabase = requireClient();
  const existing = await supabase.auth.getSession();
  if (existing.data.session?.user.id) return existing.data.session.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new LeaderboardError(error?.message ?? 'Sign-in failed', 'auth_failed');
  }
  return data.user.id;
}

export interface SubmitProgressResult {
  accepted: boolean;
  /** True when the server clamped a value it considered implausible. */
  clamped: boolean;
  storedScore: number;
  storedStreak: number;
  /** Server clock, used to detect a tampered device clock. */
  serverTime: string;
}

export async function submitProgress(payload: ProgressPayload): Promise<SubmitProgressResult> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('submit_progress', {
    p_iso_week: payload.isoWeek,
    p_week_score: payload.weekScore,
    p_streak_days: payload.streakDays,
    p_last_event_at: payload.lastEventAt ? new Date(payload.lastEventAt).toISOString() : null,
  });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  return data as SubmitProgressResult;
}

export interface LeaderboardRow {
  userId: string;
  nickname: string;
  isPro: boolean;
  value: number;
  rank: number;
  isSelf: boolean;
}

export async function fetchLeaderboard(
  board: LeaderboardBoard,
  isoWeek: string,
  limit = 100,
): Promise<{ rows: LeaderboardRow[]; self: LeaderboardRow | null }> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('leaderboard_page', {
    p_board: board,
    p_iso_week: isoWeek,
    p_limit: limit,
  });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');

  const rows = (data as LeaderboardRow[]) ?? [];
  return { rows, self: rows.find((row) => row.isSelf) ?? null };
}

export async function setNickname(nickname: string): Promise<string> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('set_nickname', { p_nickname: nickname });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  return data as string;
}

export async function createRoom(name: string): Promise<{ id: string; code: string }> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('create_room', { p_name: name });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  return data as { id: string; code: string };
}

export async function joinRoom(code: string): Promise<{ id: string; name: string }> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('join_room', { p_code: code });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  return data as { id: string; name: string };
}

export async function fetchRoomLeaderboard(
  roomId: string,
  board: LeaderboardBoard,
  isoWeek: string,
): Promise<LeaderboardRow[]> {
  const supabase = requireClient();
  const { data, error } = await supabase.rpc('room_leaderboard', {
    p_room: roomId,
    p_board: board,
    p_iso_week: isoWeek,
  });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  return (data as LeaderboardRow[]) ?? [];
}

export async function reportUser(targetId: string, reason: string): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.rpc('report_user', { p_target: targetId, p_reason: reason });
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
}

/** Opting out and "delete all data" both call this: the server row is destroyed, not hidden. */
export async function deleteRemoteAccount(): Promise<void> {
  const supabase = requireClient();
  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw new LeaderboardError(error.message, error.code ?? 'rpc_failed');
  await supabase.auth.signOut();
}
