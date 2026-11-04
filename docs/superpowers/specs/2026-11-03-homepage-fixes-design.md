# Your Top Homepage Fixes: automated freebie

Date: 2026-11-03. Owner: Dan. Report owner: Maggie.

## Why

capturedsites.com/homepage-fixes/ offers photographers a free, personalized "Your Top Homepage Fixes"
PDF. Today the PDF is made by hand with Claude running the `your-top-homepage-fixes` skill. This
project makes it fully automatic: a photographer submits the form and the PDF lands in their inbox a
couple of minutes later, with a copy on Maggie's dashboard. It has to look and read like the
hand-made reports (Bill's and Gabby's are the bar), and it has to cost **under 1 cent of Gemini per
report**.

## Goals

1. The form only submits a real email address and a website that loads. The visitor is told within
   about 3 seconds, on the page, if either one is wrong.
2. Every accepted submission gets an email: either the 9-page PDF or a kind "here's why we couldn't"
   email. Nobody is left waiting for nothing.
3. The PDF matches the approved Nov 3 design exactly (`template/report.html` from the skill), with only
   the personal slots changed.
4. Gemini 3.8 Flash (`google/gemini-3.8-flash` through the Vercel AI Gateway) does only the work that
   needs judgment. Average Gemini cost per report under $0.01, measured and stored per lead.
5. Maggie and Dan see every submission, the PDFs, cost and the funnel on beaconfrontier.com/admin/site/capturedsites.
6. **It replaces the old Free Audit "Dream Client Roadmap" report** (Dan, 2026-11-03). Once homepage
   fixes are live:
   - `POST /api/lead` runs the homepage-fixes pipeline too (same handler), so any form still
     pointed there gets the new report instead of the roadmap.
   - The Free Audit page on capturedsites.com 301-redirects to `/homepage-fixes/` (Rank Math
     redirection), done after the new form is verified live.
   - The roadmap generator is removed: `lib/report.ts`, `lib/template.ts`, `lib/template-assets.ts`,
     `lib/agent-guide.ts`, the live guide editor (`/dashboard/guide`, `/api/guide`), and
     `/api/test-generate`. The live model setting stays and now picks the homepage-fixes model
     (default `google/gemini-3.8-flash`); its options and cost estimates are updated.
   - Old roadmap rows stay in `leads` as history (`report_type = 'roadmap'`) and stay visible on the
     dashboard, read only.

## Non-goals

- Changing the report design or the fixed pages (2, 7, 8, 9). Design changes come from Maggie through
  the skill's template.
- Vector search or embeddings. Each report reads one homepage once; there's nothing to retrieve.
- A Maggie approval step before sending. Reports go straight out (Dan, 2026-11-03).
- A Rust backend. This is a new report type in the existing capturedSiteLeads app; the Rust rule is for
  new apps.

## Anti-goals (would be a failure even if it works)

- A report that breaks the skill's hard rules: invented quotes or facts, dashes, agency words, pricing
  or email-list advice, "she" for the visitor, technical numbers, "whole site" language.
- A mockup that uses a stock or AI photo, cuts off faces, or looks like a Captured Sites template
  instead of their site.
- Getting past a bot check (the skill forbids it).
- Blocking a real photographer because our check was slow or unsure. When in doubt, let them through.

## Constraints

- Lives in `~/projects/capturedSiteLeads` (Next.js 16 on Vercel `captured-site-leads`, Neon, Blob,
  Resend/MailerLite, Firecrawl, AI Gateway, puppeteer-core + `@sparticuz/chromium`). All needed keys
  already exist in its env.
- The skill folder (`/Users/danluk/Downloads/your-top-homepage-fixes`) is the source of truth for
  rules, voice, schema and template. Copy what's needed into the repo
  (`lib/homepage-fixes/` and `assets/homepage-fixes/`); keep `references/*.md` beside it so the
  prompt can be regenerated when Maggie updates the skill.
- Vercel function limit: `maxDuration = 300`. The pipeline runs in `after()` like `/api/lead`.
- Elementor's webhook action can't set headers: secret goes in `?secret=` (existing pattern), and
  Elementor needs a 200 back fast.
