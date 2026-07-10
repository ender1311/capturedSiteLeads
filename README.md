# Captured Site Leads

Next.js app on Vercel that turns website-redesign form submissions into personalized AI redesign proposal PDFs and a nurture email sequence.

**Flow:** WordPress form → `POST /api/lead` → Firecrawl scrape → LLM report (Vercel AI Gateway) → PDF (puppeteer + chromium) → Vercel Blob → MailerLite sequence → Supabase → `/dashboard`.

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

1. **Supabase**: create a free project, run `supabase/schema.sql` in the SQL editor, copy the URL + service-role key.
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
| `POST /api/lead` | Lead intake pipeline (secured by `x-lead-secret`) |
| `POST /api/webhook/mailerlite` | Email open/click engagement events |
| `GET /dashboard` | Leads table + open/click rates |
