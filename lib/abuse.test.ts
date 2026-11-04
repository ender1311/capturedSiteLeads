import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type R = { email: string | null; ip: string | null; outcome: string | null; report_type: string };
const h = vi.hoisted(() => ({ rows: [] as R[], calls: [] as unknown[][] }));
vi.mock("./db", () => ({
  sql: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push([strings.join("?"), ...values]);
    return h.rows.filter((r) => r.report_type === values[0]);
  },
}));

import { capRemaining, checkDailyLimits, dailyCap } from "./abuse";

const row = (r: Partial<R>): R => ({ email: "x@y.com", ip: null, outcome: "sent", report_type: "homepage_fixes", ...r });

beforeEach(() => {
  h.rows = [];
  h.calls = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("checkDailyLimits", () => {
  it("filters by report type in the query", async () => {
    await checkDailyLimits({ email: "a@b.com", ip: null, reportType: "homepage_fixes" });
    expect(String(h.calls[0][0])).toMatch(/report_type = \?/);
    expect(h.calls[0][1]).toBe("homepage_fixes");
  });

  it("roadmap rows never count toward homepage fixes, and the other way round", async () => {
    h.rows = Array.from({ length: 5 }, () => row({ email: "a@b.com", report_type: "roadmap" }));
    expect(await checkDailyLimits({ email: "a@b.com", ip: null, reportType: "homepage_fixes" })).toEqual({ allowed: true });
    expect(await checkDailyLimits({ email: "a@b.com", ip: null, reportType: "roadmap" })).toMatchObject({ allowed: false, kind: "email" });
  });

  it("per-email (alias-collapsed) and per-IP limits: more than 3 including this one", async () => {
    h.rows = [row({ email: "a.b+1@gmail.com" }), row({ email: "ab@gmail.com" }), row({ email: "AB@gmail.com" })];
    expect(await checkDailyLimits({ email: "ab@gmail.com", ip: null, reportType: "homepage_fixes" })).toEqual({ allowed: true });
    h.rows.push(row({ email: "ab+x@gmail.com" }));
    expect(await checkDailyLimits({ email: "ab@gmail.com", ip: null, reportType: "homepage_fixes" })).toMatchObject({ kind: "email" });
    h.rows = Array.from({ length: 4 }, (_, i) => row({ email: `${i}@x.com`, ip: "1.1.1.1" }));
    expect(await checkDailyLimits({ email: "new@x.com", ip: "1.1.1.1", reportType: "homepage_fixes" })).toMatchObject({ kind: "ip" });
  });

  it("homepage-fixes cap: HOMEPAGE_FIXES_DAILY_CAP (default 100), queued/invalid/limited rows don't count", async () => {
    expect(dailyCap("homepage_fixes")).toBe(100);
    expect(dailyCap("roadmap")).toBe(50);
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "2");
    h.rows = [
      row({ email: "1@x.com" }), row({ email: "2@x.com", outcome: "processing" }),
      row({ email: "3@x.com", outcome: "queued" }), row({ email: "4@x.com", outcome: "invalid" }), row({ email: "5@x.com", outcome: "limited" }),
    ];
    expect(await checkDailyLimits({ email: "2@x.com", ip: null, reportType: "homepage_fixes" })).toEqual({ allowed: true });
    expect(await capRemaining("homepage_fixes")).toBe(0);
    h.rows.push(row({ email: "6@x.com", outcome: "processing" }));
    expect(await checkDailyLimits({ email: "6@x.com", ip: null, reportType: "homepage_fixes" })).toMatchObject({ allowed: false, kind: "cap" });
  });

  it("a person over their own limit is told so before the cap", async () => {
    vi.stubEnv("HOMEPAGE_FIXES_DAILY_CAP", "1");
    h.rows = Array.from({ length: 4 }, () => row({ email: "a@b.com" }));
    expect(await checkDailyLimits({ email: "a@b.com", ip: null, reportType: "homepage_fixes" })).toMatchObject({ kind: "email" });
  });
});
