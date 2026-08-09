import { requireOptionalNativeModule } from 'expo-modules-core';

import type { WidgetSnapshot } from './protocol';

/**
 * Native surface implemented by the `SqueaklyWidget` Expo module (WidgetKit on iOS,
 * Glance on Android). The module is optional at runtime: in Expo Go, on the simulator
 * before a rebuild, or on a device where the extension failed to install, every call
 * degrades to a no-op instead of crashing the app on launch.
 */
export interface SqueaklyWidgetNativeModule {
  /**
   * Reads the pending queue *without* clearing it and returns a cursor describing how
   * much was read. The two-phase read is what makes the drain crash-safe: if the app
   * dies between reading and acknowledging, the same events are simply read again and
   * deduplicated by id on insert.
   */
  readPending(): Promise<{ raw: string; cursor: number }>;
  /** Removes exactly the bytes covered by `cursor`, keeping anything appended since. */
  acknowledgePending(cursor: number): Promise<void>;
  /** Publishes what the widget should render and reloads its timelines. */
  writeSnapshot(snapshot: WidgetSnapshot): Promise<void>;
  /** Wipes queue and snapshot — part of "delete all data". */
  clearAll(): Promise<void>;
  /** True when at least one Squeakly widget is on a home screen. */
  isWidgetInstalled(): Promise<boolean>;
}

const native = requireOptionalNativeModule<SqueaklyWidgetNativeModule>('SqueaklyWidget');

export const isWidgetBridgeAvailable = native !== null;

export function getWidgetBridge(): SqueaklyWidgetNativeModule | null {
  return native;
}
