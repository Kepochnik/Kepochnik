import 'i18next';

import type en from './locales/en.json';

/**
 * Makes every `t()` call type-checked against the English resource tree: a typo in a key,
 * or a key that exists in Russian but not in English, becomes a compile error rather than
 * a string rendered raw in the UI.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof en;
    returnNull: false;
  }
}
