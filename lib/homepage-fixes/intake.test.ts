import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The intake route, limits, dedupe, queue and retries, run through the real route handlers.
// No real Neon, Blob, Firecrawl, Gemini, Resend or MailerLite: the store is an in-memory table,
// the limits query reads the same table through a fake `sql`, the pipeline and `deliver` are
// mocks, and fetch answers for Resend, MailerLite and Blob.

type Row = {
  id: string; seq: number; name: string; email: string; site_url: string; goal: string | null;
  ip: string | null; outcome: string; retry_count: number; pdf_url: string | null; error: string | null;
  started_minutes_ago: number | null; stuck_alerted: boolean;
  report_type: string; content: unknown;
  input_tokens: number | null; output_tokens: number | null; cost_usd: string | null; model: string | null;
};

const h = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    seq: 0,
    capAlertDay: null as string | null,
    liveModel: null as string | null,
    afterQueue: [] as (() => unknown)[],
  };
  const dom = (s: string) =>
    s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/:?#]/)[0];
  const find = (id: string) => state.rows.find((r) => r.id === id) ?? null;
  const h_liveModel = () => (state.liveModel ? [{ value: state.liveModel, updated_at: "2026-11-04" }] : []);

  const store = {
    insertHfLead: vi.fn(async (i: { name: string; email: string; siteUrl: string; goal: string; ip: string | null; outcome: string }) => {
      const id = `lead-${++state.seq}`;
      state.rows.push({
        id, seq: state.seq, name: i.name, email: i.email, site_url: i.siteUrl, goal: i.goal, ip: i.ip,
        outcome: i.outcome, retry_count: 0, pdf_url: null, error: null, report_type: "homepage_fixes", content: null,
        input_tokens: null, output_tokens: null, cost_usd: null, model: null,
        started_minutes_ago: i.outcome === "processing" ? 0 : null, stuck_alerted: false,
      });
      return id;
    }),
    updateHfLead: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const r = find(id);
      if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    }),
    getHfLead: vi.fn(async (id: string) => {
      const r = find(id);
      return r ? { ...r } : null;
    }),
    latestSentFor: vi.fn(async (email: string, domain: string) => {
      const hit = state.rows
        .filter((r) => r.report_type === "homepage_fixes" && r.outcome === "sent" && r.pdf_url && r.email === email && dom(r.site_url) === dom(domain))
        .sort((a, b) => b.seq - a.seq)[0];
      return hit ? { id: hit.id, pdf_url: hit.pdf_url! } : null;
    }),
    recentProcessingFor: vi.fn(async (email: string, domain: string, _mins: number, beforeId: string) => {
      const me = find(beforeId)!;
      const hit = state.rows.find((r) =>
        r.report_type === "homepage_fixes" && ["processing", "queued", "retrying"].includes(r.outcome) && r.seq < me.seq &&
        r.email === email && dom(r.site_url) === dom(domain));
      return hit ? { id: hit.id } : null;
    }),
    claimHfLead: vi.fn(async (id: string, from: string[]) => {
      const r = find(id);
      if (!r || !from.includes(r.outcome)) return false;
      r.outcome = "processing";
      r.started_minutes_ago = 0;
      r.stuck_alerted = false;
      return true;
    }),
    markStuckLeads: vi.fn(async (mins: number) => {
      const stuck = state.rows.filter((r) =>
        r.outcome === "processing" && !r.stuck_alerted && (r.started_minutes_ago ?? 0) > mins);
      for (const r of stuck) r.stuck_alerted = true;
      return stuck.map((r) => ({ id: r.id, name: r.name, email: r.email, site_url: r.site_url, since: "2026-11-04T10:00:00.000Z" }));
    }),
    retryingLeads: vi.fn(async (mins: number) =>
      state.rows.filter((r) => r.outcome === "retrying" && r.retry_count === 1 && (r.started_minutes_ago ?? 99) > mins).sort((a, b) => a.seq - b.seq).map((r) => r.id)),
    queuedLeads: vi.fn(async (limit: number) =>
      state.rows.filter((r) => r.outcome === "queued").sort((a, b) => a.seq - b.seq).slice(0, limit).map((r) => r.id)),
    claimCapAlert: vi.fn(async (day: string) => {
      if (state.capAlertDay === day) return false;
      state.capAlertDay = day;
      return true;
    }),
    getCachedCapture: vi.fn(async () => null as unknown),
    putCachedCapture: vi.fn(async () => {}),
  };

  // checkDailyLimits' query: this report type's rows from the last 24 hours.
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    // getLiveModel: the model picked in the admin.
    if (/from app_config/.test(text)) return h_liveModel();
    if (/from leads/.test(text) && /report_type/.test(text)) {
      return state.rows.filter((r) => r.report_type === values[0]).map((r) => ({ email: r.email, ip: r.ip, outcome: r.outcome }));
    }
    throw new Error(`unexpected sql: ${text}`);
  });

  return {
    state, store, tag,
    runHomepageFixes: vi.fn(),
    deliver: vi.fn(),
    captureSite: vi.fn(),
    checkEmail: vi.fn(),
    checkWebsite: vi.fn(),
    after: vi.fn((fn: () => unknown) => { state.afterQueue.push(fn); }),
  };
});

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: h.after }));
vi.mock("@/lib/db", () => ({ sql: () => h.tag }));
vi.mock("@/lib/homepage-fixes/store", async (orig) => ({ ...(await orig<typeof import("./store")>()), ...h.store }));
vi.mock("@/lib/homepage-fixes/pipeline", async (orig) => ({ ...(await orig<typeof import("./pipeline")>()), runHomepageFixes: h.runHomepageFixes }));
vi.mock("@/lib/homepage-fixes/deliver", async (orig) => ({ ...(await orig<typeof import("./deliver")>()), deliver: h.deliver }));
vi.mock("@/lib/homepage-fixes/capture", async (orig) => ({ ...(await orig<typeof import("./capture")>()), captureSite: h.captureSite }));
vi.mock("@/lib/homepage-fixes/validate", async (orig) => ({
  ...(await orig<typeof import("./validate")>()),
  checkEmail: h.checkEmail,
  checkWebsite: h.checkWebsite,
}));

