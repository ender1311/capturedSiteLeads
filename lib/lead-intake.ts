import type { NextRequest } from "next/server";
import { secretMatches } from "@/lib/abuse";

// Shared by the lead intake routes (POST /api/lead and POST /api/homepage-fixes): the webhook
// secret check and the tolerant Elementor body parser.

// The ?secret= fallback exists because Elementor's webhook action can't set
// custom headers. Query strings can land in logs — prefer the header wherever
// the caller supports it, and rotate LEAD_WEBHOOK_SECRET if it ever leaks.
export function authorized(req: NextRequest): boolean {
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
export async function parseBody(req: NextRequest): Promise<{
  body: unknown;
  rawFields: Record<string, string>;
  meta: Record<string, string>;
  isForm: boolean;
}> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const json: unknown = await req.json().catch(() => null);
    // JSON callers may send the homepage-fixes goal as website_goal (the form's field ID) or goal.
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const o = json as Record<string, unknown>;
      return { body: { ...o, goal: o.website_goal ?? o.goal }, rawFields: {}, meta: {}, isForm: false };
    }
    return { body: json, rawFields: {}, meta: {}, isForm: false };
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
    // not website_goal: that's the goal question, not the address
    Object.entries(fields).find(([k, v]) => /url|website|site/.test(k) && !/goal/.test(k) && v)?.[1] ??
    Object.values(fields).find(
      (v) => v !== email && /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(v) && !v.includes("@")
    );
  const name = fields["name"] ?? byKey(/name/) ?? undefined;
  const pain = fields["pain"] ?? byKey(/pain|goal|struggl|challenge|biggest/);
  // Homepage fixes: "What would you love your website to do for you?" (field ID website_goal).
  const goal = fields["website_goal"] ?? byKey(/goal/);

  if (!email || !site_url || !name) {
    console.warn("Lead form keys received:", JSON.stringify(Object.keys(fields)));
  }
  return { body: { name, email, site_url, pain, goal }, rawFields: fields, meta, isForm: true };
}
