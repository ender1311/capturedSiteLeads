import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ImageCandidate, PageData } from "./types";

const scrape = vi.fn();
vi.mock("@mendable/firecrawl-js", () => ({
  Firecrawl: class { scrape = scrape; },
}));

import { CaptureError, captureSite, parseScrape } from "./capture";
import { DISMISS_SCRIPT, EXTRACT_SCRIPT, FRAME_SCRIPT, scrollStepScript } from "./page-script";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/firecrawl-gabby.json"), "utf8"),
);

const img = (src: string, w: number, h: number, y: number): ImageCandidate => ({ src, w, h, y, alt: "", kind: "img" });

function fakePage(over: Partial<PageData> = {}): Omit<PageData, "dismissed"> {
  return {
    title: "Jane Doe Photography", finalUrl: "https://janedoe.com/", pageHeight: 4000, metaDesc: "",
    rows: [], imgs: [], nav: ["Home"], navTop: true, navOverPhoto: false, navBg: null, navColor: null,
    logo: null, fonts: { heading: "Lora", headingWeight: "400", body: "Lato" },
    uppercaseHeadings: false, accent: null, buttons: [], textLength: 2000, sample: "Hello",
    frame: true, screenH: 900, ...over,
  };
}

function fakeDoc(page: Omit<PageData, "dismissed">) {
  return {
    screenshot: "https://storage.firecrawl.test/shot.jpg",
    metadata: { statusCode: 200 },
    actions: { javascriptReturns: [
      { type: "object", value: ["Join my list"] },
      { type: "object", value: [] },
      { type: "string", value: JSON.stringify(page) },
    ] },
  };
}

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("broken")) return new Response("nope", { status: 404 });
    if (url.includes("/missing")) return new Response(null, { status: 404 });
    if (url.includes("/shielded")) return new Response(method === "HEAD" ? null : "ok", { status: method === "HEAD" ? 403 : 200 });
    if (url.includes("/forbidden")) return new Response(method === "HEAD" ? null : "no", { status: 403 });
    if (url.includes("/nohead")) return new Response(method === "HEAD" ? null : "ok", { status: method === "HEAD" ? 405 : 200 });
    const type = url.endsWith(".png") ? "image/png" : url.includes("janedoe.com/") && !/\.(jpg|png)$/.test(url) ? "text/html" : "image/jpeg";
    return new Response(method === "HEAD" ? null : new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": type } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("page scripts", () => {
  it("are parseable ES2017 without optional chaining or nullish coalescing", () => {
    for (const s of [DISMISS_SCRIPT, EXTRACT_SCRIPT, FRAME_SCRIPT, scrollStepScript(0.5)]) {
      expect(() => new Function(`return ${s}`)).not.toThrow();
      expect(s).not.toMatch(/\?\.|\?\?/);
    }
  });
});

