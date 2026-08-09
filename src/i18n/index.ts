// Intl.PluralRules is not guaranteed on every Hermes/Android build, and Russian needs
// one/few/many/other to be correct. The polyfill is a no-op where the engine has it.
import 'intl-pluralrules';

import { getLocales } from 'expo-localization';
import i18next, {
  changeLanguage,
  use as registerI18nextPlugin,
  type i18n as I18nInstance,
} from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ru from './locales/ru.json';

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = 'system' | AppLocale;

export const DEFAULT_LOCALE: AppLocale = 'en';
export const DEFAULT_NS = 'common';

/**
 * Resources are bundled, never fetched: the app must be fully usable in airplane mode,
 * and a translation file arriving late would flash untranslated UI on first paint.
 */
export const resources = { en, ru } as const;

export function resolveLocale(preference: LocalePreference): AppLocale {
  if (preference !== 'system') return preference;
  for (const locale of getLocales()) {
    const code = locale.languageCode?.toLowerCase();
    if (code && (SUPPORTED_LOCALES as readonly string[]).includes(code)) {
      return code as AppLocale;
    }
  }
  return DEFAULT_LOCALE;
}

let initialized = false;

export async function initI18n(preference: LocalePreference = 'system'): Promise<I18nInstance> {
  const lng = resolveLocale(preference);

  if (initialized) {
    if (i18next.language !== lng) await changeLanguage(lng);
    return i18next;
  }

  await registerI18nextPlugin(initReactI18next).init({
    resources,
    lng,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    defaultNS: DEFAULT_NS,
    ns: Object.keys(en),
    returnNull: false,
    interpolation: { escapeValue: false },
    // A missing key must be loud in development and invisible in production.
    saveMissing: __DEV__,
    missingKeyHandler: __DEV__
      ? (languages, namespace, key) => {
          console.warn(`[i18n] missing key ${namespace}:${key} for ${languages.join(',')}`);
        }
      : undefined,
  });

  initialized = true;
  return i18next;
}

export async function setLocale(preference: LocalePreference): Promise<AppLocale> {
  const lng = resolveLocale(preference);
  await changeLanguage(lng);
  return lng;
}

export function currentLocale(): AppLocale {
  const language = i18next.language?.split('-')[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(language)
    ? (language as AppLocale)
    : DEFAULT_LOCALE;
}

/**
 * Locale-aware number formatting. Charts, counters and the PDF all go through this so a
 * Russian build never shows "1,234" where it means "1 234".
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value);
}

export function formatPercent(ratio: number, digits = 0): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(ratio);
}

/**
 * Deterministically picks one microcopy variant. Passing a seed (an event id, a day)
 * keeps the same line stable across re-renders instead of flickering on every frame.
 */
export function pickVariant(count: number, seed?: number): number {
  if (count <= 0) return 0;
  const base = seed ?? Math.floor(Math.random() * count);
  return Math.abs(base) % count;
}

export default i18next;
