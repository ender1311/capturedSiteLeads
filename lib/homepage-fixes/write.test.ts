import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { SYSTEM_PROMPT, userMessage } from "./prompt";
import { addUsage, costOf, lookCheck, repairFields, writeReport, WrittenIncompleteError } from "./write";
import type { Facts } from "./facts";
import type { ReportContent } from "./types";

const MODEL = "google/gemini-3.8-flash";

const facts: Facts = {
  flags: [],
  sheet: "First screen button: none\nTestimonials: none",
  trimmedText: "Hi I'm Jane. I photograph families.",
  pageText: "Hi I'm Jane. I photograph families.",
  mockup: {
    nav_position: "top", nav_style: "bar", nav_items: ["Home", "Contact"],
    heading_font: "Lora", body_font: "Lato", uppercase_headline: false,
  },
};

const gabby = JSON.parse(
  fs.readFileSync(path.join(__dirname, "skill/examples/gabby/content.json"), "utf8"),
) as ReportContent;

const reportJson = {
  fit: "report",
  photo_choice: 1,
  photo_focus: "50% 35%",
  alt_photo_focus: "50% 20%",
  layout: "left",
  alt_layout: "box",
  eyebrow: "",
  headline: "Your Friend With the Camera",
  subline: "Family photographer in Austin",
  button: "Reach Out",
  first_section_changes: ["one", "two", "three"],
  fixes: [
    { title: "A", noticed: "n", why: "w", changes: ["1", "2", "3"] },
    { title: "B", noticed: "n", why: "w", changes: ["1", "2", "3"] },
  ],
  notes_for_maggie: "notes",
};

type MockOpts = { json: unknown; input?: number; output?: number; providerMetadata?: Record<string, Record<string, unknown>> };
function mock({ json, input = 100, output = 50, providerMetadata }: MockOpts) {
  return new MockLanguageModelV3({
    provider: "gateway",
    modelId: MODEL,
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: output, text: output, reasoning: undefined },
      },
      providerMetadata: providerMetadata as never,
      warnings: [],
    }),
  });
}

