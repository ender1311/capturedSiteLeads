import type { NextRequest } from "next/server";
import { UUID, fetchLeadDetail, json, notFound, withLeadsToken } from "@/lib/homepage-fixes/admin-data";

// One lead with its content, fact sheet, notes, cost and errors (Bearer LEADS_API_TOKEN).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withLeadsToken(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  try {
    const lead = await fetchLeadDetail(id);
    return lead ? json(lead) : notFound();
  } catch (e) {
    console.error("admin lead detail failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
});
