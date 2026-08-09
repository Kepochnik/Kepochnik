# Squeakly — Phase 1 Architecture

Bundle ID `com.kepochnik.gutlog` · Expo SDK 57 · React Native 0.86 · TypeScript strict

This document is the Phase 1 deliverable: the eight foundations you asked to see before
any UI is built. Everything described here is committed and verified — `tsc --noEmit` and
`eslint` are clean, the Drizzle migration is generated from the real schema, and the pure
domain logic (timezones, streaks, ISO weeks, integrity, scoring, achievements) passes a
direct behavioural check including DST boundaries and the 2026-W53 rollover.

**No screens, components, navigation or art direction have been implemented.** That is
Phase 2, and it waits for your approval.

---

## 0. What exists right now

```
app.config.ts              bundle id, App Group entitlement, deep-link scheme
drizzle.config.ts          expo driver, migrations output
drizzle/0000_init.sql      generated — the real DDL, 8 tables, 11 indexes
metro.config.js            .sql inlining for the migration bundle
babel.config.js            inline-import + worklets plugin
eslint.config.js           two enforced architecture rules (see §4 and §8)
supabase/migrations/       full server schema, RLS, and 8 security-definer RPCs
src/db/                    schema + client
src/domain/                pure logic, zero I/O, zero React
src/repositories/          the only code that speaks SQL
src/state/                 Zustand stores + boot sequence
src/services/              widget bridge, Supabase, sync
src/i18n/                  i18next setup, en + ru resources
```

Deliberately absent: `src/app/` (expo-router routes), `src/ui/`, `src/features/`,
`modules/widget/` native sources. The project therefore does not launch yet — that is
the honest state of an architecture phase, not an oversight.

---

## 1. Local SQLite schema

Source: `src/db/schema.ts` → generated DDL in `drizzle/0000_init.sql`.

| Table | Purpose |
|---|---|
| `gas_events` | The counter. One row per tap. |
| `meals` + `meal_triggers` | Diary meals and their trigger chips (join table). |
| `daily_logs` | One row per local day: bloating, pain, free note. |
| `bristol_entries` | Bristol as *events*, not a daily value. |
| `achievements` | Progress only; the catalog itself is code. |
| `app_meta` | Typed key/value: settings, identity, sync cursors. |
| `leaderboard_outbox` | Durable queue for the only data allowed to leave the device. |

### The four decisions that matter

**Client-minted UUID primary keys.** Not autoincrement. This is what makes the widget
work: the widget mints an id while the app is dead, and the app later inserts with
`on conflict do nothing`. A queue that is drained twice, or half-drained before a crash,
produces exactly the same database either way.

**Denormalised local time.** Every row that is ever grouped by day also stores
`local_day` (`YYYY-MM-DD`), `local_hour` (0–23), `local_dow` (0=Sun) and `tz_offset`
(minutes ahead of UTC), computed at write time from the offset in effect *at that moment*.

Three things follow. A 2am event stays "last night" forever, even after the user flies to
Tokyo. "By hour of day" and "by day of week" become a single indexed `GROUP BY` with no
date arithmetic in SQL. And the widget only has to record two numbers — an epoch and an
offset — because `deriveLocalFields()` derives the rest at drain time (`src/domain/time.ts`).

**Soft delete, then purge.** Swipe-to-delete sets `deleted_at`, so Undo survives an app
kill. Rows are hard-purged after 30 days at boot. "Delete all data" is different: it drops
the database *file*, so no WAL pages survive, then recreates an empty schema.

**Suspect flag, not suppression.** `gas_events.suspect` marks an event that failed a local
integrity check. It is still saved, still shown on Track, still counted in Stats, still in
the PDF. It is excluded from exactly one thing: the aggregate that may be uploaded. Your
own data is never censored to protect a leaderboard.

Indexes: `local_day`, `occurred_at`, and composites on `(deleted_at, occurred_at)`,
`(deleted_at, local_hour)`, `(deleted_at, local_dow)` — one per chart.

---

## 2. Supabase schema

Source: `supabase/migrations/20260809120000_init.sql`.

