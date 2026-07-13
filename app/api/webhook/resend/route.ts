import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Resend webhooks are Svix-signed: HMAC-SHA256 over "<id>.<timestamp>.<body>"
// keyed with the base64 part of the whsec_ secret; the svix-signature header
// holds space-separated "v1,<base64sig>" candidates.
function verifySvixSignature(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-open by design so engagement tracking works before the secret is
    // configured — worst case is forged open/click counts, never data access.
    console.warn("RESEND_WEBHOOK_SECRET is unset — accepting unverified webhook events");
    return true;
  }
  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatures = req.headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  // Reject stale timestamps so a captured request can't be replayed later
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signatures.split(" ").some((candidate) => {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) return false;
    const provided = Buffer.from(sig, "base64");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifySvixSignature(req, rawBody)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: { to?: string[] | string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const column =
    event.type === "email.opened" ? "opens" : event.type === "email.clicked" ? "clicks" : null;
  const to = event.data?.to;
  const email = Array.isArray(to) ? to[0] : typeof to === "string" ? to : null;
  if (!column || !email) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const { error } = await supabaseAdmin().rpc("increment_engagement", {
    lead_email: email,
    counter: column,
  });
  if (error) console.error(`Engagement update failed for ${email}:`, error.message);

  return NextResponse.json({ ok: true });
}
