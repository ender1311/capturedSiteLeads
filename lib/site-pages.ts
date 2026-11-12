import { isIP } from "node:net";
import { unsafeUrlReason } from "@/lib/abuse";
import { defaultLookup, isPublicUrl, readCapped, type Lookup } from "@/lib/homepage-fixes/validate";

// The free "Rebuild Without Losing SEO" tool on capturedsites.com: list every page a
// photographer's current site has (from its sitemap, else its homepage links) with a suggested
// target on the new site. Every fetch goes through safeFetch(), the SSRF boundary.

export const USER_AGENT = "CapturedSitesRedirectPlanner/1.0 (+https://capturedsites.com/rebuild-without-losing-seo/)";
export const MAX_PAGES = 500;
export const MAX_FETCHES = 25;
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type PageType = "Home" | "About" | "Contact" | "Testimonials" | "Legal" | "Blog post" | "Blog archive" | "Portfolio" | "Other";
export type Page = { path: string; type: PageType; target: string; decide: boolean };
export type SitePages = { host: string; source: "sitemap" | "links"; truncated: boolean; pages: Page[] };
export type Deps = { fetchImpl?: typeof fetch; lookup?: Lookup; deadline?: number };

// --- input ------------------------------------------------------------------

/** The site's origin as a URL, or null for anything that isn't a public web domain. */
export function normalizeSiteUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > 2048 || /\s/.test(value)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (isIP(host.replace(/^\[|\]$/g, ""))) return null;
  if (unsafeUrlReason(url.href)) return null; // localhost, single-label, .local/.internal
  return new URL(url.origin);
}

// --- classification ---------------------------------------------------------

const word = (...w: string[]) => new Set(w);
const ABOUT = word("about", "about-me", "about-us", "meet", "meet-me", "bio", "my-story", "story");
const CONTACT = word("contact", "contact-me", "inquire", "inquiry", "inquiries", "book", "booking", "book-now");
const TESTIMONIALS = word("testimonials", "reviews", "kind-words", "love-notes", "client-love");
const LEGAL = word("privacy", "privacy-policy", "terms", "terms-and-conditions", "terms-of-service", "disclaimer", "cookie-policy");
const BLOG_ROOTS = word("blog", "journal", "posts");
const ARCHIVE = word("category", "tag", "author");
const PORTFOLIO = word(
  "portfolio", "gallery", "galleries", "work", "weddings", "wedding", "newborn", "family", "families", "maternity",
  "seniors", "senior", "engagements", "engagement", "elopements", "branding", "headshots", "portraits", "investment",
  "pricing", "services", "experience"
);

/** First match wins (brief order). `fromPostSitemap`: listed in a sitemap file whose name has "post". */
export function classify(path: string, fromPostSitemap = false): Page {
  const raw = path.split("/").filter(Boolean);
  const segs = raw.map((s) => s.toLowerCase().replace(/\.(html?|php|aspx?)$/, ""));
  const any = (set: Set<string>) => segs.some((s) => set.has(s));
  const page = (type: PageType, target: string, decide = false): Page => ({ path, type, target, decide });

  if (segs.length === 0) return page("Home", "/");
  if (any(ABOUT)) return page("About", "/about/");
  if (any(CONTACT)) return page("Contact", "/contact/");
  if (any(TESTIMONIALS)) return page("Testimonials", "/testimonials/");
  if (any(LEGAL)) return page("Legal", path);
  if (any(ARCHIVE) || /\/page\/\d+(\/|$)/i.test(path) || (segs.length === 1 && BLOG_ROOTS.has(segs[0]))) {
    return page("Blog archive", "/blog/");
  }
  if (BLOG_ROOTS.has(segs[0]) || /\/\d{4}\/\d{2}\//.test(path) || fromPostSitemap) return page("Blog post", `/blog/${raw[raw.length - 1]}/`);
  if (any(PORTFOLIO)) return page("Portfolio", path, true);
  return page("Other", path, true);
}

// --- fetching (SSRF boundary) -----------------------------------------------

type Ctx = { fetchImpl: typeof fetch; lookup: Lookup; fetchesLeft: number; deadline: number };

/**
 * GETs url, following at most MAX_REDIRECTS redirects by hand so every hop's host is resolved and
 * refused when it points at a private, loopback, link-local, CGNAT, multicast or metadata address
 * (fails closed on DNS errors). Each request counts against the per-call fetch budget. Returns the
 * body (capped) of a 200 response, else null.
 */
export async function safeFetch(start: URL, ctx: Ctx): Promise<string | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (ctx.fetchesLeft <= 0 || Date.now() > ctx.deadline) return null;
    if (!(await isPublicUrl(url, ctx.lookup))) return null;
    ctx.fetchesLeft--;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await ctx.fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml;q=0.9,*/*;q=0.8" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        res.body?.cancel().catch(() => {});
        url = new URL(location, url);
        continue;
      }
      if (res.status !== 200) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      return await readCapped(res, MAX_BODY_BYTES);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // too many redirects
}

// --- discovery --------------------------------------------------------------

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");
const decodeXml = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const PAGE_EXT = /\.(html?|php|aspx?|pdf)$/i;

export function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
}

/** The URL's path when it's a page on the site (www and apex count as one host), else null. */
function sitePath(href: string, base: URL, site: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || bareHost(u.hostname) !== site) return null;
  const last = u.pathname.split("/").pop() ?? "";
  if (last.includes(".") && !PAGE_EXT.test(last)) return null; // images, feeds, css, zips...
  return u.pathname || "/";
}

