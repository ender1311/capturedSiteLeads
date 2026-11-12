import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// In-memory stand-in for the three tables the route touches.
const h = vi.hoisted(() => {
  const s = { hits: new Map<string, number>(), cache: new Map<string, unknown>(), daily: 0, dbDown: false };
  const tag = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
    if (s.dbDown) throw new Error("db down");
    const q = strings.join("?");
    if (q.includes("check_hits")) {
      const key = String(v[0]);
      const before = s.hits.get(key) ?? 0;
      s.hits.set(key, before + 1);
      return [{ n: before }];
    }
    if (q.includes("select town, terms from keyword_cache")) {
      const [niche, keys] = v as [string, string[]];
      return keys.filter((k) => s.cache.has(`${niche}|${k}`)).map((k) => ({ town: k, terms: s.cache.get(`${niche}|${k}`) }));
    }
    if (q.includes("insert into keyword_cache")) {
      s.cache.set(`${v[0]}|${v[1]}`, JSON.parse(String(v[2])));
      return [];
    }
    if (q.includes("keyword_lookups")) {
      const [, n, cap] = v as [string, number, number];
      if (s.daily + n > cap) return [];
      s.daily += n;
      return [{ n: s.daily }];
    }
    throw new Error(`unexpected query: ${q}`);
  });
  return { s, tag };
});
vi.mock("@/lib/db", () => ({ sql: () => h.tag }));

import { OPTIONS, POST } from "./route";
import { parseInput, pickBest, termsFor } from "@/lib/town-keywords";

const fetchMock = vi.fn();
const keResponse = (vols: Record<string, number>) =>
  new Response(JSON.stringify({ data: Object.entries(vols).map(([keyword, vol]) => ({ keyword, vol })), credits: 99, credits_consumed: 4 }), { status: 200 });

