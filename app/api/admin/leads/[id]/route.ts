import type { NextRequest } from "next/server";
import { UUID, bearerAllowed, fetchLeadDetail, json, notFound } from "@/lib/homepage-fixes/admin-data";

// One lead with its content, fact sheet, notes, cost and errors (Bearer LEADS_API_TOKEN).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  try {
    const lead = await fetchLeadDetail(id);
    return lead ? json(lead) : notFound();
  } catch (e) {
    console.error("admin lead detail failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}
