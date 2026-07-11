# WordPress / Elementor Form Setup — Free Audit Lead Intake

Instructions for wiring the "Free Audit" page form (capturedsites.com, Elementor) to the lead-intake app. The app receives the submission, scrapes the lead's website, generates their personalized "Dream Client Roadmap" PDF, and emails it via the MailerLite "Lead Generator Funnel" automation.

## What the form must send

Three fields, POSTed to the webhook below. **Field custom IDs must match exactly** (lowercase): `name`, `email`, `site_url`.

## Steps (Elementor Pro Form widget)

### 1. Fields

Edit the existing form on the Free Audit page (post 1257):

| Field | Type | Label (visitor-facing) | Custom ID (Advanced tab) | Required |
|---|---|---|---|---|
| 1 | Text | Name | `name` | Yes |
| 2 | Email | Email | `email` | Yes |
| 3 | URL (or Text) | Your website address | `site_url` | Yes |

- The Name and Email fields already exist — open each field's **Advanced** tab and verify/set the Custom ID to exactly `name` and `email`.
- **Add the third field** for the website URL with Custom ID `site_url`. Use the URL field type if available; Text is fine too (the backend adds `https://` if the visitor omits it).

### 2. Actions After Submit → Webhook

- In the form widget: **Actions After Submit → Add Action → Webhook**
- Webhook URL:

```
https://captured-site-leads.vercel.app/api/lead?secret=SECRET_GOES_HERE
```

Replace `SECRET_GOES_HERE` with the value provided separately (it is the `LEAD_WEBHOOK_SECRET`). Do not publish this URL anywhere visitor-facing — it lives only in the Elementor admin settings.

- Turn **Advanced Data** ON — this forwards the visitor's IP address (`meta[remote_ip]`), which the backend needs for its per-visitor rate limiting (3 PDFs per IP per day). Without it, only per-email limits apply.

### 2b. Bot protection on the form

- In the form widget, add a **Honeypot** field (Elementor Pro has a built-in Honeypot field type) — invisible to humans, filters most dumb bots for free.
- Optionally add **reCAPTCHA v3** or **Cloudflare Turnstile** (Elementor → Settings → Integrations) for stronger protection. Not required to launch — the backend also enforces per-IP/per-email limits (3/day each) and a global daily cap.

### 3. Remove any duplicate email actions

If the form has a **MailerLite** action (or any other email-list action) in Actions After Submit, **remove it**. The backend adds the subscriber to MailerLite itself, attaching the personalized PDF link — a direct form integration would double-subscribe them without the PDF.

Keep any "Email" action that notifies Maggie internally, if one exists — that's harmless.

### 4. Button label + success message

The PDF is generated and emailed within ~1–2 minutes — it is **not** an instant download. So:

- Change the button text from `DOWNLOAD` to something send-oriented, e.g. **"SEND MY FREE AUDIT"**.
- Set the form's success message to match, e.g.:
  > "You're all set! Your personalized audit is being created right now — check your inbox in the next few minutes."

### 5. Test

Submit the form once with a real email and a real photography site URL. Expected results:

1. The form shows the success message immediately.
2. Within ~2 minutes the email arrives via MailerLite with the PDF link (requires the "Lead Generator Funnel" automation to be **enabled** in MailerLite).
3. The lead appears at https://captured-site-leads.vercel.app/dashboard (Google sign-in required) with status `processing` → `complete` and a working PDF link.

If the dashboard shows `failed`, the row's error column says why — most commonly an unreachable site URL.

## Endpoint reference

- `POST https://captured-site-leads.vercel.app/api/lead?secret=…`
- Accepts form-encoded (Elementor webhook) or JSON `{"name","email","site_url"}`
- Auth: `secret` query param, or `x-lead-secret` header for JSON callers
- Returns `202 {"id","status":"processing"}` immediately; processing continues server-side