describe("parseScrape", () => {
  it("reads the extraction JSON and screenshot", () => {
    const { page, screenshotUrl } = parseScrape(fixture);
    expect(page.nav.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeGreaterThan(20);
    expect(screenshotUrl.startsWith("https://")).toBe(true);
    expect(page.fonts.heading).not.toBe("");
    expect(page.frame).toBe(true);
    expect(page.screenH).toBe(900);
    expect(page.pageHeight).toBeLessThan(100000);
  });

  it("merges dismissed popup texts", () => {
    const { page } = parseScrape(fakeDoc(fakePage()));
    expect(page.dismissed).toEqual(["Join my list"]);
  });

  it("throws CaptureError kind empty when extraction missing", () => {
    const doc = { screenshot: "https://x.test/s.jpg", actions: { javascriptReturns: [{ type: "object", value: [] }] } };
    expect(() => parseScrape(doc)).toThrow(CaptureError);
    try { parseScrape(doc); } catch (e) { expect((e as CaptureError).kind).toBe("empty"); }
    try { parseScrape({}); } catch (e) { expect((e as CaptureError).kind).toBe("empty"); }
  });

  it("throws unreachable on HTTP >= 400 and bot_check when the page is a bot check", () => {
    const doc = { ...fakeDoc(fakePage()), metadata: { statusCode: 500 } };
    try { parseScrape(doc); throw new Error("no throw"); } catch (e) { expect((e as CaptureError).kind).toBe("unreachable"); }
    const bot = { ...fakeDoc(fakePage({ title: "Just a moment..." })), metadata: { statusCode: 403 } };
    try { parseScrape(bot); throw new Error("no throw"); } catch (e) { expect((e as CaptureError).kind).toBe("bot_check"); }
  });

  it("throws bot_check on a 200 response whose page is a bot check", () => {
    const doc = fakeDoc(fakePage({ title: "Example", sample: "Please verify you are human to continue" }));
    try { parseScrape(doc); throw new Error("no throw"); } catch (e) { expect((e as CaptureError).kind).toBe("bot_check"); }
  });
});

describe("captureSite", () => {
  beforeEach(() => { scrape.mockReset(); vi.stubEnv("FIRECRAWL_API_KEY", "fc-test"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("throws unreachable without FIRECRAWL_API_KEY and never scrapes", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const err = await captureSite("janedoe.com", { fetchImpl: stubFetch().impl }).catch((e: unknown) => e);
    expect((err as CaptureError).kind).toBe("unreachable");
    expect((err as Error).message).toMatch(/FIRECRAWL_API_KEY/);
    expect(scrape).not.toHaveBeenCalled();
  });

  it("makes exactly one basic-proxy scrape with the brief's options", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage()));
    await captureSite("janedoe.com", { fetchImpl: stubFetch().impl });
    expect(scrape).toHaveBeenCalledTimes(1);
    const [url, opts] = scrape.mock.calls[0];
    expect(url).toBe("https://janedoe.com");
    expect(opts).toMatchObject({ proxy: "basic", timeout: 45000, onlyMainContent: false });
    const scripts = opts.actions.filter((a: { type: string }) => a.type === "executeJavascript").map((a: { script: string }) => a.script);
    expect(scripts.filter((x: string) => x === DISMISS_SCRIPT)).toHaveLength(3);
    expect(scripts.indexOf(FRAME_SCRIPT)).toBe(1);
    expect(scripts[scripts.length - 1]).toBe(EXTRACT_SCRIPT);
    // The frame sits inside the viewport (invisible) so scroll animations can fire.
    expect(FRAME_SCRIPT).toMatch(/left:0;top:0;.*opacity:0;pointer-events:none/);
  });

  it("maps Firecrawl errors to unreachable", async () => {
    scrape.mockImplementation(async () => { throw new Error("SCRAPE_TIMEOUT"); });
    const err = await captureSite("janedoe.com", { fetchImpl: stubFetch().impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).kind).toBe("unreachable");
  });

  it("downloads hero first and caps at 3 photos", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [
        img("https://janedoe.com/big-lower.jpg", 1400, 900, 2000),
        img("https://janedoe.com/hero.jpg", 1440, 800, 0),
        img("https://janedoe.com/logo.svg", 1200, 900, 0),
        img("https://janedoe.com/small.jpg", 600, 400, 100),
        img("https://janedoe.com/hero.jpg", 1440, 800, 0),
        img("https://janedoe.com/mid-lower.jpg", 1000, 700, 1500),
        img("https://janedoe.com/tiny-lower.jpg", 900, 600, 3000),
      ],
      logo: { src: "https://janedoe.com/logo.png", w: 200, h: 80 },
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.photos.map((p) => p.candidate.src)).toEqual([
      "https://janedoe.com/hero.jpg",
      "https://janedoe.com/big-lower.jpg",
      "https://janedoe.com/mid-lower.jpg",
    ]);
    expect(cap.photos.map((p) => p.firstScreen)).toEqual([true, false, false]);
    expect(calls.some((c) => c.url.endsWith(".svg") || c.url.endsWith("small.jpg"))).toBe(false);
    expect(cap.before.mime).toBe("image/jpeg");
    expect(cap.logo?.mime).toBe("image/png");
    expect(cap.page.dismissed).toEqual(["Join my list"]);
  });

  it("uses the extracted screen height for firstScreen", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      frame: false, screenH: 1080,
      imgs: [img("https://janedoe.com/a.jpg", 1400, 900, 1000), img("https://janedoe.com/b.jpg", 1600, 900, 2000)],
    })));
    const cap = await captureSite("https://janedoe.com", { fetchImpl: stubFetch().impl });
    expect(cap.photos.map((p) => [p.candidate.src, p.firstScreen])).toEqual([
      ["https://janedoe.com/a.jpg", true], ["https://janedoe.com/b.jpg", false],
    ]);
  });

  it("skips photos that fail to download", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [img("https://janedoe.com/broken.jpg", 1440, 800, 0), img("https://janedoe.com/ok.jpg", 1000, 700, 1200)],
    })));
    const cap = await captureSite("https://janedoe.com", { fetchImpl: stubFetch().impl });
    expect(cap.photos.map((p) => p.candidate.src)).toEqual(["https://janedoe.com/ok.jpg"]);
  });

  it("retries a 403 or 405 HEAD once with GET and uses that status", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      buttons: [
        { text: "Home", href: "https://janedoe.com/shielded", y: 10 },
        { text: "Private", href: "https://janedoe.com/forbidden", y: 20 },
        { text: "Old", href: "https://janedoe.com/nohead", y: 30 },
        { text: "Contact", href: "https://janedoe.com/contact", y: 40 },
      ],
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.linkStatus).toEqual({
      "https://janedoe.com/shielded": 200,
      "https://janedoe.com/forbidden": 403,
      "https://janedoe.com/nohead": 200,
      "https://janedoe.com/contact": 200,
    });
    const gets = calls.filter((c) => c.method === "GET" && !c.url.includes("firecrawl")).map((c) => c.url);
    expect(gets.filter((u) => /shielded|forbidden|nohead/.test(u))).toHaveLength(3);
    expect(gets).not.toContain("https://janedoe.com/contact");
  });

  it("marks link status", async () => {
    const onSite = Array.from({ length: 20 }, (_, i) => ({ text: `Page ${i}`, href: `https://janedoe.com/page-${i}`, y: 100 + i }));
    scrape.mockResolvedValue(fakeDoc(fakePage({
      buttons: [
        { text: "Contact", href: "https://www.janedoe.com/contact", y: 50 },
        { text: "Gone", href: "https://janedoe.com/missing", y: 60 },
        { text: "Instagram", href: "https://instagram.com/janedoe", y: 70 },
        { text: "Jump", href: "#x", y: 80 },
        { text: "Portfolio", href: "https://janedoe.com/#portfolio", y: 90 },
        ...onSite,
      ],
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.linkStatus["https://www.janedoe.com/contact"]).toBe(200);
    expect(cap.linkStatus["https://janedoe.com/missing"]).toBe(404);
    expect(cap.linkStatus["https://instagram.com/janedoe"]).toBe("off-site");
    expect(cap.linkStatus["#x"]).toBe("same-page");
    expect(cap.linkStatus["https://janedoe.com/#portfolio"]).toBe("same-page");
    const heads = calls.filter((c) => c.method === "HEAD");
    expect(heads).toHaveLength(15);
    expect(Object.values(cap.linkStatus).filter((v) => typeof v === "number")).toHaveLength(15);
    expect(calls.some((c) => c.url.includes("instagram"))).toBe(false);
  });
});
