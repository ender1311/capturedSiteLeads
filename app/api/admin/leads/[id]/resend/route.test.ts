import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  deliverClaimed: vi.fn(),
  sendAlert: vi.fn(async () => {}),
  afterQueue: [] as (() => unknown)[],
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    h.afterQueue.push(fn);
  },
}));
vi.mock("@/lib/homepage-fixes/redeliver", () => ({ claimForRedeliver: h.claim, deliverClaimed: h.deliverClaimed }));
vi.mock("@/lib/homepage-fixes/deliver", async (orig) => ({ ...(await orig<typeof import("@/lib/homepage-fixes/deliver")>()), sendAlert: h.sendAlert }));

import { DeliveredNotRecordedError } from "@/lib/homepage-fixes/deliver";
import { POST } from "./route";

const TOKEN = "leads-token-for-tests";
const ID = "8f9c8d4e-1111-4222-8333-944455556666";
const ROW = { id: ID, name: "Jane Doe", email: "jane@x.com", site_url: "https://janedoe.com", outcome: "processing" };
const call = (id = ID, auth = `Bearer ${TOKEN}`) =>
  POST(new NextRequest(`https://captured-site-leads.vercel.app/api/admin/leads/${id}/resend`, { method: "POST", headers: { authorization: auth } }), {
    params: Promise.resolve({ id }),
  });
const runAfter = async () => {
  for (const fn of h.afterQueue.splice(0)) await fn();
};

beforeEach(() => {
  vi.stubEnv("LEADS_API_TOKEN", TOKEN);
  h.claim.mockReset().mockResolvedValue({ status: "claimed", row: ROW });
  h.deliverClaimed.mockReset().mockResolvedValue({ status: "sent", issues: [] });
  h.sendAlert.mockClear();
  h.afterQueue = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/admin/leads/:id/resend", () => {
  it("claims the lead, answers 202 at once, then delivers after the response", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "sending" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.claim).toHaveBeenCalledWith(ID);
    expect(h.deliverClaimed).not.toHaveBeenCalled();
    await runAfter();
    expect(h.deliverClaimed).toHaveBeenCalledWith(ROW);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  it("409 at once for a lead that is not held, or that someone else claimed first; nothing runs after", async () => {
    h.claim.mockResolvedValue({ status: "not_held", outcome: "sent" });
    expect((await call()).status).toBe(409);
    h.claim.mockResolvedValue({ status: "claim_lost" });
    expect((await call()).status).toBe(409);
    expect(h.afterQueue).toHaveLength(0);
  });

  it("404 for a missing lead, a wrong token or a bad id", async () => {
    h.claim.mockResolvedValue({ status: "not_found" });
    expect((await call()).status).toBe(404);
    h.claim.mockClear();
    expect((await call(ID, "Bearer x")).status).toBe(404);
    expect((await call("abc")).status).toBe(404);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("blocked by the copy rules after the 202: Dan and Maggie get a held alert", async () => {
    h.deliverClaimed.mockResolvedValue({ status: "blocked", issues: [{ field: "headline", level: "error", message: "too long" }] });
    expect((await call()).status).toBe(202);
    await runAfter();
    expect(h.sendAlert).toHaveBeenCalledWith("held", expect.objectContaining({ id: ID, error: expect.stringContaining("headline: too long") }));
  });

  it("a failure after the 202 alerts failed; a delivered-but-not-recorded one doesn't alert twice", async () => {
    h.deliverClaimed.mockRejectedValue(new Error("Blob down"));
    await call();
    await runAfter();
    expect(h.sendAlert).toHaveBeenCalledWith("failed", expect.objectContaining({ id: ID, error: expect.stringContaining("Blob down") }));
    h.sendAlert.mockClear();
    h.deliverClaimed.mockRejectedValue(new DeliveredNotRecordedError(ID, "delivered but not recorded"));
    await call();
    await runAfter();
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});
