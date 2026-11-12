import { sql } from "./db";

// Small-Town SEO Finder: monthly Google volumes (Keywords Everywhere, 1 paid credit per keyword) for
// the ways people search for a photographer in a town. Every result is cached per (niche, town) for
// 30 days and uncached town lookups are capped per UTC day, so the paid API spend stays bounded.

export const NICHES = new Set([
  "wedding", "family", "newborn", "senior", "maternity", "engagement",
  "elopement", "branding", "headshot", "boudoir", "pet",
]);
export const DAILY_TOWN_CAP = 150; // uncached town lookups (4 credits each) per UTC day
const KE_URL = "https://api.keywordseverywhere.com/v1/get_keyword_data";

export type Term = { term: string; volume: number };
export type TownResult = { town: string; terms: Term[]; best: string };
export type Input = { niche: string; towns: { town: string; key: string }[] };

/** Validated input, or null. Towns are trimmed and single-spaced; `key` is the lowercase cache key. */
export function parseInput(body: unknown): Input | null {
  const b = body as { niche?: unknown; towns?: unknown } | null;
  if (typeof b?.niche !== "string" || !NICHES.has(b.niche)) return null;
  if (!Array.isArray(b.towns) || b.towns.length < 1 || b.towns.length > 4) return null;
  const towns: Input["towns"] = [];
  for (const raw of b.towns) {
    if (typeof raw !== "string") return null;
    const town = raw.trim().replace(/\s+/g, " ");
    if (!/^[\p{L} .'-]{2,40}$/u.test(town) || !/\p{L}/u.test(town)) return null;
    const key = town.toLowerCase();
    if (!towns.some((t) => t.key === key)) towns.push({ town, key });
  }
  return { niche: b.niche, towns };
}

/** The four searches for a town, in tie-break order. */
export function termsFor(niche: string, townKey: string): string[] {
  return [
    `${niche} photographer ${townKey}`,
    `${townKey} ${niche} photographer`,
    `${townKey} ${niche} photos`,
    `${niche} photography ${townKey}`,
  ];
}

/** Highest volume wins; ties go to the earliest term. */
export function pickBest(terms: Term[]): string {
  let best = terms[0];
  for (const t of terms) if (t.volume > best.volume) best = t;
  return best.term;
}

export class UpstreamError extends Error {}

/** One Keywords Everywhere call for all keywords; volume by lowercase keyword. Throws UpstreamError. */
export async function fetchVolumes(keywords: string[]): Promise<Map<string, number>> {
  const key = process.env.KEYWORDS_EVERYWHERE_API_KEY;
  if (!key) throw new UpstreamError("no api key");
  const body = new URLSearchParams([["country", "us"], ["currency", "usd"], ["dataSource", "gkp"]]);
  for (const kw of keywords) body.append("kw[]", kw);
  let data: unknown;
  try {
    const res = await fetch(KE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new UpstreamError(`status ${res.status}`);
    data = ((await res.json()) as { data?: unknown }).data;
  } catch (e) {
    throw e instanceof UpstreamError ? e : new UpstreamError((e as Error).name);
  }
  if (!Array.isArray(data)) throw new UpstreamError("bad response");
  const volumes = new Map<string, number>();
  for (const row of data as { keyword?: unknown; vol?: unknown }[]) {
    if (typeof row?.keyword !== "string") continue;
    const vol = Number(row.vol);
    volumes.set(row.keyword.trim().toLowerCase(), Number.isFinite(vol) && vol > 0 ? vol : 0);
  }
  return volumes;
}

/** Fresh (under 30 days) cached terms by town key. */
export async function readCache(niche: string, keys: string[]): Promise<Map<string, Term[]>> {
  const rows = (await sql()`
    select town, terms from keyword_cache
    where niche = ${niche} and town = any(${keys}) and created_at > now() - interval '30 days'
  `) as { town: string; terms: Term[] }[];
  return new Map(rows.map((r) => [r.town, r.terms]));
}

export async function writeCache(niche: string, key: string, terms: Term[]): Promise<void> {
  await sql()`
    insert into keyword_cache (niche, town, terms, created_at) values (${niche}, ${key}, ${JSON.stringify(terms)}, now())
    on conflict (niche, town) do update set terms = excluded.terms, created_at = excluded.created_at
  `;
}

/** Atomically reserves `n` lookups from today's (UTC) cap; false when they don't fit. */
export async function reserveDaily(n: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await sql()`
    insert into keyword_lookups (day, n) values (${day}, ${n})
    on conflict (day) do update set n = keyword_lookups.n + excluded.n
    where keyword_lookups.n + excluded.n <= ${DAILY_TOWN_CAP}
    returning n
  `;
  return rows.length > 0;
}
