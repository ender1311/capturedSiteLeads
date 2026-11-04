import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import type { Browser } from "puppeteer-core";
import { EXTRACT_SCRIPT } from "./page-script";
import type { PageData } from "./types";

// Runs EXTRACT_SCRIPT in real Chrome on hand-written pages. Skipped when Chrome is not installed.
const chrome = process.env.PUPPETEER_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = fs.existsSync(chrome);

const links = (items: string[], style = "") =>
  items.map((t) => `<a href="/${t.toLowerCase()}" style="margin:0 12px;${style}">${t}</a>`).join("");

describe.skipIf(!hasChrome)("EXTRACT_SCRIPT nav pick (Chrome)", () => {
  let browser: Browser;
  beforeAll(async () => {
    const puppeteer = (await import("puppeteer-core")).default;
    browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  }, 30000);
  afterAll(async () => { await browser?.close(); });

  async function extract(body: string, title = "Weddings - Jane Doe Photography"): Promise<PageData> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(`<!doctype html><html><head><title>${title}</title>
      <style>body{margin:0;font:16px sans-serif}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
      </head><body>${body}<p style="margin-top:2000px">${"Text ".repeat(40)}</p></body></html>`);
    const out = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    await page.close();
    return out;
  }

  it("skips skip links, hidden links and the site title; prefers the nav element; dedupes", async () => {
    const p = await extract(`<header style="display:flex;justify-content:space-between;padding:20px">
      <a href="#page" class="header-skip-link" style="position:absolute;left:-16000px">Skip to Content</a>
      <a href="/" style="font-size:24px">Jane Doe Photography</a>
      <a href="#main" class="sr-only">Main content</a>
      <nav>${links(["Home", "Portfolio", "About", "Investment", "Contact", "Home"])}</nav>
      <a href="/cart">Cart</a>
    </header>`);
    expect(p.nav).toEqual(["Home", "Portfolio", "About", "Investment", "Contact"]);
    expect(p.navTop).toBe(true);
  });

  it("finds a nav bar at the bottom of the first screen", async () => {
    const p = await extract(`<div style="height:775px;background:#789"><div style="padding:40px;color:#fff">Jane Doe: Alabama based</div></div>
      <div style="padding:30px 60px;background:#fff"><nav>${links(["HOME", "ABOUT", "PORTFOLIO", "INVESTMENT", "CONTACT"])}</nav></div>`);
    expect(p.nav).toEqual(["HOME", "ABOUT", "PORTFOLIO", "INVESTMENT", "CONTACT"]);
    expect(p.navTop).toBe(false);
    expect(p.screenH).toBe(900);
  });

  it("uses the ancestor with the most links when there is no nav element, and caps at 8", async () => {
    const many = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
    const p = await extract(`<div style="padding:20px"><a href="/x">Book now</a></div>
      <div style="position:absolute;top:60px;left:400px"><span>${links(many)}</span></div>`);
    expect(p.nav).toEqual(many.slice(0, 8));
  });

  it("reads a burger menu's hidden header nav by text", async () => {
    const p = await extract(`<header style="padding:20px"><a href="/" style="color:rgb(255, 255, 255)">Jane Doe Photography</a>
      <nav style="visibility:hidden">${links(["Home", "Portfolio", "Contact"], "color:rgb(0, 0, 0)")}</nav></header>`);
    expect(p.nav).toEqual(["Home", "Portfolio", "Contact"]);
    expect(p.navTop).toBe(true);
    expect(p.navColor).toBe("rgb(255, 255, 255)");
  });

  it("keeps un-triggered fade-ins (opacity 0 with an animation class or transition) in rows", async () => {
    const p = await extract(`<h1 class="preFade" style="opacity:0">A Fun Wedding Photographer</h1>
      <p style="opacity:0;transition:opacity 0.6s">About me copy that fades in</p>
      <div class="sqs-block"><div><p style="opacity:0">Nested in a block</p></div></div>
      <p style="opacity:0">Really invisible text</p>
      <p class="fade-in" style="visibility:hidden">Hidden menu text</p>`);
    const texts = p.rows.map((r) => r.text);
    expect(texts).toContain("A Fun Wedding Photographer");
    expect(texts).toContain("About me copy that fades in");
    expect(texts).toContain("Nested in a block");
    expect(texts).not.toContain("Really invisible text");
    expect(texts).not.toContain("Hidden menu text");
  });

  const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#456"/></svg>')}`;

  it("nav over the photo: transparent header on top of the hero image", async () => {
    const p = await extract(`<header style="position:absolute;top:0;left:0;right:0;padding:20px;z-index:2">
      <nav>${links(["Home", "About", "Contact"], "color:rgb(255, 255, 255)")}</nav></header>
      <img src="${photo}" style="display:block;width:1440px;height:800px">`);
    expect(p.navOverPhoto).toBe(true);
    expect(p.navBg).toBeNull();
    expect(p.navColor).toBe("rgb(255, 255, 255)");
  });

  it("nav bar: transparent header with a white inner layer above a hero that starts at y 0 (Squarespace)", async () => {
    const p = await extract(`<header style="position:fixed;top:0;left:0;right:0;height:88px;z-index:2">
      <div class="header-background-solid" style="position:absolute;inset:0;background:rgb(255, 255, 255)"></div>
      <div style="position:relative;padding:30px"><nav>${links(["Home", "Portfolio", "About"])}</nav></div></header>
      <section style="height:724px;background:url('${photo}') center/cover"></section>`);
    expect(p.navTop).toBe(true);
    expect(p.navOverPhoto).toBe(false);
    expect(p.navBg).toBe("rgb(255, 255, 255)");
  });

  it("nav bar: transparent header over the photo box, but a solid strip outside the header covers it", async () => {
    const p = await extract(`<header style="position:absolute;top:0;left:0;right:0;height:80px;z-index:3">
      <nav style="padding:28px">${links(["Home", "About", "Contact"])}</nav></header>
      <div style="position:absolute;top:0;left:0;right:0;height:80px;background:rgb(250, 248, 240);z-index:2"></div>
      <img src="${photo}" style="display:block;width:1440px;height:800px">`);
    expect(p.navOverPhoto).toBe(false);
    expect(p.navBg).toBe("rgb(250, 248, 240)");
  });

  it("gabby layout: white nav bar at the bottom of the first screen under the hero", async () => {
    const p = await extract(`<div style="height:775px;background:url('${photo}') center/cover"><div style="padding:40px;color:#fff">Jane Doe: Alabama based</div></div>
      <div style="padding:30px 60px;background:rgb(255, 255, 255)"><nav>${links(["HOME", "ABOUT", "PORTFOLIO", "INVESTMENT", "CONTACT"], "color:rgb(35, 37, 30)")}</nav></div>`);
    expect(p.nav).toHaveLength(5);
    expect(p.navTop).toBe(false);
    expect(p.navOverPhoto).toBe(false);
    expect(p.navBg).toBe("rgb(255, 255, 255)");
  });

  it("returns no nav and navTop false when there are no nav links", async () => {
    const p = await extract(`<div style="padding:20px">Jane Doe</div>`);
    expect(p.nav).toEqual([]);
    expect(p.navTop).toBe(false);
  });
});
