-- Squeakly — leaderboards and rooms.
--
-- SCOPE, STATED ONCE AND ENFORCED EVERYWHERE BELOW:
-- this database stores a nickname, a streak length, a weekly count and a timestamp.
-- It never stores gas events, tags, meals, symptoms, bloating, pain, Bristol types or
-- notes. There is no column for them and no function that accepts them.
--
-- Every table is RLS-enabled with no direct read or write path. Clients only reach data
-- through the `security definer` functions at the bottom of this file, which is what
-- allows the server to be the sole authority on scores while still serving a public
-- top-100.

set check_function_bodies = off;

-- ---------------------------------------------------------------- tables ----

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  nickname      text not null,
  -- Set only by a server-side purchase webhook. There is intentionally no client
  -- write path, so the Pro leaderboard frame cannot be granted by a patched app.
  is_pro        boolean not null default false,
  -- Salted hash of a device identifier, used to make multi-accounting expensive.
  device_hash   text,
  banned_at     timestamptz,
  report_count  integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists profiles_nickname_key on public.profiles (lower(nickname));
create index if not exists profiles_device_hash_idx on public.profiles (device_hash);

create table if not exists public.streak_stats (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  streak_days   integer not null default 0 check (streak_days between 0 and 3650),
  best_streak   integer not null default 0 check (best_streak between 0 and 3650),
  last_event_at timestamptz,
  clamped       boolean not null default false,
  updated_at    timestamptz not null default now()
);

create index if not exists streak_stats_rank_idx
  on public.streak_stats (streak_days desc, updated_at asc);

create table if not exists public.weekly_scores (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  -- ISO week key, e.g. '2026-W32'. Matches `isoWeekKey()` on the client exactly.
  iso_week   text not null,
  score      integer not null default 0 check (score between 0 and 700),
  clamped    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, iso_week)
);

create index if not exists weekly_scores_rank_idx
  on public.weekly_scores (iso_week, score desc, updated_at asc);

create table if not exists public.rooms (
  id           uuid primary key default gen_random_uuid(),
  code         char(6) not null unique,
  name         text not null check (char_length(btrim(name)) between 1 and 40),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  member_limit integer not null default 20 check (member_limit between 2 and 20),
  created_at   timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id   uuid not null references public.rooms (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles (id) on delete set null,
  target_id   uuid not null references public.profiles (id) on delete cascade,
  reason      text not null check (reason in ('offensive_nickname', 'impersonation', 'spam', 'other')),
  created_at  timestamptz not null default now(),
  unique (reporter_id, target_id)
);

-- Regex patterns matched case-insensitively against candidate nicknames.
-- The impersonation guards are seeded here; the profanity corpus is loaded separately
-- from a private seed so this repository stays free of slur lists.
create table if not exists public.nickname_blocklist (
  pattern text primary key,
  note    text
);

insert into public.nickname_blocklist (pattern, note) values
  ('^squeakly', 'brand impersonation'),
  ('(admin|moderator|support)', 'staff impersonation'),
  ('^official', 'staff impersonation')
on conflict (pattern) do nothing;

-- Every submission attempt, accepted or not. Powers the rate limit and gives moderation
-- something to look at without ever touching health data.
create table if not exists public.submission_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  submitted_at timestamptz not null default now(),
  accepted     boolean not null,
  reason       text
);

create index if not exists submission_log_user_idx
  on public.submission_log (user_id, submitted_at desc);

-- ------------------------------------------------------------------ RLS ----

alter table public.profiles           enable row level security;
alter table public.streak_stats       enable row level security;
alter table public.weekly_scores      enable row level security;
alter table public.rooms              enable row level security;
alter table public.room_members       enable row level security;
alter table public.reports            enable row level security;
alter table public.nickname_blocklist enable row level security;
alter table public.submission_log     enable row level security;

-- The only direct read anyone gets: their own profile row.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

revoke all on public.profiles, public.streak_stats, public.weekly_scores,
              public.rooms, public.room_members, public.reports,
              public.nickname_blocklist, public.submission_log
  from anon, authenticated;

