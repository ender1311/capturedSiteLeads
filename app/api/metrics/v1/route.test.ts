import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// No real Neon: every statement goes to h.query, answered by what it asks for.
const h = vi.hoisted(() => {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => []);
  const tag = vi.fn(async () => []);
  return { query, sqlFn: Object.assign(tag, { query }) };
});
vi.mock("@/lib/db", () => ({ sql: () => h.sqlFn }));

import { GET } from "./route";

const TOKEN = "product-token-for-tests";
const req = (query: string, auth: string | null = `Bearer ${TOKEN}`) =>
  new NextRequest(`https://captured-site-leads.vercel.app/api/metrics/v1${query}`, { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  vi.stubEnv("PRODUCT_TOKEN_CAPTUREDSITES", TOKEN);
  h.query.mockReset().mockImplementation(async (text: string) => {
    if (/to_char/.test(text)) {
      return [
        // A name, an email and a URL in the same rows must never reach the body.
        { day: "2026-11-01", outcome: "sent", cost_usd: "0.008", opens: 1, clicks: 0, name: "Jane", email: "jane@x.com", site_url: "https://x.com" },
        { day: "2026-11-03", outcome: "held", cost_usd: "0.004", opens: 0, clicks: 0 },
      ];
    }
    if (/interval '24 hours'/.test(text)) return [{ finished: "5", held_failed: "2" }];
    if (/outcome = 'sent'/.test(text)) return [{ n: "41" }];
    return [];
  });
});
afterEach(() => vi.unstubAllEnvs());

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

describe("GET /api/metrics/v1", () => {
  it("answers the v1 contract, zero-filled, aggregates only", async () => {
    const res = await GET(req("?from=2026-11-01&to=2026-11-03&granularity=day"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ version: 1, app: "capturedsites", range: { from: "2026-11-01", to: "2026-11-03", granularity: "day" } });
    expect(body.series.map((s: { date: string }) => s.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(body.series[0].values.hf_sent).toBe(1);
    expect(body.series[0].values.hf_gemini_microusd).toBe(8000);
    expect(body.series[2].values.hf_held_failed).toBe(1);
    expect(body.totals).toEqual({ hf_reports_total: 41 });
    expect(body.health[0]).toMatchObject({ id: "pipeline", status: "fail", detail: { finished_24h: 5, held_failed_24h: 2 } });
    for (const id of Object.keys(body.metrics)) expect(id).toMatch(/^[a-z0-9_]{1,64}$/);
    for (const s of strings(body)) {
      expect(s).not.toContain("@");
      expect(s).not.toContain("http");
    }
  });

  it("404 with no body detail for a wrong or missing token, or no token configured", async () => {
    for (const r of [req("?from=2026-11-01&to=2026-11-03", "Bearer wrong"), req("?from=2026-11-01&to=2026-11-03", null), req("?from=2026-11-01&to=2026-11-03", TOKEN)]) {
      const res = await GET(r);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    vi.stubEnv("PRODUCT_TOKEN_CAPTUREDSITES", "");
    expect((await GET(req("?from=2026-11-01&to=2026-11-03"))).status).toBe(404);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("400 for a bad range or granularity", async () => {
    for (const q of ["", "?from=2026-11-03&to=2026-11-01", "?from=2026-11-01&to=2026-11-03&granularity=week", "?from=x&to=2026-11-01"]) {
      const res = await GET(req(q));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
