/**
 * What Pro unlocks, expressed as pure rules so gating never gets re-invented per screen.
 * The paywall is opened by a *denied capability*, never by a timer or a launch count.
 */

export const FREE_HISTORY_DAYS = 30;

export const PRO_CAPABILITIES = [
  'unlimited_history',
  'pdf_export',
  'extended_charts',
  'ad_free',
  'button_themes',
  'nickname_frame',
] as const;

export type ProCapability = (typeof PRO_CAPABILITIES)[number];

export type Tier = 'free' | 'pro';

export interface Entitlement {
  tier: Tier;
  /** Null for lifetime, epoch ms for a subscription period end. */
  expiresAt: number | null;
  source: 'none' | 'monthly' | 'lifetime' | 'promo';
}

export const FREE_ENTITLEMENT: Entitlement = { tier: 'free', expiresAt: null, source: 'none' };

export function isActive(entitlement: Entitlement, now = Date.now()): boolean {
  if (entitlement.tier !== 'pro') return false;
  return entitlement.expiresAt === null || entitlement.expiresAt > now;
}

export function can(entitlement: Entitlement, capability: ProCapability, now = Date.now()): boolean {
  return isActive(entitlement, now) && PRO_CAPABILITIES.includes(capability);
}

/** Oldest day a free user may open. Used by Diary's date picker and by Stats ranges. */
export function historyFloorDays(entitlement: Entitlement, now = Date.now()): number {
  return isActive(entitlement, now) ? Number.POSITIVE_INFINITY : FREE_HISTORY_DAYS;
}

/** Stats ranges a tier may select; the rest render locked with a paywall affordance. */
export function allowedStatsRanges(entitlement: Entitlement, now = Date.now()): number[] {
  return isActive(entitlement, now) ? [7, 30, 90] : [7, 30];
}

/** Ads exist on Diary and Stats only, and never for Pro. Track is ad-free by product rule. */
export function shouldShowAds(entitlement: Entitlement, surface: 'track' | 'diary' | 'stats' | 'profile', now = Date.now()): boolean {
  if (isActive(entitlement, now)) return false;
  return surface === 'diary' || surface === 'stats';
}
