import { describe, expect, it } from "vitest";
import { cleanBrand, cleanNav, cleanSection } from "./mockup-clean";

describe("cleanBrand (gate defect 1)", () => {
  it("strips Willow's footer copyright", () => {
    expect(cleanBrand("© 2026 WillowAnn Photography")).toBe("WillowAnn Photography");
  });
  it.each([
    ["(c) 2019-2026 Jane Doe Photo", "Jane Doe Photo"],
    ["Copyright © 2024 Jane Doe Photography. All Rights Reserved.", "Jane Doe Photography"],
    ["Jane Doe Photography © 2025", "Jane Doe Photography"],
    ["Jane Doe Photography | All rights reserved", "Jane Doe Photography"],
    ["Copyright 2020 – 2026 Studio Nine", "Studio Nine"],
    ["Gabby J Photography", "Gabby J Photography"],
    ["Studio 1999", "Studio 1999"],
  ])("%s → %s", (input, out) => {
    expect(cleanBrand(input)).toBe(out);
  });
});

describe("cleanNav (gate defect 2)", () => {
  it("cleans Niki's 8 items: dedupe, drop 'experience' next to 'the experience', cap at 6 keeping contact", () => {
    expect(cleanNav(["workshop forphotographers", "meet niki", "Home", "the experience", "galleries", "journal", "contact", "experience"]))
      .toEqual(["workshop forphotographers", "meet niki", "Home", "the experience", "galleries", "contact"]);
  });
  it("dedupes case-insensitively and squeezes whitespace", () => {
    expect(cleanNav(["Home", "HOME", " About  me ", "about me", ""])).toEqual(["Home", "About me"]);
  });
  it("keeps the first 6 when contact is already among them", () => {
    expect(cleanNav(["Home", "Contact", "A", "B", "C", "D", "E", "F"])).toEqual(["Home", "Contact", "A", "B", "C", "D"]);
  });
  it("keeps an inquire-style item as contact", () => {
    expect(cleanNav(["A", "B", "C", "D", "E", "F", "G", "Inquire"])).toEqual(["A", "B", "C", "D", "E", "Inquire"]);
  });
});

describe("cleanSection", () => {
  it("cleans logo_text and nav_items and leaves the rest alone", () => {
    const s = cleanSection({ logo_text: "© 2026 WillowAnn Photography", nav_items: ["Home", "home", "the blog", "blog"], headline: "x" });
    expect(s).toEqual({ logo_text: "WillowAnn Photography", nav_items: ["Home", "the blog"], headline: "x" });
  });
});
