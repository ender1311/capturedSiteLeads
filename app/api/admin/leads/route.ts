import { NextResponse, type NextRequest } from "next/server";
import {
  OUTCOME_FILTERS, bearerAllowed, fetchLeadsCsv, fetchLeadsPage, fetchSummary, json, notFound, parseRange,
} from "@/lib/homepage-fixes/admin-data";

// Leads for the Beacon Frontier admin (Bearer LEADS_API_TOKEN):
//   ?from&to&outcome&q&page&format=json   → { total, page, pageSize: 50, rows }
//   ?from&to&outcome&q&format=csv          → the CSV export
//   ?summary=1&from&to                     → the stat tiles and the per-day chart (default: last 30 days)
// Homepage-fixes rows only, except outcome=roadmap (the old roadmap rows, on their own).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export async function GET(req: NextRequest) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  const p = req.nextUrl.searchParams;
  const range = parseRange(p.get("from"), p.get("to"), { required: false });
  if ("error" in range) return json({ error: range.error }, 400);

  try {
    if (p.get("summary") === "1") {
      const to = range.to ?? new Date().toISOString().slice(0, 10);
      const from = range.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
      const full = parseRange(from, to, { required: true });
      if ("error" in full) return json({ error: full.error }, 400);
      return json(await fetchSummary(from, to));
    }

    const outcome = p.get("outcome") || null;
    if (outcome && !OUTCOME_FILTERS.includes(outcome)) return json({ error: "unknown outcome" }, 400);
    const q = (p.get("q") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || null;
    const filters = { from: range.from, to: range.to, outcome, q };

    const format = p.get("format") ?? "json";
    if (format === "csv") {
      return new NextResponse(await fetchLeadsCsv(filters), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (format !== "json") return json({ error: "format must be json or csv" }, 400);
    const page = Math.min(10_000, Math.max(1, Math.floor(Number(p.get("page")) || 1)));
    return json(await fetchLeadsPage(filters, page));
  } catch (e) {
    console.error("admin leads failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}
