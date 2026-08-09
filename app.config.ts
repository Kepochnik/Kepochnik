import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Bundle identifier is fixed by product decision and must not change:
 * it is the anchor for the iOS App Group, the Android package, StoreKit
 * products and the widget extension identifiers.
 */
export const BUNDLE_ID = 'com.kepochnik.gutlog';

/** Shared container used by the iOS widget extension to hand events to the app. */
export const IOS_APP_GROUP = `group.${BUNDLE_ID}`;

/** Deep link scheme, also used by the pre-iOS-17 widget fallback (`squeakly://log`). */
export const URL_SCHEME = 'squeakly';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Squeakly',
  slug: 'squeakly',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: URL_SCHEME,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    entitlements: {
      'com.apple.security.application-groups': [IOS_APP_GROUP],
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID,
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-localization',
    'expo-sqlite',
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '17.0' },
        android: { minSdkVersion: 26, compileSdkVersion: 36, targetSdkVersion: 36 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appGroup: IOS_APP_GROUP,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? null,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null,
  },
});
