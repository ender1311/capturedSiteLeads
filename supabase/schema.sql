-- Run this in the Supabase SQL editor (or via supabase db push)

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

-- Idempotent upgrade for databases created before the default changed:
-- a bare insert must not masquerade as a delivered report.
alter table leads alter column status set default 'processing';

create index if not exists leads_email_idx on leads (email);
create index if not exists leads_created_at_idx on leads (created_at desc);

-- Lock the table down; the app uses the service-role key which bypasses RLS.
alter table leads enable row level security;

-- Atomically bump opens/clicks for a lead by email (used by the MailerLite
-- webhook). Only the most recent DELIVERED lead is credited — the same person
-- may have older/failed/rejected rows, and inflating them all skews the
-- dashboard's open/click rates.
create or replace function increment_engagement(lead_email text, counter text)
returns void
language plpgsql
security invoker
as $$
declare
  target uuid;
begin
  select id into target
  from leads
  where email = lead_email and status = 'complete'
  order by created_at desc
  limit 1;
  if target is null then
    return;
  end if;

  if counter = 'opens' then
    update leads set opens = opens + 1 where id = target;
  elsif counter = 'clicks' then
    update leads set clicks = clicks + 1 where id = target;
  end if;
end;
$$;

-- Only the service role (used by the app) may call this — not the public Data API
revoke execute on function increment_engagement(text, text) from public, anon, authenticated;

-- Runtime-editable app configuration (e.g. the live LLM agent guide)
create table if not exists app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table app_config enable row level security;
