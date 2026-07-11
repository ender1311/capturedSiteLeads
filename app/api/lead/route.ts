import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { scrapeSite } from "@/lib/scrape";
import { generateReportHtml } from "@/lib/report";
import { htmlToPdf } from "@/lib/pdf";
import { storePdf } from "@/lib/storage";
import { addSubscriber } from "@/lib/mailerlite";
import { sendReportEmail } from "@/lib/email";
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
// Elementor webhook action. Elementor field IDs vary, so extraction is
// tolerant: exact keys first, then fuzzy key/value matching.
async function parseBody(req: NextRequest): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return req.json().catch(() => null);
  }
  const form = await req.formData().catch(() => null);
  if (!form) return null;

  const fields: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value !== "string") return;
    // unwrap Elementor's advanced-data shape: form_fields[xyz] -> xyz
    const clean = key.replace(/^form(?:_fields)?\[(.+)\]$/, "$1");
    fields[clean.toLowerCase()] = value.trim();
  });

  const byKey = (re: RegExp) =>
    Object.entries(fields).find(([k, v]) => re.test(k) && v)?.[1];
  const byValue = (re: RegExp) =>
    Object.values(fields).find((v) => re.test(v));

  const email =
    fields["email"] ?? byKey(/e[-_]?mail/) ?? byValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const site_url =
    fields["site_url"] ??
    byKey(/url|website|site/) ??
    Object.values(fields).find(
      (v) => v !== email && /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(v) && !v.includes("@")
    );
  const name = fields["name"] ?? byKey(/name/) ?? undefined;

  if (!email || !site_url || !name) {
    console.warn("Lead form keys received:", JSON.stringify(Object.keys(fields)));
  }
  return { name, email, site_url };
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
      await sendReportEmail({ name, email, pdfUrl, pdf });
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

  // 200 (not 202) — Elementor's webhook action treats any non-200 as failure
  return NextResponse.json({ id: lead.id, status: "processing" });
}
