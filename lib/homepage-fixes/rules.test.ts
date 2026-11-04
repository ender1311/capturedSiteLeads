import { describe, expect, it } from "vitest";
import gabby from "./skill/examples/gabby/content.json";
import { autoFix, checkContent, fieldsOf, LIMITS } from "./rules";
import type { ReportContent } from "./types";

const base = gabby as unknown as ReportContent;
const clone = (): ReportContent => structuredClone(base);
const PAGE = [
  "Photography for all steps of life",
  "Alabama-based, Travel Ready",
  "A lover of life, color, and all things fun.",
  "Follow me on Instagram!!!",
  "Read More",
  "Your friend with the camera",
  "graduation, couples, and wedding photographer in central and southeast Alabama",
  "I'm your friend with the camera.",
  "Holleigh says you met every idea I brought with a yes",
].join("\n");

const errorsOf = (c: ReportContent, page = PAGE) => checkContent(c, page).filter((i) => i.level === "error");
const warningsOf = (c: ReportContent, page = PAGE) => checkContent(c, page).filter((i) => i.level === "warning");

describe("rules", () => {
  it("gabby passes with no errors", () => {
    expect(errorsOf(clone())).toEqual([]);
  });

  it("labels fields in build.mjs format", () => {
    const labels = fieldsOf(clone()).map(([l]) => l);
    expect(labels).toContain("first_section.headline");
    expect(labels).toContain("first_section_changes[1]");
    expect(labels).toContain("fixes[1].changes[3]");
    expect(labels).toContain("fixes[2].title");
  });

  it("em dash and en dash are auto-fixed", () => {
    const c = clone();
    c.fixes[0].why = "a — b";
    c.fixes[1].why = "a – b and c—d";
    c.first_section.subline = "x  y ,  , z";
    const fixed = autoFix(c);
    expect(fixed.fixes[0].why).toBe("a, b");
    expect(fixed.fixes[1].why).toBe("a, b and c, d");
    expect(fixed.first_section.subline).toBe("x y, z");
    expect(c.fixes[0].why).toBe("a — b");
    expect(errorsOf(fixed)).toEqual([]);
  });

  it("autoFix straightens curly quotes and trims", () => {
    const c = clone();
    c.fixes[0].changes[0] = "  Make “A lover of life, color, and all things fun.” bigger, it’s nice ";
    expect(autoFix(c).fixes[0].changes[0]).toBe('Make "A lover of life, color, and all things fun." bigger, it\'s nice');
  });

  it("dash in checkContent is an error when not fixed", () => {
    const c = clone();
    c.fixes[0].why = "a — b";
    expect(errorsOf(c).some((i) => i.field === "fixes[1].why")).toBe(true);
  });

  it.each(["elevate", "leverage", "seamless", "curated", "audit", "conversion", "funnel", "optimize", "authentic", "unlock"])(
    "banned word %s is an error",
    (w) => {
      const c = clone();
      c.fixes[0].why = `This will ${w} things.`;
      expect(errorsOf(c).some((i) => i.field === "fixes[1].why" && /banned/.test(i.message))).toBe(true);
    },
  );

  it("bracket is an error", () => {
    const c = clone();
    c.fixes[0].why = "Hello [name] there.";
    expect(errorsOf(c).some((i) => i.field === "fixes[1].why")).toBe(true);
  });

  it('"12px" is an error', () => {
    const c = clone();
    c.fixes[0].why = "Make it 12px bigger.";
    expect(errorsOf(c).some((i) => /technical number/.test(i.message))).toBe(true);
  });

  it('"your whole site" is an error', () => {
    const c = clone();
    c.fixes[0].why = "Change your whole site.";
    expect(errorsOf(c).some((i) => i.field === "fixes[1].why" && /homepage only/i.test(i.message))).toBe(true);
  });

  it('"newsletter" is an error', () => {
    const c = clone();
    c.fixes[1].changes[0] = "Add a newsletter signup.";
    expect(errorsOf(c).some((i) => i.field === "fixes[2].changes[1]")).toBe(true);
  });

  it('"she" is a warning', () => {
    const c = clone();
    c.fixes[0].why = "She will see it.";
    expect(warningsOf(c).some((i) => i.field === "fixes[1].why" && /she/.test(i.message))).toBe(true);
  });

  it('"!" is a warning', () => {
    const c = clone();
    c.fixes[0].why = "Wow!";
    expect(warningsOf(c).some((i) => i.field === "fixes[1].why" && /exclamation/.test(i.message))).toBe(true);
  });

  it('"$300" is a warning', () => {
    const c = clone();
    c.fixes[0].why = "Charge $300 for it.";
    expect(warningsOf(c).some((i) => i.field === "fixes[1].why" && /price/.test(i.message))).toBe(true);
  });

  it("over-length is an error", () => {
    expect(LIMITS.fixTitle).toBe(52);
    const c = clone();
    c.fixes[0].title = "x".repeat(53);
    const errs = errorsOf(c);
    expect(errs.some((i) => i.field === "fixes[1].title" && /53 characters/.test(i.message))).toBe(true);
    c.fixes[0].title = "x".repeat(52);
    expect(errorsOf(c)).toEqual([]);
  });

  it("invented quote is an error", () => {
    const c = clone();
    c.fixes[0].noticed = 'Visitors love it, "Best day ever" says someone.';
    const errs = errorsOf(c);
    expect(errs.some((i) => i.field === "fixes[1].noticed" && /quote/i.test(i.message))).toBe(true);
  });

  it("quote matching ignores case, curly quotes, whitespace; short quotes ignored", () => {
    const c = clone();
    c.fixes[0].noticed = "Try “ALABAMA-based,   travel ready.” and \"Hi there\" ok.";
    expect(errorsOf(c)).toEqual([]);
    const page = PAGE.replace("I'm your", "I’m your");
    c.fixes[0].noticed = 'Try "I\'m your friend with the camera".';
    expect(errorsOf(c, page)).toEqual([]);
  });

  it("quote check survives autoFix of dashes inside a quoted testimonial", () => {
    const page = PAGE + '\nShe said \u2014 best day ever \u2013 and meant it';
    const c = clone();
    c.fixes[0].noticed = 'A client says "She said \u2014 best day ever \u2013 and meant it" on your page.';
    const fixed = autoFix(c);
    expect(fixed.fixes[0].noticed).toContain("She said, best day ever, and meant it");
    expect(errorsOf(fixed, page)).toEqual([]);
  });

  it('"Captured sites" misspelled is an error', () => {
    const c = clone();
    c.fixes[0].why = "Captured sites can help.";
    expect(errorsOf(c).some((i) => /Captured Sites/.test(i.message))).toBe(true);
    c.fixes[0].why = "Captured Sites can help.";
    expect(errorsOf(c)).toEqual([]);
  });

  it("paraphrased testimonial in quotes is caught", () => {
    const c = clone();
    c.fixes[0].noticed = 'Holleigh says Gabby "met every idea with a yes".';
    expect(errorsOf(c).some((i) => i.field === "fixes[1].noticed" && /quote/i.test(i.message))).toBe(true);
  });
});
