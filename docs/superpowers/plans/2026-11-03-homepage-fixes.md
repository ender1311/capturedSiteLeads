# Your Top Homepage Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A photographer submits the capturedsites.com/homepage-fixes/ form and, within a few minutes, gets the 9-page "Your Top Homepage Fixes" PDF (or a kind explanation) by email from maggie@capturedsites.com, with a copy on Maggie's dashboard, for under 1 cent of Gemini per report. It replaces the old Dream Client Roadmap report.

**Architecture:** One Firecrawl scrape (screenshot + an in-page extraction script) feeds deterministic TypeScript that builds a compact fact sheet and the mockup settings. One Gemini 3.8 Flash call (AI Gateway) writes only the judgment parts; scripts check the copy, render the mockup and PDF with the existing Chromium, and deliver via Resend. Everything lives in `lib/homepage-fixes/` of the existing capturedSiteLeads Next.js app.

**Tech Stack:** Next.js 16 App Router, TypeScript, zod 4, `ai` 7 + AI Gateway, `@mendable/firecrawl-js` 4.30, puppeteer-core + `@sparticuz/chromium`, Neon (`@neondatabase/serverless`), `@vercel/blob`, Resend REST, MailerLite REST, vitest (new).

**Spec:** `docs/superpowers/specs/2026-11-03-homepage-fixes-design.md`. Source skill (rules, template, scripts being ported): `/Users/danluk/Downloads/your-top-homepage-fixes/`. Reference PDF: `/Users/danluk/Downloads/your-top-homepage-fixes-bill.pdf`.

## Global Constraints

- Model id `google/gemini-3.8-flash` via AI Gateway (`generateObject` from `ai`); price constants $0.75 per 1M input, $3.75 per 1M output tokens.
- Gemini cost target: average under $0.01 per report (main call + repair + look check).
- Images to Gemini at low media resolution (280 tokens each); thinking at the lowest level the gateway accepts; `maxOutputTokens: 2000` on the main call.
- Firecrawl: exactly one `scrape` per report, `proxy: "basic"`, `timeout: 45000`. Never stealth/enhanced proxy, never try to pass a bot check.
- Sender: `Maggie | Captured Sites <maggie@capturedsites.com>` (env `RESEND_FROM` overrides). Homepage-fixes email always via Resend with PDF attached (skip attachment over 8 MB); MailerLite link-only only if Resend errors.
- Every copy field obeys the skill's hard rules (`references/freebie-rules.md` "Hard rules"): no em/en dashes, no brackets, no agency words, no pricing advice, no email-list/freebie advice, no technical numbers, visitor is "the visitor" with they/their, homepage only, "Captured Sites" spelled exactly, never invent quotes or facts.
- The PDF's fixed pages come only from the skill's `template/report.html`; only `{{...}}` slots, `before.jpg` and `after.jpg` change.
- Elementor webhook always gets HTTP 200.
- On-page check endpoint answers within 3 s; each sub-check has a 2.5 s deadline; a timed-out check passes.
- Vercel function `maxDuration = 300` on every route that runs the pipeline; add each such route to `outputFileTracingIncludes` in `next.config.ts`.
- No new heavy dependencies for images: contact sheet and mockup are rendered with the existing Chromium. Allowed new deps: `vitest` (dev) only.
- `npm run check` = `npm run lint && npm run typecheck && npm test && npm run build`. Never push with `--no-verify`.

## Review Focus

1. **A site whose fonts are not Google Fonts** (Adobe Typekit, custom). Expect the mockup to use the closest Google Font by category, never a blank or Times fallback. Test in Task 5.
2. **A goal field left empty or one word ("bookings")**. Expect a full report diagnosed toward "more of the right inquiries", not `hobby`. Test in Task 6 (prompt input) and Task 7 (fit decision).
3. **Copy quoting text that isn't on the page** (model paraphrases a testimonial inside quotes). Expect the quote check to catch it and the repair call to fix it. Test in Task 3.
4. **Same person resubmits within minutes** (double-click, impatient). Expect one report, the second submission re-sends it or is `limited`, never two different PDFs. Test in Task 10.
5. **A name with an apostrophe, accent or emoji ("Zoë", "D'Andre")**. Expect the PDF slots, file name and email subject to render it correctly and the file name to be ASCII-safe. Test in Task 4 and Task 8.

---

## File map

```
lib/homepage-fixes/
  types.ts          shared types (Task 1)
  skill/            copied skill references + template + assets (Task 1)
  rules.ts          copy checks, auto-fix, quote check (Task 3)
  render-html.ts    firstSectionHtml, fillReport, contactSheetHtml (Task 4)
  render.ts         Chromium: contact sheet, after.jpg, PDF, overflow (Task 4)
  page-script.ts    in-page extraction JS string (Task 2)
  capture.ts        Firecrawl scrape + downloads (Task 2)
  fonts.ts          Google Font fallback map (Task 5)
  facts.ts          fit flags, fact sheet, trimmed text, mockup settings (Task 5)
  prompt.ts         system prompt + user message builder (Task 6)
  write.ts          Gemini calls: write, repair, look check; cost (Task 6)
  pipeline.ts       capture→facts→write→rules→render, returns a Result (Task 7)
  emails.ts         report / cant_see / hobby / alert email HTML (Task 8)
  deliver.ts        Blob, Resend, MailerLite, lead row update (Task 8)
  store.ts          DB access for leads + scrape_cache (Task 8)
  validate.ts       email + website checks (Task 9)
scripts/homepage-fixes-run.mts       spike CLI (Task 7)
scripts/homepage-fixes-deliver.mts   held-report CLI (Task 10)
scripts/mailerlite-hf-fields.mts     creates MailerLite fields (Task 12)
app/api/homepage-fixes/route.ts        intake (Task 10)
app/api/homepage-fixes/check/route.ts  on-page check (Task 9)
app/api/cron/homepage-fixes/route.ts   queue + retry sweeps (Task 10)
public/homepage-fixes-check.js         Elementor page snippet (Task 9)
app/dashboard/...                      tabs (Task 11)
docs/homepage-fixes-go-live.md         manual steps (Task 12)
```

---

### Task 1: Tooling and skill assets