grant select on public.profiles to authenticated;

-- ------------------------------------------------------------ nicknames ----

create or replace function public.generate_nickname()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjectives text[] := array[
    'Quiet','Brisk','Sly','Calm','Bold','Swift','Plush','Gentle','Steady','Curious',
    'Modest','Noble','Cosy','Keen','Mellow','Nimble','Polite','Sturdy','Tidy','Wry'];
  v_nouns text[] := array[
    'Badger','Otter','Heron','Marmot','Ferret','Puffin','Bison','Lynx','Tapir','Gannet',
    'Weasel','Grouse','Beaver','Falcon','Muskrat','Pelican','Raccoon','Shrew','Vole','Wombat'];
  v_candidate text;
begin
  for _ in 1..25 loop
    v_candidate :=
      v_adjectives[1 + floor(random() * array_length(v_adjectives, 1))::int] ||
      v_nouns[1 + floor(random() * array_length(v_nouns, 1))::int] ||
      (100 + floor(random() * 900))::int::text;
    if not exists (select 1 from public.profiles where lower(nickname) = lower(v_candidate)) then
      return v_candidate;
    end if;
  end loop;
  return 'Squeak' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
end;
$$;

-- A profile appears the moment an anonymous session is created, and never before.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, public.generate_nickname())
  on conflict (id) do nothing;

  insert into public.streak_stats (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_nickname(p_nickname text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_clean text;
  v_pattern text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_clean := btrim(p_nickname);

  -- Latin and Cyrillic letters plus digits: the two languages the app ships in.
  if v_clean !~ '^[A-Za-z0-9А-Яа-яЁё]{3,16}$' then
    raise exception 'nickname_invalid' using errcode = '22023';
  end if;

  for v_pattern in select pattern from public.nickname_blocklist loop
    if lower(v_clean) ~ v_pattern then
      raise exception 'nickname_rejected' using errcode = '22023';
    end if;
  end loop;

  update public.profiles
     set nickname = v_clean, updated_at = now()
   where id = v_user;

  return v_clean;
exception
  when unique_violation then
    raise exception 'nickname_taken' using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------- submissions ----

-- The anti-cheat gate. Constants here mirror `src/domain/scoring.ts` exactly:
--   daily cap 100 -> weekly cap 700
--   sustained 2 points/minute, burst allowance 40
--   60 second cooldown between accepted submissions
--   streak may grow by at most one per elapsed calendar day
-- Implausible values are clamped rather than rejected, which removes the incentive to
-- cheat without ever punishing a user whose device was simply asleep for a week.
create or replace function public.submit_progress(
  p_iso_week      text,
  p_week_score    integer,
  p_streak_days   integer,
  p_last_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user           uuid := auth.uid();
  v_now            timestamptz := now();
  v_current_week   text := to_char(v_now, 'IYYY-"W"IW');
  v_previous_week  text := to_char(v_now - interval '7 days', 'IYYY-"W"IW');
  v_last_submit    timestamptz;
  v_prev_score     integer;
  v_prev_streak    integer;
  v_prev_streak_at timestamptz;
  v_max_delta      integer;
  v_score          integer;
  v_streak         integer;
  v_clamped        boolean;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if exists (select 1 from public.profiles where id = v_user and banned_at is not null) then
    raise exception 'account_suspended' using errcode = '42501';
  end if;

  if p_iso_week not in (v_current_week, v_previous_week) then
    raise exception 'week_out_of_range' using errcode = '22023';
  end if;

  if p_last_event_at is not null and p_last_event_at > v_now + interval '5 minutes' then
    raise exception 'timestamp_in_future' using errcode = '22023';
  end if;

  select max(submitted_at) into v_last_submit
    from public.submission_log
   where user_id = v_user and accepted;

  if v_last_submit is not null and v_now - v_last_submit < interval '60 seconds' then
    insert into public.submission_log (user_id, accepted, reason)
    values (v_user, false, 'cooldown');
    raise exception 'rate_limited' using errcode = '53400';
  end if;

  select coalesce(score, 0) into v_prev_score
    from public.weekly_scores where user_id = v_user and iso_week = p_iso_week;
  v_prev_score := coalesce(v_prev_score, 0);

  select streak_days, updated_at into v_prev_streak, v_prev_streak_at
    from public.streak_stats where user_id = v_user;
  v_prev_streak := coalesce(v_prev_streak, 0);

  v_max_delta := ceil(
    extract(epoch from (v_now - coalesce(v_last_submit, v_now - interval '1 day'))) / 60.0 * 2
  )::integer + 40;

  -- A score may fall freely (the user deleted events) but may only rise at the capped rate.
  v_score := least(greatest(coalesce(p_week_score, 0), 0), 700, v_prev_score + v_max_delta);

  v_streak := least(
    greatest(coalesce(p_streak_days, 0), 0),
    3650,
    v_prev_streak + greatest(
      1,
      floor(extract(epoch from (v_now - coalesce(v_prev_streak_at, v_now))) / 86400)::integer + 1
    )
  );

  v_clamped := (v_score <> coalesce(p_week_score, 0)) or (v_streak <> coalesce(p_streak_days, 0));

  insert into public.weekly_scores (user_id, iso_week, score, clamped, updated_at)
  values (v_user, p_iso_week, v_score, v_clamped, v_now)
  on conflict (user_id, iso_week) do update
    set score = excluded.score, clamped = excluded.clamped, updated_at = excluded.updated_at;

  insert into public.streak_stats (user_id, streak_days, best_streak, last_event_at, clamped, updated_at)
  values (v_user, v_streak, v_streak, p_last_event_at, v_clamped, v_now)
  on conflict (user_id) do update
    set streak_days   = excluded.streak_days,
        best_streak   = greatest(public.streak_stats.best_streak, excluded.streak_days),
        last_event_at = excluded.last_event_at,
        clamped       = excluded.clamped,
        updated_at    = excluded.updated_at;

  insert into public.submission_log (user_id, accepted, reason)
  values (v_user, true, case when v_clamped then 'clamped' else null end);

  return jsonb_build_object(
    'accepted', true,
    'clamped', v_clamped,
    'storedScore', v_score,
    'storedStreak', v_streak,
    'serverTime', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- --------------------------------------------------------- leaderboards ----

create or replace function public.leaderboard_page(
  p_board    text,
  p_iso_week text,
  p_limit    integer default 100
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_rows  jsonb;
begin
  if p_board not in ('streak', 'volume') then
    raise exception 'invalid_board' using errcode = '22023';
  end if;

  if p_board = 'streak' then
    with ranked as (
      select p.id,
             p.nickname,
             p.is_pro,
             s.streak_days as value,
             rank() over (order by s.streak_days desc, s.updated_at asc) as rnk
        from public.streak_stats s
        join public.profiles p on p.id = s.user_id
       where p.banned_at is null
         and s.streak_days > 0
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'userId', id, 'nickname', nickname, 'isPro', is_pro,
          'value', value, 'rank', rnk, 'isSelf', id = v_user
        ) order by rnk
      ), '[]'::jsonb)
      into v_rows
      from ranked
     where rnk <= v_limit or id = v_user;
  else
    with ranked as (
      select p.id,
             p.nickname,
             p.is_pro,
             w.score as value,
             rank() over (order by w.score desc, w.updated_at asc) as rnk
        from public.weekly_scores w
        join public.profiles p on p.id = w.user_id
       where p.banned_at is null
         and w.iso_week = p_iso_week
         and w.score > 0
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'userId', id, 'nickname', nickname, 'isPro', is_pro,
          'value', value, 'rank', rnk, 'isSelf', id = v_user
        ) order by rnk
      ), '[]'::jsonb)
      into v_rows
      from ranked
     where rnk <= v_limit or id = v_user;
  end if;

  return v_rows;
end;
$$;

-- ---------------------------------------------------------------- rooms ----

create or replace function public.create_room(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_code char(6);
  v_id   uuid;
  -- Ambiguous glyphs (I, O, 0, 1) are excluded so a code survives being read aloud.
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if (select count(*) from public.rooms where owner_id = v_user) >= 5 then
    raise exception 'room_limit_reached' using errcode = '53400';
  end if;

  for _ in 1..20 loop
    v_code := '';
    for _i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (code, name, owner_id)
  values (v_code, btrim(p_name), v_user)
  returning id into v_id;

  insert into public.room_members (room_id, user_id) values (v_id, v_user);

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;

create or replace function public.join_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_count integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));
  if not found then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  select count(*) into v_count from public.room_members where room_id = v_room.id;
  if v_count >= v_room.member_limit
     and not exists (select 1 from public.room_members where room_id = v_room.id and user_id = v_user) then
    raise exception 'room_full' using errcode = '53400';
  end if;

  insert into public.room_members (room_id, user_id)
  values (v_room.id, v_user)
  on conflict (room_id, user_id) do nothing;

  return jsonb_build_object('id', v_room.id, 'name', v_room.name);
