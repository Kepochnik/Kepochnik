import { create } from 'zustand';

import type { StatsRange } from '@/domain/taxonomy';
import { getRepositories } from '@/repositories';
import type {
  DayBucket,
  DowBucket,
  HourBucket,
  RangeBounds,
  StatsSummary,
  TagBucket,
  TagDimension,
} from '@/repositories';

interface StatsState {
  range: StatsRange;
  bounds: RangeBounds | null;
  summary: StatsSummary | null;
  byHour: HourBucket[];
  byDayOfWeek: DowBucket[];
  trend: DayBucket[];
  tagDimension: TagDimension;
  byTag: TagBucket[];
  /** The `dataVersion` this snapshot was computed from, so refreshes can be skipped. */
  computedFrom: number;

  setRange: (range: StatsRange) => void;
  setTagDimension: (dimension: TagDimension) => void;
  refresh: (dataVersion?: number) => void;
}

export const useStatsStore = create<StatsState>((set, get) => ({
  range: 7,
  bounds: null,
  summary: null,
  byHour: [],
  byDayOfWeek: [],
  trend: [],
  tagDimension: 'volume',
  byTag: [],
  computedFrom: -1,

  setRange: (range) => {
    set({ range });
    get().refresh();
  },

  setTagDimension: (dimension) => {
    const { bounds } = get();
    set({
      tagDimension: dimension,
      byTag: bounds ? getRepositories().stats.byTag(bounds, dimension) : [],
    });
  },

  refresh: (dataVersion) => {
    const { range, tagDimension, computedFrom } = get();
    if (dataVersion !== undefined && dataVersion === computedFrom) return;

    const stats = getRepositories().stats;
    const bounds = stats.boundsForRange(range);

    set({
      bounds,
      summary: stats.summary(bounds),
      byHour: stats.byHour(bounds),
      byDayOfWeek: stats.byDayOfWeek(bounds),
      trend: stats.trend(bounds),
      byTag: stats.byTag(bounds, tagDimension),
      computedFrom: dataVersion ?? computedFrom,
    });
  },
}));

export const selectHasData = (state: StatsState) => (state.summary?.total ?? 0) > 0;
