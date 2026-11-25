-- Run once in Supabase: SQL Editor > New query > paste > Run.

create table if not exists fj_questions (
  game_id text not null,
  round text not null,
  category text not null,
  value int,
  clue text not null,
  answer text not null,
  daily_double boolean not null default false,
  sort_order int not null default 0,
  updated_by text,
  updated_at timestamptz not null default now(),
  media text,
  answer_media text
);
create index if not exists fj_questions_game on fj_questions (game_id);

create table if not exists fj_rooms (
  code text primary key,
  host_key text not null,
  started boolean not null default false,
  closed boolean not null default false,
  state jsonb,
  state_ver int not null default 0,
  ver int not null default 0,
  ev_seq int not null default 0,
  touched double precision not null
);

create table if not exists fj_players (
  room_code text not null references fj_rooms (code) on delete cascade,
  id text not null,
  name text not null,
  token text not null default '',
  slot text,
  seen double precision not null default 0,
  sig text not null default '',
  sigv int not null default 0,
  ord bigint generated always as identity,
  primary key (room_code, id)
);
create index if not exists fj_players_token on fj_players (room_code, token);

create table if not exists fj_events (
  room_code text not null references fj_rooms (code) on delete cascade,
  seq int not null,
  t text not null,
  pid text not null,
  value int,
  data jsonb,
  primary key (room_code, seq)
);

create table if not exists fj_feeds (
  id text primary key,
  host_key text not null,
  view_key text not null,
  state jsonb,
  ver int not null default 0,
  touched double precision not null
);

-- The app connects with the database owner role, which bypasses row level security.
-- Enabling it with no policies keeps these tables closed to Supabase's public (anon) API.
alter table fj_questions enable row level security;
alter table fj_rooms enable row level security;
alter table fj_players enable row level security;
alter table fj_events enable row level security;
alter table fj_feeds enable row level security;
