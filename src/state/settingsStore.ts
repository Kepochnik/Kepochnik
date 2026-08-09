import { create } from 'zustand';

import { setLocale, type LocalePreference } from '@/i18n';
import { DEFAULT_SETTINGS, getRepositories, type AppSettings } from '@/repositories';

interface SettingsState extends AppSettings {
  hydrated: boolean;
  hydrate: () => void;
  /** Write-through: SQLite first, then the store, so a crash cannot lose a preference. */
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  setLanguage: (preference: LocalePreference) => Promise<void>;
  resetToDefaults: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,

  hydrate: () => {
    set({ ...getRepositories().settings.getAll(), hydrated: true });
  },

  update: (key, value) => {
    getRepositories().settings.set(key, value);
    set({ [key]: value } as Pick<AppSettings, typeof key>);
  },

  setLanguage: async (preference) => {
    getRepositories().settings.set('locale', preference);
    set({ locale: preference });
    await setLocale(preference);
  },

  resetToDefaults: () => {
    getRepositories().settings.reset();
    set({ ...DEFAULT_SETTINGS, hydrated: true });
  },
}));

export const selectHaptics = (state: SettingsState) => state.haptics;
export const selectThemeMode = (state: SettingsState) => state.themeMode;
export const selectEntitlement = (state: SettingsState) => state.entitlement;