type Step = { text: string; finish?: "stop" | "length"; input?: number; output?: number };
function mockSeq(steps: Step[]) {
  let i = 0;
  return new MockLanguageModelV3({
    provider: "gateway",
    modelId: MODEL,
    doGenerate: async () => {
      const st = steps[Math.min(i++, steps.length - 1)];
      const input = st.input ?? 100, output = st.output ?? 50;
      return {
        content: [{ type: "text", text: st.text }],
        finishReason: { unified: st.finish ?? "stop", raw: undefined },
        usage: {
          inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: output, text: output, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}
const thinking = (m: MockLanguageModelV3, n: number) =>
  (m.doGenerateCalls[n].providerOptions?.google as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel;

const promptText = (m: MockLanguageModelV3) => JSON.stringify(m.doGenerateCalls[0].prompt);

describe("SYSTEM_PROMPT", () => {
  it("carries every hard rule", () => {
    for (const w of ["dash", "the visitor", "they/their", "homepage only", "Captured Sites", "never invent", "pricing", "email list"]) {
      expect(w === "Captured Sites" ? SYSTEM_PROMPT : SYSTEM_PROMPT.toLowerCase(), w).toContain(w);
    }
    for (const w of ["audit", "conversion", "funnel", "optimize", "leverage", "elevate", "seamless", "curated",
      "aligned", "authentic", "autopilot", "unlock", "synergy", "delve", "robust", "crucial"]) {
      expect(SYSTEM_PROMPT, w).toContain(w);
    }
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(7500);
    expect(SYSTEM_PROMPT).toContain(gabby.first_section.headline);
    // Gabby is the single example: her first fix title appears once.
    expect(SYSTEM_PROMPT.split(gabby.fixes[0].title).length - 1).toBe(1);
    expect(SYSTEM_PROMPT).toContain('"Your headline already does this, so I kept it."');
    expect(SYSTEM_PROMPT).toContain('Rejected: "Give couples an easy-to-read page" (a fix)');
  });

  it("tells the model unknown facts are unknown, not absent", () => {
    expect(SYSTEM_PROMPT).toContain("could not be checked");
    expect(SYSTEM_PROMPT).toContain("may be images only");
    expect(SYSTEM_PROMPT).toContain("Capture note");
  });
});

describe("userMessage", () => {
  const base = { firstName: "Jane", website: "janedoe.com", facts, photoCount: 3 };

  it("defaults an empty goal", () => {
    expect(userMessage({ ...base, goal: "" })).toContain("Goal: not given. Diagnose toward more of the right inquiries.");
    expect(userMessage({ ...base, goal: "   " })).toContain("Goal: not given. Diagnose toward more of the right inquiries.");
  });

  it("keeps a one-word goal verbatim", () => {
    const m = userMessage({ ...base, goal: "bookings" });
    expect(m).toContain("Goal: bookings\n");
    expect(m).not.toContain("not given");
  });

  it("lists name, website, fact sheet, trimmed text and the image layout", () => {
    const m = userMessage({ ...base, goal: "bookings" });
    expect(m).toContain("Jane");
    expect(m).toContain("janedoe.com");
    expect(m).toContain(facts.sheet);
    expect(m).toContain(facts.trimmedText);
    expect(m).toContain("left = their first screen today; right = photo candidates 1 to 3");
  });

  it("names the real number of photo candidates", () => {
    expect(userMessage({ ...base, goal: "", photoCount: 2 })).toContain("right = photo candidates 1 to 2.");
    expect(userMessage({ ...base, goal: "", photoCount: 1 })).toContain("right = photo candidate 1.");
  });
});

describe("writeReport", () => {
  const input = { firstName: "Jane", website: "janedoe.com", goal: "bookings", facts, photoCount: 3, contactSheet: Buffer.from([0xff, 0xd8, 0xff]) };

  it("sends one image part with low media resolution and the low thinking option", async () => {
    const m = mock({ json: reportJson });
    await writeReport({ ...input, model: m });
    const call = m.doGenerateCalls[0];
    const parts = call.prompt.flatMap((msg) => (Array.isArray(msg.content) ? (msg.content as { type: string; mediaType?: string }[]) : []));
    const files = parts.filter((p) => p.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0].mediaType).toBe("image/jpeg");
    const google = call.providerOptions?.google as { mediaResolution: string; thinkingConfig: { thinkingLevel: string } };
    expect(google.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(google.thinkingConfig.thinkingLevel).toBe("low");
    expect(call.maxOutputTokens).toBe(2000);
    expect(call.temperature).toBeUndefined();
    expect(promptText(m)).toContain("Goal: bookings");
  });

  it("parses the report shape", async () => {
    const { written } = await writeReport({ ...input, model: mock({ json: reportJson }) });
    expect(written.fit).toBe("report");
    if (written.fit === "report") {
      expect(written.photo_choice).toBe(1);
      expect(written.fixes).toHaveLength(2);
      expect(written.first_section_changes).toHaveLength(3);
    }
  });

  it("parses the hobby shape", async () => {
    const { written } = await writeReport({ ...input, model: mock({ json: { fit: "hobby", compliment: "Lovely colors." } }) });
    expect(written).toEqual({ fit: "hobby", compliment: "Lovely colors." });
  });

  it("computes cost from usage", async () => {
    const { usage } = await writeReport({ ...input, model: mock({ json: reportJson, input: 5000, output: 1400 }) });
    expect(usage.inputTokens).toBe(5000);
    expect(usage.outputTokens).toBe(1400);
    expect(usage.calls).toBe(1);
    expect(Math.abs(usage.costUsd - 0.009)).toBeLessThan(1e-6);
  });

  it("sends one flat object schema, not a root anyOf", async () => {
    const m = mock({ json: reportJson });
    await writeReport({ ...input, model: m });
    const fmt = m.doGenerateCalls[0].responseFormat as { type: string; schema: Record<string, unknown> };
    expect(fmt.schema.type).toBe("object");
    expect(fmt.schema.anyOf).toBeUndefined();
    expect(fmt.schema.oneOf).toBeUndefined();
    expect(fmt.schema.required).toEqual(["fit"]);
  });

  for (const n of [1, 2]) {
    it(`caps photo_choice at photoCount=${n}`, async () => {
      const m = mock({ json: { ...reportJson, photo_choice: n } });
      const { written } = await writeReport({ ...input, photoCount: n, model: m });
      const fmt = m.doGenerateCalls[0].responseFormat as unknown as { schema: { properties: { photo_choice: { maximum: number } } } };
      expect(fmt.schema.properties.photo_choice.maximum).toBe(n);
      expect(promptText(m)).toContain(n === 1 ? "photo candidate 1." : "photo candidates 1 to 2.");
      if (written.fit === "report") expect(written.photo_choice).toBe(n);
    });
  }

  it("rejects photo_choice above photoCount", async () => {
    const m = mock({ json: { ...reportJson, photo_choice: 3 } });
    await expect(writeReport({ ...input, photoCount: 2, model: m })).rejects.toThrow();
    expect(m.doGenerateCalls).toHaveLength(2); // retried once
  });

  it("retries once with minimal thinking after a truncated answer and sums usage", async () => {
    const m = mockSeq([
      { text: '{"fit":"report","headline":"Your Fri', finish: "length", input: 5000, output: 2000 },
      { text: JSON.stringify(reportJson), input: 5000, output: 1200 },
    ]);
    const { written, usage } = await writeReport({ ...input, model: m });
    expect(written.fit).toBe("report");
    expect(m.doGenerateCalls).toHaveLength(2);
    expect(thinking(m, 0)).toBe("low");
    expect(thinking(m, 1)).toBe("minimal");
    expect(m.doGenerateCalls[1].maxOutputTokens).toBe(2000);
    expect(usage).toEqual({ inputTokens: 10000, outputTokens: 3200, calls: 2, costUsd: expect.closeTo(costOf({ inputTokens: 10000, outputTokens: 3200 }, MODEL), 9) });
  });

  it("retries once when a report is missing fields", async () => {
    const { headline: _h, fixes: _f, ...partial } = reportJson;
    void _h; void _f;
    const m = mockSeq([{ text: JSON.stringify(partial) }, { text: JSON.stringify(reportJson) }]);
    const { written, usage } = await writeReport({ ...input, model: m });
    expect(written.fit).toBe("report");
    expect(usage.calls).toBe(2);
    expect(thinking(m, 1)).toBe("minimal");
  });

  it("throws the typed missing-fields error when the retry is incomplete too", async () => {
    const m = mockSeq([{ text: JSON.stringify({ fit: "report", headline: "H" }) }]);
    const err = await writeReport({ ...input, model: m }).catch((e) => e);
    expect(err).toBeInstanceOf(WrittenIncompleteError);
    expect((err as WrittenIncompleteError).missing).toContain("fixes");
    expect((err as WrittenIncompleteError).missing).not.toContain("headline");
    expect(m.doGenerateCalls).toHaveLength(2);
  });

  it("treats a hobby answer without a compliment as incomplete", async () => {
    const m = mockSeq([{ text: '{"fit":"hobby"}' }, { text: '{"fit":"hobby","compliment":"Lovely colors."}' }]);
    const { written } = await writeReport({ ...input, model: m });
    expect(written).toEqual({ fit: "hobby", compliment: "Lovely colors." });
  });

  it("does not retry on other errors", async () => {
    const m = new MockLanguageModelV3({ modelId: MODEL, doGenerate: async () => { throw new Error("gateway down"); } });
    await expect(writeReport({ ...input, model: m })).rejects.toThrow("gateway down");
  });

  it("prefers the gateway's reported cost", async () => {
    const m = mock({ json: reportJson, input: 5000, output: 1400, providerMetadata: { gateway: { cost: "0.0081" } } });
    const { usage } = await writeReport({ ...input, model: m });
    expect(usage.costUsd).toBeCloseTo(0.0081, 8);
  });
});

describe("repairFields", () => {
  it("sends only failing fields and merges the fix back", async () => {
    const m = mock({ json: { fields: [{ field: "fixes[1].title", text: "Let your story shine" }] } });
    const { content, usage } = await repairFields({
      content: gabby,
      issues: [{ field: "fixes[1].title", level: "error", message: "is 70 characters (limit 52, it has to fit the page)." }],
      model: m,
    });
    const p = promptText(m);
    expect(p).toContain("fixes[1].title");
    expect(p).toContain(gabby.fixes[0].title);
    expect(p).not.toContain("first_section_changes");
    expect(p).not.toContain(gabby.fixes[1].title);
    expect(content.fixes[0].title).toBe("Let your story shine");
    expect(content.fixes[1]).toEqual(gabby.fixes[1]);
    expect(content.first_section_changes).toEqual(gabby.first_section_changes);
    expect(gabby.fixes[0].title).toBe("Let your story show what sets you apart"); // input not mutated
    expect(usage.calls).toBe(1);
    expect(thinking(m, 0)).toBe("minimal");
    expect(m.doGenerateCalls[0].maxOutputTokens).toBe(1500);
    expect(m.doGenerateCalls[0].temperature).toBeUndefined();
    expect(p).toContain('Keep any exact quote from their site unchanged, even if it contains \\"her\\", \\"!\\" or a price.');
  });

  it("sends only error-level issues", async () => {
    const m = mock({ json: { fields: [] } });
    const { content, usage } = await repairFields({
      content: gabby,
      issues: [
        { field: "fixes[2].noticed", level: "warning", message: "has an exclamation point" },
        { field: "fixes[1].why", level: "error", message: "uses a banned word" },
      ],
      model: m,
    });
    const p = promptText(m);
    expect(p).toContain("fixes[1].why");
    expect(p).not.toContain("fixes[2].noticed");
    expect(content).toEqual(gabby);
    expect(usage.calls).toBe(1);
  });

  it("makes no call for warnings only", async () => {
    const m = mock({ json: { fields: [] } });
    await repairFields({ content: gabby, issues: [{ field: "fixes[2].noticed", level: "warning", message: "x" }], model: m });
    expect(m.doGenerateCalls).toHaveLength(0);
  });

  it("merges every label shape and ignores fields it did not ask for", async () => {
    const m = mock({
      json: {
        fields: [
          { field: "first_section.headline", text: "H" },
          { field: "first_section_changes[2]", text: "C2" },
          { field: "fixes[2].changes[3]", text: "F2C3" },
          { field: "fixes[1].why", text: "not asked" },
        ],
      },
    });
    const { content } = await repairFields({
      content: gabby,
      issues: [
        { field: "first_section.headline", level: "error", message: "x" },
        { field: "first_section_changes[2]", level: "error", message: "x" },
        { field: "fixes[2].changes[3]", level: "error", message: "x" },
      ],
      model: m,
    });
    expect(content.first_section.headline).toBe("H");
    expect(content.first_section_changes[1]).toBe("C2");
    expect(content.fixes[1].changes[2]).toBe("F2C3");
    expect(content.fixes[0].why).toBe(gabby.fixes[0].why);
  });

  it("makes no call when there are no issues", async () => {
    const m = mock({ json: { fields: [] } });
    const { content, usage } = await repairFields({ content: gabby, issues: [], model: m });
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(content).toEqual(gabby);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
  });
});

describe("lookCheck", () => {
  const img = Buffer.from([0xff, 0xd8, 0xff]);
  const cases: [boolean, boolean, boolean, boolean][] = [
    [true, true, false, true],
    [false, true, false, false],
    [true, false, false, false],
    [true, true, true, false],
  ];
  for (const [faces_ok, headline_readable, looks_like_template, ok] of cases) {
    it(`ok=${ok} for faces=${faces_ok} readable=${headline_readable} template=${looks_like_template}`, async () => {
      const m = mock({ json: { faces_ok, headline_readable, looks_like_template } });
      const r = await lookCheck(img, m);
      expect(r.ok).toBe(ok);
      expect(r).toMatchObject({ faces_ok, headline_readable, looks_like_template });
      expect(m.doGenerateCalls[0].maxOutputTokens).toBe(1000);
      expect(thinking(m, 0)).toBe("minimal");
    });
  }
});

describe("cost helpers", () => {
  it("prices gemini 3.8 flash", () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, MODEL)).toBeCloseTo(4.5, 9);
  });
  it("adds usage", () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0.1, calls: 1 }, { inputTokens: 3, outputTokens: 4, costUsd: 0.2, calls: 2 }))
      .toEqual({ inputTokens: 4, outputTokens: 6, costUsd: expect.closeTo(0.3, 9), calls: 3 });
  });
});
