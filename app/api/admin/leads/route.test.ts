import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => []);
  const tag = vi.fn(async () => []);
  return { query, sqlFn: Object.assign(tag, { query }) };
});
vi.mock("@/lib/db", () => ({ sql: () => h.sqlFn }));

import { GET } from "./route";
import { GET as DETAIL } from "./[id]/route";

const TOKEN = "leads-token-for-tests";
const ID = "8f9c8d4e-1111-4222-8333-944455556666";
const req = (path: string, auth: string | null = `Bearer ${TOKEN}`) =>
  new NextRequest(`https://captured-site-leads.vercel.app${path}`, { headers: auth ? { authorization: auth } : {} });

const LEAD = {
  id: ID, created_at: new Date("2026-11-02T15:00:00.000Z"), name: '=HYPERLINK("http://evil","x")', email: "jane@x.com",
  site_url: "https://janedoe.com", goal: "More weddings", outcome: "sent", pdf_url: "https://b.public.blob.vercel-storage.com/p.pdf",
  before_url: null, after_url: null, cost_usd: "0.008000", opens: 3, clicks: 0, report_type: "homepage_fixes",
  content: { first_section: { headline: "Hi" }, fixes: [{ title: "A" }, { title: "B" }], fact_sheet: "F", notes_for_maggie: "N" },
  error: null, model: "google/gemini-3.8-flash", input_tokens: 5000, output_tokens: 800, retry_count: 0,
};

beforeEach(() => {
  vi.stubEnv("LEADS_API_TOKEN", TOKEN);
  h.query.mockReset().mockImplementation(async (text: string) => {
    if (/count\(\*\)/.test(text)) return [{ total: "1" }]; // bigint arrives as text from Neon
    if (/to_char/.test(text)) return [{ day: "2026-11-02", outcome: "sent", cost_usd: "0.008", opens: "3", clicks: "0" }];
    return [LEAD];
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("auth", () => {
  it("404 with no body for a wrong or missing token, or LEADS_API_TOKEN unset", async () => {
    for (const r of [req("/api/admin/leads", "Bearer nope"), req("/api/admin/leads", null)]) {
      const res = await GET(r);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
    vi.stubEnv("LEADS_API_TOKEN", "");
    const res = await GET(req("/api/admin/leads"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await DETAIL(req(`/api/admin/leads/${ID}`), { params: Promise.resolve({ id: ID }) })).status).toBe(404);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/leads", () => {
  it("json page: total is a number, 50 per page, rows are LeadRows", async () => {
    const res = await GET(req("/api/admin/leads?from=2026-11-01&to=2026-11-03&page=2&format=json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ total: 1, page: 2, pageSize: 50 });
    expect(body.rows[0]).toEqual({
      id: ID, created_at: "2026-11-02T15:00:00.000Z", name: LEAD.name, email: "jane@x.com", site_url: "https://janedoe.com",
      goal: "More weddings", outcome: "sent", pdf_url: LEAD.pdf_url, before_url: null, after_url: null, cost_usd: 0.008, opens: 3, clicks: 0,
    });
    const page = h.query.mock.calls.find(([t]) => /offset/.test(t))!;
    expect(page[0]).toMatch(/limit 50 offset 50/);
  });

  it("filters by outcome and a case-insensitive search", async () => {
    await GET(req("/api/admin/leads?outcome=held&q=JANE"));
    for (const [text, params] of h.query.mock.calls) {
      expect(text).toContain("outcome = $2");
      expect(text).toContain("name ilike $3 or email ilike $3 or site_url ilike $3");
      expect(params).toEqual(expect.arrayContaining(["homepage_fixes", "held", "%JANE%"]));
    }
  });

  it("old roadmap rows only under outcome=roadmap", async () => {
    await GET(req("/api/admin/leads?outcome=roadmap"));
    expect(h.query.mock.calls[0][1]).toEqual(["roadmap"]);
  });

  it("400 for an unknown outcome or bad dates", async () => {
    expect((await GET(req("/api/admin/leads?outcome=bogus"))).status).toBe(400);
    expect((await GET(req("/api/admin/leads?from=2026-13-01"))).status).toBe(400);
  });

  it("csv: the columns, quoting and the injection guard", async () => {
    const res = await GET(req("/api/admin/leads?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [header, line] = (await res.text()).split("\r\n");
    expect(header).toBe("created_at,name,email,site_url,goal,outcome,pdf_url,cost_usd,opens,clicks,headline,fix1_title,fix2_title,report_type");
    expect(line.startsWith(`2026-11-02T15:00:00.000Z,"'=HYPERLINK(""http://evil"",""x"")",jane@x.com,`)).toBe(true);
    expect(line.endsWith(",0.008,3,0,Hi,A,B,homepage_fixes")).toBe(true);
  });

  it("summary=1: numbers, rates as fractions, zero-filled days", async () => {
    const res = await GET(req("/api/admin/leads?summary=1&from=2026-11-01&to=2026-11-03"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ submissions: 1, sent: 1, cant_see: 0, hobby: 0, held_failed: 0, avg_cost_usd: 0.008, open_rate: 1, click_rate: 0 });
    expect(body.perDay).toEqual([
      { date: "2026-11-01", submissions: 0, sent: 0 },
      { date: "2026-11-02", submissions: 1, sent: 1 },
      { date: "2026-11-03", submissions: 0, sent: 0 },
    ]);
  });
});

describe("GET /api/admin/leads/:id", () => {
  it("the row plus its content, fact sheet and notes", async () => {
    const res = await DETAIL(req(`/api/admin/leads/${ID}`), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: ID, facts_sheet: "F", notes_for_maggie: "N", model: "google/gemini-3.8-flash", retry_count: 0, report_type: "homepage_fixes", cost_usd: 0.008 });
    expect(body.content).not.toHaveProperty("fact_sheet");
  });
  it("404 for an id that is not a uuid or not found", async () => {
    expect((await DETAIL(req("/api/admin/leads/abc"), { params: Promise.resolve({ id: "abc" }) })).status).toBe(404);
    h.query.mockResolvedValue([]);
    expect((await DETAIL(req(`/api/admin/leads/${ID}`), { params: Promise.resolve({ id: ID }) })).status).toBe(404);
  });
});
