import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLiveGuide, saveGuide, resetGuide, DEFAULT_GUIDE } from "@/lib/guide-store";

async function requireSession() {
  const session = await auth();
  return session?.user ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const guide = await getLiveGuide();
  return NextResponse.json({ ...guide, defaultValue: DEFAULT_GUIDE });
}

export async function PUT(req: NextRequest) {
  const denied = await requireSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const value = typeof body?.value === "string" ? body.value : "";
  if (value.trim().length < 200) {
    return NextResponse.json(
      { error: "Guide is too short — refusing to save (min 200 characters)." },
      { status: 400 }
    );
  }
  if (value.length > 100_000) {
    return NextResponse.json({ error: "Guide is too long (max 100k characters)." }, { status: 400 });
  }
  await saveGuide(value);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;
  await resetGuide();
  return NextResponse.json({ ok: true, value: DEFAULT_GUIDE });
}
