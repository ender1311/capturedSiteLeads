import { after, type NextRequest } from "next/server";
import { UUID, json, notFound, withLeadsToken } from "@/lib/homepage-fixes/admin-data";
import { DeliveredNotRecordedError, sendAlert } from "@/lib/homepage-fixes/deliver";
import { claimForRedeliver, deliverClaimed } from "@/lib/homepage-fixes/redeliver";

// Re-send a held report from its stored content (Bearer LEADS_API_TOKEN): the same shared path as
// scripts/homepage-fixes-deliver.mts without edits or --force.
//
// The quick part answers at once: 404 for a missing lead, 409 for one that is not held (it may
// already have had an email) or that someone else just claimed. Otherwise the row is claimed
// (held → processing) before answering, so a second click gets 409, and the slow part (Chromium
// re-render, Blob, Resend, MailerLite) runs after the 202. If it is blocked or fails before the
// email goes out, the row goes back to held and Dan gets an alert.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withLeadsToken(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();

  let claim: Awaited<ReturnType<typeof claimForRedeliver>>;
  try {
    claim = await claimForRedeliver(id);
  } catch (e) {
    console.error(`admin re-send of lead ${id}: could not claim:`, (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
  if (claim.status === "not_found") return notFound();
  if (claim.status === "not_held") return json({ error: "not held", outcome: claim.outcome }, 409);
  if (claim.status === "claim_lost") return json({ error: "no longer held" }, 409);

  const row = claim.row;
  const alertLead = { id: row.id, name: row.name, email: row.email, site_url: row.site_url };
  after(async () => {
    try {
      const r = await deliverClaimed(row);
      if (r.status === "blocked") {
        const errors = r.issues.filter((i) => i.level === "error").map((i) => `${i.field}: ${i.message}`);
        await sendAlert("held", { ...alertLead, error: ["Re-send from the admin was blocked by the copy rules; still held.", ...errors].join("\n") });
      }
    } catch (e) {
      // deliver already alerted when the email went out but couldn't be recorded.
      if (e instanceof DeliveredNotRecordedError) return;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`admin re-send of lead ${row.id} failed:`, message);
      await sendAlert("failed", { ...alertLead, error: `Re-send from the admin failed before the email went out; back to held.\n${message}` });
    }
  });
  return json({ status: "sending" }, 202);
});
