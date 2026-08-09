# Squeakly — Gas & Gut Tracker

One tap to log. Under a second. From a widget, without opening the app.

A gut-symptom tracker that works for two people at once: someone who wants a funny counter
with streaks, and someone who needs a clean summary to hand to a doctor. Everything
personal stays on the device.

- **Bundle ID** `com.kepochnik.gutlog`
- **Stack** Expo SDK 57 · React Native 0.86 · TypeScript strict · SQLite + Drizzle ·
  Zustand · expo-router · Skia / victory-native · Reanimated 4 · i18next (en / ru)
- **Server** Supabase, for opt-in anonymous leaderboards and rooms only. No health data
  ever leaves the device.

## Status

Phase 1 (architecture) is complete and committed. Phase 2 (UI, art direction, widgets)
is awaiting approval. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full
picture — local schema, server schema, repositories, state, widget sync, anti-cheat, i18n,
and the design foundations proposed for Phase 2.

**[docs/design-preview.html](docs/design-preview.html)** shows what it looks like: palette,
type specimen, the Pip mascot, all four tabs, Track states, achievements, leaderboard,
paywall, share cards, widgets and the motion spec. Self-contained — open it in a browser.

The app does not launch yet: `src/app/` (routes) lands in Phase 2.

## Working on it

```bash
npm install
cp .env.example .env          # optional — leaderboards are the only thing that needs it
npm run typecheck
npm run lint
npm run db:generate           # after editing src/db/schema.ts
```

A development build is required (SQLite, widgets and Skia are native); Expo Go will not
run this project.

```bash
npm run prebuild
npm run ios       # or: npm run android
```

## Layout

```
src/domain/        pure logic — no I/O, no React
src/repositories/  the only code that speaks SQL
src/state/         Zustand stores + boot sequence
src/services/      widget bridge, Supabase, sync
src/i18n/          bundled en + ru
supabase/          server DDL, RLS, security-definer RPCs
```

Two architecture rules are lint-enforced rather than documented: nothing above the
repository layer may import Drizzle, and no literal strings are allowed in UI code.

## Privacy

Gas events, tags, meals, symptoms, Bristol types and notes have no column on the server
and no code path that could send them. Leaderboards are opt-in, anonymous, and upload
exactly four things: a nickname, a streak length, a weekly count, and a timestamp.

Squeakly is a self-observation diary. It does not diagnose anything and is not medical
advice.
