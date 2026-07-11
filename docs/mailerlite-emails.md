# MailerLite "Lead Generator Funnel" — Email Content (paste-ready)

The automation exists and is triggered when a subscriber joins the **Website Lead Generator** group (our app adds them there with `name`, `site_url`, and `pdf_url` fields already filled). The MailerLite API cannot write email bodies, so this is a one-time paste job in the dashboard: **Automations → Lead Generator Funnel → edit each email**.

**Merge tags:** where you see `{$name}`, `{$site_url}`, `{$pdf_url}` below, insert them with the editor's personalization menu (the `{ }` / "Personalization" option) and pick the matching field — that guarantees the correct token syntax. For the button in Email 1, put the `pdf_url` tag in the button's **URL** field.

---

## Email 1 — sends immediately on signup

**Subject:** `{$name}`, your Dream Client Roadmap is ready 📸

**Preheader:** Your personalized website review is inside.

**Body:**

> Hi {$name},
>
> Your personalized **Dream Client Roadmap** is ready — a page-by-page review of {$site_url} through the eyes of the dream client you're trying to book.
>
> Inside you'll find the 3 highest-impact opportunities we spotted on your site, why each one matters for bookings, and exactly how to make it right.
>
> **[View My Roadmap →]** ← button, URL = `{$pdf_url}`
>
> Give it a quick read — most photographers can act on at least one of the fixes the same day.
>
> Talk soon,
> Maggie
> Captured Sites

---

## Email 2 — 1 day later

**Subject:** The fastest fix on your list

**Body:**

> Hi {$name},
>
> Did you get a chance to open your Dream Client Roadmap? If not, here it is again: **[View My Roadmap →]** (button, URL = `{$pdf_url}`)
>
> A tip from experience: don't try to fix everything at once. Opportunity #1 in your roadmap is first for a reason — it's the change your visitors feel in the first five seconds on {$site_url}.
>
> If you'd rather see what it looks like to have the whole thing handled for you — strategy, design, SEO, all of it — I'd love to show you around.
>
> **[Book a Free Tour Call →]** ← button, URL = `https://capturedsites.com/tour/`
>
> Maggie

---

## Email 3 — 1 day later

**Subject:** Beautiful site ≠ booked calendar

**Body:**

> Hi {$name},
>
> One last thought before I leave you to it.
>
> It's kind of like editing a RAW photo: you can push a file far in post, but at some point you realize the lighting and settings had to be right from the start. Websites work the same way — the biggest shift happens when the whole site is built from the ground up with the right strategy.
>
> That's what we do all day, every day, exclusively for photographers: done-for-you websites with SEO built in.
>
> If you want to explore what that looks like for {$site_url}, grab a spot here:
>
> **[Schedule a Tour →]** ← button, URL = `https://capturedsites.com/tour/`
>
> Either way — your roadmap is yours to keep. Go book those dream clients.
>
> Maggie

---

## After pasting the content

1. **Sender:** each email currently sends from `jetluk+adam@gmail.com`. Gmail senders hurt deliverability (DMARC) — switch to an address on a domain you can authenticate (e.g. `maggie@capturedsites.com`) in MailerLite → Settings → Domains, then set it as the From on all 3 emails.
2. **Enable the automation** (toggle top-right in the automation editor). MailerLite refuses to enable while any email is incomplete — if the toggle won't stick, one of the 3 emails is missing subject/content/sender.
3. Note: the automation fires **once per subscriber** (not repeatable). When testing, use an email address that has never been in the Website Lead Generator group, or delete the subscriber first.
