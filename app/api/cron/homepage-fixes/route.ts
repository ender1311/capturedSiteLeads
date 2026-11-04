import { NextResponse, type NextRequest } from "next/server";
import { secretMatches } from "@/lib/abuse";
import { sweep } from "@/lib/homepage-fixes/intake";

// Vercel crons (vercel.json): every 15 minutes re-runs leads in `retrying`; with ?queue=1 at
// 12:00 UTC (7:00 Eastern standard time) builds queued leads within the day's cap.
// Vercel sends `Authorization: Bearer ${CRON_SECRET}`; without CRON_SECRET set the route is off.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!secretMatches(req.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sweep({ queue: req.nextUrl.searchParams.get("queue") === "1" });
  return NextResponse.json(result);
}