import { DeliveredNotRecordedError } from "./deliver";
import { cantSeeEmail, reportEmail } from "./emails";
import { processLead, sweep } from "./intake";
import { POST as hfPOST } from "@/app/api/homepage-fixes/route";
import { POST as leadPOST } from "@/app/api/lead/route";
import { GET as cronGET } from "@/app/api/cron/homepage-fixes/route";

type Sent = { url: string; body: Record<string, unknown> | null };
let sent: Sent[] = [];
const PDF_BYTES = Buffer.from("%PDF-1.7 earlier report");

const resendCalls = () => sent.filter((c) => c.url.startsWith("https://api.resend.com"));
const toPhotographer = (email: string) => resendCalls().filter((c) => (c.body!.to as string[]).includes(email));
const alerts = () => resendCalls().filter((c) => (c.body!.to as string[]).includes("dan@test.com"));
const mailerlite = () => sent.filter((c) => c.url.startsWith("https://connect.mailerlite.com"));

// Runs everything after() scheduled, concurrently like separate requests' after() work would.
async function flushAfter() {
  while (h.state.afterQueue.length) {
    const batch = h.state.afterQueue.splice(0);
    await Promise.all(batch.map((fn) => fn()));
  }
}

/** Posts, lets the after-response work finish, and returns the saved row. */
async function postAndSettle(body: Record<string, unknown>, opts: Parameters<typeof jsonPost>[1] = {}) {
  const res = await hfPOST(jsonPost(body, opts));
  expect(res.status).toBe(200);
  const { id } = await res.json();
  await flushAfter();
  return row(id);
}

