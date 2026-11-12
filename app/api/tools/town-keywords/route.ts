import { NextResponse, type NextRequest } from "next/server";
import { overWindowLimit, visitorIp } from "@/lib/abuse";
import {
  UpstreamError, fetchVolumes, parseInput, pickBest, readCache, reserveDaily, termsFor, writeCache,
  type Term, type TownResult,
} from "@/lib/town-keywords";

// Public endpoint for the "Small-Town SEO Finder" page on capturedsites.com. Calls a paid keyword
// API, so: per-IP rate limit, 30-day cache per (niche, town), and a daily cap on uncached towns.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RATE_LIMIT = 5; // per IP per hour
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
  if (ip && (await overWindowLimit(`town-keywords:${ip}`, RATE_LIMIT, 60))) return fail("rate", 429);

  const input = parseInput(await req.json().catch(() => null));
  if (!input) return fail("input", 400);
  const { niche, towns } = input;

  try {
    const found = await readCache(niche, towns.map((t) => t.key));
    const missing = towns.filter((t) => !found.has(t.key));
    if (missing.length) {
      // Fails closed: no reservation (or a DB error) means no paid call.
      if (!(await reserveDaily(missing.length))) return fail("busy", 503);
      const volumes = await fetchVolumes(missing.flatMap((t) => termsFor(niche, t.key)));
      for (const t of missing) {
        const terms: Term[] = termsFor(niche, t.key).map((term) => ({ term, volume: volumes.get(term) ?? 0 }));
        found.set(t.key, terms);
        await writeCache(niche, t.key, terms).catch((e) => console.warn(`town cache write failed: ${(e as Error).message}`));
      }
    }
    const results: TownResult[] = towns.map(({ town, key }) => {
      const terms = found.get(key)!;
      return { town, terms, best: pickBest(terms) };
    });
    return NextResponse.json({ niche, towns: results, cached: missing.length === 0 }, { headers });
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.error(`town-keywords upstream failed: ${e.message}`);
      return fail("upstream", 502);
    }
    console.error(`town-keywords failed: ${(e as Error).message}`);
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
