import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazy singleton — neon() throws when DATABASE_URL is unset, and Next.js
// evaluates top-level module code at build time, so constructing this eagerly
// would break `next build` before the env var is provisioned.
let client: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  client ??= neon(process.env.DATABASE_URL!);
  return client;
}

export type Lead = {
  id: string;
  name: string;
  email: string;
  site_url: string;
  pdf_url: string | null;
  status: "processing" | "complete" | "failed" | "rejected";
  error: string | null;
  ip: string | null;
  model: string | null;
  opens: number;
  clicks: number;
  created_at: string;
  // Homepage fixes columns (db/schema.sql, 2026-11-03). Roadmap rows keep the defaults.
  report_type: "roadmap" | "homepage_fixes";
  goal: string | null;
  outcome: string | null;
  content: unknown;
  before_url: string | null;
  after_url: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null; // numeric comes back from Neon as a string
  retry_count: number;
};

// Atomically bump opens/clicks for a lead by email (used by the MailerLite and
// Resend webhooks). Only the most recent DELIVERED lead is credited — the same
// person may have older/failed/rejected rows, and inflating them all skews the
// dashboard's open/click rates.
//
// The counter is a column name, which can't be parameterized, so it is branched
// into two literal statements rather than interpolated.
export async function incrementEngagement(
  email: string,
  counter: "opens" | "clicks"
): Promise<void> {
  const q = sql();
  if (counter === "opens") {
    await q`
      update leads set opens = opens + 1
      where id = (
        select id from leads
        where email = ${email} and status = 'complete'
        order by created_at desc limit 1
      )
    `;
  } else {
    await q`
      update leads set clicks = clicks + 1
      where id = (
        select id from leads
        where email = ${email} and status = 'complete'
        order by created_at desc limit 1
      )
    `;
  }
}

// Credits the row whose email Resend reports on by its Resend email id (stored when the
// homepage-fixes email went out). True when a row matched.
async function incrementByEmailId(emailId: string, counter: "opens" | "clicks"): Promise<boolean> {
  const q = sql();
  const rows = (counter === "opens"
    ? await q`update leads set opens = opens + 1 where resend_email_id = ${emailId} returning id`
    : await q`update leads set clicks = clicks + 1 where resend_email_id = ${emailId} returning id`) as { id: string }[];
  return rows.length > 0;
}

/**
 * The Resend webhook's open/click: the row that sent that exact email (by Resend's email id)
 * when there is one, else the newest delivered row for the address (older emails, roadmap rows,
 * the MailerLite fallback). A failed id lookup falls back to the address too.
 */
export async function recordEngagement(
  event: { emailId: string | null; email: string | null },
  counter: "opens" | "clicks"
): Promise<void> {
  if (event.emailId) {
    try {
      if (await incrementByEmailId(event.emailId, counter)) return;
    } catch (e) {
      console.warn("Engagement by email id failed; matching by address:", (e as Error).message);
    }
  }
  if (event.email) await incrementEngagement(event.email, counter);
}
