import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capture } from "./types";

const h = vi.hoisted(() => {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => []);
  const tag = vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(async () => []);
  const sqlFn = Object.assign(tag, { query });
  const blobs = new Map<string, Buffer>();
  const put = vi.fn<(path: string, body: Buffer, opts: unknown) => Promise<{ url: string }>>(async (path, body) => {
    blobs.set(`https://blob.test/${path}`, body);
    return { url: `https://blob.test/${path}` };
  });
  return { query, tag, sqlFn, put, blobs };
});
vi.mock("@/lib/db", () => ({ sql: () => h.sqlFn }));
vi.mock("@vercel/blob", () => ({ put: h.put }));

import {
  claimCapAlert, claimHfLead, domainOf, getCachedCapture, getHfLead, insertHfLead, latestSentFor, markStuckLeads,
  putCachedCapture, queuedLeads, recentProcessingFor, retryingLeads, updateHfLead,
} from "./store";

beforeEach(() => {
  h.query.mockReset().mockResolvedValue([]);
  h.tag.mockReset().mockResolvedValue([]);
  h.put.mockClear();
  h.blobs.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const b = h.blobs.get(url);
    return b ? new Response(new Uint8Array(b)) : new Response("missing", { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sqlText = () => h.tag.mock.calls.at(-1)![0].join("?");

describe("store", () => {
  it("domainOf lowercases and drops scheme, www and path", () => {
    expect(domainOf("https://WWW.JaneDoe.com/about?x=1")).toBe("janedoe.com");
    expect(domainOf("janedoe.com")).toBe("janedoe.com");
    expect(domainOf("http://studio.janedoe.com:8080/")).toBe("studio.janedoe.com");
  });

  it("insertHfLead writes a homepage_fixes row and returns its id", async () => {
    h.tag.mockResolvedValueOnce([{ id: "lead-1" }]);
    const id = await insertHfLead({ name: "Jane", email: "j@x.com", siteUrl: "https://x.com", goal: "g", ip: null, outcome: "processing" });
    expect(id).toBe("lead-1");
    expect(sqlText()).toMatch(/insert into leads/);
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["Jane", "j@x.com", "https://x.com", "g", null, "processing", "processing", "homepage_fixes", "processing"]);
    expect(sqlText()).toMatch(/processing_started_at[\s\S]*case when \? = 'processing' then now\(\) end/);
  });

  it("updateHfLead writes only whitelisted columns, casts content to jsonb, keeps status in step", async () => {
    await updateHfLead("lead-1", {
      outcome: "sent", cost_usd: 0.004, content: { a: 1 },
      ...({ "id = id; drop table leads; --": "x" } as object),
    });
    const [text, params] = h.query.mock.calls[0];
    expect(text).toBe("update leads set outcome = $1, content = $2::jsonb, cost_usd = $3, status = $4 where id = $5");
    expect(params).toEqual(["sent", '{"a":1}', 0.004, "complete", "lead-1"]);
  });

  it("updateHfLead with an empty patch does nothing", async () => {
    await updateHfLead("lead-1", {});
    expect(h.query).not.toHaveBeenCalled();
  });

  it("latestSentFor matches normalized email and domain, returns null on no rows", async () => {
    expect(await latestSentFor(" Jane@X.com ", "https://www.X.com/", 30)).toBeNull();
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["homepage_fixes", "jane@x.com", "x.com", 30]);
    h.tag.mockResolvedValueOnce([{ id: "l", pdf_url: "https://p" }]);
    expect(await latestSentFor("j@x.com", "x.com", 30)).toEqual({ id: "l", pdf_url: "https://p" });
  });

  it("scrape cache round-trips images through Blob URLs", async () => {
    const cand = { src: "https://x.com/a.jpg", w: 1440, h: 800, y: 0, alt: "", kind: "img" as const };
    const c = {
      url: "https://x.com/", page: { title: "X" }, capturedAt: "2026-11-03T00:00:00Z", linkStatus: {},
      before: { data: Buffer.from("before"), mime: "image/png" },
      photos: [{ data: Buffer.from("p1"), mime: "image/jpeg", candidate: cand, firstScreen: true }],
      logo: { data: Buffer.from("logo"), mime: "image/svg+xml" },
    } as unknown as Capture;
    await putCachedCapture("https://www.x.com", c);
    expect(h.put.mock.calls.map(([p]) => p.replace(/\/\d+-\w+\//, "/U/"))).toEqual([
      "scrape-cache/x.com/U/before.png", "scrape-cache/x.com/U/logo.svg", "scrape-cache/x.com/U/photo-01.jpg",
    ]);
    const [, domain, json] = h.tag.mock.calls[0];
    expect(domain).toBe("x.com");
    expect(String(json)).not.toContain("\"data\":{\"type\":\"Buffer\"");

    h.tag.mockResolvedValueOnce([{ data: JSON.parse(String(json)) }]);
    const back = await getCachedCapture("x.com");
    expect(back!.before.data.toString()).toBe("before");
    expect(back!.logo!.data.toString()).toBe("logo");
    expect(back!.photos[0]).toMatchObject({ mime: "image/jpeg", candidate: cand, firstScreen: true });
    expect(back!.photos[0].data.toString()).toBe("p1");
    expect(back!.page).toEqual({ title: "X" });
  });

  it("getCachedCapture returns null when a cached image is gone", async () => {
    h.tag.mockResolvedValueOnce([{ data: { before: { url: "https://blob.test/missing", mime: "image/png" }, photos: [], logo: null } }]);
    expect(await getCachedCapture("x.com")).toBeNull();
  });

  it("recentProcessingFor only counts earlier processing rows for the same email and site", async () => {
    expect(await recentProcessingFor(" Jane@X.com ", "https://www.X.com/", 10, "lead-2")).toBeNull();
    const text = sqlText();
    expect(text).toMatch(/l\.outcome in \('processing', 'queued', 'retrying'\)/);
    expect(text).toMatch(/\(l\.created_at, l\.id\) < \(me\.created_at, me\.id\)/);
    expect(text).toMatch(/make_interval\(mins => \?\)/);
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["lead-2", "homepage_fixes", "jane@x.com", "x.com", 10]);
    h.tag.mockResolvedValueOnce([{ id: "lead-1" }]);
    expect(await recentProcessingFor("j@x.com", "x.com", 10, "lead-2")).toEqual({ id: "lead-1" });
  });

  it("claimHfLead moves a row to processing only from the given outcomes", async () => {
    expect(await claimHfLead("lead-1", ["retrying"])).toBe(false);
    expect(sqlText()).toMatch(/update leads set outcome = 'processing', status = 'processing', processing_started_at = now\(\), stuck_alerted_at = null/);
    expect(sqlText()).toMatch(/outcome = any\(\?::text\[\]\)/);
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["lead-1", "homepage_fixes", ["retrying"]]);
    h.tag.mockResolvedValueOnce([{ id: "lead-1" }]);
    expect(await claimHfLead("lead-1", ["queued"])).toBe(true);
  });

  it("claimCapAlert is true only when the stored day changes", async () => {
    expect(await claimCapAlert("2026-11-03")).toBe(false);
    expect(sqlText()).toMatch(/'hf_cap_alert_date'/);
    expect(sqlText()).toMatch(/where app_config\.value <> excluded\.value/);
    h.tag.mockResolvedValueOnce([{ key: "hf_cap_alert_date" }]);
    expect(await claimCapAlert("2026-11-04")).toBe(true);
  });

  it("queuedLeads and retryingLeads list ids oldest first", async () => {
    h.tag.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    expect(await queuedLeads(5)).toEqual(["a", "b"]);
    expect(sqlText()).toMatch(/outcome = 'queued'[\s\S]*order by created_at asc/);
    h.tag.mockResolvedValueOnce([{ id: "c" }]);
    expect(await retryingLeads(10, 20)).toEqual(["c"]);
    expect(sqlText()).toMatch(/outcome = 'retrying' and retry_count = 1/);
    expect(sqlText()).toMatch(/coalesce\(processing_started_at, created_at\) < now\(\) - make_interval\(mins => \?\)/);
  });

  it("markStuckLeads marks and returns processing rows past the limit that weren't alerted yet", async () => {
    h.tag.mockResolvedValueOnce([{ id: "a", name: "Jane", email: "j@x.com", site_url: "https://x.com", since: "t" }]);
    expect(await markStuckLeads(20)).toHaveLength(1);
    const text = sqlText();
    expect(text).toMatch(/^\s*update leads set stuck_alerted_at = now\(\)/);
    expect(text).toMatch(/outcome = 'processing' and stuck_alerted_at is null/);
    expect(text).toMatch(/coalesce\(processing_started_at, created_at\) < now\(\) - make_interval\(mins => \?\)/);
    expect(text).not.toMatch(/set[^\n]*outcome =/);
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["homepage_fixes", 20]);
  });

  it("getHfLead returns the row or null", async () => {
    expect(await getHfLead("x")).toBeNull();
    h.tag.mockResolvedValueOnce([{ id: "x", name: "Jane" }]);
    expect(await getHfLead("x")).toEqual({ id: "x", name: "Jane" });
    expect(sqlText()).toMatch(/report_type = \?/);
  });
});
