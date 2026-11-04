import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ImageCandidate, PageData } from "./types";

const scrape = vi.fn();
vi.mock("@mendable/firecrawl-js", () => ({
  Firecrawl: class { scrape = scrape; },
}));

import { CaptureError, captureSite, imageWidth, parseScrape, sourceUrls } from "./capture";
import { DISMISS_SCRIPT, EXTRACT_SCRIPT, FRAME_SCRIPT, scrollStepScript } from "./page-script";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/firecrawl-gabby.json"), "utf8"),
);

const img = (src: string, w: number, h: number, y: number, hero?: boolean): ImageCandidate =>
  ({ src, w, h, y, alt: "", kind: "img", ...(hero ? { hero } : {}) });

// Tiny image headers: just enough bytes for the width to be read.
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
function png(w: number, h: number) {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0]);
}
function jpeg(w: number, h: number) {
  // SOI, an APP0 segment and a DQT-like segment to skip, then SOF2 (progressive).
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const other = [0xff, 0xdb, ...be16(5), 1, 2, 3];
  return Buffer.from([0xff, 0xd8, ...app0, ...other, 0xff, 0xc2, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}
const riff = (chunk: string, data: number[]) => Buffer.from([...ascii("RIFF"), ...le24(data.length + 12), 0, ...ascii("WEBP"), ...ascii(chunk), ...le24(data.length), 0, ...data]);
const webpLossy = (w: number, h: number) => riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
function webpLossless(w: number, h: number) {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]);
}
const webpExtended = (w: number, h: number) => riff("VP8X", [0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
// A photo URL's file width: "-w700" in the name, else 1600.
const fileWidth = (url: string) => Number(url.match(/-w(\d+)/)?.[1] ?? 1600);

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
    if (url.includes("static.showit.co/2048/") && url.includes("no2048")) return new Response(null, { status: 404 });
    if (url.includes("static.showit.co/1200/") && url.includes("no1200")) return new Response(null, { status: 404 });
    const type = url.endsWith(".png") ? "image/png" : url.includes("janedoe.com/") && !/\.(jpg|png)$/.test(url) ? "text/html" : "image/jpeg";
    const w = fileWidth(url);
    const body = type === "image/png" ? png(w, 600) : type === "image/jpeg" ? jpeg(w, 600) : new TextEncoder().encode("<html></html>");
    return new Response(method === "HEAD" ? null : new Uint8Array(body), { status: 200, headers: { "content-type": type } });
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

describe("imageWidth (file header)", () => {
  it("reads JPEG (SOF after other segments), PNG and the three WebP kinds", () => {
    expect(imageWidth(jpeg(2048, 1365))).toBe(2048);
    expect(imageWidth(png(1200, 800))).toBe(1200);
    expect(imageWidth(webpLossy(1500, 1000))).toBe(1500);
    expect(imageWidth(webpLossless(999, 700))).toBe(999);
    expect(imageWidth(webpExtended(2500, 1667))).toBe(2500);
  });
  it("reads GIF and AVIF (ispe) widths too", () => {
    expect(imageWidth(Buffer.from([...ascii("GIF89a"), ...le16(1), ...le16(1), 0, 0, 0]))).toBe(1);
    const ispe = [...be32(20), ...ascii("ispe"), 0, 0, 0, 0, ...be32(1800), ...be32(1200)];
    expect(imageWidth(Buffer.from([...be32(24), ...ascii("ftypavif"), ...Array(12).fill(0), ...ispe]))).toBe(1800);
  });
  it("returns null for unknown or cut-off data", () => {
    expect(imageWidth(Buffer.from([1, 2, 3]))).toBeNull();
    expect(imageWidth(Buffer.from("<svg></svg>"))).toBeNull();
    expect(imageWidth(jpeg(2048, 1365).subarray(0, 30))).toBeNull();
    expect(imageWidth(Buffer.alloc(0))).toBeNull();
  });
});

describe("sourceUrls", () => {
  it("rewrites a Showit size segment to 2048, then 1200, then 800", () => {
    expect(sourceUrls("https://static.showit.co/800/abc/57140/x.jpg")).toEqual([
      "https://static.showit.co/2048/abc/57140/x.jpg",
      "https://static.showit.co/1200/abc/57140/x.jpg",
      "https://static.showit.co/800/abc/57140/x.jpg",
    ]);
  });
  it("keeps other URLs as they are", () => {
    expect(sourceUrls("https://images.squarespace-cdn.com/a.jpg?format=2500w")).toEqual(["https://images.squarespace-cdn.com/a.jpg?format=2500w"]);
    expect(sourceUrls("https://janedoe.com/800/x.jpg")).toEqual(["https://janedoe.com/800/x.jpg"]);
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

  it("orders hero first, then first-screen by area, then the rest by area; caps at 3", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [
        img("https://janedoe.com/big-lower.jpg", 1400, 900, 2000),
        img("https://janedoe.com/first-big.jpg", 1440, 800, 0),
        img("https://janedoe.com/logo.svg", 1200, 900, 0),
        img("https://janedoe.com/hero.jpg", 480, 900, 0, true),
        img("https://janedoe.com/first-big.jpg", 1440, 800, 0),
        img("https://janedoe.com/first-small.jpg", 600, 400, 100),
        img("https://janedoe.com/mid-lower.jpg", 1000, 700, 1500),
        img("https://janedoe.com/tiny-lower.jpg", 900, 600, 3000),
        img("https://janedoe.com/too-small.jpg", 299, 600, 3000),
      ],
      logo: { src: "https://janedoe.com/logo.png", w: 200, h: 80 },
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.photos.map((p) => p.candidate.src)).toEqual([
      "https://janedoe.com/hero.jpg",
      "https://janedoe.com/first-big.jpg",
      "https://janedoe.com/first-small.jpg",
    ]);
    expect(cap.photos[0].candidate.hero).toBe(true);
    expect(cap.photos.map((p) => p.firstScreen)).toEqual([true, true, true]);
    expect(calls.some((c) => c.url.endsWith(".svg") || c.url.endsWith("too-small.jpg"))).toBe(false);
    expect(cap.before.mime).toBe("image/jpeg");
    expect(cap.logo?.mime).toBe("image/png");
    expect(cap.page.dismissed).toEqual(["Join my list"]);
  });

  it("qualifies by the downloaded file's width: 1000 for photos, 600 for the hero; fills up from later candidates", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [
        img("https://janedoe.com/hero-w650.jpg", 1440, 800, 0, true),
        img("https://janedoe.com/a-w999.jpg", 1400, 900, 0),
        img("https://janedoe.com/b-w1000.png", 484, 484, 1000),
        img("https://janedoe.com/broken.jpg", 1300, 900, 1200),
        img("https://janedoe.com/c-w500.jpg", 1200, 900, 1400),
        img("https://janedoe.com/d-w2000.jpg", 400, 300, 3000),
        img("https://janedoe.com/e-w2000.jpg", 300, 200, 4000),
      ],
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.photos.map((p) => p.candidate.src)).toEqual([
      "https://janedoe.com/hero-w650.jpg",
      "https://janedoe.com/b-w1000.png",
      "https://janedoe.com/d-w2000.jpg",
    ]);
    // At most 6 candidates are downloaded.
    expect(calls.some((c) => c.url.includes("e-w2000"))).toBe(false);
  });

  it("drops a non-hero photo under 1000 wide and a hero under 600 wide", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [img("https://janedoe.com/hero-w599.jpg", 1440, 800, 0, true), img("https://janedoe.com/a-w999.jpg", 1400, 900, 0)],
    })));
    const cap = await captureSite("https://janedoe.com", { fetchImpl: stubFetch().impl });
    expect(cap.photos).toEqual([]);
  });

  it("leaves out images entirely above the page, unless they are the hero", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [img("https://janedoe.com/above.jpg", 1440, 900, -900), img("https://janedoe.com/hero.jpg", 1440, 960, -32, true)],
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.photos.map((p) => p.candidate.src)).toEqual(["https://janedoe.com/hero.jpg"]);
    expect(calls.some((c) => c.url.includes("above"))).toBe(false);
  });

  it("downloads Showit photos at /2048/, falling back to 1200 then 800", async () => {
    scrape.mockResolvedValue(fakeDoc(fakePage({
      imgs: [
        img("https://static.showit.co/800/AAA/57140/hero.jpg", 480, 900, 0, true),
        img("https://static.showit.co/1600/BBB/57140/no2048.jpg", 1440, 900, 1000),
        img("https://static.showit.co/400/CCC/57140/no2048-no1200.jpg", 1440, 900, 2000),
      ],
    })));
    const { impl, calls } = stubFetch();
    const cap = await captureSite("https://janedoe.com", { fetchImpl: impl });
    expect(cap.photos).toHaveLength(3);
    const got = calls.filter((c) => c.url.includes("showit")).map((c) => c.url);
    expect(got).toContain("https://static.showit.co/2048/AAA/57140/hero.jpg");
    expect(got).not.toContain("https://static.showit.co/1200/AAA/57140/hero.jpg");
    expect(got).toContain("https://static.showit.co/1200/BBB/57140/no2048.jpg");
    expect(got).toContain("https://static.showit.co/800/CCC/57140/no2048-no1200.jpg");
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
