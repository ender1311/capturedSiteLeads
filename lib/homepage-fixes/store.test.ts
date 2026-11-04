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

import { domainOf, getCachedCapture, insertHfLead, latestSentFor, putCachedCapture, updateHfLead } from "./store";

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
    expect(h.tag.mock.calls[0].slice(1)).toEqual(["Jane", "j@x.com", "https://x.com", "g", null, "processing", "processing", "homepage_fixes"]);
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
});
