import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { sql } from "./db";

export const DAILY_LIMIT_PER_KEY = 3;

// Constant-time secret comparison (hashing first equalizes lengths).
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Key used ONLY for rate limiting: collapses plus-tags everywhere and dots in
// gmail addresses so alias tricks can't multiply the daily allowance.
export function emailLimitKey(email: string): string {
  const [local, domain] = normalizeEmail(email).split("@");
  let key = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    key = key.replace(/\./g, "");
  }
  return `${key}@${domain}`;
}

// The visitor's IP comes from Elementor's advanced-data meta when available.
// Proxy headers are trusted only when the caller says so (direct API posts):
// for form posts relayed by WordPress they'd hold the WP server's IP, and
// rate-limiting on that would block every visitor at once.
export function visitorIp(
  req: NextRequest,
  formFields: Record<string, string>,
  opts: { trustHeaders: boolean }
): string | null {
  for (const [key, value] of Object.entries(formFields)) {
    if (/remote_?ip|user_?ip|client_?ip/i.test(key) && /^[0-9a-f.:]+$/i.test(value)) {
      return value;
    }
  }
  if (!opts.trustHeaders) return null;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

// Refuse URLs that would waste scrape credits or poke at internal networks.
export function unsafeUrlReason(siteUrl: string): string | null {
  let host: string;
  try {
    host = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return "invalid URL";
  }
  if (!host.includes(".")) return "hostname is not a public domain";
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return "private hostname";
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    ) {
      return "private or reserved IP address";
    }
  }
  if (host.includes(":")) return "IPv6 literals not allowed";
  return null;
}

export type ReportType = "roadmap" | "homepage_fixes";

export type RateCheck =
  | { allowed: true }
  | { allowed: false; kind: "email" | "ip" | "cap"; reason: string };

// Each report type has its own allowance, so roadmap and homepage-fixes leads never share one.
export function dailyCap(reportType: ReportType): number {
  return reportType === "homepage_fixes"
    ? Number(process.env.HOMEPAGE_FIXES_DAILY_CAP) || 100
    : Number(process.env.LEAD_DAILY_CAP) || 50;
}

// Homepage-fixes rows that never build a report (waiting in the queue, refused, or turned away)
// don't use up the service cap; otherwise the queue could never drain. Every roadmap row counts.
const NO_BUILD = new Set(["queued", "invalid", "limited"]);
type LimitRow = { email: string | null; ip: string | null; outcome: string | null };
const usesCap = (reportType: ReportType, r: LimitRow) =>
  reportType === "roadmap" || !NO_BUILD.has(r.outcome ?? "");

async function todaysRows(reportType: ReportType): Promise<LimitRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    return (await sql()`
      select email, ip, outcome from leads
      where report_type = ${reportType} and created_at > ${since}
      limit 2000
    `) as LimitRow[];
  } catch (e) {
    throw new Error(`Rate-limit lookup failed: ${(e as Error).message}`);
  }
}

// Counts the last 24 hours of this report type's attempts (including the row just inserted for
// this request, and including previously rejected attempts) in a single query. The per-email and
// per-IP limits are checked before the service cap, so a person over their own limit is told so
// even on a busy day.
export async function checkDailyLimits(input: {
  email: string;
  ip: string | null;
  reportType: ReportType;
}): Promise<RateCheck> {
  const rows = await todaysRows(input.reportType);

  const key = emailLimitKey(input.email);
  const emailCount = rows.filter((r) => r.email && emailLimitKey(r.email) === key).length;
  if (emailCount > DAILY_LIMIT_PER_KEY) {
    return { allowed: false, kind: "email", reason: `email limit reached (${DAILY_LIMIT_PER_KEY}/day)` };
  }

  if (input.ip) {
    const ipCount = rows.filter((r) => r.ip === input.ip).length;
    if (ipCount > DAILY_LIMIT_PER_KEY) {
      return { allowed: false, kind: "ip", reason: `IP limit reached (${DAILY_LIMIT_PER_KEY}/day)` };
    }
  }

  const cap = dailyCap(input.reportType);
  if (rows.filter((r) => usesCap(input.reportType, r)).length > cap) {
    return { allowed: false, kind: "cap", reason: `daily service cap reached (${cap}/day)` };
  }

  return { allowed: true };
}

/** How many more reports of this type the last 24 hours' cap allows (the queue cron's budget). */
export async function capRemaining(reportType: ReportType): Promise<number> {
  const rows = await todaysRows(reportType);
  return Math.max(0, dailyCap(reportType) - rows.filter((r) => usesCap(reportType, r)).length);
}

/**
 * Per-key sliding 10-minute window on the check_hits table: records this hit and returns true when
 * the key already had `limit` hits (so the first `limit` requests pass). Prefix the IP with the
 * tool's name so tools don't share a window. Any DB problem fails open.
 */
export async function overWindowLimit(key: string, limit: number): Promise<boolean> {
  try {
    const rows = (await sql()`
      with ins as (insert into check_hits (ip) values (${key}) returning 1),
           old as (delete from check_hits where at < now() - interval '10 minutes' returning 1)
      select count(*)::int as n from check_hits
      where ip = ${key} and at > now() - interval '10 minutes'
    `) as { n: number }[];
    return Number(rows[0]?.n ?? 0) >= limit;
  } catch (e) {
    console.warn(`rate limit skipped: ${(e as Error).message}`);
    return false;
  }
}
