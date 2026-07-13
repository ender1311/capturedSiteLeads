import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { scrapeSite } from "@/lib/scrape";
import { generateReportHtml } from "@/lib/report";
import { htmlToPdf } from "@/lib/pdf";
import { storePdf } from "@/lib/storage";
import { addSubscriber } from "@/lib/mailerlite";
import { sendReportEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase";
import { checkDailyLimits, normalizeEmail, secretMatches, unsafeUrlReason, visitorIp } from "@/lib/abuse";
import { leadEmail, leadName, leadPain, leadSiteUrl } from "@/lib/lead-fields";

export const maxDuration = 300;

const leadSchema = z.object({
  name: leadName,
  email: leadEmail,
  site_url: leadSiteUrl,
  pain: leadPain,
});

// The ?secret= fallback exists because Elementor's webhook action can't set
// custom headers. Query strings can land in logs — prefer the header wherever
// the caller supports it, and rotate LEAD_WEBHOOK_SECRET if it ever leaks.
function authorized(req: NextRequest): boolean {
  const secret = process.env.LEAD_WEBHOOK_SECRET;
  if (!secret) return false;
  return (
    secretMatches(req.headers.get("x-lead-secret"), secret) ||
    secretMatches(req.nextUrl.searchParams.get("secret"), secret)
  );
}

// Accepts JSON ({name, email, site_url}) or form-encoded posts from the
// Elementor webhook action. Elementor field IDs vary, so extraction is
// tolerant: exact keys first, then fuzzy key/value matching.
async function parseBody(req: NextRequest): Promise<{
  body: unknown;
  rawFields: Record<string, string>;
  meta: Record<string, string>;
  isForm: boolean;
}> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return { body: await req.json().catch(() => null), rawFields: {}, meta: {}, isForm: false };
  }
  const form = await req.formData().catch(() => null);
  if (!form) return { body: null, rawFields: {}, meta: {}, isForm: true };

  // Elementor sends different shapes depending on "Advanced Data":
  //   off -> name=Dan                              (flat)
  //   on  -> fields[email][value]=…  fields[email][id]=…  fields[field_abc][value]=…
  //          form[name]="New Form"  meta[remote_ip]=…  meta[page_url]=…
  // Normalize into a flat map keyed by field id. The `[value]` sub-key is
  // authoritative; `[id]/[type]/[title]` metadata is dropped; the `form[...]`
  // namespace (form-level metadata) is ignored so "New Form" can't pollute
  // the lead's name. The `meta[...]` namespace is kept SEPARATE from fields:
  // meta carries the visitor IP, but also page_url (the page hosting the
  // form), which must never win the fuzzy site_url match below.
  const fields: Record<string, string> = {};
  const meta: Record<string, string> = {};
  form.forEach((rawValue, key) => {
    if (typeof rawValue !== "string") return;
    const value = rawValue.trim();
    if (!value) return;

    const parts = [...key.matchAll(/([^[\]]+)/g)].map((m) => m[1]);
    const ns = parts[0];
    if (ns === "form") return;

    let target = fields;
    let fieldId: string | undefined;
    let sub: string | undefined;
    if (ns === "fields" || ns === "form_fields" || ns === "meta") {
      if (ns === "meta") target = meta;
      fieldId = parts[1];
      sub = parts[2];
    } else {
      fieldId = ns;
      sub = parts[1];
    }
    if (!fieldId) return;
    if (sub && sub !== "value") return; // skip [id], [type], [title], etc.

    const k = fieldId.toLowerCase();
    // a [value] sub-key always wins; otherwise first non-empty value sticks
    if (sub === "value" || target[k] === undefined) target[k] = value;
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
  const pain = fields["pain"] ?? byKey(/pain|goal|struggl|challenge|biggest/);

  if (!email || !site_url || !name) {
    console.warn("Lead form keys received:", JSON.stringify(Object.keys(fields)));
  }
  return { body: { name, email, site_url, pain }, rawFields: fields, meta, isForm: true };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { body, rawFields, meta, isForm } = await parseBody(req);
  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const { name, site_url, pain } = parsed.data;
  const email = normalizeEmail(parsed.data.email);
  // Form posts arrive via the WordPress server, so proxy headers hold the WP
  // server's IP — shared by ALL legit visitors. Trust headers only for direct
  // (JSON) callers; for form posts the visitor IP must come from form meta.
  const ip = visitorIp(req, { ...rawFields, ...meta }, { trustHeaders: !isForm });

  const urlProblem = unsafeUrlReason(site_url);
  if (urlProblem) {
    return NextResponse.json({ error: `Rejected URL: ${urlProblem}` }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert({ name, email, site_url, ip, status: "processing" })
    .select("id")
    .single();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Rate limits are counted AFTER inserting this attempt, so rejected and
  // failed attempts also consume the allowance (no free retries for abusers).
  const limit = await checkDailyLimits({ email, ip }).catch((err) => {
    console.error(err.message);
    return { allowed: true as const }; // fail open: a limiter outage shouldn't drop real leads
  });
  if (!limit.allowed) {
    await supabase
      .from("leads")
      .update({ status: "rejected", error: limit.reason })
      .eq("id", lead.id);
    return NextResponse.json({ error: limit.reason }, { status: 429 });
  }

  // Respond immediately (Elementor webhooks time out quickly); the
  // scrape → report → PDF → email pipeline continues after the response.
  after(async () => {
    try {
      const scraped = await scrapeSite(site_url);
      const { html: reportHtml, model } = await generateReportHtml({
        name,
        siteUrl: site_url,
        scrapedMarkdown: scraped,
        pain,
      });
      const pdf = await htmlToPdf(reportHtml);
      const pdfUrl = await storePdf(pdf, { name });
      await addSubscriber({ name, email, siteUrl: site_url, pdfUrl });
      await sendReportEmail({ name, email, pdfUrl, pdf });
      await supabase
        .from("leads")
        .update({ pdf_url: pdfUrl, status: "complete", model })
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
