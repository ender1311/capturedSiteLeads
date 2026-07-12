import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLiveModel, saveModel } from "@/lib/guide-store";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/lib/models";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const current = (await getLiveModel()) || process.env.LLM_MODEL || DEFAULT_MODEL;
  return NextResponse.json({ current });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const model = typeof body?.model === "string" ? body.model : "";
  if (!MODEL_OPTIONS.some((m) => m.id === model)) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }
  await saveModel(model);
  return NextResponse.json({ ok: true, current: model });
}
