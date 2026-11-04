import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contactSheetHtml, fillReport, firstSectionHtml, keepLast, pdfFileName } from "./render-html";
import type { FirstSection, ReportContent } from "./types";

const gabby = JSON.parse(
  fs.readFileSync(path.join(__dirname, "skill/examples/gabby/content.json"), "utf8")
) as ReportContent;
const IMG = "data:image/png;base64,AAAA";
const imgs = { before: "data:image/png;base64,BBBB", after: "data:image/jpeg;base64,CCCC" };

describe("keepLast", () => {
  it("escapes and glues the last word", () => {
    expect(keepLast("a <b> c")).toBe("a &lt;b&gt;&nbsp;c");
  });
});

describe("fillReport", () => {
  const html = fillReport(gabby, imgs);
  it("fills every slot", () => {
    expect(html).not.toContain("{{");
    expect(html).toContain(keepLast(gabby.fixes[0].title));
    expect(html).toContain("&nbsp;" + gabby.fixes[0].title.split(" ").pop());
    expect((html.match(/border:2px solid #337A80;border-radius:4px/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
  it("renders 3 checkbox rows per fix", () => {
    const one = fillReport({ ...gabby, fixes: [gabby.fixes[0], gabby.fixes[0]] }, imgs);
    expect(one.split(keepLast(gabby.fixes[0].changes[0])).length - 1).toBe(2);
  });
  it("inlines assets with each asset's own mime", () => {
    expect(html).not.toContain('src="assets/');
    expect(html).not.toContain('src="before.jpg"');
    expect(html).not.toContain('src="after.jpg"');
    expect(html).toContain(`src="${imgs.before}"`);
    expect(html).toContain(`src="${imgs.after}"`);
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).toContain('src="data:image/jpeg;base64,');
  });
  it("escapes HTML", () => {
    const c = { ...gabby, fixes: [{ ...gabby.fixes[0], title: "<b>x</b> done" }, gabby.fixes[1]] } as ReportContent;
    const out = fillReport(c, imgs);
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain("<b>x</b>");
  });
  it("NAME_POSS handles apostrophes and quotes in aria-label", () => {
    const out = fillReport({ ...gabby, first_name: "D'Andre" }, imgs);
    expect(out).toContain('aria-label="D\'Andre\'s new first section on a computer and phone"');
    const q = fillReport({ ...gabby, first_name: 'A"B' }, imgs);
    expect(q).toContain('aria-label="A&quot;B\'s new first section');
  });
  it("rewrites every tour link with UTM", () => {
    const utm = "https://capturedsites.com/tour/?utm_source=homepage-fixes&utm_medium=pdf&utm_campaign=homepage-fixes";
    expect(html).not.toContain('href="https://capturedsites.com/tour/"');
    expect((html.match(new RegExp(`href="${utm.replace(/[?]/g, "\\?")}"`, "g")) ?? []).length).toBe(4);
  });
});

describe("firstSectionHtml", () => {
  const base = gabby.first_section as FirstSection;
  it("bottom nav puts nav after photo", () => {
    const h = firstSectionHtml({ ...base, nav_position: "bottom", nav_style: "bar" }, IMG);
    expect(h.indexOf('class="nav"')).toBeGreaterThan(h.indexOf("url('"));
    const t = firstSectionHtml({ ...base, nav_position: "top" }, IMG);
    expect(t.indexOf('class="nav"')).toBeLessThan(t.indexOf("url('"));
  });
  it("over style makes nav text white and absolute", () => {
    const h = firstSectionHtml({ ...base, nav_style: "over", nav_color: "#123456" }, IMG);
    expect(h).toContain("color:#FFFFFF;position:absolute");
    expect(h).not.toContain("#123456");
  });
  it("loads non-system fonts from Google Fonts and omits the link for Georgia", () => {
    const h = firstSectionHtml(base, IMG);
    expect(h).toContain("fonts.googleapis.com");
    expect(h).toContain("Cormorant+Garamond");
    const g = firstSectionHtml({ ...base, heading_font: "Georgia", body_font: "Arial" }, IMG);
    expect(g).not.toContain("fonts.googleapis.com");
  });
  it("uses the logo data uri and inverts it on over style", () => {
    const h = firstSectionHtml({ ...base, nav_style: "over" }, IMG, "data:image/svg+xml;base64,ZZ");
    expect(h).toContain('src="data:image/svg+xml;base64,ZZ"');
    expect(h).toContain("invert(1)");
  });
});

describe("contactSheetHtml", () => {
  it("labels up to 3 photos and TODAY", () => {
    const h = contactSheetHtml(IMG, ["data:a", "data:b", "data:c", "data:d"]);
    expect(h).toContain("TODAY");
    expect(h).toContain(">3<");
    expect(h).not.toContain("data:d");
    expect(h).toContain("width:1600px;height:900px");
  });
});

describe("pdfFileName", () => {
  it("makes an ascii slug", () => {
    expect(pdfFileName("Zoë")).toBe("your-top-homepage-fixes-zoe.pdf");
    expect(pdfFileName("D'Andre")).toBe("your-top-homepage-fixes-dandre.pdf");
    expect(pdfFileName("Mary Ann")).toBe("your-top-homepage-fixes-mary-ann.pdf");
  });
});
