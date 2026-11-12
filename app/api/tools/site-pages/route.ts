import { NextResponse, type NextRequest } from "next/server";
import { overWindowLimit, visitorIp } from "@/lib/abuse";
import { discoverPages, normalizeSiteUrl } from "@/lib/site-pages";

// Public endpoint for the "Rebuild Without Losing SEO" page on capturedsites.com: lists a site's
// pages with suggested redirect targets. Fetches third-party sites, so every fetch goes through
// lib/site-pages safeFetch (SSRF guard) and callers are rate limited per IP.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = 10; // per IP per 10 minutes
const ALLOWED_ORIGINS = new Set(["https://capturedsites.com", "https://www.capturedsites.com"]);

function corsHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin", "Cache-Control": "no-store" };
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req);
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });

  const ip = visitorIp(req, {}, { trustHeaders: true });
  if (ip && (await overWindowLimit(`site-pages:${ip}`, RATE_LIMIT))) return fail("rate", 429);

  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const origin = normalizeSiteUrl(body?.url);
  if (!origin) return fail("url", 400);

  try {
    const result = await discoverPages(origin);
    return result ? NextResponse.json(result, { headers }) : fail("none", 404);
  } catch (e) {
    console.error(`site-pages failed: ${(e as Error).message}`);
    return fail("server", 500);
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
