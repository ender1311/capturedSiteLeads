# Maggie's diagnostic lens

Run this checklist on every homepage, before or alongside the pain-mechanism diagnosis in
`diagnosis-by-pain.md` — even when Maggie hasn't given her own notes. It's distilled from repeated
corrections across real projects (Sammi Stallings, Zachery Means, Kristina Robinson, Julia Capell,
Elena Gera) and represents what she actually looks for, independent of any one site's specifics.
Treat it as a lens to look through, not a script — not every item will produce a real finding on
every site, and a genuine finding still has to clear the hard rules (never invent a gap, verify at
real screen sizes, etc.) in the main SKILL.md.

## 1. The hero, checked first

Before anything else: is there a clear call-to-action in the hero itself (not just the nav), and is
the orienting copy (who she serves, where, what she does) actually legible and present at real
screen sizes — laptop (1440×900) first, then desktop and mobile? This is where her diagnosis starts
almost every time. A hero with a beautiful photo and no CTA, or text that's hard to read against the
image, is consistently opportunity #1 or #2.

## 2. CTA reinforcement, not just CTA presence

One CTA somewhere on the page doesn't satisfy this. Scan the whole scroll for how often and where
calls-to-action appear. Two specific failure patterns she's flagged repeatedly:
- Long stretches of the page (a full guide section, a bulleted "what to expect" list) pass with zero
  reinforcement of the CTA that appeared in the hero.
- Right after the single highest-conviction moment on the page (a "we're a great fit if you..." list,
  a testimonial, the guide section), the next thing visitors meet is a *secondary* offer or a link
  that leads away, not the main ask. That's the moment she's most likely to be convinced — the next
  click should capture that, not redirect it.

## 3. Sequencing — trust before the ask, people before philosophy

Two recurring sequencing problems:
- **Trust-building content placed after the exits.** If portfolio-category buttons or an embedded
  contact form appear before any guide/bio/testimonial content, visitors decide whether to leave
  before they've been given a reason to stay.
- **Personal introduction buried after abstract copy.** If a page opens with philosophy or mood copy
  ("this season moves quickly...") before the visitor knows whose voice they're hearing, move the
  name/photo/introduction earlier — people connect with a person before a philosophy.

## 4. Real visual hierarchy, not assumed hierarchy

Don't judge what's "the headline" from a screenshot alone. Pull actual computed `font-size` and
`font-weight` for the candidate headline-like elements (`getComputedStyle` via `javascript_tool`).
Look specifically for a **logistics or administrative line outsizing the compelling, persuasive
line** — e.g. "Now accepting bookings for 2026" rendered larger than "Ready to make memories?" This
is a distinct, specific finding worth its own opportunity when it happens, and the numbers make the
case for you (a screenshot alone won't). Keep the numbers private: the roadmap says "your booking
line is bigger than your headline," never "33px vs. 12px" ("you're making it too technical, no one
cares").

## 5. Coherence — does the page read as one thing?

Check for: a consistent voice (does it say "we" in the hero and "I" in the About section?), a
consistent visual/heading style section to section, and a sensible order (who you are → what you
offer → proof → how to start). A page can have zero broken elements and still feel "pieced
together" if these are inconsistent — that's a real, distinct opportunity, not a nitpick, when it's
present. Name the specific inconsistency (the voice shift, the mismatched heading styles), don't
just assert "it feels inconsistent."

## 6. A visible services/offerings summary

Check whether the homepage itself (not just a page reachable through the nav) tells a visitor what
she actually offers, with a clear next step to learn more about each. A "Services" nav link is not
the same as a homepage section — if the only service-shaped content on the homepage is a single
promo for an add-on (e.g., a Photo+Video bundle), that's a gap: the core offerings aren't shown, and
the one thing that is shown is secondary.

## 7. Is it easy to skim?

The most common thing the AI missed in the Nov 2 accuracy test (Maggie's top point on two sites).
Look for: paragraphs running the full width of the screen, long blocks of text with no headings or
bullets, three or more text-only sections in a row, a homepage gallery longer than about two
screens, or a slow scroll animation that makes the visitor wait. When it's there, it's a real
finding: put it in the journey opportunity (or the first-section one if it's in the hero), framed
with the "decision cost" rule in SKILL.md, not as a formatting note.

## 8. Is the About section about them?

Read the guide/About copy sentence by sentence. If most of it is the photographer's passion,
history or style, and little names what the client wants, worries about or will feel, that's
opportunity #2's finding. Maggie's words: "it feels more from your point of view than your
visitor's." The fix connects the dots: their background, and what it means for this client.

## How this relates to the pain-lens diagnosis

This checklist finds *candidate* opportunities. The pain-mechanism diagnosis in
`diagnosis-by-pain.md` still decides which ones matter most and how to rank them for a given
client's stated pain. A hero CTA gap found via this checklist, for instance, gets framed differently
for a ghosting client (a conviction/trust problem) than for a low-inquiry-volume client (a funnel
problem) — this lens tells you *where to look*, not how to write the "why it matters."
