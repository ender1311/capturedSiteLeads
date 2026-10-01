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