function req(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new NextRequest("https://captured-site-leads.vercel.app/api/tools/town-keywords", {
    method,
    headers: { origin: "https://capturedsites.com", "x-forwarded-for": "1.2.3.4", "content-type": "application/json", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}
const ip = (n: number) => ({ "x-forwarded-for": `9.9.9.${n}` });

beforeEach(() => {
  h.s.hits.clear();
  h.s.cache.clear();
  h.s.daily = 0;
  h.s.dbDown = false;
  vi.stubEnv("KEYWORDS_EVERYWHERE_API_KEY", "test-key");
  fetchMock.mockReset().mockImplementation(async () => keResponse({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseInput", () => {
  it("trims, single-spaces and dedupes towns case-insensitively", () => {
    expect(parseInput({ niche: "newborn", towns: ["  Oklahoma   City ", "oklahoma city", "Coeur d'Alene", "St. Mary-Ann"] })).toEqual({
      niche: "newborn",
      towns: [
        { town: "Oklahoma City", key: "oklahoma city" },
        { town: "Coeur d'Alene", key: "coeur d'alene" },
        { town: "St. Mary-Ann", key: "st. mary-ann" },
      ],
    });
  });

  it.each([
    null, "x", {}, { niche: "Newborn", towns: ["Edmond"] }, { niche: "cats", towns: ["Edmond"] },
    { niche: "pet", towns: [] }, { niche: "pet", towns: ["a", "b", "c", "d", "e"].map((x) => `${x}town`) },
    { niche: "pet", towns: "Edmond" }, { niche: "pet", towns: [3] }, { niche: "pet", towns: ["E"] },
    { niche: "pet", towns: ["x".repeat(41)] }, { niche: "pet", towns: ["Edmond1"] }, { niche: "pet", towns: ["<b>"] },
    { niche: "pet", towns: ["..."] }, { niche: "pet", towns: ["Edmond", ""] },
  ])("rejects %j", (body) => expect(parseInput(body)).toBeNull());
});

describe("terms and best pick", () => {
  it("builds the four terms in order", () => {
    expect(termsFor("newborn", "oklahoma city")).toEqual([
      "newborn photographer oklahoma city", "oklahoma city newborn photographer",
      "oklahoma city newborn photos", "newborn photography oklahoma city",
    ]);
  });
  it("picks the highest volume; ties and all-zero go to the first", () => {
    const t = (vols: number[]) => vols.map((volume, i) => ({ term: `t${i}`, volume }));
    expect(pickBest(t([10, 50, 20, 50]))).toBe("t1");
    expect(pickBest(t([0, 0, 0, 0]))).toBe("t0");
    expect(pickBest(t([5, 5, 5, 6]))).toBe("t3");
  });
});

describe("POST /api/tools/town-keywords", () => {
  it("looks up uncached towns in one call and returns volumes and the best term", async () => {
    fetchMock.mockResolvedValueOnce(keResponse({ "newborn photographer edmond": 90, "Edmond Newborn Photographer": 140, "newborn photography edmond": 140 }));
    const res = await POST(req({ niche: "newborn", towns: ["Edmond", "Arcadia"] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.towns[0]).toEqual({
      town: "Edmond",
      terms: [
        { term: "newborn photographer edmond", volume: 90 },
        { term: "edmond newborn photographer", volume: 140 },
        { term: "edmond newborn photos", volume: 0 },
        { term: "newborn photography edmond", volume: 140 },
      ],
      best: "edmond newborn photographer",
    });
    expect(body.towns[1].best).toBe("newborn photographer arcadia");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.keywordseverywhere.com/v1/get_keyword_data");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const form = init.body as URLSearchParams;
    expect(form.getAll("kw[]")).toHaveLength(8);
    expect([form.get("country"), form.get("currency"), form.get("dataSource")]).toEqual(["us", "usd", "gkp"]);
    expect(h.s.daily).toBe(2);
  });

  it("serves a cached repeat without calling the API or counting toward the daily cap", async () => {
    await POST(req({ niche: "newborn", towns: ["Edmond"] }));
    const res = await POST(req({ niche: "newborn", towns: [" edmond "] }, ip(2)));
    const body = await res.json();
    expect([res.status, body.cached, body.towns[0].town]).toEqual([200, true, "edmond"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.s.daily).toBe(1);
  });

  it("sends only the uncached towns", async () => {
    await POST(req({ niche: "pet", towns: ["Edmond"] }));
    const res = await POST(req({ niche: "pet", towns: ["Edmond", "Guthrie"] }, ip(2)));
    expect((await res.json()).cached).toBe(false);
    const form = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(form.getAll("kw[]")).toEqual(termsFor("pet", "guthrie"));
    expect(h.s.daily).toBe(2);
  });

  it("503 busy at the daily cap, before any paid call; cached towns still work", async () => {
    await POST(req({ niche: "pet", towns: ["Edmond"] }));
    h.s.daily = 149;
    let res = await POST(req({ niche: "pet", towns: ["Guthrie", "Arcadia"] }, ip(2)));
    expect([res.status, await res.json()]).toEqual([503, { error: "busy" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    res = await POST(req({ niche: "pet", towns: ["Edmond"] }, ip(3)));
    expect(res.status).toBe(200);
    res = await POST(req({ niche: "pet", towns: ["Guthrie"] }, ip(4)));
    expect(res.status).toBe(200);
    expect(h.s.daily).toBe(150);
  });

  it("fails closed with no paid call when the database is down", async () => {
    h.s.dbDown = true;
    const res = await POST(req({ niche: "pet", towns: ["Edmond"] }));
    expect([res.status, await res.json()]).toEqual([500, { error: "server" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 input for bad bodies, without a paid call", async () => {
    for (const [i, body] of (["not json", { niche: "dog", towns: ["Edmond"] }, { niche: "pet", towns: ["Edm0nd"] }] as unknown[]).entries()) {
      const res = await POST(req(body, ip(10 + i)));
      expect([res.status, await res.json()]).toEqual([400, { error: "input" }]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits 5 per IP per hour, keyed apart from other tools", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req({ niche: "pet", towns: ["Edmond"] }))).status).toBe(200);
    const res = await POST(req({ niche: "pet", towns: ["Edmond"] }));
    expect([res.status, await res.json()]).toEqual([429, { error: "rate" }]);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://capturedsites.com");
    expect([...h.s.hits.keys()]).toEqual(["town-keywords:1.2.3.4"]);
    const window = h.tag.mock.calls.find((c) => c[0].join("?").includes("check_hits"))!;
    expect(window[0].join("?")).toContain("make_interval(mins => ?)");
    expect(window.slice(1)).toEqual(["town-keywords:1.2.3.4", "town-keywords:1.2.3.4", 60]);
    expect((await POST(req({ niche: "pet", towns: ["Edmond"] }, ip(5)))).status).toBe(200);
  });

  it.each([
    ["non-2xx", async () => new Response("bad key sk_live_secret", { status: 401 })],
    ["insufficient credits", async () => new Response(JSON.stringify({ message: "402 Insufficient Credits" }), { status: 402 })],
    ["bad JSON", async () => new Response("<html>oops", { status: 200 })],
    ["no data array", async () => new Response(JSON.stringify({ message: "x" }), { status: 200 })],
    ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["network", async () => { throw new TypeError("fetch failed"); }],
  ])("502 upstream on %s, without leaking or caching", async (_name, impl) => {
    fetchMock.mockImplementationOnce(impl);
    const res = await POST(req({ niche: "pet", towns: ["Edmond"] }));
    expect([res.status, await res.json()]).toEqual([502, { error: "upstream" }]);
    expect(h.s.cache.size).toBe(0);
  });

  it("passes a 10 second timeout signal", async () => {
    await POST(req({ niche: "pet", towns: ["Edmond"] }));
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("502 upstream when the API key is missing", async () => {
    vi.stubEnv("KEYWORDS_EVERYWHERE_API_KEY", "");
    const res = await POST(req({ niche: "pet", towns: ["Edmond"] }));
    expect([res.status, await res.json()]).toEqual([502, { error: "upstream" }]);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect((await POST(req({ niche: "pet", towns: ["Edmond"] }, { origin }))).headers.get("access-control-allow-origin")).toBeNull();
  });
});
