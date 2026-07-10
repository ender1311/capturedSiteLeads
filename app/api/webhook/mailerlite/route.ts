import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.MAILERLITE_WEBHOOK_SECRET;
  if (!secret) return true; // verification disabled when no secret is configured
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { events?: unknown[] } & Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // MailerLite may batch events; normalize to an array
  const events = Array.isArray(payload.events) ? payload.events : [payload];
  const supabase = supabaseAdmin();

  for (const raw of events) {
    const event = raw as {
      type?: string;
      event?: string;
      subscriber?: { email?: string };
    };
    const type = (event.type ?? event.event ?? "").toLowerCase();
    const email = event.subscriber?.email;
    if (!email) continue;

    const column = type.includes("open")
      ? "opens"
      : type.includes("click")
        ? "clicks"
        : null;
    if (!column) continue;

    const { error } = await supabase.rpc("increment_engagement", {
      lead_email: email,
      counter: column,
    });
    if (error) console.error(`Engagement update failed for ${email}:`, error.message);
  }

  return NextResponse.json({ ok: true });
}
