import { generateObject } from "ai";
import { z } from "zod";
import { renderReportHtml, type ReportCopy } from "./template";
import { getLiveGuide } from "./guide-store";

const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

const copySchema = z.object({
  opportunities: z
    .array(
      z.object({
        headline: z
          .string()
          .describe(
            "Short, plain-language opportunity title, e.g. \"Proof is buried, so the price arrives before the trust\""
          ),
        noticed: z
          .string()
          .describe(
            "WHAT I NOTICED: 2-4 specific, observational sentences referencing actual homepage elements from the scrape"
          ),
        whyItMatters: z
          .string()
          .describe(
            "WHY IT MATTERS: 2-3 sentences connecting the gap to the client's specific pain outcome"
          ),
        fixFraming: z
          .string()
          .describe(
            "One line framing the fix as the Captured Sites homepage build, e.g. \"A hero and guide section built to make you the only choice:\""
          ),
        fixes: z
          .array(z.string())
          .length(3)
          .describe("HOW TO MAKE IT RIGHT: 3 bullets of direction and what good looks like"),
      })
    )
    .length(3)
    .describe("Exactly 3 prioritized homepage opportunities, ordered by impact on the stated pain"),
});

export async function generateReportHtml(input: {
  name: string;
  siteUrl: string;
  scrapedMarkdown: string;
  pain?: string;
}): Promise<string> {
  const context = (await getLiveGuide()).value;

  const { object } = await generateObject({
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    schema: copySchema,
    system: context,
    prompt: `Photographer: ${input.name}
Homepage: ${input.siteUrl}
Stated goal / pain: ${input.pain?.trim() || "(not stated — infer from the site, default toward more of the right inquiries)"}

Diagnose the homepage below against the framework and produce the 3 opportunities.

Scraped homepage content:
---
${input.scrapedMarkdown}
---`,
  });

  return renderReportHtml({
    name: input.name,
    siteUrl: input.siteUrl,
    copy: object as ReportCopy,
    ctaUrl: process.env.CTA_URL || "https://capturedsites.com/tour/",
  });
}
