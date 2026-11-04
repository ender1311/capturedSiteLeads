import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReportContent } from "./types";

const skill = path.join(__dirname, "skill");
const html = fs.readFileSync(path.join(skill, "template/report.html"), "utf8");

describe("skill assets", () => {
  it("template has exactly the slots build.mjs fills", () => {
    const found = new Set([...html.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]));
    const expected = new Set([
      "FIRST_NAME", "NAME_POSS",
      "P4_CHANGE_1", "P4_CHANGE_2", "P4_CHANGE_3",
      "F1_TITLE", "F1_NOTICED", "F1_WHY", "F1_CHANGES",
      "F2_TITLE", "F2_NOTICED", "F2_WHY", "F2_CHANGES",
    ]);
    expect(found).toEqual(expected);
  });

  it("template references only bundled assets", () => {
    const srcs = [...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) {
      expect(fs.existsSync(path.join(skill, "template", s)), s).toBe(true);
    }
  });

  it("gabby example parses as ReportContent shape", () => {
    const c = JSON.parse(
      fs.readFileSync(path.join(skill, "examples/gabby/content.json"), "utf8"),
    ) as ReportContent;
    expect(c.first_section_changes).toHaveLength(3);
    expect(c.fixes).toHaveLength(2);
    for (const f of c.fixes) expect(f.changes).toHaveLength(3);
  });
});
