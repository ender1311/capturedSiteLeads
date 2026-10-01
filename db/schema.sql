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
