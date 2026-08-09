import { create } from 'zustand';

import type { BristolType, MealTrigger, SymptomLevel } from '@/domain/taxonomy';
import { todayLocalDay, type LocalDay } from '@/domain/time';
import { getRepositories, type DiaryDay, type MealInput } from '@/repositories';

/** Free-text fields persist on a debounce so typing never hits the disk per keystroke. */
export const NOTE_DEBOUNCE_MS = 600;

interface DiaryState {
  selectedDay: LocalDay;
  day: DiaryDay | null;
  /** Local echo of the note field while the debounce is pending. */
  noteDraft: string;
  dataVersion: number;

  selectDay: (day: LocalDay) => void;
  reload: () => void;
  addMeal: (input: MealInput) => void;
  updateMeal: (id: string, input: Partial<MealInput>) => void;
  deleteMeal: (id: string) => void;
  toggleTrigger: (mealId: string, trigger: MealTrigger) => void;
  setSymptom: (field: 'bloating' | 'pain', value: SymptomLevel | null) => void;
  setNoteDraft: (value: string) => void;
  commitNote: () => void;
  addBristol: (type: BristolType, occurredAt?: number) => void;
  deleteBristol: (id: string) => void;
}

export const useDiaryStore = create<DiaryState>((set, get) => ({
  selectedDay: todayLocalDay(),
  day: null,
  noteDraft: '',
  dataVersion: 0,

  selectDay: (day) => {
    const loaded = getRepositories().diary.getDay(day);
    set({ selectedDay: day, day: loaded, noteDraft: loaded.log?.note ?? '' });
  },

  reload: () => {
    const { selectedDay } = get();
    const loaded = getRepositories().diary.getDay(selectedDay);
    set((state) => ({ day: loaded, dataVersion: state.dataVersion + 1 }));
  },

  addMeal: (input) => {
    getRepositories().diary.addMeal(input);
    get().reload();
  },

  updateMeal: (id, input) => {
    getRepositories().diary.updateMeal(id, input);
    get().reload();
  },

  deleteMeal: (id) => {
    getRepositories().diary.deleteMeal(id);
    get().reload();
  },

  toggleTrigger: (mealId, trigger) => {
    const meal = get().day?.meals.find((item) => item.id === mealId);
    if (!meal) return;
    const triggers = meal.triggers.includes(trigger)
      ? meal.triggers.filter((item) => item !== trigger)
      : [...meal.triggers, trigger];
    getRepositories().diary.updateMeal(mealId, { triggers });
    get().reload();
  },

  setSymptom: (field, value) => {
    const { selectedDay } = get();
    getRepositories().diary.upsertDailyLog(selectedDay, { [field]: value });
    get().reload();
  },

  setNoteDraft: (value) => set({ noteDraft: value }),

  commitNote: () => {
    const { selectedDay, noteDraft, day } = get();
    if ((day?.log?.note ?? '') === noteDraft) return;
    getRepositories().diary.upsertDailyLog(selectedDay, { note: noteDraft });
    get().reload();
  },

  addBristol: (type, occurredAt) => {
    getRepositories().diary.addBristol(occurredAt ?? Date.now(), type);
    get().reload();
  },

  deleteBristol: (id) => {
    getRepositories().diary.deleteBristol(id);
    get().reload();
  },
}));