- No GitHub CI. `npm run check` (to be added: lint, typecheck, vitest, build) runs in the pre-push hook.
- Firecrawl credits are billed separately from the 1 cent Gemini target (about 0.08 to 0.5 cents a
  scrape depending on plan).

## How it works

```
Visitor types email + website on capturedsites.com/homepage-fixes
  └─ page script ──GET /api/homepage-fixes/check──► answer in ≤3s, submit button unlocks only when both OK
Visitor submits
  └─ Elementor webhook ──POST /api/homepage-fixes?secret=…──► 200 at once, then after():
       1. re-validate, rate-limit, dedupe          (script)
       2. Firecrawl: one scrape                    (1 call)
       3. facts + fit flags + mockup settings      (script)
       4. Gemini 3.8 Flash: diagnosis + copy       (1 call, + at most 1 small repair call)
       5. rule check + auto-fix                    (script)
       6. after.jpg + 9-page PDF                   (Chromium, script)
       7. Blob, email, MailerLite, dashboard row   (script)
```

### 1. The on-page check (the 3-second answer)

A small script, pasted into an Elementor HTML widget on the homepage-fixes page, watches the
`email` and `site_url` fields (on blur, and 600ms after typing stops). It calls
`GET https://captured-site-leads.vercel.app/api/homepage-fixes/check?email=…&site=…`, shows a
message under the field, and keeps the submit button disabled until both are OK. It also blocks the
form's submit event as a backstop.

