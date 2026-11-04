import type { NextRequest } from "next/server";
import { UUID, bearerAllowed, json, notFound } from "@/lib/homepage-fixes/admin-data";
import { redeliverHeld } from "@/lib/homepage-fixes/redeliver";

// Re-send a held report from its stored content (Bearer LEADS_API_TOKEN): the same path as
// scripts/homepage-fixes-deliver.mts without edits or --force. Only `held` leads; anything else
// (it may already have had an email) is 409. Re-renders with Chromium, so it gets the full budget.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  try {
    const r = await redeliverHeld(id, {});
    switch (r.status) {
      case "sent":
        return json({ ok: true });
      case "not_found":
        return notFound();
      case "not_held":
        return json({ error: "not held", outcome: r.outcome }, 409);
      case "claim_lost":
        return json({ error: "no longer held" }, 409);
      case "blocked":
        return json({ error: "blocked", issues: r.issues }, 422);
    }
  } catch (e) {
    console.error(`admin re-send of lead ${id} failed:`, (e as Error).message);
    return json({ error: "delivery failed" }, 502);
  }
}