```
profiles          id (= auth.users), nickname, is_pro, device_hash, banned_at, report_count
streak_stats      user_id, streak_days, best_streak, last_event_at, clamped
weekly_scores     user_id, iso_week, score, clamped
rooms             id, code(6), name, owner_id, member_limit
room_members      room_id, user_id
reports           reporter_id, target_id, reason
nickname_blocklist  pattern
submission_log    user_id, submitted_at, accepted, reason
```

**There is no column anywhere for an event, a tag, a meal, a symptom, a Bristol type or a
note.** The privacy promise is enforced by absence, not by policy.

RLS is enabled on every table with **no** direct read or write path. The single exception
is `profiles select where id = auth.uid()`. Everything else goes through eight
`security definer` RPCs:

`set_nickname` · `submit_progress` · `leaderboard_page` · `create_room` · `join_room` ·
`room_leaderboard` · `report_user` · `delete_my_account`

That shape is what lets the server be the sole authority on scores while still serving a
public top-100 — the client can call `leaderboard_page` but cannot `select * from
weekly_scores`.

Notes worth flagging:

- `is_pro` has **no client write path**. It is set by a purchase webhook (Phase 2), so a
  patched app cannot award itself the Pro leaderboard frame.
- A profile is created by a trigger on `auth.users`, so it exists only once someone opts
  in and an anonymous session is created — never before.
- `nickname_blocklist` ships with impersonation guards (`^squeakly`, `admin|moderator`).
  The profanity corpus is loaded from a private seed so this repo carries no slur list.
- Ten reports auto-hide a profile pending review. Reversible, visibility-only.
- `delete_my_account` deletes the profile row (cascading everything) and attempts the
  `auth.users` row, degrading gracefully if privileges don't allow it.

---

## 3. Folder structure

```
squeakly/
├── app.config.ts drizzle.config.ts metro.config.js babel.config.js eslint.config.js
├── drizzle/                    generated migrations + journal
├── supabase/migrations/        server DDL, RLS, RPCs
├── modules/widget/             ⟵ P2  Expo module: WidgetKit (Swift) + Glance (Kotlin)
├── assets/fonts, assets/doodles          ⟵ P2
└── src/
    ├── app/                    ⟵ P2  expo-router routes only, no logic
    │   ├── (tabs)/ index·diary·stats·profile
    │   ├── onboarding/  achievements  leaderboard  rooms/[code]
    │   ├── paywall  settings/  share/
    │   └── _layout.tsx         boot gate + providers
    ├── ui/                     ⟵ P2  design system: tokens, primitives, motion, doodles, Pip
    ├── features/               ⟵ P2  screen-level composition (track, diary, stats, …)
    ├── domain/          ✅ pure logic — no I/O, no React, no imports from above
    │   ├── taxonomy · time · ids · streak · scoring · integrity
    │   └── entitlements · achievements
    ├── repositories/    ✅ the only code that speaks SQL
    ├── state/           ✅ Zustand stores + bootstrap
    ├── db/              ✅ drizzle schema + client
    ├── services/        ✅ widget bridge, supabase, sync   (⟵ P2: pdf, csv, share-card, ads, purchases, notifications)
    └── i18n/            ✅ i18next + en/ru resources
```

Dependencies point one way: `app → features → ui → state → repositories → db`, with
`domain` importable by anyone and importing nobody. Two of these are lint-enforced rather
than documented (§4, §8).

---

## 4. Repository layer

`src/repositories/types.ts` declares six interfaces; `index.ts` assembles them into a
`Repositories` container built from an injected `AppDatabase`, which makes every store
testable against an in-memory database.

| Repository | Responsibility |
|---|---|
| `EventRepository` | log, import (widget), list, count, soft-delete/restore, purge |
| `DiaryRepository` | meals + triggers, daily log upsert, Bristol entries |
| `StatsRepository` | all aggregates, achievement snapshot, doctor report, CSV |
| `AchievementRepository` | progress persistence and reveal bookkeeping |
| `SettingsRepository` | typed `AppSettings` over `app_meta`, with a memory mirror |
| `OutboxRepository` | durable queue with exponential backoff (5s → 10min ceiling) |

