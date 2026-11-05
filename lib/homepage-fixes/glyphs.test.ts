import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { missingGlyphs, stripSymbols } from "./glyphs";
import { fixText } from "./rules";

const template = fs.readFileSync(path.join(__dirname, "skill/template/report.html"), "utf8");
// Text the PDF actually draws: drop <style>/<script>, SVG markup and tags, decode the few entities used.
const visibleText = (html: string) =>
  html
    .replace(/<(style|script|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'");

describe("PDF glyph coverage (serverless Chromium has no fallback fonts)", () => {
  it("the report template only uses characters Lato can draw", () => {
    // Regression: "→" and "★" printed as missing-glyph boxes in production PDFs (2026-11-04).
    expect(missingGlyphs(visibleText(template))).toEqual([]);
  });

  it("missingGlyphs flags arrows, stars and emoji but not accented letters", () => {
    expect(missingGlyphs("Café Zoë Łódź “quoted” — €5 ↑ ↓")).toEqual([]);
    expect(missingGlyphs("next → ★ 📸")).toEqual(["→", "★", "📸"]);
  });

  it("stripSymbols and fixText drop symbols the font can't draw", () => {
    expect(stripSymbols("Book now → today ★★★ 📸❤️")).toBe("Book now  today  ");
    expect(fixText("Follow me on Instagram!!! 📸 → @gabby")).toBe("Follow me on Instagram!!! @gabby");
    expect(missingGlyphs(fixText("Hi 👋 there ✨ friend ➜ go"))).toEqual([]);
  });
});
