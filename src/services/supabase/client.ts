import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

/**
 * Supabase exists for exactly one feature: optional, anonymous leaderboards and rooms.
 *
 * The client is created lazily and only after the user has opted in, so a user who never
 * touches leaderboards never opens a session, never gets an anonymous id, and produces no
 * server-side record of any kind.
 */

interface SupabaseConfig {
  url: string;
  anonKey: string;
}

function readConfig(): SupabaseConfig | null {
  const extra = Constants.expoConfig?.extra as
    | { supabaseUrl?: string | null; supabaseAnonKey?: string | null }
    | undefined;
  const url = extra?.supabaseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = extra?.supabaseAnonKey ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

let client: SupabaseClient | null = null;

export function isLeaderboardConfigured(): boolean {
  return readConfig() !== null;
}

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const config = readConfig();
  if (!config) return null;

  client = createClient(config.url, config.anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // There is no email, no magic link and no OAuth in this product.
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-squeakly-client': 'mobile' },
    },
  });
  return client;
}

/** Called by "delete all data" and by opting out, so no session survives on the device. */
export async function destroySupabaseSession(): Promise<void> {
  await client?.auth.signOut();
  client = null;
}
