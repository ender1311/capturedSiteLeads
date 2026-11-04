import { Firecrawl, type ScrapeOptions } from "@mendable/firecrawl-js";
import { DISMISS_SCRIPT, EXTRACT_SCRIPT } from "./page-script";
import type { Asset, Capture, ImageCandidate, PageData } from "./types";

export class CaptureError extends Error {
  kind: "bot_check" | "unreachable" | "empty";
  constructor(kind: CaptureError["kind"], message: string) {
    super(message);
    this.name = "CaptureError";
    this.kind = kind;
  }
}

const VIEWPORT_H = 900;
const MAX_PHOTOS = 3;
const MIN_PHOTO_W = 800;
const MAX_PHOTO_TRIES = 6;
const MAX_LINKS_CHECKED = 15;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const LINK_TIMEOUT_MS = 5_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BOT_CHECK_RE =
  /just a moment|verify you are human|checking your browser|captcha|access denied|attention required|are you a robot/i;

// The one Firecrawl call per report.
export const SCRAPE_OPTIONS: ScrapeOptions = {
  formats: [{ type: "screenshot", fullPage: false, viewport: { width: 1440, height: VIEWPORT_H }, quality: 88 }],
  actions: [
    { type: "wait", milliseconds: 3000 },
    { type: "executeJavascript", script: DISMISS_SCRIPT },
    { type: "scroll", direction: "down" }, { type: "scroll", direction: "down" }, { type: "scroll", direction: "down" },
    { type: "scroll", direction: "up" }, { type: "scroll", direction: "up" }, { type: "scroll", direction: "up" },
    { type: "wait", milliseconds: 1500 },
    { type: "executeJavascript", script: DISMISS_SCRIPT },
    { type: "executeJavascript", script: EXTRACT_SCRIPT },
  ],
  onlyMainContent: false,
  proxy: "basic",
  timeout: 45000,
};

type ScrapeDoc = {
  screenshot?: string;
  actions?: { javascriptReturns?: { type: string; value: unknown }[] };
  metadata?: { statusCode?: number };
};

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function parseScrape(doc: ScrapeDoc): { page: PageData; screenshotUrl: string } {
  const returns = doc.actions?.javascriptReturns ?? [];
  const extracted = returns.length ? asJson(returns[returns.length - 1].value) : undefined;
  const page = extracted && typeof extracted === "object" && Array.isArray((extracted as PageData).rows)
    ? (extracted as Omit<PageData, "dismissed">)
    : null;
  const status = doc.metadata?.statusCode;
  if (status !== undefined && status >= 400) {
    const text = page ? `${page.title} ${page.sample}` : "";
    throw new CaptureError(BOT_CHECK_RE.test(text) ? "bot_check" : "unreachable", `Site answered HTTP ${status}`);
  }
  if (!page) throw new CaptureError("empty", "Firecrawl returned no page extraction");
  if (!doc.screenshot) throw new CaptureError("empty", "Firecrawl returned no screenshot");

  // Every return before the extraction is a dismiss() run.
  const dismissed: string[] = [];
  for (const r of returns.slice(0, -1)) {
    const v = asJson(r.value);
    if (Array.isArray(v)) for (const t of v) if (typeof t === "string" && !dismissed.includes(t)) dismissed.push(t);
  }
  return { page: { ...page, dismissed }, screenshotUrl: doc.screenshot };
}

async function download(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Asset | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": BROWSER_UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim() || "image/jpeg";
    const data = Buffer.from(await res.arrayBuffer());
    return data.length ? { data, mime } : null;
  } catch {
    return null;
  }
}

function photoOrder(imgs: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  return imgs
    .filter((i) => !/\.svg(\?|$)/i.test(i.src) && i.w >= MIN_PHOTO_W && !seen.has(i.src) && !!seen.add(i.src))
    .sort((a, b) => (a.y < VIEWPORT_H ? 0 : 1) - (b.y < VIEWPORT_H ? 0 : 1) || b.w * b.h - a.w * a.h);
}

const bareHost = (u: URL) => u.hostname.replace(/^www\./, "");

async function checkLinks(
  fetchImpl: typeof fetch,
  page: PageData,
): Promise<Capture["linkStatus"]> {
  const status: Capture["linkStatus"] = {};
  const base = new URL(page.finalUrl);
  const toCheck: string[] = [];
  for (const { href } of page.buttons) {
    if (href in status || toCheck.includes(href)) continue;
    if (href.startsWith("#")) { status[href] = "same-page"; continue; }
    let u: URL;
    try { u = new URL(href, base); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") { status[href] = "off-site"; continue; }
    if (bareHost(u) !== bareHost(base)) { status[href] = "off-site"; continue; }
    if (u.hash && u.pathname === base.pathname && u.search === base.search) { status[href] = "same-page"; continue; }
    if (toCheck.length < MAX_LINKS_CHECKED) toCheck.push(href);
  }
  await Promise.all(toCheck.map(async (href) => {
    const req = (method: string) => fetchImpl(href, {
      method, redirect: "follow", headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    try {
      let res = await req("HEAD");
      // Some servers refuse HEAD; ask again with GET so the status reflects the real page.
      if (res.status === 405 || res.status === 501) res = await req("GET");
      status[href] = res.status;
    } catch {
      status[href] = "no response";
    }
  }));
  return status;
}

export async function captureSite(url: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<Capture> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });

  let doc: ScrapeDoc;
  try {
    doc = (await firecrawl.scrape(target, SCRAPE_OPTIONS)) as ScrapeDoc;
  } catch (e) {
    throw new CaptureError("unreachable", `Firecrawl could not load ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { page, screenshotUrl } = parseScrape(doc);

  const before = await download(fetchImpl, screenshotUrl, DOWNLOAD_TIMEOUT_MS);
  if (!before) throw new CaptureError("empty", "Could not download the Firecrawl screenshot");

  const photosP = (async () => {
    const photos: Capture["photos"] = [];
    for (const candidate of photoOrder(page.imgs).slice(0, MAX_PHOTO_TRIES)) {
      if (photos.length >= MAX_PHOTOS) break;
      const asset = await download(fetchImpl, candidate.src, DOWNLOAD_TIMEOUT_MS);
      if (asset && asset.mime.startsWith("image/")) photos.push({ ...asset, candidate, firstScreen: candidate.y < VIEWPORT_H });
    }
    return photos;
  })();
  const logoP = page.logo ? download(fetchImpl, page.logo.src, DOWNLOAD_TIMEOUT_MS) : Promise.resolve(null);
  const [photos, logo, linkStatus] = await Promise.all([photosP, logoP, checkLinks(fetchImpl, page)]);

  return { url: target, page, before, photos, logo, linkStatus, capturedAt: new Date().toISOString() };
}
