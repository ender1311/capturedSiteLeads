import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ live: null as string | null, saved: [] as string[] }));
vi.mock("@/lib/guide-store", () => ({
  getLiveModel: async () => h.live,
  saveModel: async (m: string) => {
    h.saved.push(m);
  },
}));

import { GET, POST } from "./route";

const TOKEN = "leads-token-for-tests";
const req = (method: "GET" | "POST", body?: unknown, auth = `Bearer ${TOKEN}`) =>
  new NextRequest("https://captured-site-leads.vercel.app/api/admin/model", {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("LEADS_API_TOKEN", TOKEN);
  vi.stubEnv("LLM_MODEL", "");
  h.live = null;
  h.saved = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/model", () => {
  it("GET: the live model (default when none is saved) and the options", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.options[0]).toEqual({ id: "google/gemini-3.8-flash", label: expect.any(String), description: expect.any(String) });
    h.live = "google/gemini-2.5-flash-lite";
    expect((await (await GET(req("GET"))).json()).model).toBe("google/gemini-2.5-flash-lite");
  });

  it("POST saves a known model and rejects an unknown one", async () => {
    expect((await POST(req("POST", { model: "google/gemini-2.5-flash-lite" }))).status).toBe(200);
    expect(h.saved).toEqual(["google/gemini-2.5-flash-lite"]);
    const bad = await POST(req("POST", { model: "evil/model" }));
    expect(bad.status).toBe(400);
    expect((await POST(req("POST", "nope"))).status).toBe(400);
    expect(h.saved).toHaveLength(1);
  });

  it("404 for a wrong token", async () => {
    expect((await GET(req("GET", undefined, "Bearer x"))).status).toBe(404);
    expect((await POST(req("POST", { model: "google/gemini-2.5-flash-lite" }, "Bearer x"))).status).toBe(404);
    expect(h.saved).toHaveLength(0);
  });
});
