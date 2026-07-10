import { generateText } from "ai";

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

const DEFAULT_REDESIGN_CONTEXT = `
You are writing on behalf of Maggie, a professional web designer who helps small
businesses modernize their websites. Maggie's redesigns focus on: clear messaging
above the fold, mobile-first responsive layouts, fast load times, accessible
typography and color contrast, strong calls-to-action, and SEO fundamentals.
The report should be encouraging and specific to THIS site — never generic.
It is a free teaser that demonstrates value and invites the reader to work
with Maggie for the full redesign.
`.trim();

export async function generateReportHtml(input: {
  name: string;
  siteUrl: string;
  scrapedMarkdown: string;
}): Promise<string> {
  const context = process.env.REDESIGN_CONTEXT?.trim() || DEFAULT_REDESIGN_CONTEXT;

  const { text } = await generateText({
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    system: `${context}

You produce a complete, self-contained HTML document (inline <style> only, no
external assets, no JavaScript) styled for print/PDF on A4: clean sans-serif
typography, generous margins, a title page header, and clearly separated
sections. Output ONLY the HTML document — no markdown fences, no commentary.`,
    prompt: `Create a website redesign proposal report for ${input.name}'s website (${input.siteUrl}).

The report must include:
1. A short personalized intro addressed to ${input.name}.
2. "What's Working" — 2-3 genuine strengths of the current site.
3. "Redesign Opportunities" — 4-6 specific, prioritized improvements with the reasoning behind each (reference actual content/structure from the site).
4. "What a Redesign Could Look Like" — a brief vision of the modernized site.
5. A closing call-to-action to reply and schedule a free consult with Maggie.

Current site content (scraped):
---
${input.scrapedMarkdown}
---`,
  });

  // Strip accidental markdown fences if the model adds them anyway
  return text.replace(/^```html?\s*/i, "").replace(/```\s*$/, "").trim();
}
