import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getEmailProvider, saveEmailProvider } from "@/lib/guide-store";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    current: await getEmailProvider(),
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
  });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const provider = body?.provider;
  if (provider !== "mailerlite" && provider !== "resend") {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  if (provider === "resend" && !process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "RESEND_API_KEY is not configured on this deployment." },
      { status: 400 }
    );
  }
  await saveEmailProvider(provider);
  return NextResponse.json({ ok: true, current: provider });
}