**Enforced rule.** `eslint.config.js` bans importing `drizzle-orm` or `@/db/*` anywhere
outside `src/repositories` and `src/db` (plus `state/bootstrap.ts`, which opens the file).
The seam is a build error, not a code-review convention.

**Reads and writes are synchronous, on purpose.** The one-tap promise is measured in
frames, not milliseconds: `events.log()` must complete inside the same frame as the touch
so the counter and the haptic never trail the finger. expo-sqlite's sync API allows that.
The interface hides it, so swapping in an async driver later changes only these files.

`StatsRepository.achievementSnapshot()` computes all 22 metrics in **one** aggregate pass
plus two `max` sub-selects, so re-evaluating 24 achievements after a write is cheap enough
to do on a debounce.

---

## 5. State management (Zustand)

Seven stores, each with one job:

| Store | Holds |
|---|---|
| `eventStore` | today's events, count, streak, weekly average, tag-panel target, `dataVersion` |
| `diaryStore` | selected day, its meals/symptoms/Bristol, debounced note draft |
| `statsStore` | range, bounds, and the five computed chart datasets |
| `settingsStore` | mirror of `AppSettings`, write-through to SQLite |
| `profileStore` | achievement progress, unlock count, reveal queue |
| `leaderboardStore` | board, rows, self row, network status |
| `uiStore` | toasts (by i18n key, never rendered strings), paywall trigger, reduce-motion |

**One counter is the entire invalidation strategy.** Every mutation bumps
`eventStore.dataVersion`. A single subscription in `bootstrap.ts` fans that out: Stats
recomputes immediately, and on an 800ms debounce the achievements re-evaluate, the widget
snapshot republishes, and progress is queued for the leaderboard. No screen ever has to
remember to refresh another screen.

**The tap path is deliberately three-tiered.** Synchronous: integrity check, SQLite
insert, counter increment — same frame. Microtask: streak and weekly average, which need
extra queries. Debounced 800ms: achievements, widget snapshot, network. The user sees the
number move instantly; everything else settles behind them.

Boot order (`bootstrap()`): open DB → migrate → hydrate settings → init i18n → hydrate
event/diary/profile/stats → wire reactions → **first paint** → then, deferred: drain the
widget queue, purge old soft-deletes, recompute achievements, flush the outbox.

---

## 6. Widget sync flow

Contract: `src/services/widget/protocol.ts`. Bridge: `bridge.ts`. Drain: `sync.ts`.

Two files in a shared location, both dumb on purpose:

- **`pending-events.jsonl`** — append-only queue. One line per tap:
  `{"v":1,"id":"<uuid>","at":1754745600000,"tz":180,"src":"widget"}`
- **`snapshot.json`** — what the widget renders between drains: today's count, streak,
  weekly average, locale, and the day the counts belong to (so a stale snapshot renders
  as zero after midnight instead of lying).

| | iOS | Android |
|---|---|---|
| Location | App Group `group.com.kepochnik.gutlog` | `filesDir/squeakly/` |
| Trigger | WidgetKit + `AppIntent` (iOS 17+) | Glance `ActionCallback` |
| Why | Extension is a separate process; needs the shared container | Glance runs in the app's process |

The App Group entitlement is already declared in `app.config.ts`.

### Why an event can't be lost

The drain is deliberately three phases:

1. `readPending()` returns the bytes **and a cursor** — non-destructive.
2. Insert inside one transaction, `on conflict do nothing`.
3. `acknowledgePending(cursor)` truncates *exactly* what was read, preserving anything the
   widget appended in the meantime.

A crash before step 3 replays steps 1–2, which insert nothing new because ids are stable.
At-least-once delivery plus idempotent insert equals exactly-once. Malformed lines from a
half-finished write are counted and dropped rather than blocking the queue forever.

Drain runs on launch and on every foreground. `requireOptionalNativeModule` means the app
degrades to a no-op — never a crash — when the extension isn't installed.

Pre-iOS-17 fallback: the widget deep-links `squeakly://log`, which logs and returns.

