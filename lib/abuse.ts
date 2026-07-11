import type { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";

export const DAILY_LIMIT_PER_KEY = 3;

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

// The webhook arrives from the WordPress server, so the visitor's IP comes
// from Elementor's advanced-data meta when available; the socket/proxy IP is
// only a fallback (it covers direct API callers).
export function visitorIp(req: NextRequest, rawFields: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(rawFields)) {
    if (/remote_?ip|user_?ip|client_?ip/i.test(key) && /^[0-9a-f.:]+$/i.test(value)) {
      return value;
    }
  }
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

export type RateCheck =
  | { allowed: true }
  | { allowed: false; reason: string };

// Counts today's attempts (including the row just inserted for this request,
// and including previously rejected attempts) in a single query.
export async function checkDailyLimits(input: {
  email: string;
  ip: string | null;
}): Promise<RateCheck> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from("leads")
    .select("email, ip")
    .gt("created_at", since)
    .limit(2000);
  if (error) throw new Error(`Rate-limit lookup failed: ${error.message}`);

  const rows = data ?? [];
  const cap = Number(process.env.LEAD_DAILY_CAP) || 50;
  if (rows.length > cap) {
    return { allowed: false, reason: `daily service cap reached (${cap}/day)` };
  }

  const key = emailLimitKey(input.email);
  const emailCount = rows.filter((r) => r.email && emailLimitKey(r.email) === key).length;
  if (emailCount > DAILY_LIMIT_PER_KEY) {
    return { allowed: false, reason: `email limit reached (${DAILY_LIMIT_PER_KEY}/day)` };
  }

  if (input.ip) {
    const ipCount = rows.filter((r) => r.ip === input.ip).length;
    if (ipCount > DAILY_LIMIT_PER_KEY) {
      return { allowed: false, reason: `IP limit reached (${DAILY_LIMIT_PER_KEY}/day)` };
    }
  }

  return { allowed: true };
}
