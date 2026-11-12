import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const hits = new Map<string, number>();
  const tag = vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
    const key = String(values[0]);
    const before = hits.get(key) ?? 0;
    hits.set(key, before + 1);
    return [{ n: before }]; // the CTE insert is invisible to the count in the same statement
  });
  return { hits, tag, discoverPages: vi.fn() };
});
vi.mock("@/lib/db", () => ({ sql: () => h.tag }));
vi.mock("@/lib/site-pages", async (orig) => ({
  ...(await orig<typeof import("@/lib/site-pages")>()),
  discoverPages: h.discoverPages,
}));

import { OPTIONS, POST } from "./route";

const RESULT = { host: "x.com", source: "sitemap", truncated: false, pages: [{ path: "/", type: "Home", target: "/", decide: false }] };

function req(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new NextRequest("https://captured-site-leads.vercel.app/api/tools/site-pages", {
    method,
    headers: { origin: "https://capturedsites.com", "x-forwarded-for": "1.2.3.4", "content-type": "application/json", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

beforeEach(() => {
  h.hits.clear();
  h.discoverPages.mockReset().mockResolvedValue(RESULT);
});

describe("POST /api/tools/site-pages", () => {
  it("returns the pages for a normalized origin", async () => {
    const res = await POST(req({ url: "www.x.com/blog/post" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(String(h.discoverPages.mock.calls[0][0])).toBe("https://www.x.com/");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([{ url: "localhost" }, { url: "10.0.0.1" }, { url: "ftp://x.com" }, { nope: 1 }, "not json"])("400 url for %j", async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url" });
    expect(h.discoverPages).not.toHaveBeenCalled();
  });

  it("404 none when nothing is found, 500 server on a crash", async () => {
    h.discoverPages.mockResolvedValueOnce(null);
    let res = await POST(req({ url: "x.com" }));
    expect([res.status, await res.json()]).toEqual([404, { error: "none" }]);
    h.discoverPages.mockRejectedValueOnce(new Error("boom"));
    res = await POST(req({ url: "x.com" }));
    expect([res.status, await res.json()]).toEqual([500, { error: "server" }]);
  });

  it("rate limits 10 per IP per window, keyed apart from other tools", async () => {
    for (let i = 0; i < 10; i++) expect((await POST(req({ url: "x.com" }))).status).toBe(200);
    const res = await POST(req({ url: "x.com" }));
    expect([res.status, await res.json()]).toEqual([429, { error: "rate" }]);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    expect(h.discoverPages).toHaveBeenCalledTimes(10);
    expect([...h.hits.keys()]).toEqual(["site-pages:1.2.3.4"]);
    expect((await POST(req({ url: "x.com" }, { "x-forwarded-for": "5.6.7.8" }))).status).toBe(200);
  });

  it("fails open when the database is down", async () => {
    h.tag.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(req({ url: "x.com" }))).status).toBe(200);
  });
});

describe("CORS", () => {
  it.each(["https://capturedsites.com", "https://www.capturedsites.com"])("allows %s with a preflight", async (origin) => {
    const res = await OPTIONS(req(null, { origin }, "OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
  });

  it.each(["https://evil.com", "http://capturedsites.com", "https://capturedsites.com.evil.com", "http://localhost:3000"])("no allow-origin for %s", async (origin) => {
    expect((await OPTIONS(req(null, { origin }, "OPTIONS"))).headers.get("access-control-allow-origin")).toBeNull();
    expect((await POST(req({ url: "x.com" }, { origin }))).headers.get("access-control-allow-origin")).toBeNull();
  });
});