end;
$$;

create or replace function public.room_leaderboard(
  p_room     uuid,
  p_board    text,
  p_iso_week text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
begin
  if not exists (select 1 from public.room_members where room_id = p_room and user_id = v_user) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  if p_board = 'streak' then
    with ranked as (
      select p.id, p.nickname, p.is_pro, coalesce(s.streak_days, 0) as value,
             rank() over (order by coalesce(s.streak_days, 0) desc, p.created_at asc) as rnk
        from public.room_members m
        join public.profiles p on p.id = m.user_id
        left join public.streak_stats s on s.user_id = m.user_id
       where m.room_id = p_room and p.banned_at is null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'userId', id, 'nickname', nickname, 'isPro', is_pro,
      'value', value, 'rank', rnk, 'isSelf', id = v_user) order by rnk), '[]'::jsonb)
      into v_rows from ranked;
  else
    with ranked as (
      select p.id, p.nickname, p.is_pro, coalesce(w.score, 0) as value,
             rank() over (order by coalesce(w.score, 0) desc, p.created_at asc) as rnk
        from public.room_members m
        join public.profiles p on p.id = m.user_id
        left join public.weekly_scores w
               on w.user_id = m.user_id and w.iso_week = p_iso_week
       where m.room_id = p_room and p.banned_at is null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'userId', id, 'nickname', nickname, 'isPro', is_pro,
      'value', value, 'rank', rnk, 'isSelf', id = v_user) order by rnk), '[]'::jsonb)
      into v_rows from ranked;
  end if;

  return v_rows;
