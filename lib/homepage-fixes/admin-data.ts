import { NextResponse, type NextRequest } from "next/server";
import { secretMatches } from "@/lib/abuse";
import { sql } from "@/lib/db";
import { reportEmail } from "./emails";
import { pdfFileName } from "./render-html";
import { REPORT_TYPE, type HfOutcome } from "./store";

// Data for the Beacon Frontier admin (beaconfrontier.com/admin/site/capturedsites), served by
// /api/metrics/v1 (aggregates only, the product-metrics contract v1) and /api/admin/* (lead-level
// data for the admin's own pages). Both are bearer-token, server to server, and never cached.
// Queries live here; the shaping functions are pure so they can be tested without a database.

export const APP_ID = "capturedsites";
export const PAGE_SIZE = 50;
const CSV_MAX_ROWS = 10_000;
const MAX_RANGE_DAYS = 400;

export const HF_OUTCOMES: HfOutcome[] = [
  "sent", "hobby", "cant_see", "held", "failed", "limited", "queued", "invalid", "processing", "retrying",
];
/** What the list's `outcome` filter accepts: every homepage-fixes outcome, or the old roadmap rows. */
export const OUTCOME_FILTERS: readonly string[] = [...HF_OUTCOMES, "roadmap"];
/** A row whose report run is over (refusals and rows still on their way don't count). */
const FINISHED = ["sent", "hobby", "cant_see", "held", "failed"];

// ---------- responses and auth ----------

const NO_STORE = { "Cache-Control": "no-store" };
/** The metrics contract's headers: never cached anywhere, never indexed. */
export const METRICS_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export function json(body: unknown, status = 200, headers: Record<string, string> = NO_STORE): NextResponse {
  return NextResponse.json(body, { status, headers });
}

/** The same empty 404 for a missing token, a wrong one, and no token configured (fail closed). */
export function notFound(headers: Record<string, string> = NO_STORE): NextResponse {
  return new NextResponse(null, { status: 404, headers });
}

type TokenEnv = "PRODUCT_TOKEN_CAPTUREDSITES" | "LEADS_API_TOKEN";

/** True only when `envName` is set and the request carries exactly `Bearer <that value>`. */
export function bearerAllowed(req: Request, envName: TokenEnv): boolean {
  const token = process.env[envName]?.trim();
  if (!token) return false;
  return secretMatches(req.headers.get("authorization"), `Bearer ${token}`);
}

/**
 * Wraps a route handler so it runs only with the right bearer token; anything else is the empty
 * 404. proxy.ts lets every /api/admin/* request through, so every handler there must use this.
 */
export function withToken<A extends unknown[]>(
  envName: TokenEnv, handler: (req: NextRequest, ...args: A) => Promise<Response>, headers: Record<string, string> = NO_STORE,
): (req: NextRequest, ...args: A) => Promise<Response> {
  return async (req, ...args) => (bearerAllowed(req, envName) ? handler(req, ...args) : notFound(headers));
}

export const withLeadsToken = <A extends unknown[]>(handler: (req: NextRequest, ...args: A) => Promise<Response>) =>
  withToken("LEADS_API_TOKEN", handler);

// ---------- dates ----------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function validDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Every UTC day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const startOf = (day: string) => `${day}T00:00:00.000Z`;
const startOfNext = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

export type Range = { from: string; to: string };

/**
 * `from`/`to` as UTC days, inclusive, at most 400 days. With `required: false` both may be left
 * out (no bound) and either one alone bounds one side.
 */
export function parseRange(
  from: string | null, to: string | null, opts: { required: boolean },
): Range | { from: string | null; to: string | null } | { error: string } {
  const f = from || null;
  const t = to || null;
  if (opts.required && (!f || !t)) return { error: "from and to are required" };
  if ((f && !validDay(f)) || (t && !validDay(t))) return { error: "from and to must be YYYY-MM-DD" };
  if (f && t) {
    if (t < f) return { error: "to is before from" };
    // Counted arithmetically: the list of days is only built once the range is known to be small.
    const days = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / DAY_MS + 1;
    if (days > MAX_RANGE_DAYS) return { error: `at most ${MAX_RANGE_DAYS} days` };
  }
  return { from: f, to: t };
}

// ---------- per-lead numbers (no names, emails or URLs) ----------