**Files:**
- Modify: `package.json` (scripts `test: "vitest run"`, `typecheck: "tsc --noEmit"`, `check`; devDependency `vitest`)
- Create: `vitest.config.ts` (node env, `@` alias to repo root, include `**/*.test.ts`, exclude `node_modules`, `.next`)
- Create: `lib/homepage-fixes/skill/` copied from `/Users/danluk/Downloads/your-top-homepage-fixes/`: `references/*.md`, `template/report.html`, `template/assets/*`, `examples/gabby/content.json`, `SKILL.md`
- Create: `lib/homepage-fixes/types.ts`
- Test: `lib/homepage-fixes/skill.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export type TextRow = { y: number; x: number; tag: string; fs: number; fw: string; ff: string; tt: string; href?: string; text: string };
export type ImageCandidate = { src: string; w: number; h: number; y: number; alt: string; kind: "img" | "background" };
export type PageData = {
  title: string; finalUrl: string; pageHeight: number; metaDesc: string;
  rows: TextRow[]; imgs: ImageCandidate[]; nav: string[];
  navTop: boolean; navOverPhoto: boolean; navBg: string | null; navColor: string | null;
  logo: { src: string; w: number; h: number } | null;
  fonts: { heading: string; headingWeight: string; body: string };
  uppercaseHeadings: boolean; accent: string | null;
  buttons: { text: string; href: string; y: number }[];
  textLength: number; sample: string; dismissed: string[];
};
export type Asset = { data: Buffer; mime: string };
export type Capture = {
  url: string; page: PageData; before: Asset;
  photos: (Asset & { candidate: ImageCandidate; firstScreen: boolean })[];
  logo: Asset | null;
  linkStatus: Record<string, number | "off-site" | "same-page" | "no response">;
  capturedAt: string;
};
export type FitFlag = "BOT_CHECK" | "COMING_SOON" | "TOO_LITTLE_TEXT" | "NO_PHOTO";
export type Layout = "left" | "right" | "center" | "box";
export type FirstSection = {           // mirrors skill references/content-schema.md
  photo: string; photo_focus: string; layout: Layout;
  nav_position: "top" | "bottom"; nav_style: "bar" | "over";
  nav_background?: string; nav_color?: string;
  logo_image?: string; logo_text?: string; nav_items: string[];
  heading_font: string; heading_weight?: number; body_font: string;
  uppercase_headline: boolean; eyebrow?: string;
  headline: string; subline: string; button: string; accent?: string;
};
export type Fix = { title: string; noticed: string; why: string; changes: [string, string, string] };
export type ReportContent = {
  first_name: string; website: string; goal: string;
  first_section: FirstSection;
  first_section_changes: [string, string, string];
  fixes: [Fix, Fix];
  notes_for_maggie: string;
};
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
```

- [ ] **Step 1:** Add vitest and scripts. Run `npm i -D vitest@^3` and set the scripts above.
- [ ] **Step 2: Write the failing test** `skill.test.ts`:
  - `template has exactly the slots build.mjs fills`: reads `skill/template/report.html`, collects `{{X}}` names, expects the set `FIRST_NAME, NAME_POSS, P4_CHANGE_1..3, F1_TITLE, F1_NOTICED, F1_WHY, F1_CHANGES, F2_TITLE, F2_NOTICED, F2_WHY, F2_CHANGES`.
  - `template references only bundled assets`: every `src="assets/..."` file exists in `skill/template/assets/`.
  - `gabby example parses as ReportContent shape`: has 3 `first_section_changes`, 2 fixes with 3 changes each.
- [ ] **Step 3:** Copy the skill files, write `types.ts`. Run `npm test` → PASS.
- [ ] **Step 4:** Run `~/.claude/scripts/install-local-checks.sh ~/projects/capturedSiteLeads` and confirm `.git/hooks/pre-push` exists. Run `npm run check` → all pass.
- [ ] **Step 5: Commit** `chore: vitest, check script, homepage-fixes skill assets and types`.

---

### Task 2: Capture (Firecrawl, one scrape)

**Files:**
- Create: `lib/homepage-fixes/page-script.ts`, `lib/homepage-fixes/capture.ts`
- Test: `lib/homepage-fixes/capture.test.ts`, fixture `lib/homepage-fixes/fixtures/firecrawl-gabby.json`

**Interfaces:**
- Consumes: `Capture`, `PageData` from Task 1.
- Produces:
```ts
// page-script.ts
export const DISMISS_SCRIPT: string;   // capture.mjs dismiss() as a self-invoking IIFE; returns string[] of removed popup texts
export const EXTRACT_SCRIPT: string;   // capture.mjs page.evaluate body as an IIFE returning JSON.stringify(PageData without dismissed)
// capture.ts
export class CaptureError extends Error { kind: "bot_check" | "unreachable" | "empty" }
export function parseScrape(doc: { screenshot?: string; actions?: { javascriptReturns?: { type: string; value: unknown }[] }; metadata?: { statusCode?: number } }): { page: PageData; screenshotUrl: string };
export async function captureSite(url: string, opts?: { fetchImpl?: typeof fetch }): Promise<Capture>;
```

- [ ] **Step 1: Write failing tests** (pure, no network):
  - `parseScrape reads the extraction JSON and screenshot`: given the fixture, returns `page.nav` non-empty, `page.rows.length > 20`, `screenshotUrl` starts with `https://`.
  - `parseScrape merges dismissed popup texts`: first javascriptReturn (dismiss) array lands in `page.dismissed`.
  - `parseScrape throws CaptureError kind empty when extraction missing`.
  - `captureSite downloads hero first and caps at 3 photos` with a stubbed `fetchImpl` and a stubbed Firecrawl (inject via `vi.mock("@mendable/firecrawl-js")`): photos ordered first-screen first then by area, `.svg` skipped, max 3, images under 800px wide skipped.
  - `captureSite marks link status`: on-site hrefs get HEAD status, off-site `"off-site"`, `#x` `"same-page"`, max 15 checked.