function jsonPost(body: Record<string, unknown>, opts: { secret?: string; path?: string; ip?: string } = {}) {
  return new NextRequest(`https://captured-site-leads.vercel.app${opts.path ?? "/api/homepage-fixes"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lead-secret": opts.secret ?? "s3cret",
      "x-forwarded-for": opts.ip ?? "9.9.9.9",
    },
    body: JSON.stringify(body),
  });
}

const JANE = { name: "Jane", email: "jane@example.com", site_url: "janedoe.com", website_goal: "More inquiries from couples" };

function seed(r: Partial<Row>) {
  const id = r.id ?? `seed-${++h.state.seq}`;
  h.state.rows.push({
    id, seq: h.state.seq, name: "Jane", email: "jane@example.com", site_url: "https://janedoe.com", goal: "g", ip: null,
    outcome: "sent", retry_count: 0, pdf_url: null, error: null, report_type: "homepage_fixes", content: null,
    input_tokens: null, output_tokens: null, cost_usd: null, model: null,
    started_minutes_ago: null, stuck_alerted: false,
    ...r,
  });
  return id;
}

const row = (id: string) => h.state.rows.find((r) => r.id === id)!;
const SENT_RESULT = { outcome: "sent" } as const;

beforeEach(() => {
  h.state.rows = [];
  h.state.seq = 0;
  h.state.capAlertDay = null;
  h.state.liveModel = null;
  h.state.afterQueue = [];
  sent = [];
  for (const f of Object.values(h.store)) f.mockClear();
  h.after.mockClear();
  h.runHomepageFixes.mockReset().mockResolvedValue(SENT_RESULT);
  h.deliver.mockReset().mockImplementation(async (id: string) => {
    row(id).outcome = "sent";
  });
  h.captureSite.mockReset();
  h.checkEmail.mockReset().mockResolvedValue({ ok: true, code: "ok" });
  h.checkWebsite.mockReset().mockResolvedValue({ ok: true, code: "ok", url: "https://janedoe.com/" });
  vi.stubEnv("LEAD_WEBHOOK_SECRET", "s3cret");
  vi.stubEnv("CRON_SECRET", "cron-s3cret");
  vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "");
  vi.stubEnv("MAILERLITE_API_KEY", "ml_test");
  vi.stubEnv("MAILERLITE_GROUP_ID", "group-123");
  vi.stubEnv("MAILERLITE_HF_NEVER_RECEIVED_GROUP_ID", "group-never");
  vi.stubEnv("ALERT_EMAILS", "dan@test.com");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("https://api.resend.com")) return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    if (url.startsWith("https://connect.mailerlite.com")) return new Response(JSON.stringify({ data: { id: "ml-1" } }), { status: 200 });
    if (url.startsWith("https://blob.test/")) return new Response(new Uint8Array(PDF_BYTES), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/homepage-fixes", () => {
  it("bad secret → 401, nothing saved", async () => {
    const res = await hfPOST(jsonPost(JANE, { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(h.store.insertHfLead).not.toHaveBeenCalled();
  });

  it("valid form post → 200, a processing row, and processLead scheduled", async () => {
    const res = await hfPOST(jsonPost(JANE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "lead-1", status: "processing" });
    expect(row("lead-1")).toMatchObject({
      name: "Jane", email: "jane@example.com", site_url: "https://janedoe.com",
      goal: "More inquiries from couples", outcome: "processing", ip: "9.9.9.9",
    });
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.checkEmail).not.toHaveBeenCalled(); // the response doesn't wait for the re-checks
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    await flushAfter();
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(1);
    expect(h.runHomepageFixes.mock.calls[0][0]).toMatchObject({
      firstName: "Jane", website: "https://janedoe.com", goal: "More inquiries from couples", model: "google/gemini-3.8-flash",
    });
    expect(h.deliver).toHaveBeenCalledWith("lead-1",
      { name: "Jane", email: "jane@example.com", siteUrl: "https://janedoe.com", goal: "More inquiries from couples" },
      SENT_RESULT);
  });

  it("builds with the model picked in the admin; an unknown saved id falls back to the default", async () => {
    h.state.liveModel = "google/gemini-2.5-flash-lite";
    await postAndSettle(JANE);
    expect(h.runHomepageFixes.mock.calls[0][0]).toMatchObject({ model: "google/gemini-2.5-flash-lite" });
    h.state.liveModel = "made-up/model";
    await postAndSettle({ ...JANE, email: "other@example.com" });
    expect(h.runHomepageFixes.mock.calls[1][0]).toMatchObject({ model: "google/gemini-3.8-flash" });
  });

  it("re-checks the email and the website server-side with the visitor's own site text", async () => {
    await postAndSettle(JANE);
    expect(h.checkEmail).toHaveBeenCalledWith("jane@example.com");
    expect(h.checkWebsite).toHaveBeenCalledWith("janedoe.com");
  });

  it("website_goal is read from Elementor advanced-data form", async () => {
    const form = new URLSearchParams({
      "form[name]": "Homepage Fixes",
      "fields[name][value]": "Gabby",
      "fields[email][value]": "gabby@example.com",
      "fields[site_url][value]": "gabbyjphotography.com",
      "fields[website_goal][id]": "website_goal",
      "fields[website_goal][value]": "More inquiries from couples and graduates",
      "meta[remote_ip][value]": "5.6.7.8",
      "meta[page_url][value]": "https://capturedsites.com/homepage-fixes/",
    });
    const req = new NextRequest("https://captured-site-leads.vercel.app/api/homepage-fixes?secret=s3cret", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.0.0.1" },
      body: form.toString(),
    });
    const res = await hfPOST(req);
    expect(res.status).toBe(200);
    expect(row("lead-1")).toMatchObject({
      name: "Gabby", email: "gabby@example.com", site_url: "https://gabbyjphotography.com",
      goal: "More inquiries from couples and graduates", ip: "5.6.7.8", outcome: "processing",
    });
  });

  it("a website_goal field never wins the fuzzy site match", async () => {
    const form = new URLSearchParams({
      "fields[name][value]": "Gabby",
      "fields[email][value]": "gabby@example.com",
      "fields[website_goal][value]": "a better website.com experience",
      "fields[field_abc][value]": "gabbyjphotography.com",
    });
    const req = new NextRequest("https://captured-site-leads.vercel.app/api/homepage-fixes?secret=s3cret", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    await hfPOST(req);
    expect(row("lead-1").site_url).toBe("https://gabbyjphotography.com");
  });

  it("invalid email server-side → outcome invalid, no email, no pipeline", async () => {
    h.checkEmail.mockResolvedValue({ ok: false, code: "no_mail", message: "m" });
    const r = await postAndSettle(JANE);
    expect(r.outcome).toBe("invalid");
    expect(r.error).toMatch(/email: no_mail/);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    expect(resendCalls()).toHaveLength(0);
  });

  it("a placeholder site server-side → outcome invalid", async () => {
    h.checkWebsite.mockResolvedValue({ ok: false, code: "placeholder", message: "m" });
    await postAndSettle(JANE);
    expect(row("lead-1").outcome).toBe("invalid");
    expect(row("lead-1").error).toMatch(/website: placeholder/);
  });

  it("a server-side check that takes over 5 s (or throws) passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.checkEmail.mockReturnValue(new Promise(() => {}));
    h.checkWebsite.mockRejectedValue(new Error("dns down"));
    const res = await hfPOST(jsonPost(JANE));
    expect((await res.json()).status).toBe("processing");
    const settled = flushAfter();
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(1);
    expect(row("lead-1").outcome).toBe("sent");
  });

  it("a malformed payload still gets 200 and an invalid row", async () => {
    const res = await hfPOST(jsonPost({ name: "Jane", email: "not-an-email", site_url: "janedoe.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("invalid");
    expect(row("lead-1").outcome).toBe("invalid");
    expect(h.after).not.toHaveBeenCalled();
  });

  it("a database outage still answers 200 and alerts Dan", async () => {
    h.store.insertHfLead.mockRejectedValueOnce(new Error("neon down"));
    const res = await hfPOST(jsonPost(JANE));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("error");
    expect(alerts()).toHaveLength(1);
  });

  it("second submission same email+domain within 7 days re-sends the existing PDF, no pipeline run", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/homepage-fixes/x/your-top-homepage-fixes-jane.pdf", site_url: "https://www.janedoe.com/" });
    await postAndSettle(JANE);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    // A re-send is not a new report (Minor 6): the row is limited, so metrics never count it as sent.
    expect(row("lead-2")).toMatchObject({ outcome: "limited", pdf_url: "https://blob.test/homepage-fixes/x/your-top-homepage-fixes-jane.pdf" });
    expect(row("lead-2").error).toMatch(/re-sent the report from lead seed-1/);
    const mail = toPhotographer("jane@example.com");
    expect(mail).toHaveLength(1);
    const expected = reportEmail("Jane", "https://blob.test/homepage-fixes/x/your-top-homepage-fixes-jane.pdf", true);
    expect(mail[0].body).toMatchObject({ subject: expected.subject, html: expected.html });
    expect(mail[0].body!.attachments).toEqual([
      { filename: "your-top-homepage-fixes-jane.pdf", content: PDF_BYTES.toString("base64") },
    ]);
  });

  it("two simultaneous posts produce one pipeline run; the second is limited with no email", async () => {
    const [a, b] = await Promise.all([hfPOST(jsonPost(JANE)), hfPOST(jsonPost(JANE))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await flushAfter();
    expect(row("lead-1").outcome).toBe("sent");
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(1);
    expect(row("lead-2")).toMatchObject({ outcome: "limited" });
    expect(row("lead-2").error).toMatch(/lead-1/);
    expect(toPhotographer("jane@example.com")).toHaveLength(0);
  });

  it("4th submission of the day → limited, no email when there's no earlier PDF", async () => {
    for (const site of ["a.com", "b.com", "c.com"]) seed({ outcome: "cant_see", site_url: `https://${site}` });
    const r = await postAndSettle(JANE);
    expect(r.outcome).toBe("limited");
    expect(r.error).toMatch(/email limit/);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    expect(resendCalls()).toHaveLength(0);
  });

  it("over the limit with an earlier PDF for this site → limited, and that PDF is re-sent", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf" });
    seed({ outcome: "cant_see", site_url: "https://b.com" });
    seed({ outcome: "cant_see", site_url: "https://c.com" });
    expect((await postAndSettle(JANE)).outcome).toBe("limited");
    expect(toPhotographer("jane@example.com")).toHaveLength(1);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
  });

  it("per-IP limit applies too", async () => {
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) seed({ email: e, ip: "9.9.9.9", outcome: "sent" });
    const r = await postAndSettle(JANE);
    expect(r.outcome).toBe("limited");
    expect(r.error).toMatch(/IP limit/);
  });

  it("roadmap rows don't count toward the homepage-fixes limits", async () => {
    for (let i = 0; i < 5; i++) seed({ report_type: "roadmap", outcome: "sent" });
    await postAndSettle(JANE);
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(1);
  });

  it("cap reached → queued, one cap alert per day", async () => {
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "2");
    seed({ email: "a@x.com", site_url: "https://a.com", outcome: "sent" });
    seed({ email: "b@x.com", site_url: "https://b.com", outcome: "held" });
    seed({ email: "c@x.com", site_url: "https://c.com", outcome: "invalid" }); // never built: doesn't count
    const first = await postAndSettle(JANE);
    const second = await postAndSettle({ ...JANE, email: "kim@example.com", site_url: "kim.com" }, { ip: "8.8.8.8" });
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("queued");
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0].body!.subject)).toMatch(/cap/i);
    expect(resendCalls()).toHaveLength(1); // nothing to the photographers yet
  });

  it("a double submit on a capped day leaves one queued and one limited", async () => {
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "1");
    seed({ email: "a@x.com", site_url: "https://a.com", outcome: "sent" });
    const first = await postAndSettle(JANE); // queued before the second arrives
    const second = await postAndSettle(JANE);
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("limited");
    expect(second.error).toMatch(new RegExp(`duplicate of lead ${first.id}`));
    expect(toPhotographer("jane@example.com")).toHaveLength(0);
  });

  it("a resubmit while the first waits for its retry is limited", async () => {
    const first = seed({ outcome: "retrying", retry_count: 1 });
    const r = await postAndSettle(JANE);
    expect(r.outcome).toBe("limited");
    expect(r.error).toMatch(new RegExp(first));
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
  });

  it("the build gets the pipeline budget minus the time triage took", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    h.checkEmail.mockImplementation(async () => {
      t += 4_000; // a slow re-check
      return { ok: true, code: "ok" };
    });
    await postAndSettle(JANE);
    expect(h.runHomepageFixes.mock.calls[0][0].deadlineMs).toBe(270_000 - 4_000);
  });
});