The check endpoint (public, CORS limited to capturedsites.com, 30 requests per IP per 10 minutes)
answers in under 3 seconds. Each check has its own deadline (2.5s) and **a check that times out
passes** (anti-goal: don't block real people for our slowness).

Email (all scripted):
- Syntax (zod email).
- Domain receives mail: MX lookup, falling back to an A record.
- Disposable domains blocked (a bundled list).
- Common typos get a suggestion, not a block: "Did you mean gmail.com?" (gmial, gmal, hotmial,
  yaho, iclod, outlok, .con, .cmo).

Website (all scripted):
- Adds `https://` if missing; rejects private/local hosts (existing `unsafeUrlReason`).
- DNS resolves.
- A GET (browser user agent, follows redirects, reads at most 512 KB) returns 2xx.
- Blocks: no such domain, error status, or a placeholder page (coming soon, under construction,
  maintenance mode, domain for sale / parked).
- Does **not** block on thin text or a bot check page: many photographer sites (Showit, Wix) render
  their text with JavaScript, and a plain fetch can look like a bot check when a real browser is fine.
  Those cases are decided after the Firecrawl scrape, and the visitor gets an email.

On-page messages (my copy, Maggie can edit):
- Email bad syntax: "That email doesn't look quite right. Mind checking it?"
- Email domain can't receive mail: "That email address can't receive mail. Mind checking it?"
- Disposable: "Please use an email you check, so your fixes reach you."
- Typo: "Did you mean name@gmail.com?" (clickable to fix; doesn't block).
- Site doesn't exist / doesn't load: "We couldn't open that website. Mind checking the address?"
- Placeholder page: "Your site looks like it's still a coming soon page. Come back once your homepage
  is live and I'll make your fixes."

### 2. Intake (`POST /api/homepage-fixes`)

Same shape as `/api/lead`: secret check, tolerant Elementor parsing (reuse `parseBody`; the form's
field IDs are `name`, `email`, `site_url`, `website_goal`), insert a `leads` row with
`report_type = 'homepage_fixes'`, re-run the email and website checks server-side (if they fail,
record `outcome = 'invalid'` and stop; no email), apply daily limits, return 200 (always 200 to
Elementor), continue in `after()`.

Limits (my call): counted per report type, so homepage fixes and roadmap leads don't share an
allowance. 3 per email and 3 per IP per day as today. Over the per-email/IP limit: outcome `limited`;
if they already have a homepage-fixes PDF, re-send the latest one, otherwise no email. Global cap
`HOMEPAGE_FIXES_DAILY_CAP` (default 100): over it, outcome `queued`, and a Vercel cron at 7:00
Eastern processes queued leads oldest first within that day's cap. Dan gets an alert the first time
the cap is hit each day.

Dedupe: if the same normalized email already got a homepage-fixes PDF for the same domain in the last
7 days, re-send that PDF instead of building a new one. Scrape results are cached per domain for 7 days
(`scrape_cache` table) so a different person entering the same site doesn't re-scrape.

### 3. Firecrawl: one scrape

One `firecrawl.scrape(url)` with:
- `formats: ["rawHtml", {type: "screenshot", viewport 1440x900, not full page}]`
- `actions`: wait about 3s, dismiss popups and cookie banners exactly as `capture.mjs`'s `dismiss()`
  does (click Accept/Close-type buttons, remove large fixed overlays with text; this is allowed,
  it is not a bot check), scroll down and back up (to wake lazy images), dismiss again, then
  `executeJavascript`
  running a port of the skill's `capture.mjs` page script. It returns, as JSON: every visible text
  line with y position, tag, font size, weight, family and text-transform, and link target; the nav
  items; the logo image URL; image candidates (src, size, y, first screen or not, including CSS
  background images); the header's position (top/bottom) and whether it sits over the photo; button
  texts and targets.
- `proxy: "basic"` (no stealth, per the bot check rule; revisit after the test batch).

Then, scripted:
- `before.jpg` = the screenshot.
- Download the hero photo and up to 2 more candidates (largest first-screen image first), plus the
  logo. Plain `fetch`, 10s each.
- HEAD-check each on-site button target (max 15) for the "a link that goes nowhere" finding.

If Firecrawl fails, times out, or the result shows a bot check: outcome `cant_see`.

### 4. Facts and fit, all scripted (`lib/homepage-fixes/facts.ts`)

Turns the scrape into a compact **fact sheet** (target about 2,500 tokens including trimmed text) and
the mockup settings. This is where most of the old LLM work moves.

Fit flags (outcome `cant_see`, email instead of PDF):
- BOT_CHECK, COMING_SOON, TOO_LITTLE_TEXT (same rules as `capture.mjs`), no usable photo (no image
  candidate at least 800px wide).

Facts (each a short line in the sheet):
- First screen: every text line in order with relative size ("largest", "about half the largest")
  instead of pixels; whether a button is in the first screen and where it goes.
- Biggest line in the first screen vs the most persuasive-looking line, flagged when a logistics line
  (booking, "now accepting", location only, years) is largest.
- Location: whether a place name appears anywhere (US states and abbreviations, "based in", "serving"),
  and the line it's in.
- Inquiry path: which buttons reach a contact/inquire page; first button's position in screens down.
- Testimonials: blocks that look like quotes with a name, and where they sit (screens down).
- Instagram feed or "follow me" block, and what comes right after the last testimonial.
- Steps / process section present or not; services summary present or not.
- Skimmability: page length in laptop screens, longest paragraph length, runs of 3+ text-only blocks,
  gallery length in screens.
- Voice: counts of "we/our" vs "I/my" per section, flagged when it switches.
- About/intro block text, verbatim (the model needs their words for the headline and Fix #1).

Trimmed text for the model: homepage text in order, nav and footer removed, consecutive duplicates
removed, capped at about 1,800 tokens (keep first screen, intro/About and testimonials in full;
shorten gallery captions and long lists first).

Mockup settings decided by script: `photo` (hero), `nav_items`, `nav_position`, `nav_style`,
`logo_image` or `logo_text` (site title), `heading_font`/`body_font` (computed fonts; if not a Google
Font, map to the closest Google Font by category from a fixed list), `uppercase_headline`,
`heading_weight`, `accent` (filled button color if they have one).

### 5. Gemini: the judgment call (`lib/homepage-fixes/write.ts`)

One `generateObject` call to `google/gemini-3.8-flash` through the AI Gateway.

Input:
- System prompt (about 1,800 tokens): a condensed version of `freebie-rules.md`,
  `maggie-diagnostic-lens.md` and `diagnosis-by-pain.md`, the voice rules, and Gabby's approved
  content as the one example. Static and first, so Gemini's implicit caching can apply when traffic
  allows. Rules the script enforces (dashes, banned words, lengths) are stated once, briefly.
- User message: first name, website, goal (their words), fact sheet, trimmed text.
- One image: a contact sheet made by the script (their first screen today on the left, the hero photo
  and up to 2 other candidates on the right, labeled 1/2/3), sent at `media_resolution: low`
  (280 tokens).
- Thinking set to the lowest level the gateway passes through for this model (`minimal` or `low`;
  confirm in the spike), with a max output cap of about 2,000 tokens.

Output (zod schema, mirrors the skill's `content.json` minus what the script decided):
- `fit`: `"report"` or `"hobby"` (goal shows no business intent, per `diagnosis-by-pain.md`).
- If hobby: `compliment` (one genuine, specific sentence about their homepage). Nothing else.
- If report: `photo_choice` (1 to 3), `photo_focus`, `layout` (left/right/center/box), `eyebrow`
  (optional), `headline`, `subline`, `button`, `first_section_changes` (3), `fixes` (2 × title,
  noticed, why, 3 changes), `notes_for_maggie`.

Budget per report: about 5,000 input tokens (0.38¢) + about 1,400 output including thinking (0.53¢)
= about 0.9¢. Cost is computed from the gateway's reported usage and stored on the lead.

### 6. Rule check and repair (`lib/homepage-fixes/rules.ts`)

A port of `build.mjs`'s checks, plus:
- Auto-fix without the model: en/em dashes become commas, curly/straight quote normalization, double
  spaces, trailing spaces.
- Quote check: every quoted phrase in the copy must appear (case- and quote-insensitive) in the
  scraped text; otherwise it's an error ("never invent a quote").
- Any field still breaking a rule or over its length: **one** repair call with only the failing
  fields, their errors, and the rules (about 0.1¢). If anything still fails after that, outcome
  `held`: no email, Dan and Maggie get an alert email, it shows on the dashboard. (Rare by design;
  holding beats sending a broken report.)

### 7. Render

- `after.jpg`: the skill's `firstSectionHtml` (ported as is) rendered at 1400×878 @2x with the
  existing Chromium, photo and logo as data URIs, Google Fonts loaded.
- PDF: the skill's `template/report.html` with `{{...}}` slots filled exactly as `build.mjs` does
  (including `keepLast` no-lonely-word spacing), `before.jpg`/`after.jpg`/assets inlined as data URIs,
  rendered with `page.pdf` at 816×1056px, print backgrounds on.
- Overflow check on every page (same as `build.mjs`). On overflow: one repair call asking to shorten
  the overflowing field, then re-render; still overflowing → `held`.
- **Look check on the mockup** (replaces the skill's step 8 human look): one small Gemini 3.8 Flash
  call with `after.jpg` at low resolution (280 tokens) plus a 100-token question, returning
  `{faces_ok, headline_readable, looks_like_template}`. If anything fails, re-render once with the
  alternate settings the main call returned (`alt_layout`, `alt_photo_focus`, add these to its
  schema), then once with the next photo candidate; still failing → `held`. About 0.05¢ per check.
- One browser launch for both renders (renders are serialized per instance, existing `htmlToPdf`
  pattern).

### 8. Delivery and records

- PDF and `after.jpg`/`before.jpg` to Blob. File name `your-top-homepage-fixes-<first-name>.pdf`.
- Email always via Resend for homepage fixes, whatever the dashboard toggle says (attachment +
  link). Only if Resend errors, fall back to the MailerLite link-only path. From `Maggie | Captured Sites <maggie@capturedsites.com>`. New templates, my copy, Maggie can edit:
  - **Report:** subject "{name}, your top homepage fixes are ready". Body: short and warm, says it's
    their homepage with their own photo, the button "See My Homepage Fixes", and one line inviting
    them to book a Captured Sites Tour.
  - **Can't see it** (`cant_see`): subject "{name}, a quick note about your homepage fixes". Body:
    my homepage review tool couldn't load your homepage (or it looks like it's not live yet), so I
    couldn't make your fixes; reply with another link or try again once it's live; Tour link. Never
    implies Maggie looked by hand.
  - **Hobby** (`hobby`): subject "{name}, a little note about your website". Body: the `compliment`
    sentence, then a soft door ("if it ever grows into something you want to take further, I'd love to
    help").
- MailerLite: every accepted submission (`sent`, `hobby`, `cant_see`, and `failed` once its email
  goes out) joins the existing "Website Lead Generator" group (`MAILERLITE_GROUP_ID`), whose
  "Lead Generator Follow-ups" automation Maggie will rewrite for homepage fixes herself (Dan,
  2026-11-03). The app sends the report email, so the automation has no Email 1. Subscriber fields
  written (existing `name`, `site_url`, `pdf_url`, plus new ones the setup script creates via the
  MailerLite API): `goal`, `hf_outcome` (sent / hobby / cant_see / failed, so her automation can
  branch), `hf_headline` (their new headline), `hf_fix1_title`, `hf_fix2_title`, `hf_sent_date`.
  `pdf_url` is empty unless a PDF was sent.
- Database (`db/schema.sql` additions, applied by hand per the Neon note):
  - `leads`: `report_type text default 'roadmap'`, `goal text`, `outcome text`
    (`processing | sent | hobby | cant_see | invalid | limited | queued | retrying | held | failed`),
    `retry_count int default 0`, `content jsonb` (the full content incl.
    `notes_for_maggie` and the fact sheet), `before_url`, `after_url`, `input_tokens`,
    `output_tokens`, `cost_usd numeric`.
  - `scrape_cache (domain text primary key, data jsonb, created_at)`.
- Time budget: Firecrawl timeout 45s, Gemini calls 40s each, renders about 20s; worst case stays
  well under the 300s limit. No in-request retry. Errors anywhere (Firecrawl down, Gemini error):
  outcome `retrying`, `retry_count` +1; a Vercel cron every 15 minutes re-runs leads in `retrying`
  once (reusing the cached scrape when it exists). A second failure: outcome `failed`, the
  photographer gets the "can't see it" email, Dan gets an alert.
- Alerts (cap hit, `held`, `failed`) are emails via Resend to dan (`ALERT_EMAILS`, default
  danluk1311@gmail.com and maggie@capturedsites.com for `held` only).
- Delivery is one shared module (`lib/homepage-fixes/deliver.ts`) used by the route, the crons and
  the CLI.

### 9. The dashboard lives in the Beacon Frontier admin (Dan, 2026-11-03)

Everything Maggie and Dan look at is on **https://beaconfrontier.com/admin/site/capturedsites**, the
existing per-site admin page (traffic, goals, marketing, pages, sources, GA4, Google Search). Maggie
signs in with Google as a **site viewer** (`ADMIN_VIEWERS`, `email:capturedsites`): read-only, that
one site. The old capturedSiteLeads `/dashboard` redirects there.

Data flow:
- **Daily counts** go through the admin's existing product-metrics contract
  (beacon-frontier `docs/metrics-contract.md`): capturedSiteLeads serves
  `GET /api/metrics/v1` (aggregates only) and `capturedsites` gets
  `productApi: { path: "https://captured-site-leads.vercel.app/api/metrics/v1", tokenEnv: "PRODUCT_TOKEN_CAPTUREDSITES" }`.
- **Lead-level data** (names, emails, goals, PDFs, copy) is never copied into the metrics database.
  The admin page fetches it live, server to server, from capturedSiteLeads
  `GET /api/admin/leads…` with a bearer token (`LEADS_API_TOKEN`, same value on both projects).
  If capturedSiteLeads is down, the section says so and the rest of the page still works.

New "Homepage Fixes" section on the capturedsites page (both roles):
- Top numbers for the page's date range: submissions, reports sent, couldn't see, hobby, held or
  failed, average Gemini cost per report, email open rate, click rate, Tour visits from a PDF.
- Chart: submissions and reports sent per day.
- Leads table: date, name, email, website, goal, outcome pill, before/after thumbnails, PDF link,
  cost, opened, clicked. Filter by outcome, search name/email/site, 50 per page.
- Lead detail page `/admin/site/capturedsites/leads/<id>`: PDF embedded, before and after side by
  side, goal, every copy field, `notes_for_maggie`, fact sheet, cost and timing, error and issues,
  email events.
- **CSV export of leads for both Dan and Maggie** (Dan, 2026-11-03: a deliberate exception to the
  viewer "no exports" rule, scoped to this one leads export). Audited as `leads export` with role,
  never the address.
- Email setup subsection: the guide for Maggie's 3 MailerLite follow-ups (content as before:
  what was already sent, group and automation, merge fields with live examples, who joins with which
  `hf_outcome`, voice reminders, report email open/click rates).
- Admin-only controls (hidden and refused for viewers): report model picker, re-send a held report.

Funnel and attribution:
- The capturedsites.com header snippet reports `form_submit` with `form: "homepage_fixes"` on the
  homepage-fixes page; new goal "Homepage Fixes request" and funnel: any page → homepage-fixes page →
  form sent. Product numbers carry the rest (report sent, opened, clicked).
- The on-page check script reports `hf_check_blocked` with `field: email | site` through the
  collector when it blocks a submit.
- Tour links in the PDF and emails carry `utm_source=homepage-fixes&utm_medium=pdf|email&utm_campaign=homepage-fixes`,
  so Tour visits from the freebie show in Marketing and Sources.

Held reports: Dan fixes the stored content and runs
`scripts/homepage-fixes-deliver.mts <lead-id> [edited-content.json]`, which re-renders from the stored
content (or the edited file) and delivers through `deliver.ts`. No automatic deadline; the alert
makes sure someone looks the same day. An in-dashboard edit-and-send button is out of scope.

### 10. Testing and the cost gate

- **Spike first (gates the build):** a CLI script `scripts/homepage-fixes-run.mts <name> <url> <goal>`
  runs steps 3 to 7 locally and writes the PDF, page PNGs, fact sheet, and token/cost numbers to
  `out/`. Run on 5 real sites. First Bill (`wjohnsphoto.com`, William Johns Photography; goal
  "More wedding inquiries from the right couples", my guess) compared to
  `~/Downloads/your-top-homepage-fixes-bill.pdf`, and Gabby (`gabbyjphotography.com`, goal from
  `examples/gabby/content.json`) compared to that approved content. Then 3 more photographer sites,
  including one Showit and one Pixieset site. `template/report.html` is the design source of truth
  (its fixed pages match the exported `your-top-homepage-fixes-html-pages/` text exactly, checked
  2026-11-03). If the
  average Gemini cost is over 1¢ or the copy is clearly worse than Bill's, stop and re-plan before
  building intake and delivery.
- Unit tests (vitest, new): email and website check classification (fixtures), Elementor body parsing
  with `website_goal`, fact extraction from saved scrape fixtures, rule checker and auto-fix, quote
  check, template fill (all slots filled, no `{{` left), cost calculation.
- `npm run check` = lint + typecheck + vitest + build; install the pre-push hook.
- Before launch: a 10-site batch reviewed by Maggie (the skill's pre-launch test).

### 11. Go-live steps (manual, outside the code)

1. Apply the schema additions to Neon.
2. Run the setup script that creates the new MailerLite subscriber fields, and set the live model to
   `google/gemini-3.8-flash` on the dashboard.
3. On the homepage-fixes page in Elementor: add the webhook action to
   `/api/homepage-fixes?secret=…`, turn Advanced Data on, add a Honeypot field, remove any direct
   MailerLite action, set the success message ("You're all set. Your homepage fixes are being made
   right now, check your inbox in a few minutes."), and add the HTML widget with the check script.

## Left to the builder

File layout inside `lib/homepage-fixes/`, the exact condensed prompt wording (must keep every hard
rule), the Google Font fallback list, the disposable-domain list source, the contact sheet layout,
and dashboard styling (match the existing dashboard).
