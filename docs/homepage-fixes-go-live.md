# Homepage Fixes go-live checklist

Design: [docs/superpowers/specs/2026-11-03-homepage-fixes-design.md](./superpowers/specs/2026-11-03-homepage-fixes-design.md). Items marked done were applied to the live systems on 2026-11-04. Do not redo them.

## Deploy order (must be followed)

1. **capturedSiteLeads first:** merge `feat/homepage-fixes` into main, so Vercel deploys it to production.
2. **Then beacon-frontier:** branch `feat/capturedsites-homepage-fixes` (worktree `~/projects/beacon-frontier-wt-hf`).

If the order is reversed, beacon-frontier's daily product pull hits an endpoint that does not exist yet, fails, and emails alerts.

## Status

| # | Step | Status |
|---|---|---|
| 1 | Neon schema | Done 2026-11-04 |
| 2 | MailerLite fields | Open (run the script) |
| 3 | Resend tracking and webhook | Open (Resend dashboard) |
| 4 | Vercel env | Mostly done 2026-11-04; open items below |
| 4a | Gemini prepaid credit | Open |
| 4b | capturedsites.com header snippet | Open |
| 5 | Elementor form | Open |
| 6 | Real test submission | Open |
| 7 | 10-site batch for Maggie | Open |
| 8 | Redirect Free Audit page | Open, after Maggie approves |

## 1. Neon schema: DONE 2026-11-04

The whole homepage-fixes schema block is applied, including `resend_email_id`. Check with `\d leads` in the Neon SQL editor if you want to see it.

## 2. MailerLite custom fields

`name`, `site_url` and `pdf_url` already exist. The script creates the missing text fields (`goal`, `hf_outcome`, `hf_headline`, `hf_fix1_title`, `hf_fix2_title`, `hf_sent_date`). It is idempotent and never prints the key.

```bash
set -a; . ./.env.local; set +a
npx tsx scripts/mailerlite-hf-fields.mts --dry-run   # read-only: "would create <key>" / "exists <key>"
npx tsx scripts/mailerlite-hf-fields.mts             # creates the missing ones
```

## 3. Resend

Open the Resend dashboard (https://resend.com). The repo's Resend key is send-only, so this cannot be scripted.

1. Domains → capturedsites.com → Configuration: confirm **Open tracking** and **Click tracking** are on.
2. Webhooks → Add webhook: endpoint `https://captured-site-leads.vercel.app/api/webhook/resend`, events `email.opened` and `email.clicked`.
3. Copy the webhook's signing secret and set it on Vercel as `RESEND_WEBHOOK_SECRET` (capturedSiteLeads, production and preview), then redeploy. Without the secret, the route accepts unverified events.

## 4. Vercel env

**capturedSiteLeads (production and preview), DONE 2026-11-04:** `CRON_SECRET`, `PRODUCT_TOKEN_CAPTUREDSITES`, `LEADS_API_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY` (from the Google Cloud project captured-sites-ai-1103, "Captured Sites AI", under danluk1311@gmail.com), `LLM_MODEL=google/gemini-3.8-flash`.

**beacon-frontier, DONE 2026-11-04:** `PRODUCT_TOKEN_CAPTUREDSITES` and `LEADS_API_TOKEN`, with the same values as capturedSiteLeads.

**Billing, DONE 2026-11-04:** the billing account "captured sites pdf" is linked to captured-sites-ai-1103.

**Still open:**

- `RESEND_WEBHOOK_SECRET` (step 3).
- beacon-frontier `LEADS_API_URL`: confirm it is set to the capturedSiteLeads production URL (`https://captured-site-leads.vercel.app`).
- beacon-frontier `ADMIN_VIEWERS`: confirm it contains `maggie@capturedsites.com:capturedsites` (add her Gmail too if she signs in with it). The value is stored as sensitive and cannot be read back, so re-enter the full list if unsure.
- Optional: `HOMEPAGE_FIXES_DAILY_CAP` (default 100) and `ALERT_EMAILS` (default danluk1311@gmail.com).
- The report model is `google/gemini-3.8-flash` via `LLM_MODEL`; it can also be changed in the beacon-frontier admin.

### 4a. Gemini prepaid credit

Paid calls fail with 402 "prepayment credits depleted" until credit is added. Go to AI Studio (https://ai.studio/projects) → Captured Sites AI → Billing, and add prepaid credit. Expect about 0.9 cents per report.

### 4b. capturedsites.com header snippet

Update the snippet per beacon-frontier `docs/metrics.md` so the homepage-fixes form reports `homepage_fixes`.

## 5. Elementor, Your Top Homepage Fixes form

The live page is `/homepage-fixes/` (page id 1516). Its form "Your Top Homepage Fixes" has fields `name`, `email`, `site_url` and `website_goal`, and its only action today is MailerLite (no webhook, no honeypot).

1. Actions After Submit → add **Webhook**: `https://captured-site-leads.vercel.app/api/homepage-fixes?secret=<LEAD_WEBHOOK_SECRET>`. Turn **Advanced Data** ON.
2. Add a **Honeypot** field to the form.
3. Remove the MailerLite action. This is safe: capturedSiteLeads now upserts the subscriber itself.
4. Success message: `You're all set. Your homepage fixes are being made right now, check your inbox in a few minutes.` (replacing "Thank you! Your top fixes are on their way to your inbox.")
5. Add an HTML widget anywhere on the page: `<script src="https://captured-site-leads.vercel.app/homepage-fixes-check.js" defer></script>`

Note: the Free Audit page (id 1257, `/free-audit/`) posts to `https://captured-site-leads.vercel.app/api/lead?secret=...`. Once this app is deployed, that endpoint also builds homepage-fixes reports (it shares the handler), so the old page keeps working.

## 6. Test with a real submission

Submit the live form with Dan's email. Confirm: the email arrives with the PDF attached, a row shows in https://beaconfrontier.com/admin/site/capturedsites, and the MailerLite subscriber has the `hf_*` fields filled.

## 7. Pre-launch: 10-site batch for Maggie

Run the CLI on 10 real photographer sites and send the PDFs to Maggie for review. Output goes to `out/<first-name>-<domain>/` (git-ignored).

```bash
set -a; . ./.env.local; set +a
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npx vite-node --config vitest.config.ts scripts/homepage-fixes-run.mts -- \
  Jane https://janedoephotography.com "More wedding inquiries from the right couples"
```

Flags: `--model <id>` overrides the model; `--capture-only` stops after capture (no Gemini cost); `--from-capture out/<folder>` reuses a saved capture instead of calling Firecrawl. Every run saves its capture, so a re-run with a different model or after a prompt tweak is cheap.

## 8. Retire the Free Audit page

After Maggie approves the batch and step 6 passes: Rank Math → Redirections → 301 from the Free Audit page URL (`/free-audit/`) to `/homepage-fixes/`.
