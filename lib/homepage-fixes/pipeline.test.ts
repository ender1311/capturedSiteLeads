import { describe, expect, it, vi } from "vitest";
import { CaptureError } from "./capture";
import { runHomepageFixes, type Stages } from "./pipeline";
import type { RuleIssue } from "./rules";
import type { Capture, FirstSection, PageData, ReportContent, Usage } from "./types";
import type { Written } from "./write";

// Every stage is a fake: no Firecrawl, Gemini or Chromium. buildFacts, autoFix, checkContent and
// fillReport run for real.

const LONG = "I love photographing families and couples across the city. ".repeat(6);

function page(over: Partial<PageData> = {}): PageData {
  return {
    title: "Jane Doe Photography", finalUrl: "https://janedoe.com/", pageHeight: 4000, metaDesc: "",
    rows: [{ y: 1200, x: 100, tag: "p", fs: 16, fw: "400", ff: "Lato", tt: "none", text: LONG }],
    imgs: [
      { src: "https://janedoe.com/a.jpg", w: 1440, h: 800, y: 0, alt: "", kind: "img" },
      { src: "https://janedoe.com/b.jpg", w: 1200, h: 800, y: 1500, alt: "", kind: "img" },
    ],
    nav: ["Home", "About", "Contact"], navTop: true, navOverPhoto: false, navBg: "rgb(255, 255, 255)", navColor: "rgb(34, 34, 34)",
    logo: null, fonts: { heading: "Lora", headingWeight: "400", body: "Lato" },
    uppercaseHeadings: false, accent: null, buttons: [], textLength: 400, sample: `Hello there\n${LONG}`,
    dismissed: [], frame: true, screenH: 900, ...over,
  };
}

const PHOTO1 = Buffer.from("photo-one");
const PHOTO2 = Buffer.from("photo-two");
const uri = (b: Buffer, mime: string) => `data:${mime};base64,${b.toString("base64")}`;

function capture(over: Partial<PageData> = {}, photos = 2, logo = false): Capture {
  const p = page(over);
  return {
    url: p.finalUrl, page: p, before: { data: Buffer.from("before-png"), mime: "image/png" },
    photos: [
      { data: PHOTO1, mime: "image/jpeg", candidate: p.imgs[0], firstScreen: true },
      { data: PHOTO2, mime: "image/webp", candidate: p.imgs[1], firstScreen: false },
    ].slice(0, photos),
    logo: logo ? { data: Buffer.from("logo"), mime: "image/png" } : null,
    linkStatus: {}, capturedAt: "2026-11-03T00:00:00.000Z",
  };
}

const usage = (inputTokens: number, outputTokens: number, costUsd: number): Usage => ({ inputTokens, outputTokens, costUsd, calls: 1 });

const REPORT: Extract<Written, { fit: "report" }> = {
  fit: "report", photo_choice: 1, photo_focus: "50% 35%", alt_photo_focus: "50% 20%", layout: "left", alt_layout: "center",
  eyebrow: "", headline: "Photos That Feel Like Home", subline: "Family and couples photographer in the city", button: "Reach Out",
  first_section_changes: [
    "Your headline now comes from your own intro, so the visitor hears your voice first.",
    "What you shoot and where now sits right under the headline.",
    "One clear button now takes the visitor to your inquiry form.",
  ],
  fixes: [
    {
      title: "Let your story lead", noticed: "Your intro is warm and easy to like.", why: "People book the person as much as the photos.",
      changes: ["Move your intro higher.", "Add a photo of you.", "End it with a button to reach out."],
    },
    {
      title: "Guide the visitor to reach out", noticed: "Your reviews sit far down the page.", why: "Proof helps right where people decide.",
      changes: ["Add a button after your reviews.", "Show three simple steps.", "Keep one inquiry button wording."],
    },
  ],
  notes_for_maggie: "Headline built from the intro.",
};

type Calls = { renderAfter: { s: FirstSection; photo: string; logo?: string }[] };