- [ ] **Step 2:** Run `npx vitest run lib/homepage-fixes/capture.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `page-script.ts` ports `scripts/capture.mjs` from the skill: the `dismiss()` logic (button names list, close selectors, removal of fixed overlays with text, z-index ≥ 10, area > 30%) and the `page.evaluate` body, extended to also return `navTop` (y of the first nav link < 180 → true, else check bottom of first screen), `navOverPhoto` (header background transparent and overlapping the largest first-screen image), `navBg`/`navColor` (computed colors of the header), `uppercaseHeadings` (text-transform of the largest first-screen row), `accent` (background color of the first filled button-like link, else null). Scripts must be plain ES2017 strings with no imports.
  `captureSite` makes one call:
  ```ts
  firecrawl.scrape(url, {
    formats: [{ type: "screenshot", fullPage: false, viewport: { width: 1440, height: 900 }, quality: 88 }],
    actions: [
      { type: "wait", milliseconds: 3000 },
      { type: "executeJavascript", script: DISMISS_SCRIPT },
      { type: "scroll", direction: "down" }, { type: "scroll", direction: "down" }, { type: "scroll", direction: "down" },
      { type: "scroll", direction: "up" }, { type: "scroll", direction: "up" }, { type: "scroll", direction: "up" },
      { type: "wait", milliseconds: 1500 },
      { type: "executeJavascript", script: DISMISS_SCRIPT },
      { type: "executeJavascript", script: EXTRACT_SCRIPT },
    ],
    onlyMainContent: false, proxy: "basic", timeout: 45000,
  })
  ```
  Then fetch the screenshot URL into `before`, download photos (10 s each, browser UA) and the logo, HEAD-check links (5 s each, run in parallel). Firecrawl error or HTTP ≥ 400 → `CaptureError("unreachable")`. Save one real response as the fixture by running the live call once against `gabbyjphotography.com` with a throwaway script (strip nothing; it's public site data).
- [ ] **Step 4:** Run the tests → PASS. Run the live call once on `wjohnsphoto.com` and print `page.fonts`, `page.nav`, photo count, and Firecrawl `creditsUsed` if returned; note credits in the commit message.
- [ ] **Step 5: Commit** `feat(homepage-fixes): one-call Firecrawl capture`.

---

### Task 3: Copy rules, auto-fix and quote check

**Files:**
- Create: `lib/homepage-fixes/rules.ts`
- Test: `lib/homepage-fixes/rules.test.ts`

**Interfaces:**
- Consumes: `ReportContent`.
- Produces:
```ts
export type RuleIssue = { field: string; level: "error" | "warning"; message: string };
export const LIMITS: Record<string, number>; // headline 60, subline 110, button 24, eyebrow 60, change note 190, fix title 52, noticed 360, why 260, fix change 130
export function autoFix(c: ReportContent): ReportContent;          // dashes→", ", collapse spaces, trim, curly→straight quotes inside fields
export function checkContent(c: ReportContent, pageText: string): RuleIssue[];
export function fieldsOf(c: ReportContent): [string, string][];   // [label, text] in the build.mjs label format, e.g. "fixes[1].changes[2]"
```

- [ ] **Step 1: Write failing tests**, using `skill/examples/gabby/content.json` as the base and mutating one field per test:
  - `gabby passes with no errors` given a pageText containing all her quoted phrases.
  - `em dash and en dash are auto-fixed` ("a — b" → "a, b").
  - `banned word is an error` for each of: elevate, leverage, seamless, curated, audit, conversion, funnel, optimize, authentic, unlock (regex copied from `build.mjs`).
  - `bracket is an error`, `"12px" is an error`, `"your whole site" is an error`, `"newsletter" is an error`.
  - `"she" is a warning`, `"!" is a warning`, `"$300" is a warning`.
  - `over-length is an error` (build.mjs treats it as a warning; here it's an error so it triggers repair): fix title of 53 chars.
  - `invented quote is an error`: noticed contains `"Best day ever"` not in pageText → error on that field. Matching ignores case, curly vs straight quotes, and runs of whitespace; quotes shorter than 3 words are ignored.
  - `"Captured sites" misspelled is an error`.
  - Review Focus 3: `paraphrased testimonial in quotes is caught` ("met every idea with a yes" when page says "met every idea I brought with a yes").
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Port the regexes from the skill's `scripts/build.mjs` exactly.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(homepage-fixes): copy rules, auto-fix, quote check`.

---

### Task 4: Rendering (mockup, contact sheet, PDF)

**Files:**
- Create: `lib/homepage-fixes/render-html.ts`, `lib/homepage-fixes/render.ts`
- Modify: `lib/pdf.ts` (export `getBrowser()` so both share it; keep `htmlToPdf` as is until Task 11 removes roadmap)
- Test: `lib/homepage-fixes/render-html.test.ts`, `lib/homepage-fixes/render.test.ts` (Chromium; runs only when `PUPPETEER_EXECUTABLE_PATH` is set, `describe.skipIf`)

**Interfaces:**
- Consumes: `ReportContent`, `FirstSection`, `Asset`.
- Produces:
```ts
// render-html.ts (pure)
export function keepLast(s: string): string;                       // escape + &nbsp; before last word
export function firstSectionHtml(s: FirstSection, photoDataUri: string, logoDataUri?: string): string;
export function fillReport(c: ReportContent, imgs: { before: string; after: string }): string; // data URIs in, full HTML out, assets inlined
export function contactSheetHtml(before: string, photos: string[]): string; // 1600x900: today on left half, up to 3 photos labeled 1,2,3 on right
export function pdfFileName(firstName: string): string;            // "your-top-homepage-fixes-<ascii-slug>.pdf"
// render.ts
export async function renderContactSheet(beforeUri: string, photoUris: string[]): Promise<Buffer>;  // JPEG, 1600x900, quality 80
export async function renderAfter(s: FirstSection, photoUri: string, logoUri?: string): Promise<Buffer>; // JPEG 1400x878 @2x, quality 90
export async function renderPdf(html: string): Promise<{ pdf: Buffer; overflow: { page: number; hits: string[] }[] }>;
```

- [ ] **Step 1: Write failing tests** (pure):
  - `fillReport fills every slot`: output contains no `{{`, contains Gabby's F1 title with `&nbsp;` before its last word, and contains 3 checkbox rows per fix.
  - `fillReport inlines assets`: no `src="assets/` and no `src="before.jpg"` remain; they're `data:` URIs.
  - `fillReport escapes HTML`: a headline `<b>x</b>` renders as `&lt;b&gt;`.
  - `firstSectionHtml bottom nav puts nav after photo` and `over style makes nav text white` (port of build.mjs behavior).
  - `firstSectionHtml loads non-system fonts from Google Fonts` and omits the link for `Georgia`.
  - Review Focus 5: `pdfFileName("Zoë")` = `your-top-homepage-fixes-zoe.pdf`; `pdfFileName("D'Andre")` = `your-top-homepage-fixes-dandre.pdf`; `NAME_POSS` for `D'Andre` renders `D&#39;Andre's` or `D'Andre's` correctly escaped in `aria-label`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement by porting `firstSectionHtml`, the slot fill, `keepLast` and `change()` from the skill's `scripts/build.mjs` verbatim (only change: images arrive as data URIs). `render.ts` reuses one browser per call chain through `getBrowser()`; PDF via `page.pdf({ width: "816px", height: "1056px", printBackground: true, preferCSSPageSize: true })` after `document.fonts.ready`; overflow check copied from build.mjs.
- [ ] **Step 4:** Run → PASS. With local Chrome set, run the Chromium test that renders Gabby's example with `examples/gabby/photos/photo-01.jpg` and `before.jpg`, writes `out/gabby.pdf`, asserts 9 pages (count `/Type /Page` occurrences) and empty `overflow`. Open the PDF and compare pages 1, 3 to 6 against Bill's PDF visually for layout parity.
- [ ] **Step 5: Commit** `feat(homepage-fixes): mockup, contact sheet and PDF rendering`.

---

### Task 5: Facts, fit flags and mockup settings

