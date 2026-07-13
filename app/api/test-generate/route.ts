import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { scrapeSite } from "@/lib/scrape";
import { generateReportHtml } from "@/lib/report";
import { htmlToPdf } from "@/lib/pdf";
import { storePdf } from "@/lib/storage";
import { unsafeUrlReason } from "@/lib/abuse";
import { leadName, leadPain, leadSiteUrl } from "@/lib/lead-fields";

export const maxDuration = 300;

const testSchema = z.object({
  name: leadName,
  site_url: leadSiteUrl,
  pain: leadPain,
});

// Runs scrape → LLM (current live guide) → PDF and returns the PDF URL.
// No lead row, no MailerLite, no email — a pure tuning loop for the guide.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = testSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { name, site_url, pain } = parsed.data;

  const urlProblem = unsafeUrlReason(site_url);
  if (urlProblem) {
    return NextResponse.json({ error: `Rejected URL: ${urlProblem}` }, { status: 400 });
  }

  try {
    const scraped = await scrapeSite(site_url);
    const { html: reportHtml, model } = await generateReportHtml({
      name,
      siteUrl: site_url,
      scrapedMarkdown: scraped,
      pain,
    });
    const pdf = await htmlToPdf(reportHtml);
    const pdfUrl = await storePdf(pdf, { name, folder: "test-reports" });
    return NextResponse.json({ pdf_url: pdfUrl, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