---

## 7. Anti-cheat flow

Three layers, sharing one set of constants (`src/domain/scoring.ts` ↔ the SQL function).

**Layer 1 — local, `domain/integrity.ts`.**
Writes closer than 350ms are one physical tap and are dropped entirely. Beyond 12 events
in a rolling 60s window, or a device clock that jumped backwards more than a minute, or an
event more than 10 minutes in the future → saved and shown, flagged `suspect`, excluded
from the uploaded score.

**Layer 2 — the payload itself.** `buildProgressPayload()` in `services/sync` is the whole
privacy contract in one function: an ISO week string, a capped count, a streak length, a
timestamp. There is no code path that can add anything else to that object.

**Layer 3 — server, `submit_progress`.** The client's number is a *claim*; Postgres
independently derives the maximum plausible value and takes the smaller:

- weekly cap 700 (daily cap 100 × 7)
- score may rise by at most `ceil(minutes × 2) + 40` since the last accepted submission —
  and may fall freely, because deleting events is legitimate
- streak may grow by at most one per elapsed calendar day, hard cap 3650
- one accepted submission per 60s; the rest are logged and rejected
- `last_event_at` more than 5 minutes in the future is rejected
- the ISO week must be the current or previous one

Over-claims are **clamped, not rejected** (`clamped = true`). This removes the incentive to
cheat without punishing someone whose phone was in a drawer for a week.

**Clock trust.** Every submission returns the server clock. If the device disagrees by more
than 10 minutes, `clockTrusted` flips false and uploads pause. Local tracking is untouched.

**Multi-accounting.** `profiles.device_hash` (a salted device hash) makes farming accounts
cost real devices rather than reinstalls.

**Moderation.** Report button per row → `report_user`, unique per reporter/target, with a
10-report auto-hide pending review.

---

## 8. i18n

`i18next` + `react-i18next`, English default, Russian second, both **bundled** — never
fetched, because the app must be fully usable in airplane mode and a late-arriving
translation would flash untranslated UI on first paint.

- One file per language (`locales/en.json`, `ru.json`), top-level keys are the 13
  namespaces: `common · onboarding · track · diary · stats · profile · achievements ·
  leaderboard · paywall · settings · share · report · errors`.
- **Type-safe keys.** `i18next.d.ts` binds `CustomTypeOptions.resources` to the English
  tree, so a typo or a Russian-only key is a compile error, not a raw string in the UI.
- **Russian plurals are real.** `intl-pluralrules` is polyfilled because Hermes/Android
  can't be relied on for it, and counters carry `_one/_few/_many/_other` — «1 запись»,
  «3 записи», «7 записей».
- **No hardcoded strings, enforced.** `eslint-plugin-i18next` runs against
  `src/app`, `src/features`, `src/ui`.
- Numbers and percentages go through `formatNumber` / `formatPercent` so a Russian build
  never renders `1,234` where it means `1 234`.
- Microcopy variety uses `pickVariant(count, seed)` — seeded by event id so a line stays
  stable across re-renders instead of flickering every frame.
- Toasts are stored as i18n keys, so they re-render correctly if the language changes.
- Humour is **written per language, not translated**: the Russian achievement titles are
  their own jokes («Надбавка за вредность», «Карманный учёный»), not literal renderings.

The doctor-facing `report` namespace is deliberately humour-free in both languages, and
both carry the disclaimer verbatim.

---

## 9. The privacy contract, in one table

| Data | Device | Server |
|---|---|---|
| Gas events, tags, notes | ✅ | ❌ no column exists |
| Meals, triggers | ✅ | ❌ |
| Bloating, pain, Bristol, daily notes | ✅ | ❌ |
| Achievements, settings | ✅ | ❌ |
| Nickname | ✅ | ✅ only after opt-in |
| Streak length, weekly count, last-event timestamp | ✅ | ✅ only after opt-in |

No registration. No account required. Leaderboards are opt-in, anonymous-auth only, and
opting out deletes the server row rather than hiding it.

---

## 10. Design foundations proposed for Phase 2

