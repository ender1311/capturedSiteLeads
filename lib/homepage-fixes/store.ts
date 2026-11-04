import { put } from "@vercel/blob";
import { sql } from "@/lib/db";
import type { Asset, Capture } from "./types";

// Neon rows for homepage-fixes leads (report_type 'homepage_fixes') and the 7-day scrape cache.

export type HfOutcome =
  | "processing" | "sent" | "hobby" | "cant_see" | "invalid" | "limited"
  | "queued" | "retrying" | "held" | "failed";

export const REPORT_TYPE = "homepage_fixes";

// The older `status` column still drives the roadmap dashboard and the open/click
// webhooks (they credit only 'complete' rows), so every outcome keeps it in step.
const STATUS: Record<HfOutcome, "processing" | "complete" | "failed" | "rejected"> = {
  processing: "processing", queued: "processing", retrying: "processing",
  sent: "complete", hobby: "complete", cant_see: "complete",
  invalid: "rejected", limited: "rejected",
  held: "failed", failed: "failed",
};

/** The host a cache entry or duplicate check goes by: lower case, no www. */
export function domainOf(siteUrl: string): string {
  let host = siteUrl.trim().toLowerCase();
  try {
    host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    // keep the raw value
  }
  return host.replace(/^www\./, "");
}

export async function insertHfLead(i: {
  name: string; email: string; siteUrl: string; goal: string; ip: string | null; outcome: HfOutcome;
}): Promise<string> {
  const rows = (await sql()`
    insert into leads (name, email, site_url, goal, ip, outcome, status, report_type)
    values (${i.name}, ${i.email}, ${i.siteUrl}, ${i.goal}, ${i.ip}, ${i.outcome}, ${STATUS[i.outcome]}, ${REPORT_TYPE})
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

export type HfPatch = Partial<{
  outcome: HfOutcome; error: string; pdf_url: string; before_url: string; after_url: string;
  content: unknown; input_tokens: number; output_tokens: number; cost_usd: number; model: string;
  retry_count: number;
}>;

// Column names can't be parameters, so only these are ever written into the statement.
const COLUMNS = [
  "outcome", "error", "pdf_url", "before_url", "after_url", "content",
  "input_tokens", "output_tokens", "cost_usd", "model", "retry_count",
] as const;

export async function updateHfLead(id: string, patch: HfPatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  for (const col of COLUMNS) {
    if (!(col in patch) || patch[col] === undefined) continue;
    if (col === "content") add(col, JSON.stringify(patch.content), "::jsonb");
    else add(col, patch[col]);
  }
  if (patch.outcome) add("status", STATUS[patch.outcome]);
  if (!sets.length) return;
  params.push(id);
  await sql().query(`update leads set ${sets.join(", ")} where id = $${params.length}`, params);
}

/** The newest sent homepage-fixes report for this email and site in the last `withinDays` days. */
export async function latestSentFor(
  email: string, domain: string, withinDays: number,
): Promise<{ id: string; pdf_url: string } | null> {
  const rows = (await sql()`
    select id, pdf_url from leads
    where report_type = ${REPORT_TYPE}
      and outcome = 'sent'
      and pdf_url is not null
      and lower(email) = ${email.trim().toLowerCase()}
      and regexp_replace(lower(site_url), '^([a-z]+://)?(www\\.)?([^/:?#]+).*$', '\\3') = ${domainOf(domain)}
      and created_at > now() - make_interval(days => ${withinDays})
    order by created_at desc
    limit 1
  `) as { id: string; pdf_url: string }[];
  return rows[0] ?? null;
}

// ---------- scrape cache ----------

type StoredAsset = { url: string; mime: string };
type StoredCapture = Omit<Capture, "before" | "photos" | "logo"> & {
  before: StoredAsset;
  photos: (StoredAsset & { candidate: Capture["photos"][number]["candidate"]; firstScreen: boolean })[];
  logo: StoredAsset | null;
};

const ext = (mime: string) =>
  /png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : /gif/.test(mime) ? "gif" : /avif/.test(mime) ? "avif" : /svg/.test(mime) ? "svg" : "jpg";

async function fetchAsset(a: StoredAsset): Promise<Asset> {
  const res = await fetch(a.url);
  if (!res.ok) throw new Error(`cached image ${a.url} returned ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: a.mime };
}

/**
 * A capture of this domain from the last `maxAgeDays` days, images re-fetched from Blob.
 * Best effort: any miss or failure returns null and the caller scrapes again.
 */
export async function getCachedCapture(domain: string, maxAgeDays = 7): Promise<Capture | null> {
  try {
    const rows = (await sql()`
      select data from scrape_cache
      where domain = ${domainOf(domain)} and created_at > now() - make_interval(days => ${maxAgeDays})
    `) as { data: StoredCapture }[];
    if (!rows.length) return null;
    const d = rows[0].data;
    const [before, logo, ...photos] = await Promise.all([
      fetchAsset(d.before),
      d.logo ? fetchAsset(d.logo) : Promise.resolve(null),
      ...d.photos.map(fetchAsset),
    ]);
    return {
      ...d,
      before: before as Asset,
      logo,
      photos: d.photos.map((p, i) => ({ ...(photos[i] as Asset), candidate: p.candidate, firstScreen: p.firstScreen })),
    };
  } catch (e) {
    console.warn("Scrape cache read failed:", (e as Error).message);
    return null;
  }
}

/** Stores the capture's images in Blob and the rest as jsonb. Best effort: failures only log. */
export async function putCachedCapture(domain: string, c: Capture): Promise<void> {
  try {
    const d = domainOf(domain);
    const folder = `scrape-cache/${d.replace(/[^a-z0-9.-]/g, "-")}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const upload = async (name: string, a: Asset): Promise<StoredAsset> => {
      const { url } = await put(`${folder}/${name}.${ext(a.mime)}`, a.data, { access: "public", contentType: a.mime });
      return { url, mime: a.mime };
    };
    const [before, logo, ...photos] = await Promise.all([
      upload("before", c.before),
      c.logo ? upload("logo", c.logo) : Promise.resolve(null),
      ...c.photos.map((p, i) => upload(`photo-${String(i + 1).padStart(2, "0")}`, p)),
    ]);
    const data: StoredCapture = {
      ...c,
      before: before as StoredAsset,
      logo,
      photos: c.photos.map((p, i) => ({ ...(photos[i] as StoredAsset), candidate: p.candidate, firstScreen: p.firstScreen })),
    };
    await sql()`
      insert into scrape_cache (domain, data, created_at)
      values (${d}, ${JSON.stringify(data)}::jsonb, now())
      on conflict (domain) do update set data = excluded.data, created_at = excluded.created_at
    `;
  } catch (e) {
    console.warn("Scrape cache write failed:", (e as Error).message);
  }
}
