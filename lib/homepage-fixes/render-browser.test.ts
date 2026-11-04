import { describe, expect, it, vi } from "vitest";

// A fake Chromium: counts launches, pages and closes, and records what each page was told.
const h = vi.hoisted(() => {
  const log: string[] = [];
  let launches = 0;
  const getBrowser = vi.fn(async () => {
    const n = ++launches;
    log.push(`launch ${n}`);
    return {
      newPage: async () => {
        log.push(`page ${n}`);
        const el = { screenshot: async () => new Uint8Array([0xff, 0xd8]) };
        return {
          setJavaScriptEnabled: async (on: boolean) => { log.push(`js ${on}`); },
          setViewport: async () => {},
          setContent: async () => {},
          evaluate: async () => [],
          $: async () => el,
          pdf: async () => new Uint8Array([0x25]),
          close: async () => { log.push(`close page ${n}`); },
        };
      },
      close: async () => { log.push(`close browser ${n}`); },
    };
  });
  return { log, getBrowser, reset: () => { log.length = 0; launches = 0; } };
});
vi.mock("@/lib/pdf", () => ({ getBrowser: h.getBrowser }));

import { renderAfter, renderContactSheet, renderPdf, withBrowser } from "./render";
import type { FirstSection } from "./types";

const IMG = "data:image/png;base64,AAAA";
const SECTION = { headline: "Hello there friend", layout: "left", nav_items: ["Home"], heading_font: "Lora", body_font: "Lato" } as FirstSection;

describe("one Chromium per report run (Minor 3)", () => {
  it("inside withBrowser, every render gets a new page on one browser, closed at the end", async () => {
    h.reset();
    await withBrowser(async () => {
      await renderContactSheet(IMG, [IMG]);
      await renderAfter(SECTION, IMG);
      await renderPdf("<html></html>");
    });
    expect(h.log.filter((l) => l.startsWith("launch"))).toEqual(["launch 1"]);
    expect(h.log.filter((l) => l.startsWith("page"))).toHaveLength(3);
    expect(h.log.filter((l) => l.startsWith("close page"))).toHaveLength(3);
    expect(h.log.at(-1)).toBe("close browser 1");
  });

  it("closes the browser when the run throws, and launches none if nothing renders", async () => {
    h.reset();
    await expect(withBrowser(async () => {
      await renderAfter(SECTION, IMG);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(h.log.at(-1)).toBe("close browser 1");
    h.reset();
    await withBrowser(async () => "nothing to render");
    expect(h.log).toEqual([]);
  });

  it("two runs at once each get their own browser", async () => {
    h.reset();
    await Promise.all([
      withBrowser(() => renderAfter(SECTION, IMG)),
      withBrowser(() => renderAfter(SECTION, IMG)),
    ]);
    expect(h.log.filter((l) => l.startsWith("launch"))).toHaveLength(2);
    expect(h.log.filter((l) => l.startsWith("close browser"))).toHaveLength(2);
  });

  it("outside withBrowser a render still launches and closes its own browser", async () => {
    h.reset();
    await renderAfter(SECTION, IMG);
    expect(h.log[0]).toBe("launch 1");
    expect(h.log.at(-1)).toBe("close browser 1");
  });
});

describe("JavaScript is off in every render page (C1)", () => {
  it("mockup, contact sheet and PDF pages all disable JavaScript before loading content", async () => {
    h.reset();
    await renderContactSheet(IMG, [IMG]);
    await renderAfter(SECTION, IMG);
    await renderPdf("<html></html>");
    expect(h.log.filter((l) => l === "js false")).toHaveLength(3);
  });
});
