import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { unsafeUrlReason } from "@/lib/abuse";
import { DISPOSABLE_DOMAINS } from "./disposable-domains";

// On-page checks for the homepage-fixes form (spec section 1). Every check is
// scripted, never throws, and leans toward passing when it can't tell: the
// anti-goal is blocking a real person because of our own slowness or a flaky
// DNS server.

export type FieldCheck = { ok: boolean; code: string; message?: string; suggestion?: string };

export const EMAIL_MESSAGES = {
  bad_syntax: "That email doesn't look quite right. Mind checking it?",
  no_mail: "That email address can't receive mail. Mind checking it?",
  disposable: "Please use an email you check, so your fixes reach you.",
} as const;

export const SITE_MESSAGES = {
  unreachable: "We couldn't open that website. Mind checking the address?",
  placeholder:
    "Your site looks like it's still a coming soon page. Come back once your homepage is live and I'll make your fixes.",
} as const;

export const TIMEOUT_PASS: FieldCheck = { ok: true, code: "timeout" };

// Resolves to onTimeout if p hasn't settled within ms. A rejection of p is
// passed through unchanged.
export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

// --- email -----------------------------------------------------------------

const emailSchema = z.email();

// Misspelled provider name -> the provider's domain.
const PROVIDER_TYPOS: Record<string, string> = {
  gmial: "gmail.com",
  gmal: "gmail.com",
  gmai: "gmail.com",
  gnail: "gmail.com",
  hotmial: "hotmail.com",
  hotmal: "hotmail.com",
  yaho: "yahoo.com",
  yahooo: "yahoo.com",
  iclod: "icloud.com",
  icoud: "icloud.com",
  outlok: "outlook.com",
};
const TLD_TYPOS = new Set(["con", "cmo", "comm"]);

function suggestDomain(domain: string): string | null {
  const labels = domain.split(".");
  if (labels.length === 2 && PROVIDER_TYPOS[labels[0]]) return PROVIDER_TYPOS[labels[0]];
  const tld = labels[labels.length - 1];
  if (TLD_TYPOS.has(tld)) return [...labels.slice(0, -1), "com"].join(".");
  return null;
}

// DNS answers that mean "this name definitely has no such record".
const DNS_MISSING = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);
const isMissing = (e: unknown) => DNS_MISSING.has((e as { code?: string })?.code ?? "");

type EmailDeps = {
  resolveMx?: (d: string) => Promise<unknown[]>;
  resolve4?: (d: string) => Promise<string[]>;
};

export async function checkEmail(email: string, deps: EmailDeps = {}): Promise<FieldCheck> {
  const resolveMx = deps.resolveMx ?? ((d: string) => dns.resolveMx(d));
  const resolve4 = deps.resolve4 ?? ((d: string) => dns.resolve4(d));

  const value = email.trim();
  if (value.length > 254 || !emailSchema.safeParse(value).success) {
    return { ok: false, code: "bad_syntax", message: EMAIL_MESSAGES.bad_syntax };
  }
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();

  const fixed = suggestDomain(domain);
  if (fixed) {
    const suggestion = `${local}@${fixed}`;
    return { ok: true, code: "typo", suggestion, message: `Did you mean ${suggestion}?` };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, code: "disposable", message: EMAIL_MESSAGES.disposable };
  }

  const noMail: FieldCheck = { ok: false, code: "no_mail", message: EMAIL_MESSAGES.no_mail };
  let mxMissing = false;
  try {
    const mx = (await resolveMx(domain)) as { exchange?: string }[];
    if (mx.length > 0) {
      // A lone null MX ("." / "") means the domain explicitly accepts no mail (RFC 7505).
      const real = mx.some((r) => r.exchange && r.exchange !== ".");
      return real ? { ok: true, code: "ok" } : noMail;
    }
    mxMissing = true;
  } catch (e) {
    mxMissing = isMissing(e);
  }
  try {
    const a = await resolve4(domain);
    if (a.length > 0) return { ok: true, code: "ok" };
    return mxMissing ? noMail : { ok: true, code: "ok" };
  } catch (e) {
    // Only block when both lookups say the name has no records; a DNS outage passes.
    return mxMissing && isMissing(e) ? noMail : { ok: true, code: "ok" };
  }
}

// --- website ---------------------------------------------------------------

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 512 * 1024;
const FETCH_BUDGET_MS = 2400;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Parked or for-sale wording blocks wherever it appears. "Coming soon" style
// wording blocks only in the title or on a thin page: a full homepage can
// easily say "Fall minis coming soon".
const PARKED_RE = /domain (is )?for sale|buy this domain|parked free/i;
const SOON_RE = /coming soon|under construction|launching soon|maintenance mode/i;
const THIN_PAGE_WORDS = 150;
// Firewall and bot-check statuses (Cloudflare, Wordfence, Sucuri...): a real
// browser often gets through, so Firecrawl decides after the form is sent.
const FIREWALL_STATUSES = new Set([401, 403, 429, 503]);

