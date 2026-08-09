import { eq } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client';
import { appMeta } from '@/db/schema';
import { FREE_ENTITLEMENT } from '@/domain/entitlements';

import type { AppSettings, SettingsRepository } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'system',
  themeMode: 'system',
  weekStartsOn: 'system',
  haptics: true,
  reminderTime: null,
  leaderboardOptIn: false,
  nickname: null,
  anonUserId: null,
  avatarSeed: null,
  buttonTheme: 'signature',
  entitlement: FREE_ENTITLEMENT,
  onboardingCompletedAt: null,
  lastWidgetDrainAt: null,
  lastProgressSubmitAt: null,
  clockTrusted: true,
  shareCardsCreated: 0,
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

/**
 * Settings live in the same SQLite file as everything else so "delete all data" is one
 * atomic operation, and so a settings write can share a transaction with a data write.
 * Values are JSON-encoded; the typed accessor is the only supported way in.
 */
export function createSettingsRepository(db: AppDatabase): SettingsRepository {
  /** In-memory mirror: settings are read on nearly every render and must never hit disk twice. */
  let cache: AppSettings | null = null;

  function load(): AppSettings {
    if (cache) return cache;
    const rows = db.select().from(appMeta).all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const next = { ...DEFAULT_SETTINGS };
    for (const key of SETTINGS_KEYS) {
      const raw = stored.get(key);
      if (raw === undefined) continue;
      try {
        (next as Record<string, unknown>)[key] = JSON.parse(raw);
      } catch {
        // A corrupted value falls back to its default rather than blocking boot.
      }
    }
    cache = next;
    return next;
  }

  function write(key: keyof AppSettings, value: unknown): void {
    const now = Date.now();
    db.insert(appMeta)
      .values({ key, value: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: now },
      })
      .run();
  }

  return {
    getAll(): AppSettings {
      return { ...load() };
    },

    get(key) {
      return load()[key];
    },

    set(key, value) {
      const current = load();
      cache = { ...current, [key]: value };
      write(key, value);
    },

    patch(values) {
      const current = load();
      cache = { ...current, ...values };
      db.transaction(() => {
        for (const [key, value] of Object.entries(values)) {
          write(key as keyof AppSettings, value);
        }
      });
    },

    reset() {
      cache = { ...DEFAULT_SETTINGS };
      db.transaction((tx) => {
        for (const key of SETTINGS_KEYS) {
          tx.delete(appMeta).where(eq(appMeta.key, key)).run();
        }
      });
    },
  };
}
