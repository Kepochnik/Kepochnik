import type { AchievementProgress, AchievementSnapshot } from '@/domain/achievements';
import type { Entitlement } from '@/domain/entitlements';
import type { ProgressPayload } from '@/domain/scoring';
import type {
  BristolType,
  EventSource,
  GasContext,
  GasSmell,
  GasVolume,
  MealTrigger,
  StatsRange,
  SymptomLevel,
} from '@/domain/taxonomy';
import type { LocalDay } from '@/domain/time';

/* ----------------------------------------------------------------- models */

export interface GasEvent {
  id: string;
  occurredAt: number;
  localDay: LocalDay;
  localHour: number;
  localDow: number;
  source: EventSource;
  volume: GasVolume | null;
  smell: GasSmell | null;
  context: GasContext | null;
  note: string | null;
  suspect: boolean;
}

export interface Meal {
  id: string;
  occurredAt: number;
  localDay: LocalDay;
  title: string;
  note: string | null;
  triggers: MealTrigger[];
}

export interface DailyLog {
  localDay: LocalDay;
  bloating: SymptomLevel | null;
  pain: SymptomLevel | null;
  note: string | null;
}

export interface BristolEntry {
  id: string;
  occurredAt: number;
  localDay: LocalDay;
  type: BristolType;
}

export interface DiaryDay {
  localDay: LocalDay;
  meals: Meal[];
  bristol: BristolEntry[];
  log: DailyLog | null;
}

/* ------------------------------------------------------------ event repo */

export interface LogEventInput {
  occurredAt?: number;
  source?: EventSource;
  tzOffset?: number;
  volume?: GasVolume | null;
  smell?: GasSmell | null;
  context?: GasContext | null;
  note?: string | null;
  suspect?: boolean;
}

/** Shape handed over by the widget drain. Ids are minted natively and must be preserved. */
export interface ImportedEvent {
  id: string;
  occurredAt: number;
  tzOffset: number;
  source: EventSource;
}

export interface EventTagPatch {
  volume?: GasVolume | null;
  smell?: GasSmell | null;
  context?: GasContext | null;
  note?: string | null;
}

/**
 * Reads and writes are synchronous on purpose. The one-tap promise is measured in
 * frames: `log()` must complete inside the same frame as the touch so the counter and
 * the haptic never lag behind the finger. expo-sqlite's sync API makes that possible;
 * the interface hides it so a future async driver only changes this file's implementation.
 */
export interface EventRepository {
  log(input?: LogEventInput): GasEvent;
  /** Idempotent bulk insert used by the widget drain. Returns how many rows were new. */
  importMany(events: readonly ImportedEvent[]): number;
  listForDay(day: LocalDay): GasEvent[];
  listRange(from: LocalDay, to: LocalDay): GasEvent[];
  countForDay(day: LocalDay): number;
  /** Newest-first timestamps used by burst detection. */
  recentTimes(limit: number): number[];
  /** Latest `occurredAt` ever stored, used to detect a rewound device clock. */
  highWaterMark(): number | null;
  activeDays(from?: LocalDay): LocalDay[];
  updateTags(id: string, patch: EventTagPatch): void;
  softDelete(id: string): void;
  restore(id: string): void;
  purgeDeletedBefore(timestamp: number): number;
}

/* ------------------------------------------------------------ diary repo */

export interface MealInput {
  occurredAt: number;
  title: string;
  note?: string | null;
  triggers: readonly MealTrigger[];
}

export interface DiaryRepository {
  getDay(day: LocalDay): DiaryDay;
  addMeal(input: MealInput): Meal;
  updateMeal(id: string, input: Partial<MealInput>): void;
  deleteMeal(id: string): void;
  upsertDailyLog(day: LocalDay, patch: Partial<Omit<DailyLog, 'localDay'>>): DailyLog;
  addBristol(occurredAt: number, type: BristolType): BristolEntry;
  deleteBristol(id: string): void;
  /** Days in range that have any diary content, for the calendar strip. */
  daysWithContent(from: LocalDay, to: LocalDay): LocalDay[];
}

/* ------------------------------------------------------------ stats repo */

