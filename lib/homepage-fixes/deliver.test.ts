import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Facts } from "./facts";
import type { PipelineResult } from "./pipeline";
import type { ReportContent, Usage } from "./types";

// No real Neon, Blob, Resend or MailerLite: sql, put and fetch are all fakes.

const h = vi.hoisted(() => {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => []);
  const tag = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
  const sqlFn = Object.assign(tag, { query });
  const put = vi.fn<(path: string, body: unknown, opts: unknown) => Promise<{ url: string }>>(async (path) => ({ url: `https://blob.test/${path}` }));
  return { query, tag, sqlFn, put };
});
vi.mock("@/lib/db", () => ({ sql: () => h.sqlFn }));
vi.mock("@vercel/blob", () => ({ put: h.put }));

import { deliver, sendAlert } from "./deliver";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let resendStatus = 200;
let mailerliteStatus = 200;

beforeEach(() => {
  calls = [];
  resendStatus = 200;
  mailerliteStatus = 200;
  h.query.mockClear();
  h.put.mockClear();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "");
  vi.stubEnv("MAILERLITE_API_KEY", "ml_test");
  vi.stubEnv("MAILERLITE_GROUP_ID", "group-123");
  vi.stubEnv("ALERT_EMAILS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("https://api.resend.com")) {
      return new Response(JSON.stringify(resendStatus === 200 ? { id: "email-1" } : { message: "boom" }), { status: resendStatus });
    }
    if (url.startsWith("https://connect.mailerlite.com")) {
      return new Response(JSON.stringify({ data: { id: "ml-1", status: "sent" } }), { status: mailerliteStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LEAD = { name: "Jane", email: "jane@example.com", siteUrl: "https://janedoe.com", goal: "more family sessions" };
const USAGE: Usage = { inputTokens: 4100, outputTokens: 880, costUsd: 0.0064, calls: 5 };
const FACTS = { flags: [], sheet: "FACT SHEET LINES", trimmedText: "", pageText: "", mockup: {} } as unknown as Facts;
const CONTENT = {
  first_name: "Jane", website: "https://janedoe.com", goal: "more family sessions",
  first_section: { headline: "Family photos that feel like home" },
  first_section_changes: ["a", "b", "c"],
  fixes: [
    { title: "Show your people first", noticed: "n", why: "w", changes: ["1", "2", "3"] },
    { title: "Make the next step easy", noticed: "n", why: "w", changes: ["1", "2", "3"] },
  ],
  notes_for_maggie: "Her about page is lovely.",
} as unknown as ReportContent;

const sent = (pdf = Buffer.from("%PDF-1.7 fake")): PipelineResult => ({
  outcome: "sent", content: CONTENT, pdf,
  before: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), after: Buffer.from([0xff, 0xd8, 0xff, 1]),
  facts: FACTS, usage: USAGE, model: "google/gemini-3.8-flash",
});

const resend = () => calls.filter((c) => c.url.startsWith("https://api.resend.com"));
const ml = (path: string, method = "POST") =>
  calls.filter((c) => c.url === `https://connect.mailerlite.com/api${path}` && c.method === method);

/** The columns the last `update leads` set, mapped to their parameters. */
function lastUpdate(): Record<string, unknown> {
  const call = [...h.query.mock.calls].reverse().find(([text]) => /^\s*update leads/i.test(text));
  if (!call) throw new Error("no update leads query");
  const [text, params = []] = call;
  const out: Record<string, unknown> = {};
  for (const m of text.matchAll(/(\w+) = \$(\d+)/g)) out[m[1]] = (params as unknown[])[Number(m[2]) - 1];
  return out;
}

describe("deliver", () => {
  it("deliver sent: Resend called with attachment base64 and from maggie@capturedsites.com; MailerLite called with hf fields; row updated outcome sent with cost", async () => {
    const r = sent();
    await deliver("lead-1", LEAD, r);

    // Blob: the PDF under its human file name, plus before/after images, in one unique folder.
    const paths = h.put.mock.calls.map(([p]) => p);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toMatch(/^homepage-fixes\/[^/]+\/your-top-homepage-fixes-jane\.pdf$/);
    const folder = paths[0].split("/").slice(0, 2).join("/");
    expect(paths).toContain(`${folder}/before.png`);
    expect(paths).toContain(`${folder}/after.jpg`);

    const [email] = resend();
    expect(resend()).toHaveLength(1);
    expect(email.body!.from).toBe("Maggie | Captured Sites <maggie@capturedsites.com>");
    expect(email.body!.to).toEqual(["jane@example.com"]);
    expect(email.body!.subject).toBe("Jane, your homepage fixes are ready");
    expect(email.body!.attachments).toEqual([
      { filename: "your-top-homepage-fixes-jane.pdf", content: r.outcome === "sent" ? r.pdf.toString("base64") : "" },
    ]);
    expect(String(email.body!.html)).toContain("attached to this email");
    expect(String(email.body!.html)).toContain(`https://blob.test/${paths[0]}`);
    expect(String(email.body!.text)).toContain("Hi Jane,");

    const [sub] = ml("/subscribers");
    expect(sub.body!.email).toBe("jane@example.com");
    expect(sub.body!.groups).toEqual(["group-123"]);
    expect(sub.body!.fields).toEqual({
      name: "Jane", site_url: "https://janedoe.com", pdf_url: `https://blob.test/${paths[0]}`,
      goal: "more family sessions", hf_outcome: "sent", hf_headline: "Family photos that feel like home",
      hf_fix1_title: "Show your people first", hf_fix2_title: "Make the next step easy",
      hf_sent_date: new Date().toISOString().slice(0, 10),
    });

    const u = lastUpdate();
    expect(u.outcome).toBe("sent");
    expect(u.status).toBe("complete");
    expect(u.cost_usd).toBe(0.0064);
    expect(u.input_tokens).toBe(4100);
    expect(u.output_tokens).toBe(880);
    expect(u.model).toBe("google/gemini-3.8-flash");
    expect(u.pdf_url).toBe(`https://blob.test/${paths[0]}`);
    expect(u.before_url).toBe(`https://blob.test/${folder}/before.png`);
    expect(u.after_url).toBe(`https://blob.test/${folder}/after.jpg`);
    const content = JSON.parse(String(u.content));
    expect(content.fact_sheet).toBe("FACT SHEET LINES");
    expect(content.notes_for_maggie).toBe("Her about page is lovely.");
    // The order matters: the email goes out before the row says "sent".
    const updateOrder = h.query.mock.invocationCallOrder[h.query.mock.calls.length - 1];
    const firstFetchOrder = vi.mocked(fetch).mock.invocationCallOrder[0];
    expect(updateOrder).toBeGreaterThan(firstFetchOrder);
  });

  it("deliver falls back to MailerLite link email when Resend returns 500", async () => {
    resendStatus = 500;
    await deliver("lead-1", LEAD, sent());
    expect(resend()).toHaveLength(1);
    const [campaign] = ml("/campaigns");
    const emails = campaign.body!.emails as { subject: string; content: string; from: string }[];
    expect(emails[0].subject).toBe("Jane, your homepage fixes are ready");
    expect(emails[0].content).toContain("See My Homepage Fixes");
    expect(emails[0].content).not.toContain("attached to this email");
    expect(emails[0].content).toContain("{$unsubscribe}");
    expect(emails[0].content).not.toContain("Dream Client Roadmap");
    expect(ml("/campaigns/ml-1/schedule")).toHaveLength(1);
    expect(lastUpdate().outcome).toBe("sent");
  });

  it("deliver skips attachment over 8 MB", async () => {
    await deliver("lead-1", LEAD, sent(Buffer.alloc(8 * 1024 * 1024 + 1)));
    const [email] = resend();
    expect(email.body!.attachments).toBeUndefined();
    expect(String(email.body!.html)).not.toContain("attached");
    expect(String(email.body!.html)).toContain("See My Homepage Fixes");
  });

  it("deliver held: no Resend call to the photographer; alert sent to both addresses", async () => {
    const issues = [{ field: "headline", level: "error" as const, message: "uses a dash" }];
    await deliver("lead-9", LEAD, { outcome: "held", reason: "look check failed", content: CONTENT, issues, facts: FACTS, usage: USAGE, model: "m" });
    expect(resend().every((c) => !(c.body!.to as string[]).includes("jane@example.com"))).toBe(true);
    expect(resend()).toHaveLength(1);
    const alert = resend()[0].body!;
    expect(alert.to).toEqual(["danluk1311@gmail.com", "maggie@capturedsites.com"]);
    expect(String(alert.subject)).toBe("[Homepage Fixes] held: Jane (https://janedoe.com)");
    expect(String(alert.text)).toContain("lead-9");
    expect(String(alert.text)).toContain("look check failed");
    expect(ml("/subscribers")).toHaveLength(0);
    expect(h.put).not.toHaveBeenCalled();
    const u = lastUpdate();
    expect(u.outcome).toBe("held");
    expect(u.error).toBe("look check failed");
    const content = JSON.parse(String(u.content));
    expect(content.issues).toEqual(issues);
    expect(content.fact_sheet).toBe("FACT SHEET LINES");
    expect(content.notes_for_maggie).toBe("Her about page is lovely.");
  });

  it("deliver continues when MailerLite throws", async () => {
    mailerliteStatus = 500;
    await expect(deliver("lead-1", LEAD, sent())).resolves.toBeUndefined();
    expect(resend()).toHaveLength(1);
    expect(lastUpdate().outcome).toBe("sent");
  });

  it("deliver hobby: hobby email with the compliment, MailerLite upsert with empty pdf_url", async () => {
    await deliver("lead-2", LEAD, { outcome: "hobby", compliment: "Your beach sessions glow.", facts: FACTS, usage: USAGE, model: "m" });
    const [email] = resend();
    expect(email.body!.subject).toBe("Jane, a little note about your website");
    expect(String(email.body!.text)).toContain("Your beach sessions glow.");
    expect(email.body!.attachments).toBeUndefined();
    const fields = ml("/subscribers")[0].body!.fields as Record<string, string>;
    expect(fields).toMatchObject({ pdf_url: "", hf_outcome: "hobby", hf_headline: "", hf_fix1_title: "", hf_fix2_title: "" });
    expect(lastUpdate()).toMatchObject({ outcome: "hobby", cost_usd: 0.0064 });
  });

  it("deliver cant_see: COMING_SOON gets the not-live copy, anything else the couldn't-load copy", async () => {
    await deliver("lead-3", LEAD, { outcome: "cant_see", reason: "COMING_SOON", usage: USAGE });
    expect(String(resend()[0].body!.text)).toContain("isn't quite live yet");
    expect((ml("/subscribers")[0].body!.fields as Record<string, string>).hf_outcome).toBe("cant_see");
    expect(lastUpdate().outcome).toBe("cant_see");

    calls = [];
    await deliver("lead-4", LEAD, { outcome: "cant_see", reason: "unreachable", usage: USAGE });
    expect(String(resend()[0].body!.text)).toContain("couldn't load your homepage");
  });
});

describe("sendAlert", () => {
  it("sends failed alerts to ALERT_EMAILS only, and never throws", async () => {
    vi.stubEnv("ALERT_EMAILS", "a@x.com, b@x.com");
    await sendAlert("failed", { id: "1", name: "Jane", email: "j@x.com", site_url: "https://x.com", error: "Firecrawl down" });
    expect(resend()[0].body!.to).toEqual(["a@x.com", "b@x.com"]);
    resendStatus = 500;
    await expect(sendAlert("cap", { id: "1", name: "Jane", email: "j@x.com", site_url: "https://x.com" })).resolves.toBeUndefined();
  });
});
