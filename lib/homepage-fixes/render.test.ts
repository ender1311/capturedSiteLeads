import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillReport } from "./render-html";
import { placeAfter, renderAfter, renderContactSheet, renderPdf, withBrowser } from "./render";
import type { ReportContent } from "./types";

const GAB = "/Users/danluk/Downloads/your-top-homepage-fixes/examples/gabby";
const have = !!process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(GAB);
const gabby = JSON.parse(
  fs.readFileSync(path.join(__dirname, "skill/examples/gabby/content.json"), "utf8")
) as ReportContent;
const uri = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

describe.skipIf(!have)("chromium rendering", () => {
  it("renders contact sheet, mockup and a 9 page PDF with no overflow", async () => {
    const photo = uri(`${GAB}/photos/photo-01.jpg`, "image/jpeg");
    const before = uri(`${GAB}/before.jpg`, "image/jpeg");

    const sheet = await renderContactSheet(before, [photo, photo]);
    expect(sheet[0]).toBe(0xff);
    expect(sheet.length).toBeGreaterThan(5000);

    const after = await renderAfter(gabby.first_section, photo);
    expect(after.subarray(0, 2).toString("hex")).toBe("ffd8");

    const html = fillReport(gabby, { before, after: `data:image/jpeg;base64,${after.toString("base64")}` });
    const { pdf, overflow } = await renderPdf(html);
    fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "out/gabby.pdf"), pdf);
    fs.writeFileSync(path.join(process.cwd(), "out/gabby-after.jpg"), after);
    fs.writeFileSync(path.join(process.cwd(), "out/gabby-sheet.jpg"), sheet);
    expect(pages(pdf)).toBe(9);
    expect(overflow).toEqual([]);
  }, 120_000);
});

describe.skipIf(!have)("chromium placement", () => {
  it("never lets an uppercase headline overflow, and moves the words off a person", async () => {
    const photo = uri(`${GAB}/photos/photo-01.jpg`, "image/jpeg");
    const s = { ...gabby.first_section, layout: "left" as const, uppercase_headline: true, headline: "Real Moments, Not Posed Memories" };
    await withBrowser(async () => {
      const plain = await placeAfter(s, photo);
      expect(plain.clean).toBe(true); // no people: only overflow matters
      const crowded = await placeAfter(s, photo, undefined, [{ box: [100, 0, 700, 500] }]); // someone on the left half
      expect(crowded.clean).toBe(true);
      expect(crowded.overlap).toBe(0);
      expect(crowded.section.layout).not.toBe("left");
      expect(crowded.image.subarray(0, 2).toString("hex")).toBe("ffd8");
    });
  }, 120_000);
});
