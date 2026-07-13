import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";

const csvCell = (v: unknown): string => {
  let s = v == null ? "" : String(v);
  // Neutralize spreadsheet formula injection: lead names/URLs are
  // attacker-supplied and this file gets opened in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin()
    .from("leads")
    .select("name, email, site_url, status, pdf_url, model, opens, clicks, ip, error, created_at")
    .order("created_at", { ascending: false })
    .limit(10_000);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const header = ["name", "email", "site_url", "status", "pdf_url", "model", "opens", "clicks", "ip", "error", "created_at"];
  const rows = (data ?? []).map((l) => header.map((k) => csvCell((l as Record<string, unknown>)[k])).join(","));
  const csv = [header.join(","), ...rows].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
