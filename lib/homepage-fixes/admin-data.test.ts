import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: () => Object.assign(vi.fn(async () => []), { query: vi.fn(async () => []) }) }));

import {
  csvCell, daysBetween, emailFields, emailSetupBody, leadsCsv, leadsWhere, metricsBody, parseRange, pipelineHealth, summaryBody,
  toLeadDetail, toLeadRow, type HfDayRow,
} from "./admin-data";

const row = (day: string, outcome: string | null, extra: Partial<HfDayRow> = {}): HfDayRow =>
  ({ day, outcome, cost_usd: null, opens: 0, clicks: 0, ...extra });

/** Every string anywhere in v. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}
function numbers(v: unknown): number[] {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.flatMap(numbers);
  if (v && typeof v === "object") return Object.values(v).flatMap(numbers);
  return [];
}

describe("daysBetween / parseRange", () => {
  it("lists every UTC day, inclusive", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
  it("rejects bad, reversed and too-long ranges", () => {
    expect(parseRange("2026-11-01", "2026-11-03", { required: true })).toEqual({ from: "2026-11-01", to: "2026-11-03" });
    expect(parseRange("2026-11-31", "2026-12-01", { required: true })).toHaveProperty("error");
    expect(parseRange("2026-11-03", "2026-11-01", { required: true })).toHaveProperty("error");
    expect(parseRange("2025-01-01", "2026-11-01", { required: true })).toHaveProperty("error");
    expect(parseRange("0001-01-01", "9999-12-31", { required: true })).toHaveProperty("error");
    expect(parseRange("2025-10-01", "2026-11-04", { required: true })).toEqual({ from: "2025-10-01", to: "2026-11-04" }); // 400 days
    expect(parseRange("2025-09-30", "2026-11-04", { required: true })).toHaveProperty("error"); // 401
    expect(parseRange(null, null, { required: true })).toHaveProperty("error");
    expect(parseRange(null, null, { required: false })).toEqual({ from: null, to: null });
    expect(parseRange("nope", null, { required: false })).toHaveProperty("error");
  });
});

describe("metricsBody (contract v1)", () => {
  const now = new Date("2026-11-04T10:00:00.000Z");
  const rows = [
    row("2026-11-01", "sent", { cost_usd: "0.008123", opens: 2, clicks: 1 }),
    row("2026-11-01", "held", { cost_usd: "0.004" }),
    row("2026-11-01", "limited"),
    row("2026-11-03", "hobby", { cost_usd: 0.002 }),
    row("2026-11-03", "cant_see"),
    row("2026-11-03", "sent", { cost_usd: "0.01", opens: 0, clicks: 0 }),
  ];
  const body = metricsBody(rows, "2026-11-01", "2026-11-03", { reportsTotal: 12, finished24h: 10, heldFailed24h: 1, now });

  it("has the contract's shape and the app id", () => {
    expect(body.version).toBe(1);
    expect(body.app).toBe("capturedsites");
    expect(body.generatedAt).toBe(now.toISOString());
    expect(body.range).toEqual({ from: "2026-11-01", to: "2026-11-03", granularity: "day" });
    for (const [id, d] of Object.entries(body.metrics)) {
      expect(id).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(d.unit).toBe("count");
      expect(["gauge", "counter"]).toContain(d.kind);
    }
    expect(Object.keys(body.metrics).sort()).toEqual([
      "hf_cant_see", "hf_clicked", "hf_gemini_microusd", "hf_held_failed", "hf_hobby", "hf_invalid_limited",
      "hf_opened", "hf_reports_total", "hf_sent", "hf_submissions",
    ]);
    expect(body.totals).toEqual({ hf_reports_total: 12 });
  });

  it("zero-fills the series across the whole range, counters only", () => {
    expect(body.series.map((s) => s.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    const counters = Object.entries(body.metrics).filter(([, d]) => d.kind === "counter").map(([id]) => id).sort();
    for (const s of body.series) expect(Object.keys(s.values).sort()).toEqual(counters);
    expect(body.series[1].values).toEqual(Object.fromEntries(counters.map((c) => [c, 0])));
    expect(body.series[0].values).toMatchObject({
      hf_submissions: 3, hf_sent: 1, hf_held_failed: 1, hf_invalid_limited: 1, hf_opened: 1, hf_clicked: 1,
      hf_gemini_microusd: 12123,
    });
    expect(body.series[2].values).toMatchObject({ hf_submissions: 3, hf_sent: 1, hf_hobby: 1, hf_cant_see: 1, hf_opened: 0, hf_gemini_microusd: 12000 });
  });

  it("every value is a non-negative integer and no string carries an address or a URL", () => {
    for (const n of numbers({ totals: body.totals, series: body.series, health: body.health })) {
      expect(Number.isInteger(n) && n >= 0).toBe(true);
    }
    for (const s of strings(body)) {
      expect(s).not.toContain("@");
      expect(s).not.toContain("http");
    }
  });

  it("pipeline health: numbers only in detail", () => {
    expect(body.health).toEqual([{ id: "pipeline", status: "warn", checkedAt: now.toISOString(), detail: { finished_24h: 10, held_failed_24h: 1 } }]);
  });
});

describe("pipelineHealth", () => {
  it("fails over 20% held or failed, warns on any, else ok", () => {
    expect(pipelineHealth(0, 0)).toBe("ok");
    expect(pipelineHealth(10, 0)).toBe("ok");
    expect(pipelineHealth(10, 1)).toBe("warn");
    expect(pipelineHealth(10, 2)).toBe("warn");
    expect(pipelineHealth(10, 3)).toBe("fail");
    expect(pipelineHealth(1, 1)).toBe("fail");
  });
});

describe("summaryBody", () => {
  it("counts outcomes and treats any open or click as one opened or clicked report", () => {
    const s = summaryBody([
      row("2026-11-01", "sent", { cost_usd: "0.01", opens: 5, clicks: "0" }),
      row("2026-11-01", "sent", { cost_usd: "0.006", opens: "1", clicks: 2 }),
      row("2026-11-02", "sent", { cost_usd: "0.008" }),
      row("2026-11-02", "sent", { cost_usd: "0.008" }),
      row("2026-11-02", "hobby", { cost_usd: "0.002", opens: 3 }),
      row("2026-11-02", "cant_see", { cost_usd: "0" }),
      row("2026-11-02", "failed"),
      row("2026-11-02", "held", { cost_usd: "0.006" }),
      row("2026-11-02", "invalid"),
    ], "2026-11-01", "2026-11-03");
    expect(s).toMatchObject({ submissions: 9, sent: 4, cant_see: 1, hobby: 1, held_failed: 2, open_rate: 0.5, click_rate: 0.25 });
    expect(s.avg_cost_usd).toBeCloseTo((0.01 + 0.006 + 0.008 + 0.008 + 0.002 + 0.006) / 6, 6);
    expect(s.perDay).toEqual([
      { date: "2026-11-01", submissions: 2, sent: 2 },
      { date: "2026-11-02", submissions: 7, sent: 2 },
      { date: "2026-11-03", submissions: 0, sent: 0 },
    ]);
    expect(typeof s.submissions).toBe("number");
  });
  it("rates are 0 with nothing sent", () => {
    const s = summaryBody([], "2026-11-01", "2026-11-01");
    expect(s).toMatchObject({ submissions: 0, open_rate: 0, click_rate: 0, avg_cost_usd: 0 });
  });
});

describe("leadsWhere", () => {
  it("homepage fixes only by default", () => {
    const w = leadsWhere({});
    expect(w.clause).toBe("report_type = $1");
    expect(w.params).toEqual(["homepage_fixes"]);
  });
  it("roadmap rows only under outcome=roadmap", () => {
    expect(leadsWhere({ outcome: "roadmap" })).toEqual({ clause: "report_type = $1", params: ["roadmap"] });
  });
  it("filters by outcome, date range and a case-insensitive search on name, email and site", () => {
    const w = leadsWhere({ outcome: "held", from: "2026-11-01", to: "2026-11-03", q: "Ja_ne%" });
    expect(w.clause).toBe(
      "report_type = $1 and outcome = $2 and created_at >= $3::timestamptz and created_at < $4::timestamptz"
      + " and (name ilike $5 or email ilike $5 or site_url ilike $5)",
    );
    expect(w.params).toEqual(["homepage_fixes", "held", "2026-11-01T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "%Ja\\_ne\\%%"]);
  });
});

describe("CSV", () => {
  it("RFC 4180 quoting", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0.0081)).toBe("0.0081");
  });
  it("guards against formula injection", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });
  it("header, CRLF records and the content titles", () => {
    const csv = leadsCsv([{
      created_at: new Date("2026-11-01T12:00:00.000Z"), name: "=HYPERLINK(1)", email: "j@x.com", site_url: "https://janedoe.com",
      goal: "More, better", outcome: "sent", pdf_url: "https://b/p.pdf", cost_usd: "0.008100", opens: 2, clicks: 0,
      content: { first_section: { headline: "Hello" }, fixes: [{ title: "Fix A" }, { title: "Fix B" }] }, report_type: "homepage_fixes",
    }]);
    const [header, line, end] = csv.split("\r\n");
    expect(header).toBe("created_at,name,email,site_url,goal,outcome,pdf_url,cost_usd,opens,clicks,headline,fix1_title,fix2_title,report_type");
    expect(line).toBe("2026-11-01T12:00:00.000Z,'=HYPERLINK(1),j@x.com,https://janedoe.com,\"More, better\",sent,https://b/p.pdf,0.0081,2,0,Hello,Fix A,Fix B,homepage_fixes");
    expect(end).toBe("");
  });
});

describe("rows", () => {
  const db = {
    id: "8f9c8d4e-1111-4222-8333-944455556666", created_at: new Date("2026-11-01T12:00:00.000Z"), name: "Jane Doe",
    email: "jane@x.com", site_url: "https://janedoe.com", goal: null, outcome: "held", pdf_url: null, before_url: null,
    after_url: null, cost_usd: "0.006000", opens: "0", clicks: 1, report_type: "homepage_fixes", error: "rules",
    model: "google/gemini-3.8-flash", input_tokens: 5000, output_tokens: 900, retry_count: 0,
    content: { first_section: { headline: "H" }, notes_for_maggie: "Look at the logo", fact_sheet: "FACTS", issues: [{ field: "x" }] },
  };
  it("LeadRow: numbers are numbers, dates are ISO strings", () => {
    expect(toLeadRow(db)).toEqual({
      id: db.id, created_at: "2026-11-01T12:00:00.000Z", name: "Jane Doe", email: "jane@x.com", site_url: "https://janedoe.com",
      goal: "", outcome: "held", pdf_url: null, before_url: null, after_url: null, cost_usd: 0.006, opens: 0, clicks: 1,
    });
  });
  it("detail splits the fact sheet, issues and notes out of the content", () => {
    const d = toLeadDetail(db);
    expect(d).toMatchObject({ facts_sheet: "FACTS", issues: [{ field: "x" }], notes_for_maggie: "Look at the logo", error: "rules", retry_count: 0, report_type: "homepage_fixes" });
    expect(d.content).toEqual({ first_section: { headline: "H" }, notes_for_maggie: "Look at the logo" });
  });
});

describe("emailFields", () => {
  it("lists the MailerLite merge fields, with examples from the newest sent lead when there is one", () => {
    const fallback = emailFields(null);
    expect(fallback.map((f) => f.tag)).toEqual([
      "{$name}", "{$site_url}", "{$pdf_url}", "{$goal}", "{$hf_outcome}", "{$hf_headline}", "{$hf_fix1_title}", "{$hf_fix2_title}", "{$hf_sent_date}",
    ]);
    expect(fallback[0].example).toBe("Jane Doe");
    const live = emailFields({ name: "Bill Johns", site_url: "https://wjohnsphoto.com", goal: "More weddings", pdf_url: "https://b/p.pdf", headline: "H", fix1: "A", fix2: "B", sent_date: "2026-11-02" });
    expect(live.find((f) => f.tag === "{$hf_fix2_title}")!.example).toBe("B");
    expect(live.find((f) => f.tag === "{$hf_sent_date}")!.example).toBe("2026-11-02");
  });
});

describe("emailSetupBody", () => {
  it("the real report email for Jane, the group and automation, zero-filled 30-day outcomes and fractional rates", () => {
    const b = emailSetupBody(null, [row("2026-11-01", "sent", { opens: 1 }), row("2026-11-01", "sent"), row("2026-11-02", "held")]);
    expect(b.reportEmail.subject).toBe("Jane, your top homepage fixes are ready");
    expect(b.reportEmail.html).toContain("Hi Jane,");
    expect(b.reportEmail.html).toContain("See My Homepage Fixes");
    expect(b).toMatchObject({ group: "Website Lead Generator", automation: "Lead Generator Follow-ups", open_rate30d: 0.5, click_rate30d: 0 });
    expect(b.outcomes30d).toEqual({ sent: 2, hobby: 0, cant_see: 0, held: 1, failed: 0, limited: 0, queued: 0, invalid: 0, processing: 0, retrying: 0 });
    expect(b.fields).toHaveLength(9);
  });
});
