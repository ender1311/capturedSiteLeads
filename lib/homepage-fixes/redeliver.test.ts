import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shared held-report delivery (the CLI and the admin re-send route). No Neon, Chromium or email:
// the store, renderers, rules and deliver are fakes.
const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  claim: vi.fn(async () => true),
  update: vi.fn(async () => {}),
  deliver: vi.fn(async () => {}),
  issues: [] as { field: string; level: "error" | "warning"; message: string }[],
}));
vi.mock("./store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  getHfLead: async () => h.row,
  claimHfLead: h.claim,
  updateHfLead: h.update,
  getCachedCapture: async () => ({
    before: { data: Buffer.from("b"), mime: "image/jpeg" },
    photos: [{ data: Buffer.from("p"), mime: "image/jpeg" }],
    logo: null,
  }),
}));
vi.mock("./facts", () => ({ buildFacts: () => ({ pageText: "", sheet: "S" }) }));
vi.mock("./rules", () => ({ checkContent: () => [...h.issues] }));
vi.mock("./pipeline", () => ({ overflowIssues: () => [] }));
vi.mock("./render", () => ({
  renderAfter: async () => Buffer.from("after"),
  renderPdf: async () => ({ pdf: Buffer.from("%PDF"), overflow: [] }),
}));
vi.mock("./render-html", () => ({ fillReport: () => "<html></html>" }));
vi.mock("./deliver", async (orig) => ({ ...(await orig<typeof import("./deliver")>()), deliver: h.deliver }));

import { DeliveredNotRecordedError } from "./deliver";
import { claimForRedeliver, deliverClaimed, redeliverHeld } from "./redeliver";

const CONTENT = {
  first_name: "Jane", first_section: { photo: "photo-01.jpg", headline: "H" }, first_section_changes: [], fixes: [{}, {}],
  fact_sheet: "old", issues: [], held_reason: "rules",
};

beforeEach(() => {
  h.row = {
    id: "L1", name: "Jane Doe", email: "jane@x.com", site_url: "https://janedoe.com", goal: "g", outcome: "held",
    retry_count: 0, pdf_url: null, content: CONTENT, input_tokens: 10, output_tokens: 5, cost_usd: "0.004", model: "m",
  };
  h.claim.mockReset().mockResolvedValue(true);
  h.update.mockReset().mockResolvedValue(undefined);
  h.deliver.mockReset().mockResolvedValue(undefined);
  h.issues = [];
});

