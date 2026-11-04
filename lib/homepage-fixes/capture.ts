import { Firecrawl, type ScrapeOptions } from "@mendable/firecrawl-js";
import { DISMISS_SCRIPT, EXTRACT_SCRIPT, FRAME_SCRIPT, SCREEN_H, SCREEN_W, scrollStepScript } from "./page-script";
import type { Asset, Capture, ImageCandidate, PageData } from "./types";
import { defaultLookup, isPublicUrl, type Lookup } from "./validate";

export class CaptureError extends Error {
  kind: "bot_check" | "unreachable" | "empty";
  constructor(kind: CaptureError["kind"], message: string) {
    super(message);
    this.name = "CaptureError";
    this.kind = kind;
  }
}

const MAX_PHOTOS = 3;
// Displayed-size prefilter, then the downloaded file's own width decides.
const MIN_SHOWN_W = 300;
const MIN_SHOWN_H = 200;
const MIN_FILE_W = 1000;
const MIN_HERO_FILE_W = 600;
const MAX_PHOTO_TRIES = 6;
const MAX_LINKS_CHECKED = 15;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const LINK_TIMEOUT_MS = 5_000;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BOT_CHECK_RE =
  /just a moment|verify you are human|checking your browser|captcha|access denied|attention required|are you a robot/i;

// The one Firecrawl call per report. Firecrawl's action browser is 1920x100000, so the
// page is re-loaded in a hidden same-origin 1440x900 iframe and read from there.
const SCROLL_STEPS = [0.2, 0.4, 0.6, 0.8, 1];
export const SCRAPE_OPTIONS: ScrapeOptions = {
  formats: [{ type: "screenshot", fullPage: false, viewport: { width: SCREEN_W, height: SCREEN_H }, quality: 88 }],
  actions: [
    { type: "wait", milliseconds: 3000 },
    { type: "executeJavascript", script: DISMISS_SCRIPT },
    { type: "executeJavascript", script: FRAME_SCRIPT },
    { type: "wait", milliseconds: 4000 },
    { type: "executeJavascript", script: DISMISS_SCRIPT },
    // Step through the page so lazy images load, then back to the top.
    ...SCROLL_STEPS.flatMap((f) => [
      { type: "executeJavascript" as const, script: scrollStepScript(f) },
      { type: "wait" as const, milliseconds: 300 },
    ]),
    { type: "executeJavascript", script: scrollStepScript(0) },
    { type: "wait", milliseconds: 1500 },
    { type: "executeJavascript", script: DISMISS_SCRIPT },
    { type: "executeJavascript", script: EXTRACT_SCRIPT },
  ],
  onlyMainContent: false,
  proxy: "basic",
  timeout: 45000,
};

export type ScrapeDoc = {
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
  if (BOT_CHECK_RE.test(`${page.title} ${page.sample}`)) {
    throw new CaptureError("bot_check", "The site showed a bot check, so the homepage could not be seen");
  }
  if (!doc.screenshot) throw new CaptureError("empty", "Firecrawl returned no screenshot");

  // Array returns before the extraction are dismiss() runs; the rest are status strings.
  const dismissed: string[] = [];
  for (const r of returns.slice(0, -1)) {
    const v = asJson(r.value);
    if (Array.isArray(v)) for (const t of v) if (typeof t === "string" && !dismissed.includes(t)) dismissed.push(t);
  }
  return { page: { ...page, dismissed }, screenshotUrl: doc.screenshot };
}

type FetchDeps = { fetchImpl: typeof fetch; lookup: Lookup };

/**
 * Every server-side fetch of a URL the submitted page handed us: each URL and each redirect hop is
 * vetted first (no private, loopback, link-local or metadata addresses; DNS failure refuses), and
 * redirects are followed by hand, at most 5. null when refused.
 */
async function vettedFetch(deps: FetchDeps, url: string, init: RequestInit): Promise<Response | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  for (let hop = 0; ; hop++) {
    if (!(await isPublicUrl(u, deps.lookup))) return null;
    const res = await deps.fetchImpl(u.href, { ...init, redirect: "manual", credentials: "omit" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) return null;
    try { u = new URL(location, u); } catch { return null; }
  }
}

// The image types a downloaded file may be rendered as. SVG is allowed only because every image
// goes into <img src> or CSS url() as a data URI (scripts never run there), never inlined.
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|avif|svg\+xml)$/;

