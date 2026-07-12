-- Run this in the Supabase SQL editor (or via supabase db push)

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  site_url text not null,
  pdf_url text,
  status text not null default 'complete', -- processing | complete | failed | rejected
  error text,
  ip text,
  model text,
  opens int not null default 0,
  clicks int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists leads_email_idx on leads (email);
create index if not exists leads_created_at_idx on leads (created_at desc);

-- Lock the table down; the app uses the service-role key which bypasses RLS.
alter table leads enable row level security;

-- Atomically bump opens/clicks for a lead by email (used by the MailerLite webhook)
create or replace function increment_engagement(lead_email text, counter text)
returns void
language plpgsql
security invoker
as $$
begin
  if counter = 'opens' then
    update leads set opens = opens + 1 where email = lead_email;
  elsif counter = 'clicks' then
    update leads set clicks = clicks + 1 where email = lead_email;
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