**Files:**
- Create: `lib/homepage-fixes/fonts.ts`, `lib/homepage-fixes/facts.ts`
- Test: `lib/homepage-fixes/facts.test.ts` (uses the Task 2 fixture plus small hand-written `PageData` objects)

**Interfaces:**
- Consumes: `Capture`, `PageData`, `FitFlag`, `FirstSection`.
- Produces:
```ts
// fonts.ts
export function toGoogleFont(family: string, role: "heading" | "body"): string; // known Google family → itself; else closest by category; serif default "Cormorant Garamond", sans "Montserrat", script/display heading → "Playfair Display"
// facts.ts
export type ScriptMockup = Omit<FirstSection, "photo" | "photo_focus" | "layout" | "eyebrow" | "headline" | "subline" | "button">;
export type Facts = {
  flags: FitFlag[];
  sheet: string;        // compact fact lines, no pixel numbers
  trimmedText: string;  // ≤ 7,200 chars (~1,800 tokens)
  pageText: string;     // full visible text, for the quote check
  mockup: ScriptMockup;
};
export function buildFacts(c: Capture): Facts;
```

- [ ] **Step 1: Write failing tests:**
  - Flags: `BOT_CHECK` when title is "Just a moment..."; `COMING_SOON` for "Coming soon"; `TOO_LITTLE_TEXT` when `textLength < 300`; `NO_PHOTO` when no photo ≥ 800 wide. (Regexes from capture.mjs.)
  - `sheet says when no button is in the first screen` (rows with href in first 900px that are buttons → none) → line `First screen button: none`.
  - `sheet flags a logistics line bigger than the headline`: rows "Now booking 2026" fs 48 and "Ready to make memories?" fs 22 → line contains `"Now booking 2026" is the biggest line in the first screen, more than twice the size of "Ready to make memories?"`.
  - `location found`: a row "based in Birmingham, Alabama" → `Location: yes, "based in Birmingham, Alabama"`; none → `Location: not found anywhere on the homepage`.
  - `testimonials detected` (quote-like block followed by a name line, or a heading containing "kind words|testimonials|love notes|reviews") with position in screens.
  - `instagram block after last testimonial` detected from text "follow" + "instagram" or an instagram href.
  - `voice switch` when first screen uses "we" and About uses "I".
  - `skimmability`: page height in screens, longest paragraph in words, count of 3+ consecutive text-only blocks.
  - `trimmedText removes nav and footer rows and stays under 7,200 chars` on the fixture.
  - `sheet contains no px or % numbers` on the fixture.
  - `mockup from fixture`: `nav_items` equals the fixture's nav, `nav_position` "bottom" for Gabby, `uppercase_headline` true for Gabby.
  - Review Focus 1: `toGoogleFont("brandon-grotesque","body")` → "Montserrat"; `toGoogleFont("Cormorant Garamond","heading")` → itself; `toGoogleFont("Adobe Garamond Pro","heading")` → "Cormorant Garamond".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Sheet line order: Goal-agnostic facts only, one per line, in the order of `maggie-diagnostic-lens.md` sections 1 to 8. Relative size words: "more than twice the size", "about the same size", "smaller". `fonts.ts` holds a list of ~60 common Google families plus category keywords (serif: garamond, caslon, baskerville, bodoni, didot, playfair, cormorant, libre; script: script, hand, signature).
- [ ] **Step 4:** Run → PASS; print `buildFacts` on the fixture and count characters of `sheet + trimmedText` (target ≤ 10,000 chars).
- [ ] **Step 5: Commit** `feat(homepage-fixes): deterministic fact sheet and mockup settings`.

---

### Task 6: Gemini calls (write, repair, look check) and cost

**Files:**
- Create: `lib/homepage-fixes/prompt.ts`, `lib/homepage-fixes/write.ts`
- Modify: `lib/models.ts` (add `google/gemini-3.8-flash` with input 0.00000075 and output 0.00000375 per token as the new `DEFAULT_MODEL`; add `google/gemini-3.5-flash-lite` 0.0000003 / 0.0000025; update `TOKENS_PER_REPORT` to `{ input: 5600, output: 1500 }`)
- Test: `lib/homepage-fixes/write.test.ts` (uses `MockLanguageModelV3` / the mock model exported by `ai/test`; no network)

**Interfaces:**
- Consumes: `Facts`, `RuleIssue`, `ReportContent`, `Usage`, `LIMITS`.
- Produces:
```ts
// prompt.ts
export const SYSTEM_PROMPT: string;  // ≤ 7,500 chars; static
export function userMessage(input: { firstName: string; website: string; goal: string; facts: Facts }): string;
// write.ts
export const writtenSchema: z.ZodType<Written>;
export type Written =
  | { fit: "hobby"; compliment: string }
  | { fit: "report"; photo_choice: 1 | 2 | 3; photo_focus: string; alt_photo_focus: string; layout: Layout; alt_layout: Layout;
      eyebrow: string; headline: string; subline: string; button: string;
      first_section_changes: [string, string, string]; fixes: [Fix, Fix]; notes_for_maggie: string };
export async function writeReport(input: { firstName: string; website: string; goal: string; facts: Facts; contactSheet: Buffer; model?: string }): Promise<{ written: Written; usage: Usage }>;
export async function repairFields(input: { content: ReportContent; issues: RuleIssue[]; model?: string }): Promise<{ content: ReportContent; usage: Usage }>; // sends only failing fields, merges back
export async function lookCheck(after: Buffer, model?: string): Promise<{ ok: boolean; faces_ok: boolean; headline_readable: boolean; looks_like_template: boolean; usage: Usage }>;
export function costOf(u: { inputTokens: number; outputTokens: number }, model: string): number;
export function addUsage(a: Usage, b: Usage): Usage;
```

