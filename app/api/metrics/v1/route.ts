import type { NextRequest } from "next/server";
import { bearerAllowed, fetchMetrics, json, notFound, parseRange } from "@/lib/homepage-fixes/admin-data";

// Product numbers for the Beacon Frontier admin: the metrics contract v1 (beacon-frontier
// docs/metrics-contract.md), aggregates only. Bearer PRODUCT_TOKEN_CAPTUREDSITES; any token
// problem (or no token configured) is the same empty 404.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!bearerAllowed(req, "PRODUCT_TOKEN_CAPTUREDSITES")) return notFound();
  const p = req.nextUrl.searchParams;
  const granularity = p.get("granularity") ?? "day";
  if (granularity !== "day") return json({ error: "granularity must be day" }, 400);
  const range = parseRange(p.get("from"), p.get("to"), { required: true });
  if ("error" in range) return json({ error: range.error }, 400);
  try {
    return json(await fetchMetrics(range.from!, range.to!));
  } catch (e) {
    console.error("metrics v1 failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}
