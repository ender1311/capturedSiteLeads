import type { NextRequest } from "next/server";
import { handleHomepageFixes } from "@/lib/homepage-fixes/intake";

// The Elementor webhook for "Your Top Homepage Fixes". Answers 200 fast (401 only on a bad
// secret); the report is built in after(). See lib/homepage-fixes/intake.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function POST(req: NextRequest) {
  return handleHomepageFixes(req);
}
