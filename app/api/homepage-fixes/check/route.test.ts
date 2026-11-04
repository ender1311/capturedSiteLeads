import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const hits = new Map<string, number>();
  const tag = vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
    const ip = String(values[0]);
    const before = hits.get(ip) ?? 0;
    hits.set(ip, before + 1);
    return [{ n: before }]; // the CTE insert is invisible to the count in the same statement
  });
  const checkEmail = vi.fn();
  const checkWebsite = vi.fn();
  return { hits, tag, checkEmail, checkWebsite };
});
vi.mock("@/lib/db", () => ({ sql: () => h.tag }));
vi.mock("@/lib/homepage-fixes/validate", async (orig) => ({
  ...(await orig<typeof import("@/lib/homepage-fixes/validate")>()),
  checkEmail: h.checkEmail,
  checkWebsite: h.checkWebsite,
}));

import { GET, OPTIONS } from "./route";

function req(query: string, headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`https://captured-site-leads.vercel.app/api/homepage-fixes/check${query}`, {
    method,
    headers: { origin: "https://capturedsites.com", "x-forwarded-for": "1.2.3.4", ...headers },
  });
}

beforeEach(() => {
  h.hits.clear();
  h.tag.mockClear();
  h.checkEmail.mockReset().mockResolvedValue({ ok: true, code: "ok" });
  h.checkWebsite.mockReset().mockResolvedValue({ ok: true, code: "ok", url: "https://janedoe.com/" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/homepage-fixes/check", () => {
  it("runs both checks and returns their results", async () => {
    h.checkEmail.mockResolvedValue({ ok: false, code: "no_mail", message: "m" });
    const res = await GET(req("?email=bob%40x.com&site=janedoe.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: { ok: false, code: "no_mail", message: "m" },
      site: { ok: true, code: "ok", url: "https://janedoe.com/" },
    });
    expect(h.checkEmail).toHaveBeenCalledWith("bob@x.com");
    expect(h.checkWebsite).toHaveBeenCalledWith("janedoe.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("runs only the requested check", async () => {
    const res = await GET(req("?site=janedoe.com"));
    expect(await res.json()).toEqual({ site: { ok: true, code: "ok", url: "https://janedoe.com/" } });
    expect(h.checkEmail).not.toHaveBeenCalled();
  });

  it("400 when neither field is given", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("answers under 3 s with timeout passes when a check hangs", async () => {
    vi.useFakeTimers();
    h.checkEmail.mockReturnValue(new Promise(() => {}));
    h.checkWebsite.mockReturnValue(new Promise(() => {}));
    let res: Response | undefined;
    const p = GET(req("?email=bob%40x.com&site=janedoe.com")).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(2999);
    await p;
    expect(res).toBeDefined();
    expect(await res!.json()).toEqual({ email: { ok: true, code: "timeout" }, site: { ok: true, code: "timeout" } });
  });

  it("answers under 3 s when the rate-limit query hangs (fail open)", async () => {
    vi.useFakeTimers();
    h.tag.mockReturnValueOnce(new Promise(() => {}));
    let res: Response | undefined;
    const p = GET(req("?email=bob%40x.com")).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(2999);
    await p;
    expect(res!.status).toBe(200);
  });

  it("fails open when the rate-limit query errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.tag.mockRejectedValueOnce(new Error('relation "check_hits" does not exist'));
    const res = await GET(req("?email=bob%40x.com"));
    expect(res.status).toBe(200);
  });

  it("rate limits: the 31st request in 10 minutes from one IP gets 429", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await GET(req("?email=bob%40x.com"))).status).toBe(200);
    }
    const res = await GET(req("?email=bob%40x.com"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow_down" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    // another IP is unaffected
    expect((await GET(req("?email=bob%40x.com", { "x-forwarded-for": "5.6.7.8" }))).status).toBe(200);
    // the query counts the last 10 minutes for this IP
    const text = h.tag.mock.calls[0][0].join("?");
    expect(text).toMatch(/insert into check_hits/);
    expect(text).toMatch(/interval '10 minutes'/);
  });

  it("prunes old hits for every IP, not just the caller's (Minor 8)", async () => {
    await GET(req("?email=bob%40x.com"));
    const text = h.tag.mock.calls[0][0].join("?");
    const prune = text.match(/delete from check_hits[\s\S]*?returning/)?.[0] ?? "";
    expect(prune).toMatch(/at < now\(\) - interval '10 minutes'/);
    expect(prune).not.toMatch(/ip\s*=/);
  });
});

describe("CORS", () => {
  it("echoes allowed origins", async () => {
    for (const origin of ["https://capturedsites.com", "https://www.capturedsites.com"]) {
      const res = await GET(req("?email=bob%40x.com", { origin }));
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toMatch(/Origin/);
    }
  });

  it("does not echo other origins", async () => {
    for (const origin of ["https://evil.com", "https://capturedsites.com.evil.com", "http://capturedsites.com"]) {
      const res = await GET(req("?email=bob%40x.com", { origin }));
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });

  it("allows http://localhost:* outside production only", async () => {
    vi.stubEnv("NODE_ENV", "development");
    let res = await GET(req("?email=bob%40x.com", { origin: "http://localhost:5500" }));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5500");
    vi.stubEnv("NODE_ENV", "production");
    res = await GET(req("?email=bob%40x.com", { origin: "http://localhost:5500" }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("OPTIONS preflight", async () => {
    const res = await OPTIONS(req("", {}, "OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
    const denied = await OPTIONS(req("", { origin: "https://evil.com" }, "OPTIONS"));
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
