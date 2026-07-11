import { generateObject } from "ai";
import { z } from "zod";
import { renderReportHtml, type ReportCopy } from "./template";

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

const DEFAULT_REDESIGN_CONTEXT = `
You write on behalf of Maggie at Captured Sites, who builds done-for-you,
SEO-ready websites exclusively for photographers. The "Dream Client Roadmap"
framework: a converting photographer site answers five visitor questions in
order — What can you do for me? (hero) / Why should I trust you? (guide) /
What is it like to work with you? (portfolio) / Have you done this before?
(testimonials) / How do I get started? (steps). Findings must be specific to
THIS site — reference its actual content, never generic. Tone: warm, expert,
encouraging; photography metaphors welcome (e.g. "like editing a RAW photo").
This is a free teaser that demonstrates value and builds trust.
Write plain prose only — no markdown, no asterisks, no emphasis markers,
no quotes around site text.
`.trim();

const copySchema = z.object({
  opportunities: z
    .array(
      z.object({
        headline: z
          .string()
          .describe(
            "Punchy opportunity headline, 6-12 words, e.g. \"Your proof is buried, so the price arrives before the trust\""
          ),
        noticed: z
          .string()
          .describe(
            "WHAT I NOTICED: 2-3 sentences describing what's actually on their site right now, referencing specific content"
          ),
        whyItMatters: z
          .string()
          .describe(
            "WHY IT MATTERS: 2-3 sentences on how this costs them inquiries/bookings from dream clients"
          ),
        fixes: z
          .array(z.string())
          .length(3)
          .describe("HOW TO MAKE IT RIGHT: 3 concrete, actionable fixes, one sentence each"),
      })
    )
    .length(3)
    .describe("Exactly 3 prioritized redesign opportunities"),
});

export async function generateReportHtml(input: {
  name: string;
  siteUrl: string;
  scrapedMarkdown: string;
}): Promise<string> {
  const context = process.env.REDESIGN_CONTEXT?.trim() || DEFAULT_REDESIGN_CONTEXT;

  const { object } = await generateObject({
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    schema: copySchema,
    system: context,
    prompt: `Analyze ${input.name}'s website (${input.siteUrl}) against the Dream Client Roadmap framework and produce the 3 highest-impact redesign opportunities.

Scraped site content:
---
${input.scrapedMarkdown}
---`,
  });

  return renderReportHtml({
    name: input.name,
    siteUrl: input.siteUrl,
    copy: object as ReportCopy,
    ctaUrl: process.env.CTA_URL || "https://capturedsites.com",
  });
}
