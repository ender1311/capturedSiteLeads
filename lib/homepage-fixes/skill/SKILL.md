---
name: your-top-homepage-fixes
description: Make a photographer's personalized "Your Top Homepage Fixes" PDF, Captured Sites' free AI-made report, from three inputs - their first name, their website, and their goal (their answer to "What would you love your website to do for you?"). Captures the homepage, diagnoses it with Maggie's Dream Client Roadmap lens, writes the new first section and two fixes in Maggie's voice, mocks up the new first section with a real photo from their site, and renders the 9-page PDF in the current approved design. Use whenever Maggie says "make the freebie for X," "run Your Top Homepage Fixes on this site," "update the freebie for [name]," or hands over a name, website and goal, including batch tests on several sites. Not for the live Dream Client Roadmap call deliverable (that is dream-client-roadmap).
---

# Your Top Homepage Fixes

Inputs: **first name**, **website**, **goal**. Output: a 9-page PDF in the approved Nov 3 design,
plus a PNG of every page for checking. Nothing is ever sent to the photographer; Maggie (or the
automation she approves) delivers it.

Read `references/freebie-rules.md` in full before writing anything. It says exactly what changes
per person and the rules each field must pass. The diagnosis uses `references/maggie-diagnostic-lens.md`
and `references/diagnosis-by-pain.md` (copies from the dream-client-roadmap skill; if that skill is
installed, its versions win).

## Setup (once)
The scripts need Node 18+ and Playwright with Chromium. If `node scripts/capture.mjs` says Playwright
isn't found: `npm i playwright && npx playwright install chromium` in any folder, then set
`PLAYWRIGHT_DIR` to that folder. On Maggie's Mac it's already in `~/.claude-browser`.

## Steps

1. **Make a job folder.** In Maggie's Captured Assets Build repo use
   `areas/content/drafts/homepage-fixes-runs/<first-name>-<domain>/`; anywhere else, a new folder in
   the working directory.

2. **Capture.** `node <skill>/scripts/capture.mjs <website> <job-folder>`
   It saves `before.jpg` (laptop first screen), `screens/` (every laptop screen down plus the phone
   first screen), `text.txt` (every line in page order with font size, weight, font and where links
   go, with each link's status), `photos/` (their own photos, largest first, first-screen ones
   first), `logo.*`, and `capture.json` (fonts, nav, photos, buttons, flags, notes).

3. **Fit check. Stop here** if `capture.json` has any flag (BOT_CHECK, COMING_SOON,
   TOO_LITTLE_TEXT) or `before.jpg` shows a popup or a blank hero: tell Maggie in one line which
   and why, and write nothing for the photographer. Never try to get past a bot check. Pixieset
   sites often block capture (Dan owns the workaround).

4. **Look at the whole homepage.** View `before.jpg`, every file in `screens/`, and read
   `text.txt` top to bottom. Note: what the first screen says and how big each line is, where every
   button goes (and any that don't load), the About/intro copy, testimonials and who wrote them,
   what comes right after the most convincing moment, how long and skimmable the page is, small
   polish issues. Only claim what you saw at laptop size unless the phone screen shows it too.

5. **Diagnose.** Restate their goal in one line. Run the lens, then the pain mechanism, and land on
   the shape in `freebie-rules.md`: the first section (always the top fix), then Fix #1 and Fix #2.
   Write the reasoning in a few lines for `notes_for_maggie`.

6. **Write `content.json`** in the job folder, following `references/content-schema.md`. Pick the
   photo: open the candidates in `photos/` and choose their current hero photo or their strongest
   people photo, then set `photo_focus`. Copy their nav items, logo, fonts. Write every line in
   Maggie's voice per `freebie-rules.md`.

7. **Build.** `node <skill>/scripts/build.mjs <job-folder>`
   It checks the copy (dashes, brackets, banned words, email advice, technical numbers, lengths,
   she/her), builds `after.jpg`, fills the template and renders `<file>.pdf` and `pages/page-N.png`.
   Fix every error it prints. Read every warning and fix it unless it's their own quoted words.
   If it reports overflow, shorten that text and build again.

8. **Look before you hand it over.** View `after.jpg` and `pages/page-1.png`, `3`, `4`, `5`, `6`.
   Check: the photo is theirs and faces aren't cut off; the headline is readable over the photo
   (if not, change `layout`, `photo_focus` or pick another photo); text fits every box; the new
   first section looks like their site, not ours. Rebuild until it's right.

9. **Report back** in a few lines: the PDF path, the three opportunities in one line each, where
   the headline came from, and anything you couldn't verify. When Maggie is checking a batch (like
   the 10-site test before launch), list each site with a pass or a short note.

## Batch runs
Run steps 1 to 9 per site. Do one first and show Maggie before doing the rest, unless she said to
run them all. Keep each site in its own job folder.

## When the design changes
The fixed pages live in `template/report.html` and must match Maggie's current approved freebie
(canvas page "✅ Current freebie (Nov 3)", which matches `areas/content/drafts/your-top-homepage-fixes-gabby-sample.pdf`).
When she changes the design, update the template from the new version: keep the `{{...}}` slots,
and rebuild `examples/gabby` to check it still matches her PDF.
