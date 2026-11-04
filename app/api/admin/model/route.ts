import type { NextRequest } from "next/server";
import { bearerAllowed, json, notFound } from "@/lib/homepage-fixes/admin-data";
import { getLiveModel, saveModel } from "@/lib/guide-store";
import { MODEL_OPTIONS, pickModel } from "@/lib/models";

// The live report model (app_config llm_model), read and set from the Beacon Frontier admin
// (Bearer LEADS_API_TOKEN). The homepage-fixes pipeline reads the same setting.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const options = () => MODEL_OPTIONS.map(({ id, label, description }) => ({ id, label, description }));

export async function GET(req: NextRequest) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  try {
    return json({ model: pickModel(await getLiveModel(), process.env.LLM_MODEL), options: options() });
  } catch (e) {
    console.error("admin model read failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}

export async function POST(req: NextRequest) {
  if (!bearerAllowed(req, "LEADS_API_TOKEN")) return notFound();
  const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
  const model = typeof body?.model === "string" ? body.model : "";
  if (!MODEL_OPTIONS.some((m) => m.id === model)) return json({ error: "unknown model" }, 400);
  try {
    await saveModel(model);
    return json({ ok: true, model });
  } catch (e) {
    console.error("admin model save failed:", (e as Error).message);
    return json({ error: "unavailable" }, 500);
  }
}
