import type { NextRequest } from "next/server";
import { bearerAllowed, fetchEmailSetup, json, notFound } from "@/lib/homepage-fixes/admin-data";

// What Maggie needs for her MailerLite follow-ups (Bearer LEADS_API_TOKEN): the report email as
// sent, the group and automation, the merge fields with examples, and the last 30 days' numbers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  try {
    return json(await fetchEmailSetup());
  } catch (e) {
    console.error("admin email setup failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}