export interface RangeBounds {
  from: LocalDay;
  to: LocalDay;
}

export interface StatsSummary {
  total: number;
  daysCovered: number;
  daysWithEvents: number;
  averagePerDay: number;
  averagePerActiveDay: number;
  busiestHour: number | null;
  busiestDow: number | null;
  /** Change against the immediately preceding window of equal length, as a ratio. */
  deltaVsPreviousWindow: number | null;
}

export interface HourBucket {
  hour: number;
  count: number;
}

export interface DowBucket {
  dow: number;
  count: number;
}

export interface DayBucket {
  localDay: LocalDay;
  count: number;
}

export interface TagBucket {
  value: string | null;
  count: number;
}

export type TagDimension = 'volume' | 'smell' | 'context';

export interface DoctorReportData extends RangeBounds {
  eventCount: number;
  eventsPerDay: number;
  averageBloating: number | null;
  averagePain: number | null;
  bristolCounts: Record<number, number>;
  bristolTotal: number;
  meals: Meal[];
  dailyLogs: DailyLog[];
  dailyCounts: DayBucket[];
}

export interface CsvExport {
  filename: string;
  content: string;
}

export interface StatsRepository {
  summary(bounds: RangeBounds): StatsSummary;
  byHour(bounds: RangeBounds): HourBucket[];
  byDayOfWeek(bounds: RangeBounds): DowBucket[];
  trend(bounds: RangeBounds): DayBucket[];
  byTag(bounds: RangeBounds, dimension: TagDimension): TagBucket[];
  boundsForRange(range: StatsRange): RangeBounds;
  achievementSnapshot(): AchievementSnapshot;
  doctorReport(bounds: RangeBounds): DoctorReportData;
  /** Non-suspect daily counts for the current ISO week — the only numbers that may sync. */
  weeklyCounts(days: readonly LocalDay[]): { localDay: LocalDay; count: number }[];
  lastNonSuspectEventAt(): number | null;
  buildCsv(bounds: RangeBounds): CsvExport;
}

/* ----------------------------------------------------- achievements repo */

export interface AchievementRepository {
  all(): AchievementProgress[];
  save(progress: readonly AchievementProgress[]): void;
  markRevealed(keys: readonly string[]): void;
}

/* --------------------------------------------------------- settings repo */

export interface AppSettings {
  /** 'system' follows the device; explicit values survive a device language change. */
  locale: 'system' | 'en' | 'ru';
  themeMode: 'system' | 'light' | 'dark';
  weekStartsOn: 'system' | 'mon' | 'sun';
  haptics: boolean;
  /** 'HH:mm' local time, or null when reminders are off. */
  reminderTime: string | null;
  leaderboardOptIn: boolean;
  nickname: string | null;
  anonUserId: string | null;
  avatarSeed: string | null;
  buttonTheme: string;
  entitlement: Entitlement;
  onboardingCompletedAt: number | null;
  lastWidgetDrainAt: number | null;
  lastProgressSubmitAt: number | null;
  clockTrusted: boolean;
  shareCardsCreated: number;
}

export interface SettingsRepository {
  getAll(): AppSettings;
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  patch(values: Partial<AppSettings>): void;
  reset(): void;
}

/* ----------------------------------------------------------- outbox repo */

export type OutboxKind = 'progress' | 'nickname' | 'opt_out';

export interface OutboxItem {
  id: number;
  kind: OutboxKind;
  payload: ProgressPayload | { nickname: string } | Record<string, never>;
  attempts: number;
  nextAttemptAt: number;
}

export interface OutboxRepository {
  enqueue(kind: OutboxKind, payload: OutboxItem['payload']): void;
  /** At most one pending item per kind; a newer progress payload replaces the older one. */
  due(now: number): OutboxItem[];
  markFailed(id: number, error: string, now: number): void;
  remove(id: number): void;
  clear(): void;
}

/* -------------------------------------------------------------- container */

export interface Repositories {
  events: EventRepository;
  diary: DiaryRepository;
  stats: StatsRepository;
  achievements: AchievementRepository;
  settings: SettingsRepository;
  outbox: OutboxRepository;
}
