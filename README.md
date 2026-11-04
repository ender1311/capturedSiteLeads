# Captured Site Leads

Next.js app on Vercel that turns website-redesign form submissions into personalized AI redesign proposal PDFs and a nurture email sequence.

**Flow:** WordPress "Your Top Homepage Fixes" form → `POST /api/homepage-fixes` (or `/api/lead`, same handler) → Firecrawl scrape → Gemini report (`google/gemini-3.8-flash`) → PDF (puppeteer + chromium) → Vercel Blob → email via Resend with the PDF attached → MailerLite subscriber upsert (nurture automation) → Neon Postgres. Reports and stats are viewed in the Beacon Frontier admin: https://beaconfrontier.com/admin/site/capturedsites.

Going live: see [docs/homepage-fixes-go-live.md](./docs/homepage-fixes-go-live.md). Design: [docs/superpowers/specs/2026-11-03-homepage-fixes-design.md](./docs/superpowers/specs/2026-11-03-homepage-fixes-design.md).

See [SPEC.md](./SPEC.md) for the full plan, costs, and API contracts.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the keys
npm run dev
```

## Access control

Google sign-in (Auth.js) protects every page. Only the emails hardcoded in `auth.ts` (`danluk1311@gmail.com`, `maggiemluk@gmail.com`) can sign in. The machine-to-machine routes (`/api/lead`, `/api/webhook/mailerlite`) are exempt — they use their own shared-secret/signature auth.

Google OAuth client setup (one-time, console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID → Web application):

- Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google` and `https://<your-domain>/api/auth/callback/google`
- Put the client ID/secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, and set `AUTH_SECRET` (`npx auth secret`).

### One-time service setup

1. **Neon Postgres**: `vercel integration add neon` (Vercel Marketplace auto-injects `DATABASE_URL`), then apply `db/schema.sql` once against the new database.
2. **Firecrawl**: grab an API key at firecrawl.dev (1K free credits).
3. **MailerLite**: create an API key, a group (note its ID), and an automation triggered by "joins group" that sends the 3-email sequence (use the `pdf_url` custom field in the emails). Add a webhook for open/click events pointing at `https://<your-domain>/api/webhook/mailerlite`.
4. **Vercel**: import the GitHub repo, connect a Blob store (Storage tab), enable AI Gateway, and add the env vars from `.env.example` (`vercel env add ...`). `BLOB_READ_WRITE_TOKEN` and `AI_GATEWAY_API_KEY` are auto-injected on Vercel.
5. **WordPress**: point the form webhook (Gravity Forms/Zapier) at `POST https://<your-domain>/api/lead` with header `x-lead-secret: <LEAD_WEBHOOK_SECRET>` and JSON body `{ name, email, site_url }`.

### Test a lead locally

```bash
curl -X POST http://localhost:3000/api/lead \
  -H "Content-Type: application/json" \
  -H "x-lead-secret: $LEAD_WEBHOOK_SECRET" \
  -d '{"name":"Jane Doe","email":"jane@example.com","site_url":"https://example.com"}'
```

For local PDF generation, set `PUPPETEER_EXECUTABLE_PATH` to a local Chrome binary (on Vercel, `@sparticuz/chromium` is used automatically).

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/lead` | Lead intake (secured by `?secret=` or `x-lead-secret`); same handler as `/api/homepage-fixes` |
| `POST /api/homepage-fixes` | Homepage Fixes intake from the Elementor webhook |
| `GET /api/homepage-fixes/check` | On-page site check used by `homepage-fixes-check.js` (answers within 3 s) |
| `GET /api/cron/homepage-fixes` | Cron: retries and housekeeping (secured by `CRON_SECRET`) |
| `GET /api/metrics/v1` | Daily product metrics pulled by beacon-frontier (`PRODUCT_TOKEN_CAPTUREDSITES`) |
| `/api/admin/*` | Admin data for the Beacon Frontier admin: `leads`, `leads/[id]`, `leads/[id]/resend`, `model`, `email-setup` (`LEADS_API_TOKEN`) |
| `POST /api/webhook/resend` | Email open/click events from Resend (`RESEND_WEBHOOK_SECRET`) |
| `POST /api/webhook/mailerlite` | Email open/click events from MailerLite |
| `GET /dashboard` | 308 redirect to https://beaconfrontier.com/admin/site/capturedsites |
