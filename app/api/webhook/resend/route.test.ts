import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// A tiny in-memory leads table behind the two statements the webhook can run.
type Row = { id: string; email: string; status: string; seq: number; resend_email_id: string | null; opens: number; clicks: number };
const h = vi.hoisted(() => {
  const state = { rows: [] as Row[], idLookupFails: false };
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const col = /set opens/.test(text) ? "opens" : "clicks";
    if (/where resend_email_id =/.test(text)) {
      if (state.idLookupFails) throw new Error('column "resend_email_id" does not exist');
      const hit = state.rows.filter((r) => r.resend_email_id === values[0]);
      for (const r of hit) r[col]++;
      return hit.map((r) => ({ id: r.id }));
    }
    if (/where email =/.test(text)) {
      const newest = state.rows.filter((r) => r.email === values[0] && r.status === "complete").sort((a, b) => b.seq - a.seq)[0];
      if (newest) newest[col]++;
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  });
  return { state, tag };
});
// The real lib/db (its id-first then address fallback is what's under test), over a fake Neon.
vi.mock("@neondatabase/serverless", () => ({ neon: () => h.tag }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new NextRequest("https://captured-site-leads.vercel.app/api/webhook/resend", { method: "POST", body: JSON.stringify(body) }));
const row = (id: string) => h.state.rows.find((r) => r.id === id)!;

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", ""); // unsigned events accepted (the route's documented fail-open)
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.state.idLookupFails = false;
  h.state.rows = [
    { id: "report", email: "jane@x.com", status: "complete", seq: 1, resend_email_id: "em_report", opens: 0, clicks: 0 },
    { id: "hobby", email: "jane@x.com", status: "complete", seq: 2, resend_email_id: "em_hobby", opens: 0, clicks: 0 },
  ];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/webhook/resend", () => {
  it("an open on the report's email id goes to the report row, even with a newer hobby row", async () => {
    expect((await post({ type: "email.opened", data: { email_id: "em_report", to: ["jane@x.com"] } })).status).toBe(200);
    expect(row("report").opens).toBe(1);
    expect(row("hobby").opens).toBe(0);
    await post({ type: "email.clicked", data: { email_id: "em_report", to: ["jane@x.com"] } });
    expect(row("report").clicks).toBe(1);
  });

  it("an unknown email id (an old or MailerLite email) falls back to the newest delivered row", async () => {
    await post({ type: "email.opened", data: { email_id: "em_other", to: ["jane@x.com"] } });
    expect(row("hobby").opens).toBe(1);
    expect(row("report").opens).toBe(0);
  });

  it("no email id, or a failed id lookup, matches by address", async () => {
    await post({ type: "email.opened", data: { to: "jane@x.com" } });
    expect(row("hobby").opens).toBe(1);
    h.state.idLookupFails = true;
    await post({ type: "email.opened", data: { email_id: "em_report", to: ["jane@x.com"] } });
    expect(row("hobby").opens).toBe(2);
  });

  it("other events are ignored", async () => {
    expect(await (await post({ type: "email.delivered", data: { email_id: "em_report" } })).json()).toEqual({ ok: true, ignored: true });
    expect(row("report").opens + row("hobby").opens).toBe(0);
  });
});
