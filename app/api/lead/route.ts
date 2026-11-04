import type { NextRequest } from "next/server";
import { handleHomepageFixes } from "@/lib/homepage-fixes/intake";

// The original lead webhook. Since the homepage-fixes switch (2026-11-03) it runs the same
// handler as POST /api/homepage-fixes, so a form still pointed here gets the new report.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function POST(req: NextRequest) {
  return handleHomepageFixes(req);
}
