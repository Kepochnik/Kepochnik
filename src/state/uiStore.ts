import { create } from 'zustand';

import type { ProCapability } from '@/domain/entitlements';

export interface Toast {
  id: number;
  /** i18n key, never a rendered string — toasts survive a language change. */
  messageKey: string;
  params?: Record<string, string | number>;
  tone: 'neutral' | 'success' | 'warning';
  /** Optional single action, e.g. Undo after a delete. */
  action?: { labelKey: string; onPress: () => void };
  durationMs: number;
}

interface UiState {
  toasts: Toast[];
  /** Set when a locked capability was touched; the paywall reads it for its headline. */
  paywallTrigger: ProCapability | null;
  reduceMotion: boolean;

  toast: (toast: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => number;
  dismissToast: (id: number) => void;
  openPaywall: (trigger: ProCapability) => void;
  closePaywall: () => void;
  setReduceMotion: (value: boolean) => void;
}

let toastId = 0;

export const useUiStore = create<UiState>((set) => ({
  toasts: [],
  paywallTrigger: null,
  reduceMotion: false,

  toast: (input) => {
    toastId += 1;
    const toast: Toast = { id: toastId, durationMs: 2600, ...input };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    return toast.id;
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  openPaywall: (trigger) => set({ paywallTrigger: trigger }),
  closePaywall: () => set({ paywallTrigger: null }),
  setReduceMotion: (value) => set({ reduceMotion: value }),
}));
