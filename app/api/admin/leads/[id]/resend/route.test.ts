import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ redeliver: vi.fn() }));
vi.mock("@/lib/homepage-fixes/redeliver", () => ({ redeliverHeld: h.redeliver }));

import { POST } from "./route";

const TOKEN = "leads-token-for-tests";
const ID = "8f9c8d4e-1111-4222-8333-944455556666";
const call = (id = ID, auth = `Bearer ${TOKEN}`) =>
  POST(new NextRequest(`https://captured-site-leads.vercel.app/api/admin/leads/${id}/resend`, { method: "POST", headers: { authorization: auth } }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.stubEnv("LEADS_API_TOKEN", TOKEN);
  h.redeliver.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/admin/leads/:id/resend", () => {
  it("delivers a held lead through the shared re-delivery path, never forced", async () => {
    h.redeliver.mockResolvedValue({ status: "sent", issues: [] });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.redeliver).toHaveBeenCalledWith(ID, {});
  });

  it("409 for a lead that is not held, or that someone else claimed first", async () => {
    h.redeliver.mockResolvedValue({ status: "not_held", outcome: "sent" });
    expect((await call()).status).toBe(409);
    h.redeliver.mockResolvedValue({ status: "claim_lost" });
    expect((await call()).status).toBe(409);
  });

  it("422 when the copy rules block it, 404 when missing, 502 when delivery throws", async () => {
    h.redeliver.mockResolvedValue({ status: "blocked", issues: [{ field: "x", level: "error", message: "m" }] });
    const blocked = await call();
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toEqual({ error: "blocked", issues: [{ field: "x", level: "error", message: "m" }] });
    h.redeliver.mockResolvedValue({ status: "not_found" });
    expect((await call()).status).toBe(404);
    h.redeliver.mockRejectedValue(new Error("Resend down"));
    const failed = await call();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "delivery failed" });
  });

  it("404 for a wrong token or a bad id, without touching the lead", async () => {
    expect((await call(ID, "Bearer x")).status).toBe(404);
    expect((await call("abc")).status).toBe(404);
    expect(h.redeliver).not.toHaveBeenCalled();
  });
});