function fakes(over: Partial<Stages> = {}, cap = capture()): { stages: Partial<Stages>; calls: Calls; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const calls: Calls = { renderAfter: [] };
  const spies = {
    capture: vi.fn(async () => cap),
    write: vi.fn(async () => ({ written: structuredClone(REPORT) as Written, usage: usage(3000, 700, 0.005) })),
    repair: vi.fn(async ({ content }: { content: ReportContent; issues: RuleIssue[] }) => ({ content, usage: usage(400, 100, 0.0007) })),
    look: vi.fn(async () => ({ ok: true, faces_ok: true, headline_readable: true, looks_like_template: false, usage: usage(350, 40, 0.0004) })),
    renderAfter: vi.fn(async (s: FirstSection, photo: string, logo?: string) => {
      calls.renderAfter.push({ s: structuredClone(s), photo, logo });
      return Buffer.from(`after-${calls.renderAfter.length}`);
    }),
    renderPdf: vi.fn(async () => ({ pdf: Buffer.from("%PDF"), overflow: [] as { page: number; hits: string[] }[] })),
    renderContactSheet: vi.fn(async () => Buffer.from("contact")),
  };
  return { stages: { ...(spies as unknown as Stages), ...over }, calls, spies };
}

const INPUT = { firstName: "Jane", website: "janedoe.com", goal: "More inquiries from couples" };