// Addresses a public website must never resolve to. Two lists, because a
// BlockList holding ::ffff:0:0/96 also matches every IPv4 address.
const reserved4 = new BlockList();
const reserved6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) reserved4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) reserved6.addSubnet(net, prefix, "ipv6");

export function isReservedIp(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isReservedIp(mapped[1]);
  const family = isIP(address);
  if (family === 4) return reserved4.check(address, "ipv4");
  if (family === 6) return reserved6.check(address, "ipv6");
  return true; // not an IP at all: refuse
}

function addressesOf(result: unknown): string[] {
  const list = Array.isArray(result) ? result : [result];
  return list
    .map((r) => (typeof r === "string" ? r : (r as { address?: string })?.address))
    .filter((a): a is string => typeof a === "string");
}

type SiteDeps = { lookup?: (h: string) => Promise<unknown>; fetchImpl?: typeof fetch };
type SiteCheck = FieldCheck & { url?: string };

const unreachable = (code: "bad_url" | "no_such_site" | "not_loading"): SiteCheck => ({
  ok: false,
  code,
  message: SITE_MESSAGES.unreachable,
});

function parseSite(site: string): URL | null {
  let value = site.trim();
  if (!value || value.length > 2048 || /\s/.test(value)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// Refuses non-web schemes, private names, and hosts that resolve to private or
// reserved addresses. Run on the first URL and on every redirect target.
async function vet(url: URL, lookup: (h: string) => Promise<unknown>): Promise<SiteCheck | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return unreachable("bad_url");
  if (url.username || url.password) return unreachable("bad_url");
  if (unsafeUrlReason(url.href)) return unreachable("bad_url");
  let addresses: string[];
  try {
    addresses = addressesOf(await lookup(url.hostname));
  } catch (e) {
    return isMissing(e) ? unreachable("no_such_site") : { ok: true, code: "ok" };
  }
  if (addresses.length === 0) return unreachable("no_such_site");
  if (addresses.some(isReservedIp)) return unreachable("bad_url");
  return null;
}

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, buf.length - offset);
    buf.set(part, offset);
    offset += part.length;
    if (offset >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

function visibleText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

export function isPlaceholderPage(html: string): boolean {
  const { title, text } = visibleText(html);
  if (PARKED_RE.test(title) || PARKED_RE.test(text)) return true;
  if (SOON_RE.test(title)) return true;
  const words = text ? text.split(" ").length : 0;
  return words < THIN_PAGE_WORDS && SOON_RE.test(text);
}

export async function checkWebsite(site: string, deps: SiteDeps = {}): Promise<SiteCheck> {
  const lookup = deps.lookup ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));
  const fetchImpl = deps.fetchImpl ?? fetch;

  let url = parseSite(site);
  if (!url) return unreachable("bad_url");
  // When we supplied https:// ourselves, a TLS/connect failure gets one retry
  // over http:// (same vetting, same deadline budget).
  let httpFallback = !/^[a-z][a-z0-9+.-]*:\/\//i.test(site.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_BUDGET_MS);
  try {
    for (let hop = 0; ; hop++) {
      const refused = await vet(url, lookup);
      if (refused) return refused;

      let res: Response;
      try {
        res = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual", // followed by hand so each hop is vetted
          credentials: "omit",
          signal: controller.signal,
          headers: {
            "user-agent": BROWSER_UA,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
          },
        });
      } catch {
        if (controller.signal.aborted) return TIMEOUT_PASS;
        if (httpFallback && hop === 0 && url.protocol === "https:") {
          httpFallback = false;
          url = new URL(url.href.replace(/^https:/, "http:"));
          hop = -1; // the retry starts the redirect count afresh
          continue;
        }
        return unreachable("not_loading");
      }

      httpFallback = false;
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return unreachable("not_loading");
        try {
          url = new URL(location, url);
        } catch {
          return unreachable("not_loading");
        }
        continue;
      }

      let html = "";
      try {
        html = await readCapped(res, MAX_BODY_BYTES);
      } catch {
        if (controller.signal.aborted) return TIMEOUT_PASS;
      }

      if (FIREWALL_STATUSES.has(res.status)) return { ok: true, code: "ok", url: url.href };
      if (res.status >= 400) return unreachable("not_loading");

      if (isPlaceholderPage(html)) {
        return { ok: false, code: "placeholder", message: SITE_MESSAGES.placeholder };
      }
      return { ok: true, code: "ok", url: url.href };
    }
  } finally {
    clearTimeout(timer);
  }
}
