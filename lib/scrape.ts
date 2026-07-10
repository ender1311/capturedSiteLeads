import { Firecrawl } from "@mendable/firecrawl-js";

const MAX_SCRAPE_CHARS = 40_000;

export async function scrapeSite(siteUrl: string): Promise<string> {
  const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });

  const doc = await firecrawl.scrape(siteUrl, {
    formats: ["markdown"],
    onlyMainContent: false,
    timeout: 60_000,
  });

  const markdown = doc.markdown ?? "";
  if (!markdown.trim()) {
    throw new Error(`Firecrawl returned no content for ${siteUrl}`);
  }

  // Cap what we feed the LLM to keep token costs predictable
  return markdown.length > MAX_SCRAPE_CHARS
    ? markdown.slice(0, MAX_SCRAPE_CHARS)
    : markdown;
}
