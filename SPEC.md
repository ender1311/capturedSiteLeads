# Captured Site Leads — Redesign Intake App (Spec)

Maggie's WordPress site collects leads (name, email, site URL). This app receives that data, scrapes the lead's site, generates an AI redesign proposal PDF, emails it via a MailerLite sequence, and tracks engagement in a dashboard.

**Total startup cost: $0** (free tiers). Scales to ~$5–10/mo for ~100 leads (mostly LLM tokens).

## High-Level Flow

1. **WordPress form** (Gravity Forms / Contact Form 7) collects `name`, `email`, `site_url` → webhook POST to this app. *(Handled on Maggie's site — out of scope here.)*
2. **`POST /api/lead`** (this app, on Vercel):
   - Validate payload + shared secret.
   - **Firecrawl** scrapes the lead's site → clean markdown.
   - **LLM** (via Vercel AI Gateway — cheap model, e.g. DeepSeek Flash or Gemini Flash-Lite) takes Maggie's redesign context + scraped content → generates redesign report as HTML.
   - **puppeteer-core + @sparticuz/chromium** renders the HTML → PDF.
   - **Vercel Blob** stores the PDF → public CDN URL.
   - **MailerLite** API adds subscriber to a group (with `pdf_url` custom field) → triggers the 3-email sequence.
   - **Supabase** inserts the lead row.
3. **`POST /api/webhook/mailerlite`**: MailerLite open/click webhook events → increment engagement counters in Supabase.
4. **`GET /dashboard`**: leads table + open/click/conversion stats from Supabase.
5. **Auth**: Google sign-in via Auth.js; only `danluk1311@gmail.com` and `maggiemluk@gmail.com` (allowlist in `auth.ts`) can access pages. `proxy.ts` guards everything except the machine-to-machine API routes, which use shared secrets.

## Stack & Costs (zero to start)

| Piece | Choice | Cost |
|---|---|---|
| Hosting/compute | Next.js (App Router) on Vercel Hobby, Fluid Compute | Free — 100 GB bandwidth, 1M function invocations/mo |
| Scraping | Firecrawl | Free 1K credits, then pay-per-page |
| LLM | Vercel AI Gateway, model set by `LLM_MODEL` env (DeepSeek Flash ~$0.14/M input, or Gemini Flash-Lite ~$0.10/M) | Pennies per report |
| PDF | puppeteer-core + @sparticuz/chromium | Free, Vercel-compatible |
| PDF storage | Vercel Blob (public) | Usage-based, pennies at this scale |
| Email sequence | MailerLite | Free — 500 subs / 2,500 emails/mo, API 120 req/min |
| Database | Supabase Postgres | Free — 500 MB |

Why this shape: serverless, API-first, everything OpenAI/SDK-compatible, deployable in under an hour, and WordPress stays light (just a form + webhook).

## API Contracts

### `POST /api/lead`
Headers: `x-lead-secret: <LEAD_WEBHOOK_SECRET>`

```json
{ "name": "Jane Doe", "email": "jane@example.com", "site_url": "https://janes-site.com" }
```

The pipeline runs inline — Vercel functions allow up to 300s, plenty for scrape + LLM + PDF. Responds `200` with `{ id, pdf_url }` on success, `4xx/5xx` with `{ error }` otherwise. Failed pipelines still insert a lead row with `status: 'failed'` so no lead is silently lost.

### `POST /api/webhook/mailerlite`
MailerLite webhook (subscriber opened / clicked events). Optional HMAC signature verification via `MAILERLITE_WEBHOOK_SECRET`. Matches subscriber email → increments `opens` / `clicks` on the lead row.

## DB Schema (Supabase)

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  site_url text not null,
  pdf_url text,
  status text not null default 'complete', -- complete | failed
  error text,
  opens int not null default 0,
  clicks int not null default 0,
  created_at timestamptz not null default now()
);
```

## Environment Variables

| Key | Purpose |
|---|---|
| `LEAD_WEBHOOK_SECRET` | Shared secret the WP form webhook must send |
| `AUTH_SECRET` | Auth.js session encryption (`npx auth secret`) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client for sign-in |
| `FIRECRAWL_API_KEY` | Firecrawl scraping |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway (auto-provided via OIDC when deployed on Vercel) |
| `LLM_MODEL` | Gateway model string, e.g. `deepseek/deepseek-chat` or `google/gemini-2.5-flash-lite` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (auto-provided when Blob store is connected) |
| `MAILERLITE_API_KEY` | MailerLite API |
| `MAILERLITE_GROUP_ID` | Group whose automation sends the 3-email sequence |
| `MAILERLITE_WEBHOOK_SECRET` | Optional — verify webhook signatures |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access (never exposed to client) |
| `REDESIGN_CONTEXT` | Optional — Maggie's redesign brief/context override (defaults baked in `lib/report.ts`) |

## Deploy

1. Push to GitHub (`ender1311/capturedSiteLeads`) → import in Vercel → auto-deploys on push.
2. In Vercel: connect a Blob store, add env vars (`vercel env`), enable AI Gateway.
3. Run `supabase/schema.sql` in the Supabase SQL editor.
4. In MailerLite: create the group + automation (trigger: joins group), and a webhook pointing at `/api/webhook/mailerlite` for open/click events.
5. Point the WordPress form webhook at `POST /api/lead` with the shared secret header.