describe("POST /api/lead", () => {
  it("/api/lead posts now run the homepage-fixes handler", async () => {
    const res = await leadPOST(jsonPost(JANE, { path: "/api/lead" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "lead-1", status: "processing" });
    expect(row("lead-1").report_type).toBe("homepage_fixes");
    await flushAfter();
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(1);
  });

  it("/api/lead keeps the 401 on a bad secret", async () => {
    const res = await leadPOST(jsonPost(JANE, { path: "/api/lead", secret: "nope" }));
    expect(res.status).toBe(401);
  });
});

describe("processLead", () => {
  it("error once → retrying; twice → failed + cant-see email + alert", async () => {
    const id = seed({ outcome: "processing", pdf_url: null });
    h.runHomepageFixes.mockRejectedValue(new Error("Firecrawl 502"));

    await processLead(id);
    expect(row(id)).toMatchObject({ outcome: "retrying", retry_count: 1 });
    expect(row(id).error).toMatch(/Firecrawl 502/);
    expect(resendCalls()).toHaveLength(0);

    const r = await sweep();
    expect(r).toEqual({ queued: 0, retried: 1 });
    expect(h.runHomepageFixes).toHaveBeenCalledTimes(2);
    expect(row(id).outcome).toBe("failed");
    expect(row(id).error).toMatch(/Firecrawl 502/);
    const mail = toPhotographer("jane@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0].body!.subject).toBe(cantSeeEmail("Jane", "couldnt_load").subject);
    expect(mail[0].body!.html).toBe(cantSeeEmail("Jane", "couldnt_load").html);
    expect(alerts()).toHaveLength(1);
    const ml = mailerlite().find((c) => c.body && "fields" in c.body)!;
    expect(ml.body!.fields).toMatchObject({ hf_outcome: "failed", hf_sent_date: "" });
    expect(ml.body!.fields).not.toHaveProperty("pdf_url");
  });

  it("emails greet by first name: re-sent report and the failed path", async () => {
    seed({ name: "Jane Doe", outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf" });
    await postAndSettle({ ...JANE, name: "Jane Doe" });
    const id = seed({ name: "Jane Doe", email: "jd@example.com", outcome: "processing", retry_count: 1 });
    h.runHomepageFixes.mockRejectedValueOnce(new Error("boom"));
    await processLead(id);
    const [report] = toPhotographer("jane@example.com");
    expect(report.body!.subject).toBe("Jane, your top homepage fixes are ready");
    expect(String(report.body!.text)).toMatch(/^Hi Jane,/);
    const [failed] = toPhotographer("jd@example.com");
    expect(failed.body!.subject).toBe("Jane, a quick note about your homepage fixes");
    expect(String(failed.body!.text)).toMatch(/^Hi Jane,/);
    const sub = mailerlite().find((c) => c.body && "fields" in c.body)!;
    expect(sub.body!.fields).toMatchObject({ name: "Jane Doe" });
  });

  it("a delivery error after the email went out is never retried", async () => {
    const id = seed({ outcome: "processing" });
    h.deliver.mockRejectedValue(new DeliveredNotRecordedError(id, "delivered but not recorded: neon down"));
    await processLead(id);
    expect(row(id).outcome).toBe("processing");
    expect(row(id).retry_count).toBe(0);
    expect(row(id).error).toMatch(/delivered but not recorded/);
    expect(resendCalls()).toHaveLength(0);
  });

  it("only rows in processing or retrying are built and delivered", async () => {
    const id = seed({ outcome: "sent" });
    await processLead(id);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("does not deliver if the row was finished elsewhere while the pipeline ran", async () => {
    const id = seed({ outcome: "processing" });
    h.runHomepageFixes.mockImplementation(async () => {
      row(id).outcome = "sent";
      return SENT_RESULT;
    });
    await processLead(id);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("uses the cached capture when there is one", async () => {
    const cached = { url: "https://janedoe.com" };
    h.store.getCachedCapture.mockResolvedValueOnce(cached);
    const id = seed({ outcome: "processing" });
    await processLead(id);
    expect(h.store.getCachedCapture).toHaveBeenCalledWith("janedoe.com");
    expect(h.runHomepageFixes.mock.calls[0][0].capture).toBe(cached);
  });

  it("caches a fresh capture for the next person on the same site", async () => {
    const fresh = { url: "https://janedoe.com", fresh: true };
    h.captureSite.mockResolvedValue(fresh);
    h.runHomepageFixes.mockImplementation(async (input: { website: string }, stages: { capture: (u: string) => Promise<unknown> }) => {
      await stages.capture(input.website);
      return SENT_RESULT;
    });
    const id = seed({ outcome: "processing" });
    await processLead(id);
    expect(h.captureSite).toHaveBeenCalledWith("https://janedoe.com");
    expect(h.store.putCachedCapture).toHaveBeenCalledWith("janedoe.com", fresh);
  });
});

describe("processLead: deadline and cache (I2, Minor 2)", () => {
  it("tells the pipeline whether the lead still has a retry left", async () => {
    const first = seed({ outcome: "processing", retry_count: 0 });
    await processLead(first);
    expect(h.runHomepageFixes.mock.calls[0][0].canRetry).toBe(true);
    const last = seed({ email: "kim@example.com", outcome: "retrying", retry_count: 1 });
    await processLead(last);
    expect(h.runHomepageFixes.mock.calls[1][0].canRetry).toBe(false);
  });

  it("an out-of-time throw on the first attempt sends the lead to retrying, with no email", async () => {
    const { OutOfTimeError } = await import("./pipeline");
    const id = seed({ outcome: "processing" });
    h.runHomepageFixes.mockRejectedValue(new OutOfTimeError("the write call"));
    await processLead(id);
    expect(row(id)).toMatchObject({ outcome: "retrying", retry_count: 1 });
    expect(resendCalls()).toHaveLength(0);
  });

  const withFreshCapture = (result: unknown) => {
    h.captureSite.mockResolvedValue({ url: "https://janedoe.com", fresh: true });
    h.runHomepageFixes.mockImplementation(async (input: { website: string }, stages: { capture: (u: string) => Promise<unknown> }) => {
      await stages.capture(input.website);
      if (result instanceof Error) throw result;
      return result;
    });
  };

  it.each([["COMING_SOON"], ["TOO_LITTLE_TEXT"], ["NO_PHOTO"], ["BOT_CHECK"]])(
    "does not cache a capture that ended in can't-see (%s), so a resubmit after launch scrapes again",
    async (reason) => {
      withFreshCapture({ outcome: "cant_see", reason, usage: {} });
      await processLead(seed({ outcome: "processing" }));
      expect(h.store.putCachedCapture).not.toHaveBeenCalled();
    },
  );

  it("still caches the capture when the run fails, so the retry skips Firecrawl", async () => {
    withFreshCapture(new Error("Gemini 503"));
    await processLead(seed({ outcome: "processing" }));
    expect(h.store.putCachedCapture).toHaveBeenCalledWith("janedoe.com", { url: "https://janedoe.com", fresh: true });
  });
});

describe("sweep start cutoff (I2)", () => {
  it("starts a lead only while it still gets at least 240 s, so a slow first lead stops the run", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    const a = seed({ outcome: "retrying", retry_count: 1, started_minutes_ago: 30 });
    const b = seed({ email: "kim@example.com", outcome: "retrying", retry_count: 1, started_minutes_ago: 30 });
    h.runHomepageFixes.mockImplementation(async () => { t += 31_000; return SENT_RESULT; });
    expect(await sweep()).toEqual({ queued: 0, retried: 1 });
    expect(h.runHomepageFixes.mock.calls[0][0].deadlineMs).toBeGreaterThanOrEqual(240_000);
    expect(row(a).outcome).toBe("sent");
    expect(row(b).outcome).toBe("retrying");
  });

  it("fast leads (a re-send, a can't-see) still let the next one start", async () => {
    let t = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    seed({ outcome: "retrying", retry_count: 1, started_minutes_ago: 30 });
    seed({ email: "kim@example.com", outcome: "retrying", retry_count: 1, started_minutes_ago: 30 });
    h.runHomepageFixes.mockImplementation(async () => { t += 5_000; return SENT_RESULT; });
    expect(await sweep()).toEqual({ queued: 0, retried: 2 });
    for (const c of h.runHomepageFixes.mock.calls) expect(c[0].deadlineMs).toBeGreaterThanOrEqual(240_000);
  });

  it("the queue cron runs every 15 minutes through the morning, since each run builds about one lead", async () => {
    const fs = await import("node:fs");
    const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    const queue = cfg.crons.find((c) => c.path.includes("queue=1"))!;
    expect(queue.schedule).toBe("*/15 12-16 * * *");
  });
});

describe("sweep and the cron route", () => {
  it("queue run processes queued leads oldest first within the day's cap", async () => {
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "3");
    seed({ email: "a@x.com", outcome: "sent" });
    const q1 = seed({ email: "q1@x.com", outcome: "queued" });
    const q2 = seed({ email: "q2@x.com", outcome: "queued" });
    const q3 = seed({ email: "q3@x.com", outcome: "queued" });
    const r = await sweep({ queue: true });
    expect(r).toEqual({ queued: 2, retried: 0 });
    expect(h.deliver.mock.calls.map((c) => c[0])).toEqual([q1, q2]);
    expect(row(q3).outcome).toBe("queued");
  });

  it("a stuck processing row alerts once across two sweeps; a fresh one doesn't; neither changes", async () => {
    const stuck = seed({ outcome: "processing", started_minutes_ago: 25 });
    const fresh = seed({ email: "kim@example.com", outcome: "processing", started_minutes_ago: 3 });
    await sweep();
    await sweep();
    expect(alerts()).toHaveLength(1);
    expect(String(alerts()[0].body!.text)).toMatch(/stuck in processing since 2026-11-04T10:00:00.000Z/);
    expect(String(alerts()[0].body!.text)).toContain(stuck);
    expect(row(stuck)).toMatchObject({ outcome: "processing", retry_count: 0 });
    expect(row(fresh)).toMatchObject({ outcome: "processing", stuck_alerted: false });
    expect(h.store.markStuckLeads).toHaveBeenCalledWith(20);
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
  });

  it("a retry waits 10 minutes from when the failed attempt started", async () => {
    const recent = seed({ outcome: "retrying", retry_count: 1, started_minutes_ago: 4 });
    expect(await sweep()).toEqual({ queued: 0, retried: 0 });
    expect(h.store.retryingLeads).toHaveBeenCalledWith(10, 20);
    row(recent).started_minutes_ago = 11;
    expect(await sweep()).toEqual({ queued: 0, retried: 1 });
  });

  it("queue run: a queued lead whose person already got a report for this site is limited and re-sent", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf", id: "old" });
    const q = seed({ outcome: "queued" });
    const r = await sweep({ queue: true });
    expect(h.runHomepageFixes).not.toHaveBeenCalled();
    expect(row(q).outcome).toBe("limited");
    expect(row(q).error).toMatch(/duplicate of lead old/);
    expect(toPhotographer("jane@example.com")).toHaveLength(1);
    expect(r.queued).toBe(0);
  });

  it("the retry run leaves the queue alone", async () => {
    const q = seed({ outcome: "queued" });
    expect(await sweep()).toEqual({ queued: 0, retried: 0 });
    expect(row(q).outcome).toBe("queued");
  });

  it("cron route: no CRON_SECRET → 404; wrong bearer → 401; right bearer runs the sweep", async () => {
    const get = (auth?: string, query = "") =>
      cronGET(new NextRequest(`https://captured-site-leads.vercel.app/api/cron/homepage-fixes${query}`, {
        headers: auth ? { authorization: auth } : {},
      }));
    vi.stubEnv("CRON_SECRET", "");
    expect((await get("Bearer cron-s3cret")).status).toBe(404);
    vi.stubEnv("CRON_SECRET", "cron-s3cret");
    expect((await get("Bearer nope")).status).toBe(401);
    expect((await get()).status).toBe(401);
    const q = seed({ outcome: "queued" });
    const ok = await get("Bearer cron-s3cret", "?queue=1");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ queued: 1, retried: 0 });
    expect(h.deliver.mock.calls[0][0]).toBe(q);
  });
});

describe("never-received group", () => {
  const neverCalls = () =>
    mailerlite().filter((c) => c.url.endsWith("/subscribers") && (c.body?.groups as string[] | undefined)?.includes("group-never"));

  it("server-side invalid (email or site) joins it", async () => {
    h.checkEmail.mockResolvedValue({ ok: false, code: "no_mail", message: "m" });
    await postAndSettle(JANE);
    expect(neverCalls()).toHaveLength(1);
    expect(neverCalls()[0].body).toEqual({ email: "jane@example.com", fields: { name: "Jane" }, groups: ["group-never"] });
  });

  it("an invalid payload joins it only when the email looks like an email", async () => {
    await hfPOST(jsonPost({ name: "Jane", email: "jane@example.com" })); // no site_url
    expect(neverCalls()).toHaveLength(1);
    await hfPOST(jsonPost({ name: "Jane", email: "not-an-email", site_url: "janedoe.com" }));
    expect(neverCalls()).toHaveLength(1);
  });

  it("limited with no earlier report joins it", async () => {
    for (const site of ["a.com", "b.com", "c.com"]) seed({ outcome: "cant_see", site_url: `https://${site}` });
    expect((await postAndSettle(JANE)).outcome).toBe("limited");
    expect(neverCalls()).toHaveLength(1);
  });

  it("limited with an earlier report re-sent does not", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf" });
    seed({ outcome: "cant_see", site_url: "https://b.com" });
    seed({ outcome: "cant_see", site_url: "https://c.com" });
    await postAndSettle(JANE);
    expect(toPhotographer("jane@example.com")).toHaveLength(1);
    expect(neverCalls()).toHaveLength(0);
  });

  it("a dedupe re-send does not", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf" });
    await postAndSettle(JANE);
    expect(toPhotographer("jane@example.com")).toHaveLength(1);
    expect(neverCalls()).toHaveLength(0);
  });

  it("the twin (concurrent duplicate) stop does not", async () => {
    seed({ outcome: "processing", started_minutes_ago: 1 });
    expect((await postAndSettle(JANE)).outcome).toBe("limited");
    expect(neverCalls()).toHaveLength(0);
  });

  it("queued does not", async () => {
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "1");
    seed({ outcome: "sent", site_url: "https://other.com", email: "x@example.com" });
    expect((await postAndSettle(JANE)).outcome).toBe("queued");
    expect(neverCalls()).toHaveLength(0);
  });

  it("a failed re-send of an earlier report joins it", async () => {
    seed({ outcome: "sent", pdf_url: "https://blob.test/p/your-top-homepage-fixes-jane.pdf" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const origin = new URL(url).origin;
      if (origin === "https://api.resend.com") return new Response("boom", { status: 500 });
      if (origin === "https://connect.mailerlite.com") return new Response("boom", { status: 500 });
      return new Response(new Uint8Array(PDF_BYTES), { status: 200 });
    }));
    expect((await postAndSettle(JANE)).outcome).toBe("failed");
    expect(neverCalls().length).toBeGreaterThanOrEqual(1);
  });

  it("unset env: no never-received call", async () => {
    vi.stubEnv("MAILERLITE_HF_NEVER_RECEIVED_GROUP_ID", "");
    h.checkEmail.mockResolvedValue({ ok: false, code: "no_mail", message: "m" });
    await postAndSettle(JANE);
    expect(mailerlite()).toHaveLength(0);
  });

  it("a MailerLite 500 does not stop the row from ending invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    h.checkEmail.mockResolvedValue({ ok: false, code: "no_mail", message: "m" });
    expect((await postAndSettle(JANE)).outcome).toBe("invalid");
  });
});