end;
$$;

-- ----------------------------------------------------------- moderation ----

create or replace function public.report_user(p_target uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_target = v_user then
    raise exception 'cannot_report_self' using errcode = '22023';
  end if;

  insert into public.reports (reporter_id, target_id, reason)
  values (v_user, p_target, p_reason)
  on conflict (reporter_id, target_id) do nothing;

  update public.profiles
     set report_count = (select count(*) from public.reports where target_id = p_target),
         updated_at = now()
   where id = p_target
  returning report_count into v_count;

  -- Auto-hide pending human review. Reversible, and it only affects visibility.
  if v_count >= 10 then
    update public.profiles set banned_at = now() where id = p_target and banned_at is null;
  end if;
end;
$$;

-- ------------------------------------------------------------- deletion ----

-- Called by "delete all data" and by opting out. The profile row and everything that
-- references it are destroyed, not flagged.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return;
  end if;

  delete from public.profiles where id = v_user;

  begin
    delete from auth.users where id = v_user;
  exception
    when insufficient_privilege then
      -- The profile is already gone; the empty auth row is reaped by a scheduled job.
      null;
  end;
end;
$$;

-- --------------------------------------------------------------- grants ----

revoke execute on all functions in schema public from anon, authenticated;

grant execute on function
  public.set_nickname(text),
  public.submit_progress(text, integer, integer, timestamptz),
  public.leaderboard_page(text, text, integer),
  public.create_room(text),
  public.join_room(text),
  public.room_leaderboard(uuid, text, text),
  public.report_user(uuid, text),
  public.delete_my_account()
to authenticated;
