import { NextRequest, NextResponse, after } from "next/server";
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
  site_url: z
    .string()
    .min(4)
    .transform((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
    .pipe(z.string().url()),
});

function authorized(req: NextRequest): boolean {
  const secret = process.env.LEAD_WEBHOOK_SECRET;
  if (!secret) return false;
  return (
    req.headers.get("x-lead-secret") === secret ||
    req.nextUrl.searchParams.get("secret") === secret
  );
}

// Accepts JSON ({name, email, site_url}) or form-encoded posts from the
// Elementor webhook action (field custom IDs must be name/email/site_url).
async function parseBody(req: NextRequest): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return req.json().catch(() => null);
  }
  const form = await req.formData().catch(() => null);
  if (!form) return null;
  const pick = (key: string) =>
    form.get(key) ?? form.get(`form_fields[${key}]`) ?? undefined;
  return { name: pick("name"), email: pick("email"), site_url: pick("site_url") };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = leadSchema.safeParse(await parseBody(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { name, email, site_url } = parsed.data;
  const supabase = supabaseAdmin();

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert({ name, email, site_url, status: "processing" })
    .select("id")
    .single();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Respond immediately (Elementor webhooks time out quickly); the
  // scrape → report → PDF → email pipeline continues after the response.
  after(async () => {
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
      await supabase
        .from("leads")
        .update({ pdf_url: pdfUrl, status: "complete" })
        .eq("id", lead.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Lead pipeline failed:", message);
      await supabase
        .from("leads")
        .update({ status: "failed", error: message })
        .eq("id", lead.id);
    }
  });

  return NextResponse.json({ id: lead.id, status: "processing" }, { status: 202 });
}
