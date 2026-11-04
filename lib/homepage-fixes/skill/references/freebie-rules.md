# Your Top Homepage Fixes: what goes on each page and how to write it

The report is 9 pages. Only pages 1, 3, 4, 5 and 6 change per person, and only in the spots below.
Everything else is Maggie's approved copy (Nov 3 version, canvas page "✅ Current freebie (Nov 3)")
and lives in `template/report.html`. Never rewrite the fixed pages for one person.

| Page | What's personal | Field in content.json |
|---|---|---|
| 1 Cover | The new first section on the computer screen | `first_section` (built into after.jpg) |
| 2 What I do | Nothing | |
| 3 The strategy in action | The new first section, bigger | `first_section` |
| 4 Can you see the difference? | Today (before.jpg) next to the new first section, and three "What I changed for you" notes | `first_section_changes` |
| 5 Fix #1 | Title, What I noticed, Why it matters, 3 changes | `fixes[0]` |
| 6 Fix #2 | Same, plus a fixed Tour box | `fixes[1]` |
| 7 to 9 | Nothing (strategy, Maggie's bio, client results, Tour buttons) | |

## The three opportunities
Diagnose like a Dream Client Roadmap (`maggie-diagnostic-lens.md`, then `diagnosis-by-pain.md`),
with the goal they typed in as the pain. Default shape (Maggie, Nov 2): very rarely does a homepage
do all three well.
1. **The first section: win trust right away.** This is always the top fix in this report, shown as
   the new first section on pages 3 and 4, not written up as a fix page.
2. **The About section: connect the dots** between their background and what their client wants.
   Usually Fix #1.
3. **An intentional customer journey:** what's missing that guides the visitor to inquire (calls to
   action after high-trust moments, a steps section, a clear portfolio or services section,
   testimonials placed where they help, a page that's easy to skim). Usually Fix #2.

If one is genuinely strong already, say so warmly in the nearest "What I noticed" and use that slot
for the next-biggest real gap. Never invent a gap. Fix #1 and Fix #2 must be distinct.

## The new first section (pages 1, 3, 4)
- **A real photo from their own website**, ideally their current hero photo (Maggie, Nov 3: locked).
  Pick from `photos/`. Never a stock or AI photo. Set `photo_focus` so faces aren't cut off.
- **Match their site:** their fonts (`capture.json` fonts), their nav items in their order, their
  logo or business name, nav at the top or bottom like their site. It should look like their site
  on a better day, not like a Captured Sites template.
- **Headline: their words, their warmth.** Build it from a line they already wrote (intro, About,
  a testimonial theme). Short: 3 to 8 words. Never generic ("Timeless Wedding Photography").
- **Subline: what they shoot and where,** using only facts on their site. If the location isn't
  anywhere on the site, leave it out of the mockup and say in change note 2: "Add where you're
  based, right under your headline." Never print a fill-in.
- **One button,** in their own button wording if they have one that goes to their inquiry form,
  otherwise a warm plain one ("Reach Out", "Get in Touch", "Check My Date").
- **Take away before you add.** If the hero is busy (extra taglines, two buttons, social links, a
  huge name), the new version drops them. At least one change note should name what you removed.
- **Keep what already works.** If their headline already says who and what, keep it and say so in
  note 1 ("Your headline already does this, so I kept it."). Spend the changes on what's missing.

## The three "What I changed for you" notes (page 4)
They answer the fixed "What top sites do" lines, in this order:
1. Their headline helps visitors understand what makes the photographer different, in their voice.
2. They say what they shoot and where, big enough to read at a glance.
3. They give one clear next step on the first section.

Each note: what it was on their site today, in their words or a plain description, then what it is
now and why it helps the visitor. 1 to 2 sentences, 190 characters or fewer.
Gabby, note 1: "Photography for all steps of life" became "Your friend with the camera," built from your
own intro, so visitors feel your warmth right away.

## Fix pages (5 and 6)
- **Title:** names the opportunity, positive, never the fix or the problem. Up to 52 characters.
  Good: "Let your story show what sets you apart", "Turn your warmest visitors into inquiries".
  Rejected: "Give couples an easy-to-read page" (a fix), "There's no proof on the homepage" (a problem).
- **What I noticed** (about 250 to 360 characters): start with a real, specific strength (quote
  them, name a client from a testimonial), then the gap in concrete terms from their actual page:
  literal lines, what's biggest, where a button goes, what comes right after the best moment.
  Small polish issues (typos, a link that goes nowhere, a cut-off logo) go here warmly: "a few
  small details aren't quite doing your work justice yet."
- **Why it matters** (about 150 to 260 characters): the consequence for the visitor, tied to their
  goal. No generic "this could cost you inquiries."
- **What I'd change:** exactly 3 checkbox lines, each one doable change on the homepage, 130
  characters or fewer, naming the section (first section, About, testimonials, steps, portfolio).

## Hard rules (build.mjs checks most of these)
- Homepage only. Never "your whole site."
- Never invent a story, result, quote or fact. Quote their site exactly.
- Website visitors are "the visitor" with they/their, never "she."
- No technical numbers (pixels, percentages, character counts). "More than twice as large," "a
  long way down the page."
- No em or en dashes, no brackets or fill-ins, no exclamation points except inside their quotes.
- Never recommend adding pricing. One price point at most, only when the price shows in the first
  screens.
- No email list, newsletter or freebie advice.
- No agency words: audit, conversion, funnel, optimize, leverage, elevate, seamless, curated.
- Never imply Maggie looked at the site by hand. The report says it was made with her homepage
  review process and AI (page 9 footer). Don't add "I spent time on your site" lines.
- Business name exactly "Captured Sites."

## Voice
Maggie's "I" talking to the photographer as "you": a warm friend who happens to be an expert.
Short connected sentences, everyday words, affirm first, believe the best about them. If Maggie's
`captured-sites-copy-playbook` skill is available, read it before writing; its bans apply.

## Calibration
`examples/gabby/content.json` is Maggie's approved report (her PDF matches it). Match its depth and
tone; don't reuse its lines.
