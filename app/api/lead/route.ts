import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { scrapeSite } from "@/lib/scrape";
import { generateReportHtml } from "@/lib/report";
import { htmlToPdf } from "@/lib/pdf";
import { storePdf } from "@/lib/storage";
import { addSubscriber } from "@/lib/mailerlite";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 300;

const leadSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  site_url: z.string().url(),
});

export async function POST(req: NextRequest) {
  if (req.headers.get("x-lead-secret") !== process.env.LEAD_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = leadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { name, email, site_url } = parsed.data;
  const supabase = supabaseAdmin();

  try {
    const scraped = await scrapeSite(site_url);
    const reportHtml = await generateReportHtml({
      name,
      siteUrl: site_url,
      scrapedMarkdown: scraped,
    });
    const pdf = await htmlToPdf(reportHtml);
    const pdfUrl = await storePdf(pdf, email);
    await addSubscriber({ name, email, siteUrl: site_url, pdfUrl });

    const { data, error } = await supabase
      .from("leads")
      .insert({ name, email, site_url, pdf_url: pdfUrl, status: "complete" })
      .select("id")
      .single();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);

    return NextResponse.json({ id: data.id, pdf_url: pdfUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Lead pipeline failed:", message);

    // Record the lead even when the pipeline fails so it can be retried manually
    await supabase
      .from("leads")
      .insert({ name, email, site_url, status: "failed", error: message })
      .then(({ error }) => {
        if (error) console.error("Failed-lead insert also failed:", error.message);
      });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