Locking these alongside the architecture saves a round trip. Nothing here is implemented yet.

**Accent — deep muted teal, not mustard.** `#1F6F6B`, pressed `#175451`, tint `#DCE9E6`.
It reads modern and ownable, sits calmly on cream, and stays credible on a page a doctor
might see. Chart supports, restrained: muted terracotta `#C2673F`, smoky olive `#7C8B5C`,
dusty blue `#5B7C99`.

**Paper.** Base `#F6F1E8`, alt `#EFE8DC`, raised `#FBF8F2` — the tonal shift is what
differentiates Track from Diary from Stats without four different themes. Ink `#171512`
(warm, not pure black), secondary `#5A544B`, hairline `#DFD6C6`.
Dark: `#131211` / `#1A1917` / `#201E1B`, ink `#F2ECE1`, accent lifted to `#4FA8A0`.
States: success `#3F7D58`, warning `#B8862F`, error `#B4453A`.

**Type — Onest** (OFL), *not* Satoshi. Satoshi ships no Cyrillic, which disqualifies it as
the single family for an app whose second language is Russian — a mixed-font fallback
would break the type system on exactly the screens we care about. Onest is the same
contemporary, slightly warm grotesk with first-class Cyrillic and strong numerals.
Hero counter at 72pt Bold, tracking −5%.
One engineering note: rather than depending on the font shipping `tnum`, the hero counter
renders **one fixed-width column per digit** — which is also what makes the odometer roll
animation possible. Scale: 72 / 40 / 28 / 20 / 17 / 15 / 13.

**Motion.** 150–250ms ease-out throughout. Hero tap fires haptics and the count in the
same frame; the celebration variant is chosen from a pool of six (ripple ring, counter pop,
doodle burst, wobble outline, halo pulse, spark strokes) seeded by event id so it varies
without ever repeating twice in a row. `uiStore.reduceMotion` mirrors the OS setting.

**Pip** appears in five places only: onboarding, empty states, achievement unlocks, streak
milestones, share cards. Nowhere else. Product-first, not mascot-first.

---

## 11. Deviations you should know about

1. **Reanimated 4.5, not 3.** Expo SDK 57 ships Reanimated 4 and won't build with 3. The
   API we need is a superset. No action needed, just flagging it against your brief.
2. **victory-native 41 is the "XL" line** — Skia-rendered, not the old SVG version. Skia is
   installed and will also render share cards offscreen at 1080×1350, so no
   `react-native-view-shot` and no extra dependency.
3. **Ads and purchases are not yet wired.** `domain/entitlements.ts` defines the gates
   (`shouldShowAds`, `allowedStatsRanges`, `historyFloorDays`), but AdMob and RevenueCat
   need real account IDs at native-build time. Adding them before those IDs exist would
   break `expo prebuild`. Phase 2, once you provide them.
4. **`expo install` couldn't reach `api.expo.dev`** from this environment (network policy),
   so versions were pinned from npm directly. Every `expo-*` package is on the 57.x line
   matching the SDK.
5. **The Pro leaderboard frame needs a purchase webhook** to set `profiles.is_pro`, since
   there is deliberately no client write path for it.
6. **Satoshi is out, Onest is in** — see §10. Found while building the visual preview:
   Satoshi has no Cyrillic at all.

## Visual preview

`docs/design-preview.html` renders the whole thing — palette, type specimen, Pip, all four
tabs, Track states (post-tap, empty, dark, Russian), achievements, leaderboard, paywall,
share cards, widgets and the motion spec. Open it in any browser; it is fully self-contained.

## 12. What I need from you to start Phase 2

- ✅ or changes to the accent/palette and Onest (§10, and the preview)
- AdMob unit IDs + RevenueCat key, or a "defer ads to v1.1" decision
- Supabase project URL + anon key, or "build leaderboards against a local stack for now"

On approval, Phase 2 order: design tokens and primitives → floating pill tab bar → Track
(hero button, counter, tag panel, motion) → Diary → Stats and charts → Profile,
achievements, leaderboard → share cards, PDF, paywall → widgets (Swift + Kotlin).