/** One homepage-fixes row reduced to what the counts need. */
export type HfDayRow = {
  day: string; outcome: string | null; cost_usd: string | number | null; opens: number | string; clicks: number | string;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : num(v));

async function select<T>(text: string, params: unknown[]): Promise<T[]> {
  return (await sql().query(text, params)) as T[];
}

export async function fetchHfDayRows(from: string, to: string): Promise<HfDayRow[]> {
  return select<HfDayRow>(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, outcome, cost_usd, opens, clicks
     from leads
     where report_type = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz`,
    [REPORT_TYPE, startOf(from), startOfNext(to)],
  );
}

/** Opened / clicked share of sent reports: any open (or click) at all counts the report once. */
function rates(rows: HfDayRow[]): { open_rate: number; click_rate: number } {
  const sent = rows.filter((r) => r.outcome === "sent");
  if (!sent.length) return { open_rate: 0, click_rate: 0 };
  return {
    open_rate: sent.filter((r) => num(r.opens) > 0).length / sent.length,
    click_rate: sent.filter((r) => num(r.clicks) > 0).length / sent.length,
  };
}

// ---------- GET /api/metrics/v1 ----------

const COUNTERS = {
  hf_submissions: { label: "Homepage Fixes requests", test: () => true },
  hf_sent: { label: "Reports sent", test: (r: HfDayRow) => r.outcome === "sent" },
  hf_hobby: { label: "Hobby replies", test: (r: HfDayRow) => r.outcome === "hobby" },
  hf_cant_see: { label: "Couldn't see the site", test: (r: HfDayRow) => r.outcome === "cant_see" },
  hf_held_failed: { label: "Held or failed", test: (r: HfDayRow) => r.outcome === "held" || r.outcome === "failed" },
  hf_invalid_limited: { label: "Refused or over the limit", test: (r: HfDayRow) => r.outcome === "invalid" || r.outcome === "limited" },
  hf_opened: { label: "Reports opened", test: (r: HfDayRow) => r.outcome === "sent" && num(r.opens) > 0 },
  hf_clicked: { label: "Reports clicked", test: (r: HfDayRow) => r.outcome === "sent" && num(r.clicks) > 0 },
} as const;
type CounterId = keyof typeof COUNTERS | "hf_gemini_microusd";

export type MetricsBody = {
  version: 1;
  app: string;
  generatedAt: string;
  range: { from: string; to: string; granularity: "day" };
  metrics: Record<string, { label: string; kind: "gauge" | "counter"; unit: "count" }>;
  totals: Record<string, number>;
  series: { date: string; values: Record<CounterId, number> }[];
  health: { id: string; status: "ok" | "warn" | "fail"; checkedAt: string; detail: Record<string, number> }[];
};

/** `fail` when over 20% of the last 24 hours' finished leads were held or failed, `warn` on any. */
export function pipelineHealth(finished: number, heldFailed: number): "ok" | "warn" | "fail" {
  if (heldFailed <= 0) return "ok";
  return finished > 0 && heldFailed / finished <= 0.2 ? "warn" : "fail";
}

export function metricsBody(
  rows: HfDayRow[], from: string, to: string,
  extra: { reportsTotal: number; finished24h: number; heldFailed24h: number; now?: Date },
): MetricsBody {
  const now = (extra.now ?? new Date()).toISOString();
  const byDay = new Map<string, HfDayRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const ids = Object.keys(COUNTERS) as (keyof typeof COUNTERS)[];
  const metrics: MetricsBody["metrics"] = {};
  for (const id of ids) metrics[id] = { label: COUNTERS[id].label, kind: "counter", unit: "count" };
  metrics.hf_gemini_microusd = { label: "Gemini cost (millionths of a dollar)", kind: "counter", unit: "count" };
  metrics.hf_reports_total = { label: "Reports sent, all time", kind: "gauge", unit: "count" };
  const count = (n: number) => Math.max(0, Math.round(n));
  return {
    version: 1,
    app: APP_ID,
    generatedAt: now,
    range: { from, to, granularity: "day" },
    metrics,
    totals: { hf_reports_total: count(extra.reportsTotal) },
    series: daysBetween(from, to).map((date) => {
      const day = byDay.get(date) ?? [];
      const values = Object.fromEntries(ids.map((id) => [id, day.filter(COUNTERS[id].test).length])) as Record<CounterId, number>;
      values.hf_gemini_microusd = count(day.reduce((s, r) => s + num(r.cost_usd), 0) * 1_000_000);
      return { date, values };
    }),
    health: [{
      id: "pipeline",
      status: pipelineHealth(extra.finished24h, extra.heldFailed24h),
      checkedAt: now,
      detail: { finished_24h: count(extra.finished24h), held_failed_24h: count(extra.heldFailed24h) },
    }],
  };
}

export async function fetchMetrics(from: string, to: string): Promise<MetricsBody> {
  const [rows, total, recent] = await Promise.all([
    fetchHfDayRows(from, to),
    select<{ n: string | number }>(`select count(*) as n from leads where report_type = $1 and outcome = 'sent'`, [REPORT_TYPE]),
    select<{ finished: string | number; held_failed: string | number }>(
      `select count(*) as finished, count(*) filter (where outcome in ('held', 'failed')) as held_failed
       from leads
       where report_type = $1 and outcome = any($2::text[]) and created_at > now() - interval '24 hours'`,
      [REPORT_TYPE, FINISHED],
    ),
  ]);
  return metricsBody(rows, from, to, {
    reportsTotal: num(total[0]?.n),
    finished24h: num(recent[0]?.finished),
    heldFailed24h: num(recent[0]?.held_failed),
  });
}

// ---------- GET /api/admin/leads?summary=1 ----------

export type LeadsSummary = {
  submissions: number; sent: number; cant_see: number; hobby: number; held_failed: number;
  /** Average Gemini cost of the rows that ran Gemini (cost above 0). */
  avg_cost_usd: number;
  /** 0 to 1, of sent reports */
  open_rate: number;
  /** 0 to 1, of sent reports */
  click_rate: number;
  perDay: { date: string; submissions: number; sent: number }[];
};

export function summaryBody(rows: HfDayRow[], from: string, to: string): LeadsSummary {
  const is = (...o: string[]) => rows.filter((r) => o.includes(r.outcome ?? "")).length;
  const costs = rows.map((r) => num(r.cost_usd)).filter((c) => c > 0);
  return {
    submissions: rows.length,
    sent: is("sent"),
    cant_see: is("cant_see"),
    hobby: is("hobby"),
    held_failed: is("held", "failed"),
    avg_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
    ...rates(rows),
    perDay: daysBetween(from, to).map((date) => {
      const day = rows.filter((r) => r.day === date);
      return { date, submissions: day.length, sent: day.filter((r) => r.outcome === "sent").length };
    }),
  };
}

export async function fetchSummary(from: string, to: string): Promise<LeadsSummary> {
  return summaryBody(await fetchHfDayRows(from, to), from, to);
}

// ---------- GET /api/admin/leads (list and CSV) ----------

export type LeadFilters = { from?: string | null; to?: string | null; outcome?: string | null; q?: string | null };

/** The WHERE clause and its parameters for the list, its count and the CSV. */
export function leadsWhere(f: LeadFilters): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.outcome === "roadmap") parts.push(`report_type = ${p("roadmap")}`);
  else {
    parts.push(`report_type = ${p(REPORT_TYPE)}`);
    if (f.outcome) parts.push(`outcome = ${p(f.outcome)}`);
  }
  if (f.from) parts.push(`created_at >= ${p(startOf(f.from))}::timestamptz`);
  if (f.to) parts.push(`created_at < ${p(startOfNext(f.to))}::timestamptz`);
  const q = (f.q ?? "").trim();
  if (q) {
    const like = p(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    parts.push(`(name ilike ${like} or email ilike ${like} or site_url ilike ${like})`);
  }
  return { clause: parts.join(" and "), params };
}

export type LeadRow = {
  id: string; created_at: string; name: string; email: string; site_url: string; goal: string; outcome: string;
  pdf_url: string | null; before_url: string | null; after_url: string | null; cost_usd: number | null;
  opens: number; clicks: number;
};
export type LeadDetail = LeadRow & {
  content: unknown; facts_sheet: unknown; notes_for_maggie: string | null; error: string | null; issues: unknown;
  model: string | null; input_tokens: number | null; output_tokens: number | null; retry_count: number;
  report_type: string | null;
};

type DbRow = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const text = (v: unknown): string => (v == null ? "" : String(v));
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// Roadmap rows have no homepage-fixes outcome; they show as "roadmap" (only ever on their own).
const OUTCOME_SQL = `case when report_type = 'roadmap' then 'roadmap' else coalesce(outcome, '') end as outcome`;
const ROW_COLUMNS = `id, created_at, name, email, site_url, goal, ${OUTCOME_SQL}, pdf_url, before_url, after_url, cost_usd, opens, clicks`;

export function toLeadRow(r: DbRow): LeadRow {
  return {
    id: String(r.id),
    created_at: iso(r.created_at),
    name: text(r.name),
    email: text(r.email),
    site_url: text(r.site_url),
    goal: text(r.goal),
    outcome: text(r.outcome),
    pdf_url: strOrNull(r.pdf_url),
    before_url: strOrNull(r.before_url),
    after_url: strOrNull(r.after_url),
    cost_usd: numOrNull(r.cost_usd),
    opens: num(r.opens),
    clicks: num(r.clicks),
  };
}

export function toLeadDetail(r: DbRow): LeadDetail {
  const stored = obj(r.content);
  let content: unknown = r.content ?? null;
  if (stored) {
    const { fact_sheet: _f, issues: _i, ...rest } = stored;
    void _f;
    void _i;
    content = rest;
  }
  return {
    ...toLeadRow(r),
    content,
    facts_sheet: stored?.fact_sheet ?? null,
    notes_for_maggie: strOrNull(stored?.notes_for_maggie),
    error: strOrNull(r.error),
    issues: stored?.issues ?? null,
    model: strOrNull(r.model),
    input_tokens: numOrNull(r.input_tokens),
    output_tokens: numOrNull(r.output_tokens),
    retry_count: num(r.retry_count),
    report_type: strOrNull(r.report_type),
  };
}

export async function fetchLeadsPage(f: LeadFilters, page: number): Promise<{ total: number; page: number; pageSize: number; rows: LeadRow[] }> {
  const { clause, params } = leadsWhere(f);
  const offset = (page - 1) * PAGE_SIZE;
  const [count, rows] = await Promise.all([
    select<{ total: string | number }>(`select count(*) as total from leads where ${clause}`, params),
    select<DbRow>(`select ${ROW_COLUMNS} from leads where ${clause} order by created_at desc, id desc limit ${PAGE_SIZE} offset ${offset}`, params),
  ]);
  return { total: num(count[0]?.total), page, pageSize: PAGE_SIZE, rows: rows.map(toLeadRow) };
}

export async function fetchLeadDetail(id: string): Promise<LeadDetail | null> {
  const rows = await select<DbRow>(
    `select ${ROW_COLUMNS}, content, error, model, input_tokens, output_tokens, retry_count, report_type
     from leads where id = $1`,
    [id],
  );
  return rows[0] ? toLeadDetail(rows[0]) : null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- CSV ----------

const CSV_COLUMNS = [
  "created_at", "name", "email", "site_url", "goal", "outcome", "pdf_url", "cost_usd", "opens", "clicks",
  "headline", "fix1_title", "fix2_title", "report_type",
] as const;

/** One RFC 4180 cell. Text starting with = + - @ (or a tab or CR) gets a leading ' so a spreadsheet never runs it. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsCsv(rows: DbRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    const c = obj(r.content);
    const fixes = Array.isArray(c?.fixes) ? (c.fixes as unknown[]) : [];
    const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      created_at: iso(r.created_at),
      name: text(r.name),
      email: text(r.email),
      site_url: text(r.site_url),
      goal: text(r.goal),
      outcome: text(r.outcome),
      pdf_url: text(r.pdf_url),
      cost_usd: numOrNull(r.cost_usd),
      opens: num(r.opens),
      clicks: num(r.clicks),
      headline: text(obj(c?.first_section)?.headline),
      fix1_title: text(obj(fixes[0])?.title),
      fix2_title: text(obj(fixes[1])?.title),
      report_type: text(r.report_type),
    };
    lines.push(CSV_COLUMNS.map((k) => csvCell(cells[k])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export async function fetchLeadsCsv(f: LeadFilters): Promise<string> {
  const { clause, params } = leadsWhere(f);
  const rows = await select<DbRow>(
    `select created_at, name, email, site_url, goal, ${OUTCOME_SQL}, pdf_url, cost_usd, opens, clicks, content, report_type
     from leads where ${clause} order by created_at desc, id desc limit ${CSV_MAX_ROWS}`,
    params,
  );
  return leadsCsv(rows);
}

// ---------- GET /api/admin/email-setup ----------

export type ExampleLead = {
  name: string; site_url: string; goal: string; pdf_url: string; headline: string; fix1: string; fix2: string; sent_date: string;
};

const FALLBACK_EXAMPLE: ExampleLead = {
  name: "Jane Doe",
  site_url: "https://janedoephotography.com",
  goal: "More wedding inquiries from the right couples",
  pdf_url: `https://example.public.blob.vercel-storage.com/homepage-fixes/example/${pdfFileName("Jane")}`,
  headline: "Wedding photos that feel like you",
  fix1: "Show who you photograph",
  fix2: "Make the next step easy",
  sent_date: "2026-11-03",
};

/**
 * The MailerLite subscriber fields the app writes (spec section 8), as merge tags for Maggie's
 * "Lead Generator Follow-ups" emails, with examples from the newest sent report when there is one.
 */
export function emailFields(live: ExampleLead | null): { tag: string; holds: string; example: string }[] {
  const e = live ?? FALLBACK_EXAMPLE;
  return [
    { tag: "{$name}", holds: "Their name, as they typed it on the form", example: e.name },
    { tag: "{$site_url}", holds: "The website they asked about", example: e.site_url },
    { tag: "{$pdf_url}", holds: "The link to their Top Homepage Fixes PDF. Empty unless a PDF was sent", example: e.pdf_url },
    { tag: "{$goal}", holds: "What they want their homepage to do, in their own words", example: e.goal },
    { tag: "{$hf_outcome}", holds: "What they got: sent, hobby, cant_see or failed. Branch the automation on this", example: "sent" },
    { tag: "{$hf_headline}", holds: "The new headline in their report", example: e.headline },
    { tag: "{$hf_fix1_title}", holds: "The title of their first fix", example: e.fix1 },
    { tag: "{$hf_fix2_title}", holds: "The title of their second fix", example: e.fix2 },
    { tag: "{$hf_sent_date}", holds: "The day the report went out (YYYY-MM-DD). Empty unless a PDF was sent", example: e.sent_date },
  ];
}

export type EmailSetup = {
  reportEmail: { subject: string; html: string };
  group: string;
  automation: string;
  fields: { tag: string; holds: string; example: string }[];
  outcomes30d: Record<HfOutcome, number>;
  open_rate30d: number;
  click_rate30d: number;
};

export function emailSetupBody(live: ExampleLead | null, rows30d: HfDayRow[]): EmailSetup {
  const email = reportEmail("Jane", FALLBACK_EXAMPLE.pdf_url, true);
  const outcomes30d = Object.fromEntries(HF_OUTCOMES.map((o) => [o, rows30d.filter((r) => r.outcome === o).length])) as Record<HfOutcome, number>;
  const r = rates(rows30d);
  return {
    reportEmail: { subject: email.subject, html: email.html },
    group: "Website Lead Generator",
    automation: "Lead Generator Follow-ups",
    fields: emailFields(live),
    outcomes30d,
    open_rate30d: r.open_rate,
    click_rate30d: r.click_rate,
  };
}

export async function fetchEmailSetup(): Promise<EmailSetup> {
  const [rows30d, newest] = await Promise.all([
    fetchHfDayRows(daysAgo(29), today()),
    select<DbRow>(
      `select name, site_url, goal, pdf_url, content, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as sent_date
       from leads where report_type = $1 and outcome = 'sent' and pdf_url is not null
       order by created_at desc limit 1`,
      [REPORT_TYPE],
    ),
  ]);
  const n = newest[0];
  const c = obj(n?.content);
  const fixes = Array.isArray(c?.fixes) ? (c.fixes as unknown[]) : [];
  const live: ExampleLead | null = n
    ? {
      name: text(n.name), site_url: text(n.site_url), goal: text(n.goal), pdf_url: text(n.pdf_url),
      headline: text(obj(c?.first_section)?.headline), fix1: text(obj(fixes[0])?.title), fix2: text(obj(fixes[1])?.title),
      sent_date: text(n.sent_date),
    }
    : null;
  return emailSetupBody(live, rows30d);
}
