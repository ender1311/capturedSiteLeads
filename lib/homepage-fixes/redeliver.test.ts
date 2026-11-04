import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { redeliverHeld } from "./redeliver";

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