describe("runHomepageFixes", () => {
  it("fit flag stops before Gemini", async () => {
    const { stages, spies } = fakes({}, capture({ textLength: 120 }));
    const r = await runHomepageFixes(INPUT, stages);
    expect(r).toMatchObject({ outcome: "cant_see", reason: "TOO_LITTLE_TEXT", usage: { calls: 0, costUsd: 0 } });
    expect(spies.write).not.toHaveBeenCalled();
    expect(spies.renderContactSheet).not.toHaveBeenCalled();
  });

  it("no downloaded photo is NO_PHOTO", async () => {
    const { stages, spies } = fakes({}, capture({}, 0));
    const r = await runHomepageFixes(INPUT, stages);
    expect(r).toMatchObject({ outcome: "cant_see", reason: "NO_PHOTO" });
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("CaptureError bot_check → cant_see", async () => {
    const { stages, spies } = fakes({ capture: vi.fn(async () => { throw new CaptureError("bot_check", "bot check"); }) });
    const r = await runHomepageFixes(INPUT, stages);
    expect(r).toMatchObject({ outcome: "cant_see", reason: "bot_check" });
    expect(spies.write).not.toHaveBeenCalled();
  });

  it("other capture errors are thrown for the retry", async () => {
    const { stages } = fakes({ capture: vi.fn(async () => { throw new Error("socket hang up"); }) });
    await expect(runHomepageFixes(INPUT, stages)).rejects.toThrow("socket hang up");
  });

  it("a given capture skips Firecrawl", async () => {
    const { stages, spies } = fakes();
    const r = await runHomepageFixes({ ...INPUT, capture: capture() }, stages);
    expect(r.outcome).toBe("sent");
    expect(spies.capture).not.toHaveBeenCalled();
  });

  it("hobby returns compliment, no render", async () => {
    const { stages, spies } = fakes({ write: vi.fn(async () => ({ written: { fit: "hobby", compliment: "Your colors are lovely." } as Written, usage: usage(3000, 100, 0.003) })) });
    const r = await runHomepageFixes(INPUT, stages);
    expect(r).toMatchObject({ outcome: "hobby", compliment: "Your colors are lovely.", usage: { calls: 1 }, model: "google/gemini-3.8-flash" });
    expect(spies.renderAfter).not.toHaveBeenCalled();
    expect(spies.renderPdf).not.toHaveBeenCalled();
  });

  it("passes the model, photo count and contact sheet to write", async () => {
    const { stages, spies } = fakes();
    await runHomepageFixes({ ...INPUT, model: "google/gemini-3.5-flash-lite" }, stages);
    expect(spies.renderContactSheet).toHaveBeenCalledWith(uri(Buffer.from("before-png"), "image/png"), [uri(PHOTO1, "image/jpeg"), uri(PHOTO2, "image/webp")]);
    expect(spies.write).toHaveBeenCalledWith(expect.objectContaining({
      firstName: "Jane", website: "janedoe.com", goal: "More inquiries from couples", photoCount: 2,
      contactSheet: Buffer.from("contact"), model: "google/gemini-3.5-flash-lite",
    }));
    expect(spies.look).toHaveBeenCalledWith(expect.any(Buffer), "google/gemini-3.5-flash-lite");
  });

  it("ReportContent assembly: script mockup + written fields + chosen photo", async () => {
    const written = { ...structuredClone(REPORT), photo_choice: 2 as const, eyebrow: "" };
    const { stages, calls } = fakes({ write: vi.fn(async () => ({ written: written as Written, usage: usage(1, 1, 0) })) }, capture({}, 2, true));
    const r = await runHomepageFixes(INPUT, stages);
    if (r.outcome !== "sent") throw new Error(`expected sent, got ${r.outcome}`);
    const fs = r.content.first_section;
    expect(fs).toMatchObject({
      photo: "photos/photo-02.webp", photo_focus: "50% 35%", layout: "left",
      headline: REPORT.headline, subline: REPORT.subline, button: "Reach Out",
      nav_items: ["Home", "About", "Contact"], nav_position: "top", nav_style: "bar", logo_image: "logo.png",
    });
    expect(fs).not.toHaveProperty("eyebrow");
    expect(r.content).toMatchObject({ first_name: "Jane", website: "janedoe.com", goal: "More inquiries from couples" });
    expect(r.content.first_section_changes).toEqual(REPORT.first_section_changes);
    expect(r.content.fixes).toEqual(REPORT.fixes);
    expect(calls.renderAfter[0].photo).toBe(uri(PHOTO2, "image/webp"));
    expect(calls.renderAfter[0].logo).toBe(uri(Buffer.from("logo"), "image/png"));
    expect(r.after).toEqual(Buffer.from("after-1"));
    expect(r.before).toEqual(Buffer.from("before-png"));
    expect(r.pdf).toEqual(Buffer.from("%PDF"));
  });

  it("the PDF gets the before and after images as data URIs", async () => {
    const { stages, spies } = fakes();
    await runHomepageFixes(INPUT, stages);
    const html = spies.renderPdf.mock.calls[0][0] as string;
    expect(html).toContain(uri(Buffer.from("before-png"), "image/png"));
    expect(html).toContain(uri(Buffer.from("after-1"), "image/jpeg"));
    expect(html).not.toContain("{{");
  });

  it("rule errors trigger exactly one repair; still failing → held", async () => {
    const bad = { ...structuredClone(REPORT), headline: "Elevate Your Story" };
    const { stages, spies } = fakes({ write: vi.fn(async () => ({ written: bad as Written, usage: usage(1, 1, 0) })) });
    const r = await runHomepageFixes(INPUT, stages);
    expect(spies.repair).toHaveBeenCalledTimes(1);
    const arg = spies.repair.mock.calls[0][0] as { issues: RuleIssue[]; model: string };
    expect(arg.issues.some((i) => i.field === "first_section.headline" && i.level === "error")).toBe(true);
    expect(arg.model).toBe("google/gemini-3.8-flash");
    expect(r.outcome).toBe("held");
    if (r.outcome !== "held") return;
    expect(r.reason).toMatch(/rule/i);
    expect(r.issues.some((i) => i.field === "first_section.headline" && i.level === "error")).toBe(true);
    expect(spies.renderAfter).not.toHaveBeenCalled();
  });

  it("a repair that fixes the errors goes on to send", async () => {
    const bad = { ...structuredClone(REPORT), headline: "Elevate Your Story" };
    const repair = vi.fn(async ({ content }: { content: ReportContent }) => {
      const c = structuredClone(content);
      c.first_section.headline = "Your Story, Told Warmly";
      return { content: c, usage: usage(1, 1, 0) };
    });
    const { stages, calls } = fakes({ write: vi.fn(async () => ({ written: bad as Written, usage: usage(1, 1, 0) })), repair });
    const r = await runHomepageFixes(INPUT, stages);
    expect(r.outcome).toBe("sent");
    expect(calls.renderAfter[0].s.headline).toBe("Your Story, Told Warmly");
  });

  it("auto-fixes dashes without a repair call, and warnings never block", async () => {
    const w = { ...structuredClone(REPORT), subline: "Family photographer — in the city!" };
    const { stages, spies } = fakes({ write: vi.fn(async () => ({ written: w as Written, usage: usage(1, 1, 0) })) });
    const r = await runHomepageFixes(INPUT, stages);
    expect(spies.repair).not.toHaveBeenCalled();
    expect(r.outcome).toBe("sent");
    if (r.outcome === "sent") expect(r.content.first_section.subline).toBe("Family photographer, in the city!");
  });

  it("look check failure re-renders with alt settings, then next photo, then held", async () => {
    const look = vi.fn(async () => ({ ok: false, faces_ok: false, headline_readable: true, looks_like_template: false, usage: usage(1, 1, 0) }));
    const { stages, calls, spies } = fakes({ look });
    const r = await runHomepageFixes(INPUT, stages);
    expect(calls.renderAfter).toHaveLength(3);
    expect(look).toHaveBeenCalledTimes(3);
    expect(calls.renderAfter[0].s).toMatchObject({ layout: "left", photo_focus: "50% 35%", photo: "photos/photo-01.jpg" });
    expect(calls.renderAfter[0].photo).toBe(uri(PHOTO1, "image/jpeg"));
    expect(calls.renderAfter[1].s).toMatchObject({ layout: "center", photo_focus: "50% 20%", photo: "photos/photo-01.jpg" });
    expect(calls.renderAfter[2].s).toMatchObject({ photo_focus: "50% 40%", photo: "photos/photo-02.webp" });
    expect(calls.renderAfter[2].photo).toBe(uri(PHOTO2, "image/webp"));
    expect(r.outcome).toBe("held");
    if (r.outcome === "held") expect(r.reason).toMatch(/look check/i);
    expect(spies.renderPdf).not.toHaveBeenCalled();
  });

  it("look check passing on the alt settings keeps them", async () => {
    const look = vi.fn()
      .mockResolvedValueOnce({ ok: false, faces_ok: true, headline_readable: false, looks_like_template: false, usage: usage(1, 1, 0) })
      .mockResolvedValueOnce({ ok: true, faces_ok: true, headline_readable: true, looks_like_template: false, usage: usage(1, 1, 0) });
    const { stages, calls } = fakes({ look });
    const r = await runHomepageFixes(INPUT, stages);
    expect(calls.renderAfter).toHaveLength(2);
    expect(r.outcome).toBe("sent");
    if (r.outcome === "sent") {
      expect(r.content.first_section).toMatchObject({ layout: "center", photo_focus: "50% 20%" });
      expect(r.after).toEqual(Buffer.from("after-2"));
    }
  });

  it("look check with only one photo stops after the alt settings", async () => {
    const look = vi.fn(async () => ({ ok: false, faces_ok: false, headline_readable: true, looks_like_template: false, usage: usage(1, 1, 0) }));
    const { stages, calls } = fakes({ look }, capture({}, 1));
    const r = await runHomepageFixes(INPUT, stages);
    expect(calls.renderAfter).toHaveLength(2);
    expect(r.outcome).toBe("held");
  });

  it("overflow triggers one repair asking to shorten the overflowing field, then held if still overflowing", async () => {
    const hit = REPORT.fixes[0].noticed.slice(0, 60);
    const renderPdf = vi.fn(async () => ({ pdf: Buffer.from("%PDF"), overflow: [{ page: 5, hits: [hit] }] }));
    const { stages, spies } = fakes({ renderPdf });
    const r = await runHomepageFixes(INPUT, stages);
    expect(spies.repair).toHaveBeenCalledTimes(1);
    const arg = spies.repair.mock.calls[0][0] as { issues: RuleIssue[] };
    expect(arg.issues).toHaveLength(1);
    expect(arg.issues[0]).toMatchObject({ field: "fixes[1].noticed", level: "error" });
    expect(arg.issues[0].message).toMatch(/shorten/i);
    expect(renderPdf).toHaveBeenCalledTimes(2);
    expect(r.outcome).toBe("held");
    if (r.outcome === "held") expect(r.reason).toMatch(/overflow/i);
  });

  it("overflow fixed by the repair is sent", async () => {
    const renderPdf = vi.fn()
      .mockResolvedValueOnce({ pdf: Buffer.from("%PDF-1"), overflow: [{ page: 4, hits: [REPORT.first_section_changes[1].toUpperCase()] }] })
      .mockResolvedValueOnce({ pdf: Buffer.from("%PDF-2"), overflow: [] });
    const { stages, spies } = fakes({ renderPdf });
    const r = await runHomepageFixes(INPUT, stages);
    expect((spies.repair.mock.calls[0][0] as { issues: RuleIssue[] }).issues[0].field).toBe("first_section_changes[2]");
    expect(r.outcome).toBe("sent");
    if (r.outcome === "sent") expect(r.pdf).toEqual(Buffer.from("%PDF-2"));
  });

  it("overflow on fixed template text is held without a repair", async () => {
    const renderPdf = vi.fn(async () => ({ pdf: Buffer.from("%PDF"), overflow: [{ page: 2, hits: ["IMG"] }] }));
    const { stages, spies } = fakes({ renderPdf });
    const r = await runHomepageFixes(INPUT, stages);
    expect(spies.repair).not.toHaveBeenCalled();
    expect(r.outcome).toBe("held");
  });

  it("usage sums all calls", async () => {
    const bad = { ...structuredClone(REPORT), headline: "Elevate Your Story" };
    const repair = vi.fn(async ({ content }: { content: ReportContent }) => {
      const c = structuredClone(content);
      c.first_section.headline = "Your Story, Told Warmly";
      return { content: c, usage: usage(400, 100, 0.0007) };
    });
    const look = vi.fn()
      .mockResolvedValueOnce({ ok: false, faces_ok: false, headline_readable: true, looks_like_template: false, usage: usage(350, 40, 0.0004) })
      .mockResolvedValueOnce({ ok: true, faces_ok: true, headline_readable: true, looks_like_template: false, usage: usage(350, 40, 0.0004) });
    const { stages } = fakes({ write: vi.fn(async () => ({ written: bad as Written, usage: { ...usage(3000, 700, 0.005), calls: 2 } })), repair, look });
    const r = await runHomepageFixes(INPUT, stages);
    expect(r.outcome).toBe("sent");
    expect(r.usage.inputTokens).toBe(3000 + 400 + 350 + 350);
    expect(r.usage.outputTokens).toBe(700 + 100 + 40 + 40);
    expect(r.usage.calls).toBe(2 + 1 + 1 + 1);
    expect(r.usage.costUsd).toBeCloseTo(0.005 + 0.0007 + 0.0004 + 0.0004, 10);
  });

  describe("deadline", () => {
    // A clock the fakes move forward: the write call takes most of the budget.
    function slowWrite(ms: number, written: Written = structuredClone(REPORT)) {
      let t = 1_000_000;
      const now = () => t;
      const write = vi.fn(async () => { t += ms; return { written, usage: usage(1, 1, 0) }; });
      return { now, write };
    }

    it("skips the repair when under 60 s are left → held out of time", async () => {
      const { now, write } = slowWrite(215_000, { ...structuredClone(REPORT), headline: "Elevate Your Story" });
      const { stages, spies } = fakes({ now, write });
      const r = await runHomepageFixes(INPUT, stages);
      expect(spies.repair).not.toHaveBeenCalled();
      expect(r).toMatchObject({ outcome: "held", reason: "out of time" });
    });

    it("finishes when the content already passes, even when short on time", async () => {
      const { now, write } = slowWrite(215_000);
      const { stages } = fakes({ now, write });
      expect((await runHomepageFixes(INPUT, stages)).outcome).toBe("sent");
    });

    it("skips the look-check re-render when short on time", async () => {
      const { now, write } = slowWrite(215_000);
      const look = vi.fn(async () => ({ ok: false, faces_ok: false, headline_readable: true, looks_like_template: false, usage: usage(1, 1, 0) }));
      const { stages, calls } = fakes({ now, write, look });
      const r = await runHomepageFixes(INPUT, stages);
      expect(calls.renderAfter).toHaveLength(1);
      expect(r).toMatchObject({ outcome: "held", reason: "out of time" });
    });

    it("skips the overflow repair when short on time", async () => {
      const { now, write } = slowWrite(215_000);
      const renderPdf = vi.fn(async () => ({ pdf: Buffer.from("%PDF"), overflow: [{ page: 5, hits: [REPORT.fixes[0].noticed] }] }));
      const { stages, spies } = fakes({ now, write, renderPdf });
      const r = await runHomepageFixes(INPUT, stages);
      expect(spies.repair).not.toHaveBeenCalled();
      expect(r).toMatchObject({ outcome: "held", reason: "out of time" });
    });

    it("honours a custom deadlineMs", async () => {
      const { now, write } = slowWrite(30_000, { ...structuredClone(REPORT), headline: "Elevate Your Story" });
      const { stages, spies } = fakes({ now, write });
      const r = await runHomepageFixes({ ...INPUT, deadlineMs: 80_000 }, stages);
      expect(spies.repair).not.toHaveBeenCalled();
      expect(r).toMatchObject({ outcome: "held", reason: "out of time" });
    });
  });
});
