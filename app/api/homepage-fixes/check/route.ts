import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { visitorIp } from "@/lib/abuse";
import {
  checkEmail,
  checkWebsite,
  withDeadline,
  TIMEOUT_PASS,
  type FieldCheck,
} from "@/lib/homepage-fixes/validate";

// Public on-page check for the homepage-fixes form (spec section 1). Called by
// public/homepage-fixes-check.js from capturedsites.com. Answers within 3 s:
// each check gets 2.5 s and a check that times out passes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const CHECK_DEADLINE_MS = 2500;
const RATE_LIMIT_DEADLINE_MS = 400;
const RATE_LIMIT = 30; // per IP per 10 minutes

const ALLOWED_ORIGINS = new Set(["https://capturedsites.com", "https://www.capturedsites.com"]);

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (process.env.NODE_ENV !== "production" && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin", "Cache-Control": "no-store" };
  const origin = allowedOrigin(req.headers.get("origin"));
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

// Records this hit and counts the IP's earlier hits in the window, in one round
// trip. The CTE's insert isn't visible to the count, so `n` excludes this hit.
// Also trims this IP's expired rows. Any DB problem fails open.
async function overRateLimit(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  try {
    const rows = (await sql()`
      with ins as (insert into check_hits (ip) values (${ip}) returning 1),
           old as (delete from check_hits where ip = ${ip} and at < now() - interval '10 minutes' returning 1)
      select count(*)::int as n from check_hits
      where ip = ${ip} and at > now() - interval '10 minutes'
    `) as { n: number }[];
    return Number(rows[0]?.n ?? 0) >= RATE_LIMIT;
  } catch (e) {
    console.warn(`check rate limit skipped: ${(e as Error).message}`);
    return false;
  }
}

const guard = (p: Promise<FieldCheck>) =>
  withDeadline(p, CHECK_DEADLINE_MS, TIMEOUT_PASS).catch(() => TIMEOUT_PASS);

export async function GET(req: NextRequest) {
  const headers = corsHeaders(req);
  const email = req.nextUrl.searchParams.get("email");
  const site = req.nextUrl.searchParams.get("site");
  if (email === null && site === null) {
    return NextResponse.json({ error: "missing" }, { status: 400, headers });
  }

  // Rate limit first so a limited caller can't make us fetch sites; its own
  // deadline keeps the total (0.4 s + 2.5 s) under the 3 s promise.
  const ip = visitorIp(req, {}, { trustHeaders: true });
  if (await withDeadline(overRateLimit(ip), RATE_LIMIT_DEADLINE_MS, false)) {
    return NextResponse.json({ error: "slow_down" }, { status: 429, headers });
  }

  const [emailResult, siteResult] = await Promise.all([
    email !== null ? guard(checkEmail(email)) : undefined,
    site !== null ? guard(checkWebsite(site)) : undefined,
  ]);

  const body: { email?: FieldCheck; site?: FieldCheck } = {};
  if (emailResult) body.email = emailResult;
  if (siteResult) body.site = siteResult;
  return NextResponse.json(body, { headers });
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