- [ ] **Step 1: Write failing tests:**
  - `SYSTEM_PROMPT carries every hard rule`: contains the words "dash", "the visitor", "they/their", "homepage only", "Captured Sites", "never invent", "pricing", "email list", and the banned word list; is ≤ 7,500 chars; contains Gabby's headline as the single example.
  - `userMessage puts goal verbatim and defaults empty goal` (Review Focus 2): empty goal → `Goal: not given. Diagnose toward more of the right inquiries.`; one word "bookings" kept verbatim.
  - `writeReport sends one image part with low media resolution and the low thinking option`: inspect the mock model's received `prompt` (one `file` part, `image/jpeg`) and `providerOptions` (`google.mediaResolution === "MEDIA_RESOLUTION_LOW"`, `google.thinkingConfig.thinkingLevel === "low"`), `maxOutputTokens === 2000`.
  - `writeReport computes cost from usage`: mock usage 5,000 in / 1,400 out on `google/gemini-3.8-flash` → `costUsd` ≈ 0.00900 (±1e-6). Prefer `providerMetadata.gateway.cost` when the mock provides it.
  - `repairFields sends only failing fields`: issues on `fixes[1].title` only → prompt contains that field and not `first_section_changes`.
  - `lookCheck ok only when all three pass`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Condense `freebie-rules.md`, `maggie-diagnostic-lens.md` and `diagnosis-by-pain.md` into `SYSTEM_PROMPT` (sections: Your job, The three opportunities, The new first section, The three change notes, Fix pages, Hard rules, Voice, Hobby check, Example = Gabby's content.json minimized). The user message lists: name, website, goal, fact sheet, trimmed text, and "Image: left = their first screen today; right = photo candidates 1 to 3". All calls go through `generateObject` with `providerOptions: { google: { mediaResolution: "MEDIA_RESOLUTION_LOW", thinkingConfig: { thinkingLevel: "low" } } }`, `temperature: 0.4`. Look check prompt asks three yes/no questions about the image, `maxOutputTokens: 200`.
- [ ] **Step 4:** Run → PASS. Then one live call per option against the gateway (refresh local token with `vercel env pull .env.local` first) with Gabby's facts to confirm the gateway accepts both provider options; if `thinkingLevel: "low"` is rejected, try `"minimal"`, then omit, and record which worked in a code comment. Print usage.
- [ ] **Step 5: Commit** `feat(homepage-fixes): Gemini write, repair and look check with cost tracking`.

---

### Task 7: Pipeline and the spike CLI (GATE)

**Files:**
- Create: `lib/homepage-fixes/pipeline.ts`, `scripts/homepage-fixes-run.mts`
- Test: `lib/homepage-fixes/pipeline.test.ts` (all stages injected as fakes)

**Interfaces:**
- Consumes: everything from Tasks 2 to 6.
- Produces:
```ts
export type PipelineResult =
  | { outcome: "sent"; content: ReportContent; pdf: Buffer; before: Buffer; after: Buffer; facts: Facts; usage: Usage; model: string }
  | { outcome: "hobby"; compliment: string; facts: Facts; usage: Usage; model: string }
  | { outcome: "cant_see"; reason: FitFlag | "unreachable" | "bot_check" | "empty"; usage: Usage }
  | { outcome: "held"; reason: string; content: ReportContent; issues: RuleIssue[]; facts: Facts; usage: Usage; model: string };
export type Stages = { capture: typeof captureSite; write: typeof writeReport; repair: typeof repairFields; look: typeof lookCheck; renderAfter: typeof renderAfter; renderPdf: typeof renderPdf; renderContactSheet: typeof renderContactSheet };
export async function runHomepageFixes(input: { firstName: string; website: string; goal: string; model?: string; capture?: Capture }, stages?: Partial<Stages>): Promise<PipelineResult>;
```
"sent" here means "ready to send"; delivery happens in Task 8.

- [ ] **Step 1: Write failing tests** with fakes:
  - `fit flag stops before Gemini` (`TOO_LITTLE_TEXT` → `cant_see`, write never called).
  - `CaptureError bot_check → cant_see`.
  - `hobby returns compliment, no render`.
  - `rule errors trigger exactly one repair; still failing → held`.
  - `look check failure re-renders with alt settings, then next photo, then held` (3 renderAfter calls max).
  - `overflow triggers one repair asking to shorten the overflowing field, then held if still overflowing`.
  - `usage sums all calls`.
  - `ReportContent assembly`: script mockup + written fields + chosen photo → `first_section.photo` is the chosen photo's data URI key.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the order from the spec: capture (or given) → `buildFacts` → flags → contact sheet → `writeReport` → assemble → `autoFix` → `checkContent` → repair once → `renderAfter` → `lookCheck` (alt layout/focus, then next photo) → `fillReport` → `renderPdf` → overflow repair once. `scripts/homepage-fixes-run.mts <first-name> <url> "<goal>" [--model id]` loads `.env.local`, runs the pipeline with real stages, writes to `out/<first-name>-<domain>/`: `report.pdf`, `before.jpg`, `after.jpg`, `contact.jpg`, `facts.txt`, `content.json`, `result.json` (outcome, usage, cost, elapsed seconds).
- [ ] **Step 4:** Run → PASS. Then run the CLI on:
  1. `Bill https://www.wjohnsphoto.com "More wedding inquiries from the right couples"`
  2. `Gabby https://gabbyjphotography.com "More inquiries from couples and graduates"`
  3. to 5. three more photographer sites: one Showit, one Pixieset, one Squarespace or WordPress (pick from Google results for "wedding photographer <state>").
- [ ] **Step 5: GATE. Stop and report to Dan** a table: site, outcome, Gemini cost, elapsed seconds, Firecrawl credits, and a one-line copy-quality verdict versus Bill's PDF; attach Bill's and Gabby's generated PDFs. Continue to Task 8 only if the average Gemini cost is under $0.01 and Dan says go. If cost is over: first lower `trimmedText` cap, then shorten `SYSTEM_PROMPT`, then try thinking "minimal", re-run, report again.
- [ ] **Step 6: Commit** `feat(homepage-fixes): pipeline and spike CLI` (do not commit `out/`; add it to `.gitignore`).

---

### Task 8: Storage, delivery and emails

**Files:**
- Modify: `db/schema.sql` (append the block below), `lib/db.ts` (`Lead` type gains new columns)
- Create: `lib/homepage-fixes/store.ts`, `lib/homepage-fixes/emails.ts`, `lib/homepage-fixes/deliver.ts`
- Modify: `lib/mailerlite.ts` (`addSubscriber` takes optional `fields: Record<string,string>`)
- Test: `lib/homepage-fixes/emails.test.ts`, `lib/homepage-fixes/deliver.test.ts` (fetch + blob + sql mocked)

Schema append:
```sql
alter table leads add column if not exists report_type text not null default 'roadmap';
alter table leads add column if not exists goal text;
alter table leads add column if not exists outcome text;
alter table leads add column if not exists content jsonb;
alter table leads add column if not exists before_url text;
alter table leads add column if not exists after_url text;
alter table leads add column if not exists input_tokens int;
alter table leads add column if not exists output_tokens int;
alter table leads add column if not exists cost_usd numeric(10,6);
alter table leads add column if not exists retry_count int not null default 0;
create index if not exists leads_type_created_idx on leads (report_type, created_at desc);
create table if not exists scrape_cache (domain text primary key, data jsonb not null, created_at timestamptz not null default now());
create table if not exists check_hits (ip text not null, at timestamptz not null default now());
create index if not exists check_hits_ip_at_idx on check_hits (ip, at);
```

**Interfaces:**
- Produces:
```ts
// store.ts
export type HfOutcome = "processing" | "sent" | "hobby" | "cant_see" | "invalid" | "limited" | "queued" | "retrying" | "held" | "failed";
export async function insertHfLead(i: { name: string; email: string; siteUrl: string; goal: string; ip: string | null; outcome: HfOutcome }): Promise<string>;
export async function updateHfLead(id: string, patch: Partial<{ outcome: HfOutcome; error: string; pdf_url: string; before_url: string; after_url: string; content: unknown; input_tokens: number; output_tokens: number; cost_usd: number; model: string; retry_count: number }>): Promise<void>;
export async function latestSentFor(email: string, domain: string, withinDays: number): Promise<{ id: string; pdf_url: string } | null>;
export async function getCachedCapture(domain: string, maxAgeDays = 7): Promise<Capture | null>;  // images stored as Blob URLs in jsonb, re-fetched into Buffers
export async function putCachedCapture(domain: string, c: Capture): Promise<void>;
// emails.ts
export function reportEmail(name: string, pdfUrl: string, attached: boolean): { subject: string; html: string; text: string };
export function cantSeeEmail(name: string, reason: "not_live" | "couldnt_load"): { subject: string; html: string; text: string };
export function hobbyEmail(name: string, compliment: string): { subject: string; html: string; text: string };
export function alertEmail(kind: "held" | "failed" | "cap", lead: { id: string; name: string; email: string; site_url: string; error?: string }): { subject: string; html: string; text: string };
// deliver.ts
export async function deliver(leadId: string, lead: { name: string; email: string; siteUrl: string; goal: string }, result: PipelineResult): Promise<void>;
export async function sendAlert(kind: "held" | "failed" | "cap", lead: {...}): Promise<void>;
```

Email copy (exact; Maggie may edit later; shared shell = the existing `deliveryEmailHtml` styling, without `&mdash;`):
- **Report** subject `{name}, your homepage fixes are ready`. Body: "Hi {name}," / "Your Top Homepage Fixes are ready. It's your own homepage, with your own photo and words, showing a new first section and two more opportunities to turn more visitors into inquiries." / (attached) "Your fixes are attached to this email, or you can view them online:" / button "See My Homepage Fixes" → pdfUrl / "If you'd love to see what it looks like to have your whole website built this way, I'd love to show you around on a Captured Sites Tour." link `https://capturedsites.com/tour/` / "Talk soon, Maggie, Captured Sites".
- **Can't see** subject `{name}, a quick note about your homepage fixes`. Body (`couldnt_load`): "Hi {name}," / "Thanks so much for asking for your homepage fixes. My homepage review tool couldn't load your homepage, so I wasn't able to make them this time." / "If your site lives at another address, just reply with the link and I'll take care of it." (`not_live`): "…it looks like your homepage isn't quite live yet, so I wasn't able to make them this time." / "Once it's live, come back to capturedsites.com/homepage-fixes and I'll make them for you." / Tour line / sign-off.
- **Hobby** subject `{name}, a little note about your website`. Body: "Hi {name}," / "{compliment}" / "It sounds like photography is something you love doing for yourself right now, so I won't fill your inbox with fixes. If it ever grows into something you want to take further, I'd love to help." / sign-off.
- Alert subject `[Homepage Fixes] {kind}: {name} ({site})` to `ALERT_EMAILS` (default `danluk1311@gmail.com`; add `maggie@capturedsites.com` for `held`), body lists lead id, email, site, error, dashboard link `https://captured-site-leads.vercel.app/dashboard`.

`deliver` per outcome: `sent` → `storePdf`-style upload to `homepage-fixes/<unique>/<pdfFileName>` plus before/after JPEGs, Resend send with attachment (fallback `sendPdfEmail` from `lib/mailerlite.ts` on error), MailerLite upsert with fields `name, site_url, pdf_url, goal, hf_outcome, hf_headline, hf_fix1_title, hf_fix2_title, hf_sent_date` in group `MAILERLITE_GROUP_ID`, update row (`outcome`, urls, content incl. facts sheet and notes_for_maggie, tokens, cost, model). `hobby`/`cant_see` → their email + MailerLite upsert (pdf_url empty). `held` → no photographer email, `sendAlert("held")`, store content+issues. MailerLite failure never blocks the email or the row update (log + continue).

- [ ] **Step 1: Write failing tests:**
  - `emails contain no dashes, no exclamation points, spell Captured Sites`, for all three templates.
  - `reportEmail mentions attachment only when attached`.
  - Review Focus 5: `subjects escape nothing and HTML escapes names` (`D'Andre` in subject literal; `<script>` name escaped in HTML).
  - `deliver sent: Resend called with attachment base64 and from maggie@capturedsites.com; MailerLite called with hf fields; row updated outcome sent with cost`.
  - `deliver falls back to MailerLite link email when Resend returns 500`.
  - `deliver skips attachment over 8 MB`.
  - `deliver held: no Resend call to the photographer; alert sent to both addresses`.
  - `deliver continues when MailerLite throws`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat(homepage-fixes): storage, delivery and email templates`.

---

### Task 9: On-page validation (check endpoint + page snippet)

**Files:**
- Create: `lib/homepage-fixes/validate.ts`, `lib/homepage-fixes/disposable-domains.ts` (bundled list, ~3,000 domains from the `disposable-email-domains` GitHub list, as a `Set<string>`), `app/api/homepage-fixes/check/route.ts`, `public/homepage-fixes-check.js`
- Test: `lib/homepage-fixes/validate.test.ts`, `app/api/homepage-fixes/check/route.test.ts`

**Interfaces:**
- Produces:
```ts
export type FieldCheck = { ok: boolean; code: string; message?: string; suggestion?: string };
export async function checkEmail(email: string, deps?: { resolveMx?: (d: string) => Promise<unknown[]>; resolve4?: (d: string) => Promise<string[]> }): Promise<FieldCheck>;
export async function checkWebsite(site: string, deps?: { lookup?: (h: string) => Promise<unknown>; fetchImpl?: typeof fetch }): Promise<FieldCheck & { url?: string }>;
export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T>;
```
Codes and messages (exact, from the spec):
- email `bad_syntax` "That email doesn't look quite right. Mind checking it?"; `no_mail` "That email address can't receive mail. Mind checking it?"; `disposable` "Please use an email you check, so your fixes reach you."; `typo` ok:true, message "Did you mean {suggestion}?"; `ok`; `timeout` ok:true.
- website `bad_url` / `no_such_site` / `not_loading` "We couldn't open that website. Mind checking the address?"; `placeholder` "Your site looks like it's still a coming soon page. Come back once your homepage is live and I'll make your fixes."; `ok`; `timeout` ok:true.
- Typo map: gmial, gmal, gmai, gnail → gmail.com; hotmial, hotmal → hotmail.com; yaho, yahooo → yahoo.com; iclod, icoud → icloud.com; outlok → outlook.com; TLD `.con`, `.cmo`, `.comm` → `.com`.

Route: `GET /api/homepage-fixes/check?email=&site=` (either or both), runs checks in parallel, each under `withDeadline(…, 2500, timeout)`, returns `{ email?: FieldCheck, site?: FieldCheck }`. CORS: `Access-Control-Allow-Origin` echoes the request origin only if it is `https://capturedsites.com` or `https://www.capturedsites.com` (plus `http://localhost:*` when `NODE_ENV !== "production"`); handle `OPTIONS`. Rate limit: 30 per IP per 10 minutes via `check_hits` (insert + count in one round trip; on DB error fail open); over → `429 { error: "slow_down" }` and the snippet treats 429 as pass. Not behind auth (add to the `proxy.ts` exemptions alongside `/api/lead`).

Website fetch: `unsafeUrlReason` first; DNS lookup; `GET` with browser UA, `redirect: "follow"`, read ≤ 512 KB; status ≥ 400 → `not_loading` except 403/429/503 with a bot-check body (Cloudflare "Just a moment", "Attention Required") → `ok` (let Firecrawl decide, per spec); placeholder regex `coming soon|under construction|launching soon|maintenance mode|domain (is )?for sale|buy this domain|parked free` on title + first 5,000 text chars.

Snippet `public/homepage-fixes-check.js` (vanilla, no deps, served from the app): finds `form[name="Your Top Homepage Fixes"]`, fields `#form-field-email` and `#form-field-site_url`; on blur and 600 ms after typing stops calls the endpoint for that field; shows the message in a `<div class="hf-check" role="status" aria-live="polite">` under the field (red `#b42318` for blocking, teal `#337A80` for suggestions; typo suggestion is a button that fills the field); disables the submit button until both fields have a passing result for their current value; intercepts `submit` (capture phase) and blocks it if either field is unchecked or failing, running the checks first if unchecked. Network errors, 429 and timeouts count as pass.

- [ ] **Step 1: Write failing tests** for every code above with injected deps (no network), `withDeadline` timing (fake timers), CORS allow/deny, OPTIONS, rate limit 31st request → 429, and the route answering under 3 s when a dep hangs (fake timers).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Manually: `npm run dev`, open a local HTML file that copies the live form markup (save it from `https://capturedsites.com/homepage-fixes/`) plus `<script src="http://localhost:3000/homepage-fixes-check.js">`, confirm: `bob@gmial.com` suggests gmail; `bob@nodomain-xyz123.com` blocks; `example.invalid` blocks; `gabbyjphotography.com` passes; submit button state follows.
- [ ] **Step 5: Commit** `feat(homepage-fixes): on-page email and website checks`.

---

### Task 10: Intake, limits, dedupe, queue, retries, CLI deliver

**Files:**
- Create: `app/api/homepage-fixes/route.ts`, `app/api/cron/homepage-fixes/route.ts`, `scripts/homepage-fixes-deliver.mts`, `lib/homepage-fixes/intake.ts`
- Modify: `app/api/lead/route.ts` (move `parseBody` and `authorized` into `lib/lead-intake.ts`; `POST /api/lead` now calls the same `handleHomepageFixes(req)` as the new route), `lib/abuse.ts` (`checkDailyLimits` gains `reportType` and filters by it; cap env per type: `HOMEPAGE_FIXES_DAILY_CAP` default 100), `vercel.json` (crons), `next.config.ts` (tracing for the three new routes), `proxy.ts` (exempt `/api/homepage-fixes`, `/api/homepage-fixes/check`, `/api/cron/homepage-fixes` — cron guarded by `CRON_SECRET` bearer)
- Test: `lib/homepage-fixes/intake.test.ts`

**Interfaces:**
- Consumes: `parseBody` (now also returns `goal` from `website_goal`), validators, store, pipeline, deliver.
- Produces:
```ts
export async function handleHomepageFixes(req: NextRequest): Promise<NextResponse>; // always 200 after auth; 401 only on bad secret
export async function processLead(leadId: string): Promise<void>;   // loads row, uses scrape cache, runs pipeline, delivers; on thrown error → retrying/failed per spec
export async function sweep(): Promise<{ queued: number; retried: number }>; // cron body
```
Behavior: insert row (`report_type 'homepage_fixes'`, `outcome 'processing'`) → server re-check email + website (no deadline pass-through here: use 5 s deadlines, and a timeout still passes) → invalid → `outcome invalid`, stop → limits (per email / per IP 3 per 24 h for this type) → over: if `latestSentFor(email, domain, 7)` exists re-send that PDF with `reportEmail`, outcome `limited` → global cap over: `queued` + `sendAlert("cap")` once per day (check `app_config` key `hf_cap_alert_date`) → dedupe: `latestSentFor(email, domain, 7)` → re-send, outcome `sent` with `pdf_url` copied → else `after(() => processLead(id))`. Errors in `processLead`: first → `outcome retrying`, `retry_count 1`; second → `failed`, `cantSeeEmail(name, "couldnt_load")`, `sendAlert("failed")`.
Crons in `vercel.json`: `{ "path": "/api/cron/homepage-fixes", "schedule": "*/15 * * * *" }` (retries: rows `retrying` older than 10 min with `retry_count = 1`) and `{ "path": "/api/cron/homepage-fixes?queue=1", "schedule": "0 12 * * *" }` (07:00 Eastern standard time = 12:00 UTC; processes `queued` oldest first up to the cap, max 20 per run, sequentially within `maxDuration`).
CLI `homepage-fixes-deliver.mts <lead-id> [edited-content.json]`: loads the row, uses edited content or stored `content`, re-renders (`renderAfter` + `fillReport` + `renderPdf`) from the cached capture, runs `checkContent` and prints issues (refuses to send on errors unless `--force`), then `deliver`.

- [ ] **Step 1: Write failing tests** (sql, pipeline and deliver mocked):
  - `bad secret → 401`; `valid form post → 200 and processLead scheduled`.
  - `website_goal is read from Elementor advanced-data form` (`fields[website_goal][value]`).
  - `invalid email server-side → outcome invalid, no email`.
  - Review Focus 4: `second submission same email+domain within 7 days re-sends the existing PDF, no pipeline run`; `two simultaneous posts produce one pipeline run` (second sees the first row `processing` for same email+domain within 10 minutes → outcome `limited`, no email).
  - `4th submission of the day → limited`.
  - `cap reached → queued, one cap alert per day`.
  - `processLead error once → retrying; twice → failed + cant-see email + alert`.
  - `/api/lead posts now run the homepage-fixes handler`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Local end-to-end: `npm run dev`, then the curl from the README pointed at `/api/homepage-fixes` with `{"name":"Dan","email":"danluk1311@gmail.com","site_url":"gabbyjphotography.com","website_goal":"More inquiries from couples and graduates"}`; confirm the email arrives from maggie@capturedsites.com with the PDF attached and the row shows `sent` with cost.
- [ ] **Step 5: Commit** `feat(homepage-fixes): intake, limits, dedupe, queue and retries`.

---

### Task 11: Dashboard, and retiring the roadmap generator

**Files:**
- Create: `app/dashboard/homepage-fixes-table.tsx`, `app/dashboard/[id]/page.tsx` (detail), `app/dashboard/emails/page.tsx` (Email setup), `app/dashboard/history/page.tsx` (Roadmap history)
- Modify: `app/dashboard/page.tsx` (Homepage Fixes is the default view: filter `report_type = 'homepage_fixes'`), `app/dashboard/nav-tabs.tsx` (tabs: Homepage Fixes `/dashboard`, Email setup `/dashboard/emails`, Roadmap history `/dashboard/history`), `app/api/leads/export` (add `report_type`, `goal`, `outcome`, `cost_usd` columns), `app/api/model/route.ts` + model picker (moved to Email setup page footer as "Report model")
- Delete: `lib/report.ts`, `lib/template.ts`, `lib/template-assets.ts`, `lib/agent-guide.ts`, `app/dashboard/guide/`, `app/api/guide/`, `app/api/test-generate/`, `app/api/email-provider/` and the guide/provider functions in `lib/guide-store.ts` (keep `getLiveModel`/`saveModel`), `lib/email-template.ts` roadmap copy (move the shared shell into `lib/homepage-fixes/emails.ts`)
- Test: `app/dashboard/emails/fields.test.ts`

**Spec for the screens** (match the existing dashboard styling: zinc cards, teal `#337a80` accents):
- **Homepage Fixes table:** columns Date, Name, Email, Website (link), Goal (truncate 60 chars, full on hover), Outcome (colored pill: sent green, hobby/cant_see amber, held/failed red, others zinc), PDF (link), Cost (`$0.0091` format), Opens/Clicks. Stats row: Reports sent (30 days), Not a fit / couldn't see, Held or failed, Average Gemini cost (30 days).
- **Detail page:** before.jpg and after.jpg side by side, `notes_for_maggie`, goal, all copy fields, the fact sheet in a `<pre>`, outcome and error, cost breakdown, and for `held` the issues list plus the CLI command to send it (`npx tsx scripts/homepage-fixes-deliver.mts <id>`).
- **Email setup page** (for Maggie, plain words, top to bottom):
  1. "What they've already received": the report email subject and body rendered from `reportEmail("Gabby", "#", true)`, with "Sent the moment their PDF is ready, so your automation should start with a wait, not an email."
  2. "Where your follow-ups run": group "Website Lead Generator", automation "Lead Generator Follow-ups", trigger "joins group", link `https://dashboard.mailerlite.com/automations`.
  3. "Fields you can use": table of `{$name}`, `{$site_url}`, `{$pdf_url}`, `{$goal}`, `{$hf_outcome}`, `{$hf_headline}`, `{$hf_fix1_title}`, `{$hf_fix2_title}`, `{$hf_sent_date}` with what each holds and the value from the latest `sent` lead; then the personalization-menu tip from `docs/mailerlite-emails.md`.
  4. "Who joins": counts by `hf_outcome` for the last 30 days, and "Add a condition step on hf_outcome = sent before any email that talks about their fixes, so people who got a hobby or couldn't-load note don't get them."
  5. "Voice reminders": no dashes, no agency words (list), "Captured Sites" spelled exactly, homepage only, Tour link `https://capturedsites.com/tour/`.
  6. "How the report email is doing": opens and clicks rate for the last 30 days.
- **Roadmap history:** the old leads table, read-only, filter `report_type = 'roadmap'`.

- [ ] **Step 1: Write failing test** `fields.test.ts`: `emailSetupFields(latestLead)` returns the 9 fields in order, each with a non-empty description, and example values taken from the lead's `content` (`hf_fix1_title` = `content.fixes[0].title`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement screens and deletions. **Step 4:** `npm run check` → PASS (no imports of deleted files remain: `grep -rn "agent-guide\|lib/report\|lib/template" app lib` returns nothing). Run `npm run dev`, sign in, and view all three tabs and one detail page with the Task 10 test lead.
- [ ] **Step 5: Commit** `feat(dashboard): Homepage Fixes, Email setup and Roadmap history; retire roadmap generator`.

---

### Task 12: Go-live kit

**Files:**
- Create: `scripts/mailerlite-hf-fields.mts` (creates text fields `goal`, `hf_outcome`, `hf_headline`, `hf_fix1_title`, `hf_fix2_title`, `hf_sent_date` via `POST /api/fields` if missing; idempotent; prints what it did), `docs/homepage-fixes-go-live.md`
- Modify: `README.md` (flow line and endpoints table now describe homepage fixes; mention the go-live doc)

`docs/homepage-fixes-go-live.md` checklist (exact steps):
1. Neon: run the Task 8 schema block in the SQL editor; confirm with `\d leads`.
2. MailerLite: `npx tsx scripts/mailerlite-hf-fields.mts`.
3. Resend: in the capturedsites.com domain's Configuration tab, confirm Open and Click tracking are on; confirm the webhook to `/api/webhook/resend` exists.
4. Vercel env: `CRON_SECRET`, `HOMEPAGE_FIXES_DAILY_CAP=100`, `ALERT_EMAILS`; set the live model to `google/gemini-3.8-flash` on the dashboard.
5. Elementor, homepage-fixes page: Actions After Submit → Webhook `https://captured-site-leads.vercel.app/api/homepage-fixes?secret=<LEAD_WEBHOOK_SECRET>`; Advanced Data ON; add Honeypot field; remove any MailerLite action; success message "You're all set. Your homepage fixes are being made right now, check your inbox in a few minutes."; add an HTML widget anywhere on the page with `<script src="https://captured-site-leads.vercel.app/homepage-fixes-check.js" defer></script>`.
6. Test with a real submission to Dan's email; confirm PDF, dashboard row, MailerLite subscriber fields.
7. Pre-launch: 10-site batch with `scripts/homepage-fixes-run.mts`, PDFs to Maggie for review.
8. After Maggie approves and step 6 passes: Rank Math → Redirections: 301 from the Free Audit page URL to `/homepage-fixes/`.

- [ ] **Step 1:** Write the script with a `--dry-run` flag; run `--dry-run` → prints the 6 fields as "would create" or "exists".
- [ ] **Step 2:** Write the doc and README changes.
- [ ] **Step 3:** `npm run check` → PASS.
- [ ] **Step 4: Commit** `docs: homepage fixes go-live kit`.
- [ ] **Step 5:** Hand the go-live checklist to Dan (steps 1 to 5 change live systems; do them only with his go-ahead).