describe("redeliverHeld", () => {
  it("claims held → processing, then delivers the stored content without the fact sheet or issues", async () => {
    expect(await redeliverHeld("L1")).toEqual({ status: "sent", issues: [] });
    expect(h.claim).toHaveBeenCalledWith("L1", ["held"]);
    const [id, lead, result] = h.deliver.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(id).toBe("L1");
    expect(lead).toEqual({ name: "Jane Doe", email: "jane@x.com", siteUrl: "https://janedoe.com", goal: "g" });
    expect(result.outcome).toBe("sent");
    expect(result.content).not.toHaveProperty("fact_sheet");
    expect(result.content).not.toHaveProperty("issues");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.004, calls: 0 });
  });

  it("refuses a lead that is not held, before claiming or rendering", async () => {
    h.row!.outcome = "sent";
    expect(await redeliverHeld("L1")).toEqual({ status: "not_held", outcome: "sent" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("not_found, blocked by rule errors, and a lost claim never send", async () => {
    const held = h.row;
    h.row = null;
    expect(await redeliverHeld("L1")).toEqual({ status: "not_found" });
    h.row = held;
    h.issues = [{ field: "f", level: "error", message: "m" }];
    expect(await redeliverHeld("L1")).toMatchObject({ status: "blocked" });
    h.issues = [];
    h.claim.mockResolvedValue(false);
    expect(await redeliverHeld("L1")).toEqual({ status: "claim_lost" });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("a failure before the email goes out puts the lead back to held", async () => {
    h.deliver.mockRejectedValue(new Error("Blob down"));
    await expect(redeliverHeld("L1")).rejects.toThrow("Blob down");
    expect(h.update).toHaveBeenCalledWith("L1", { outcome: "held" });
  });

  it("never reverts after the email went out", async () => {
    h.deliver.mockRejectedValue(new DeliveredNotRecordedError("L1", "delivered but not recorded"));
    await expect(redeliverHeld("L1")).rejects.toBeInstanceOf(DeliveredNotRecordedError);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("--force skips the held check and the claim, and never reverts", async () => {
    h.row!.outcome = "sent";
    h.deliver.mockRejectedValue(new Error("x"));
    await expect(redeliverHeld("L1", { force: true })).rejects.toThrow("x");
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("the admin path: claimForRedeliver then deliverClaimed", () => {
  it("claims a held lead up front; a lead that isn't held or was claimed first is refused", async () => {
    const claimed = await claimForRedeliver("L1");
    expect(claimed).toMatchObject({ status: "claimed", row: { id: "L1" } });
    expect(h.claim).toHaveBeenCalledWith("L1", ["held"]);
    h.claim.mockResolvedValue(false);
    expect(await claimForRedeliver("L1")).toEqual({ status: "claim_lost" });
    h.row!.outcome = "sent";
    h.claim.mockClear();
    expect(await claimForRedeliver("L1")).toEqual({ status: "not_held", outcome: "sent" });
    expect(h.claim).not.toHaveBeenCalled();
    h.row = null;
    expect(await claimForRedeliver("L1")).toEqual({ status: "not_found" });
  });

  it("delivers a claimed row without claiming again", async () => {
    const row = { ...h.row!, outcome: "processing" } as never;
    expect(await deliverClaimed(row)).toEqual({ status: "sent", issues: [] });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("puts a claimed row back to held when the rules block it, or anything fails before the email goes out", async () => {
    const row = { ...h.row!, outcome: "processing" } as never;
    h.issues = [{ field: "f", level: "error", message: "m" }];
    expect(await deliverClaimed(row)).toMatchObject({ status: "blocked" });
    expect(h.update).toHaveBeenLastCalledWith("L1", { outcome: "held" });
    expect(h.deliver).not.toHaveBeenCalled();

    h.issues = [];
    h.update.mockClear();
    await expect(deliverClaimed({ ...(row as object), content: null } as never)).rejects.toThrow(/no stored content/);
    expect(h.update).toHaveBeenLastCalledWith("L1", { outcome: "held" });

    h.update.mockClear();
    h.deliver.mockRejectedValue(new Error("Resend and MailerLite down"));
    await expect(deliverClaimed(row)).rejects.toThrow("down");
    expect(h.update).toHaveBeenLastCalledWith("L1", { outcome: "held" });
  });

  it("never puts it back once the email went out", async () => {
    h.deliver.mockRejectedValue(new DeliveredNotRecordedError("L1", "delivered but not recorded"));
    await expect(deliverClaimed({ ...h.row!, outcome: "processing" } as never)).rejects.toBeInstanceOf(DeliveredNotRecordedError);
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("never-received group after a held report is sent", () => {
  let calls: { url: string; method: string }[] = [];
  let status = { get: 200, del: 204 };
  beforeEach(() => {
    calls = [];
    status = { get: 200, del: 204 };
    vi.stubEnv("MAILERLITE_API_KEY", "ml_test");
    vi.stubEnv("MAILERLITE_HF_NEVER_RECEIVED_GROUP_ID", "group-never");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method });
      if (method === "DELETE") return new Response(null, { status: status.del });
      return new Response(JSON.stringify({ data: { id: "sub-9" } }), { status: status.get });
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const deleted = () => calls.filter((c) => c.method === "DELETE");

  it("removes the person from the group once the report is delivered", async () => {
    await redeliverHeld("L1");
    expect(calls[0]).toEqual({ url: "https://connect.mailerlite.com/api/subscribers/jane%40x.com", method: "GET" });
    expect(deleted()).toEqual([{ url: "https://connect.mailerlite.com/api/subscribers/sub-9/groups/group-never", method: "DELETE" }]);
  });

  it("the admin path removes them too", async () => {
    const c = await claimForRedeliver("L1");
    if (c.status !== "claimed") throw new Error("not claimed");
    await deliverClaimed(c.row);
    expect(deleted()).toHaveLength(1);
  });

  it("does not remove them when delivery fails before the email goes out", async () => {
    h.deliver.mockRejectedValue(new Error("blob down"));
    await expect(redeliverHeld("L1")).rejects.toThrow("blob down");
    expect(calls).toHaveLength(0);
  });

  it("removes them when the email went out but recording failed", async () => {
    h.deliver.mockRejectedValue(new DeliveredNotRecordedError("L1", "x"));
    await expect(redeliverHeld("L1")).rejects.toThrow();
    expect(deleted()).toHaveLength(1);
  });

  it("a 404 (not a subscriber, or not in the group) and a 500 are both ignored", async () => {
    status = { get: 404, del: 204 };
    await expect(redeliverHeld("L1")).resolves.toMatchObject({ status: "sent" });
    expect(deleted()).toHaveLength(0);
    h.row!.outcome = "held";
    status = { get: 200, del: 404 };
    await expect(redeliverHeld("L1")).resolves.toMatchObject({ status: "sent" });
    status = { get: 500, del: 500 };
    await expect(redeliverHeld("L1")).resolves.toMatchObject({ status: "sent" });
  });

  it("unset env: no MailerLite call", async () => {
    vi.stubEnv("MAILERLITE_HF_NEVER_RECEIVED_GROUP_ID", "");
    await redeliverHeld("L1");
    expect(calls).toHaveLength(0);
  });
});
