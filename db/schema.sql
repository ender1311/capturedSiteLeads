-- Neon Postgres schema. Apply with:
--   npx dotenv -e .env.local -- node scripts/apply-schema.mjs
-- or paste into the Neon SQL editor.
--
-- No row-level security here: unlike Supabase, Neon exposes no public data
-- API. The only way in is the connection string, which lives in DATABASE_URL
-- and is never shipped to the browser.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  site_url text not null,
  pdf_url text,
  status text not null default 'processing', -- processing | complete | failed | rejected
  error text,
  ip text,
  model text,
  opens int not null default 0,
  clicks int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists leads_email_idx on leads (email);
create index if not exists leads_created_at_idx on leads (created_at desc);

-- Runtime-editable app configuration (the live LLM agent guide, the email
-- provider toggle, the model override).
create table if not exists app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Homepage fixes (2026-11-03). Applied by hand at go-live, like the rest of
-- this file. report_type tells roadmap rows from homepage_fixes rows; outcome
-- is the homepage-fixes state (processing | sent | hobby | cant_see | invalid
-- | limited | queued | retrying | held | failed).
alter table leads add column if not exists report_type text not null default 'roadmap';
alter table leads add column if not exists goal text;
alter table leads add column if not exists outcome text;
alter table leads add column if not exists content jsonb;
alter table leads add column if not exists before_url text;
alter table leads add column if not exists after_url text;
alter table leads add column if not exists input_tokens int;
alter table leads add column if not exists output_tokens int;
alter table leads add column if not exists cost_usd numeric(10,6);
alter table leads add column if not exists retry_count int not null default 0;
create index if not exists leads_type_created_idx on leads (report_type, created_at desc);
create table if not exists scrape_cache (domain text primary key, data jsonb not null, created_at timestamptz not null default now());
create table if not exists check_hits (ip text not null, at timestamptz not null default now());
create index if not exists check_hits_ip_at_idx on check_hits (ip, at);