async function fromSitemaps(origin: URL, site: string, ctx: Ctx): Promise<Map<string, boolean> | null> {
  const found = new Map<string, boolean>(); // path -> listed in a "post" sitemap
  const seen = new Set<string>();

  async function read(sitemap: URL): Promise<boolean> {
    if (seen.has(sitemap.href)) return false;
    seen.add(sitemap.href);
    const xml = await safeFetch(sitemap, ctx);
    if (!xml || !/<(urlset|sitemapindex)\b/i.test(xml)) return false;
    if (/<sitemapindex\b/i.test(xml)) {
      for (const loc of locs(xml)) {
        let child: URL;
        try {
          child = new URL(loc, sitemap);
        } catch {
          continue;
        }
        if (bareHost(child.hostname) === site) await read(child);
      }
      return true;
    }
    const isPost = /post/i.test(sitemap.pathname.split("/").pop() ?? "");
    for (const loc of locs(xml)) {
      const path = sitePath(loc, sitemap, site);
      if (path !== null) found.set(path, (found.get(path) ?? false) || isPost);
    }
    return true;
  }

  for (const name of ["/sitemap.xml", "/sitemap_index.xml"]) {
    await read(new URL(name, origin));
    if (found.size) return found;
  }
  const robots = await safeFetch(new URL("/robots.txt", origin), ctx);
  for (const m of robots?.matchAll(/^\s*sitemap:\s*(\S+)/gim) ?? []) {
    try {
      await read(new URL(m[1], origin));
    } catch {
      continue;
    }
  }
  return found.size ? found : null;
}

async function fromHomepage(origin: URL, site: string, ctx: Ctx): Promise<Map<string, boolean> | null> {
  const html = await safeFetch(origin, ctx);
  if (html === null) return null;
  const found = new Map<string, boolean>([["/", false]]);
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)/gi)) {
    const path = sitePath(decodeXml(m[1]), origin, site);
    if (path !== null) found.set(path, false);
  }
  return found;
}

export function toPages(found: Map<string, boolean>): { pages: Page[]; truncated: boolean } {
  const paths = [...found.keys()].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return {
    truncated: paths.length > MAX_PAGES,
    pages: paths.slice(0, MAX_PAGES).map((p) => classify(p, found.get(p))),
  };
}

/** null when neither a sitemap nor the homepage gave any pages. */
export async function discoverPages(origin: URL, deps: Deps = {}): Promise<SitePages | null> {
  const ctx: Ctx = {
    fetchImpl: deps.fetchImpl ?? fetch,
    lookup: deps.lookup ?? defaultLookup,
    fetchesLeft: MAX_FETCHES,
    deadline: deps.deadline ?? Date.now() + 45_000,
  };
  const site = bareHost(origin.hostname);
  const host = origin.hostname.toLowerCase();
  const sitemap = await fromSitemaps(origin, site, ctx);
  if (sitemap) return { host, source: "sitemap", ...toPages(sitemap) };
  const links = await fromHomepage(origin, site, ctx);
  if (links) return { host, source: "links", ...toPages(links) };
  return null;
}