/** An image type from the file's leading bytes (JPEG, PNG, GIF, WebP, AVIF), or null. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "image/avif";
  return null;
}

/**
 * The type a downloaded file is kept as: the server's Content-Type only when it is exactly an
 * allowed image type, else whatever its bytes say, else null (drop it). The result only ever
 * holds [a-z0-9.+/-], so it is safe inside a data: URI in an attribute.
 */
export function imageMime(contentType: string, data: Buffer): string | null {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return IMAGE_MIME_RE.test(t) ? t : sniffImageMime(data);
}

async function download(deps: FetchDeps, url: string, timeoutMs: number): Promise<Asset | null> {
  try {
    const res = await vettedFetch(deps, url, {
      headers: { "user-agent": BROWSER_UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res?.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) return null;
    const mime = imageMime(res.headers.get("content-type") ?? "", data);
    return mime ? { data, mime } : null;
  } catch {
    return null;
  }
}

/** Pixel width from an image file's header (JPEG, PNG, WebP, GIF, AVIF/HEIF), or null. */
export function imageWidth(b: Buffer): number | null {
  const n = b.length;
  // PNG: IHDR width
  if (n >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") return b.readUInt32BE(16);
  // GIF: logical screen width
  if (n >= 10 && b.toString("ascii", 0, 3) === "GIF") return b.readUInt16LE(6);
  // WebP: VP8 (lossy), VP8L (lossless), VP8X (extended)
  if (n >= 16 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 " && n >= 28) return b.readUInt16LE(26) & 0x3fff;
    if (chunk === "VP8L" && n >= 23) return 1 + (b[21] | ((b[22] & 0x3f) << 8));
    if (chunk === "VP8X" && n >= 27) return 1 + b.readUIntLE(24, 3);
    return null;
  }
  // JPEG: walk the segments to the first SOF marker
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < n) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 8 < n ? b.readUInt16BE(i + 7) : null;
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  // AVIF/HEIF: the widest "ispe" (image spatial extents) box
  if (n >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
    let best: number | null = null;
    for (let i = b.indexOf("ispe"); i >= 0 && i + 12 <= n; i = b.indexOf("ispe", i + 4)) best = Math.max(best ?? 0, b.readUInt32BE(i + 8));
    return best;
  }
  return null;
}

/** Where to download a photo from, best first: Showit images at 2048, then 1200, then 800. */
export function sourceUrls(src: string): string[] {
  let u: URL;
  try { u = new URL(src); } catch { return [src]; }
  if (u.hostname !== "static.showit.co" || !/^\/\d+\//.test(u.pathname)) return [src];
  return [...new Set(["2048", "1200", "800"].map((size) => {
    const v = new URL(src);
    v.pathname = v.pathname.replace(/^\/\d+\//, `/${size}/`);
    return v.href;
  }).concat(src))];
}

async function downloadFirst(deps: FetchDeps, urls: string[]): Promise<Asset | null> {
  for (const url of urls) {
    const asset = await download(deps, url, DOWNLOAD_TIMEOUT_MS);
    if (asset) return asset;
  }
  return null;
}

/** Hero first, then other first-screen images by displayed area, then the rest by area. */
function photoOrder(imgs: ImageCandidate[], screenH: number): ImageCandidate[] {
  const seen = new Set<string>();
  const rank = (i: ImageCandidate) => (i.hero ? 0 : i.y < screenH ? 1 : 2);
  return imgs
    .filter((i) => !/\.svg(\?|$)/i.test(i.src)
      && (i.hero || (i.w >= MIN_SHOWN_W && i.h >= MIN_SHOWN_H && i.y + i.h > 0))
      && !seen.has(i.src) && !!seen.add(i.src))
    .sort((a, b) => rank(a) - rank(b) || b.w * b.h - a.w * a.h);
}

/** A downloaded photo qualifies by its file's own width: 1000 px, or 600 px for the hero. */
function qualifies(asset: Asset, candidate: ImageCandidate): boolean {
  if (asset.mime.includes("svg")) return false;
  const w = imageWidth(asset.data);
  return w !== null && w >= (candidate.hero ? MIN_HERO_FILE_W : MIN_FILE_W);
}

const bareHost = (u: URL) => u.hostname.replace(/^www\./, "");

async function checkLinks(
  deps: FetchDeps,
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
    // Relative to the page; a refused URL or redirect hop counts as no response.
    const target = new URL(href, base).href;
    const req = (method: string) => vettedFetch(deps, target, {
      method, headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    try {
      let res = await req("HEAD");
      // Some servers (and bot shields) refuse HEAD; ask once more with GET and use that status.
      if (res && (res.status === 403 || res.status === 405 || res.status === 501)) {
        res = await req("GET");
        await res?.body?.cancel().catch(() => {}); // headers are enough
      }
      status[href] = res ? res.status : "no response";
    } catch {
      status[href] = "no response";
    }
  }));
  return status;
}

type CaptureOpts = { fetchImpl?: typeof fetch; lookup?: Lookup };

// Firecrawl's own words for "the target site is the problem" (its SCRAPE_* error codes carry these
// too), as opposed to a problem with our account or Firecrawl's service.
const TARGET_FAILED_RE =
  /dns resolution|failing to load|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ADDRESS_UNREACHABLE|ERR_SSL|ERR_CERT|ERR_TIMED_OUT|no longer supported/i;
const CLIENT_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

/**
 * True when a scrape error means the target site couldn't be seen (unreachable, DNS failure,
 * blocked by Firecrawl, or the 45 s scrape timeout): those become can't-see. Our key, credits, rate
 * limit and Firecrawl's own outages (401, 402, 429, 5xx, network errors to its API) are not, so
 * they throw plainly and the lead goes retrying, then failed with an alert.
 */
export function isTargetFailure(e: unknown): boolean {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof err.status === "number" ? err.status : undefined;
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (status === 401 || status === 402 || status === 429) return false;
  if (code.startsWith("SCRAPE_") || status === 408) return true;
  if (status === undefined && (CLIENT_TIMEOUT_CODES.has(code) || /\btimeout of \d+ms exceeded\b/i.test(message))) return true;
  return (status === undefined || status === 403 || status >= 500) && TARGET_FAILED_RE.test(message);
}

export async function captureSite(url: string, opts: CaptureOpts = {}): Promise<Capture> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const apiKey = process.env.FIRECRAWL_API_KEY;
  // Our setup, not the site: a plain error (retried, then failed with an alert).
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set, so the site could not be captured");
  const firecrawl = new Firecrawl({ apiKey });

  let doc: ScrapeDoc;
  try {
    doc = (await firecrawl.scrape(target, SCRAPE_OPTIONS)) as ScrapeDoc;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (isTargetFailure(e)) throw new CaptureError("unreachable", `Firecrawl could not load ${target}: ${why}`);
    const status = (e as { status?: unknown })?.status;
    throw new Error(`Firecrawl scrape failed${typeof status === "number" ? ` (HTTP ${status})` : ""}: ${why}`);
  }
  return captureFromDoc(target, doc, opts);
}

// Everything after the scrape: screenshot, photos, logo and link checks.
export async function captureFromDoc(url: string, doc: ScrapeDoc, opts: CaptureOpts = {}): Promise<Capture> {
  const deps: FetchDeps = { fetchImpl: opts.fetchImpl ?? fetch, lookup: opts.lookup ?? defaultLookup };
  const { page, screenshotUrl } = parseScrape(doc);
  const screenH = page.screenH > 0 ? page.screenH : SCREEN_H;

  const before = await download(deps, screenshotUrl, DOWNLOAD_TIMEOUT_MS);
  if (!before) throw new CaptureError("empty", "Could not download the Firecrawl screenshot");

  const photosP = (async () => {
    const candidates = photoOrder(page.imgs, screenH).slice(0, MAX_PHOTO_TRIES);
    const assets = await Promise.all(candidates.map((c) => downloadFirst(deps, sourceUrls(c.src))));
    const photos: Capture["photos"] = [];
    candidates.forEach((candidate, i) => {
      const asset = assets[i];
      if (photos.length < MAX_PHOTOS && asset && qualifies(asset, candidate)) {
        photos.push({ ...asset, candidate, firstScreen: !!candidate.hero || candidate.y < screenH });
      }
    });
    return photos;
  })();
  const logoP = page.logo ? download(deps, page.logo.src, DOWNLOAD_TIMEOUT_MS) : Promise.resolve(null);
  const [photos, logo, linkStatus] = await Promise.all([photosP, logoP, checkLinks(deps, page)]);

  return { url, page, before, photos, logo, linkStatus, capturedAt: new Date().toISOString() };
}
