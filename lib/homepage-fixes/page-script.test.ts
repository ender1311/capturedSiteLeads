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
      <div class="fadeIn"><p style="opacity:0">Parent fades in</p></div>
      <p style="opacity:0">Really invisible text</p>
      <p class="fade-in" style="visibility:hidden">Hidden menu text</p>`);
    const texts = p.rows.map((r) => r.text);
    expect(texts).toContain("A Fun Wedding Photographer");
    expect(texts).toContain("About me copy that fades in");
    expect(texts).not.toContain("Nested in a block"); // evidence must be on the element or its parent
    expect(texts).toContain("Parent fades in");
    expect(texts).not.toContain("Really invisible text");
    expect(texts).not.toContain("Hidden menu text");
  });

  it("excludes an opacity-0 mobile menu with a transition inside nav", async () => {
    const p = await extract(`<h1 style="margin:200px 40px">Hero headline</h1>
      <nav><div class="mobile-menu" style="opacity:0;transition:opacity .3s;position:absolute;top:0;left:0;width:400px">
        <p style="opacity:0;transition:opacity .3s">Menu tagline text</p><a href="/x" class="fade" style="opacity:0">Menu link</a></div></nav>`);
    const texts = p.rows.map((r) => r.text);
    expect(texts).toContain("Hero headline");
    expect(texts).not.toContain("Menu tagline text");
    expect(texts).not.toContain("Menu link");
  });

  it("excludes an opacity-0 role=dialog popup with a transition", async () => {
    const p = await extract(`<div role="dialog" style="opacity:0;transition:opacity .4s;position:fixed;top:100px;left:100px;width:500px">
      <p style="opacity:0;transition:opacity .4s">Join my list for a discount</p><p class="preFade" style="opacity:0">Sign up now</p></div>`);
    const texts = p.rows.map((r) => r.text);
    expect(texts).not.toContain("Join my list for a discount");
    expect(texts).not.toContain("Sign up now");
  });

  it("ignores theme tokens on body when checking for hidden menus (Squarespace)", async () => {
    const p = await extract(`<script>document.body.className = "header-overlay-alignment-center tweak-mobile-menu-burger";</script>
      <h1 class="preFade" style="opacity:0">A Fun Wedding Photographer</h1>`);
    expect(p.rows.map((r) => r.text)).toContain("A Fun Wedding Photographer");
  });

  it("includes an opacity-0 .preFade hero headline", async () => {
    const p = await extract(`<section><div style="padding-top:300px"><h1 class="preFade" style="opacity:0;font-size:60px">Your Friend With the Camera</h1></div></section>`);
    const h = p.rows.find((r) => r.text === "Your Friend With the Camera");
    expect(h?.tag).toBe("h1");
    expect(p.fonts.heading).not.toBe("");
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

  const color = (c: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="${c}"/></svg>`)}`;
  const slides = (style: (i: number) => string) => [1, 2, 3, 4].map((i) =>
    `<div class="slide" style="position:absolute;inset:0;background:url('${color(`#${i}${i}${i}`)}#s${i}') center/cover;${style(i)}"></div>`).join("");

  it("hero: a slider of 4 stacked same-size slides where the 4th is on top", async () => {
    const p = await extract(`<section style="position:relative;height:775px">${slides(() => "")}
      <div style="position:absolute;left:100px;top:300px;color:#fff"><h1>Jane Doe Photography</h1><a href="/contact">Inquire</a></div></section>`);
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#s4$/);
    expect(p.imgs.filter((i) => i.hero)).toHaveLength(1);
  });

  it("hero: the visible slide wins over slides on top with opacity 0", async () => {
    const p = await extract(`<section style="position:relative;height:775px">${slides((i) => (i === 2 ? "opacity:1" : "opacity:0"))}</section>`);
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#s2$/);
    // Opacity-0 slides that are not the hero are left out.
    expect(p.imgs.some((i) => /#s[134]$/.test(i.src))).toBe(false);
  });

  it("hero: a slide whose opacity transition has not advanced counts at its end value (frozen headless timeline)", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(`<!doctype html><html><head><title>Jane</title><style>.slide{transition:opacity 10s linear}</style></head><body style="margin:0">
      <section style="position:relative;height:775px">${slides((i) => (i === 1 ? "opacity:1" : "opacity:0"))}</section>
      <p style="margin-top:2000px">${"Text ".repeat(40)}</p></body></html>`);
    // Slick-style change: slide 3 goes on top and fades in, slide 1 fades out; then the clock stops.
    await page.evaluate(() => {
      const s = document.querySelectorAll<HTMLElement>(".slide");
      void s[0].offsetWidth;
      s[2].style.zIndex = "999"; s[2].style.opacity = "1"; s[0].style.opacity = "0";
      document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; });
    });
    const p = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    await page.close();
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#s3$/);
  });

  it("slider: stops the slideshow so the screenshot keeps showing the hero slide", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(`<!doctype html><html><head><title>Jane</title><style>.slide{transition:opacity .2s}</style></head><body style="margin:0">
      <section style="position:relative;height:775px">${slides((i) => (i === 1 ? "opacity:1;z-index:2" : "opacity:0"))}</section>
      <p style="margin-top:2000px">${"Text ".repeat(40)}</p>
      <script>var n = 0; setInterval(function () { var s = document.querySelectorAll('.slide'); s.forEach(function (e) { e.style.opacity = 0; e.style.zIndex = ''; });
        n = (n + 1) % 4; s[n].style.opacity = 1; s[n].style.zIndex = 2; window.__n = n; }, 250);</script></body></html>`);
    await new Promise((r) => setTimeout(r, 300));
    const p = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    const at = await page.evaluate(() => (window as unknown as { __n: number }).__n);
    await new Promise((r) => setTimeout(r, 700));
    const later = await page.evaluate(() => (window as unknown as { __n: number }).__n);
    const top = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".slide")].findIndex((e) => getComputedStyle(e).opacity === "1"));
    await page.close();
    expect(p.imgs[0].hero).toBe(true);
    expect(later).toBe(at);
    expect(p.imgs[0].src).toMatch(new RegExp(`#s${top + 1}$`));
  });

  it("slider mid cross-fade: the more visible slide is the hero and is shown fully for the screenshot", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    // jQuery Cycle style: the incoming slide is on top at 0.3, the outgoing one under it at 0.7.
    await page.setContent(`<!doctype html><html><head><title>Jane</title></head><body style="margin:0">
      <section style="position:relative;height:900px">${slides((i) => (i === 1 ? "opacity:0.7;z-index:99" : i === 2 ? "opacity:0.3;z-index:100" : "opacity:0"))}</section>
      <p>${"Text ".repeat(40)}</p></body></html>`);
    const p = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    const ops = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".slide")].map((e) => getComputedStyle(e).opacity));
    await page.close();
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#s1$/);
    expect(ops).toEqual(["1", "0", "0", "0"]);
  });

  it("no slider: the page's timers keep running after the extraction", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(`<!doctype html><html><head><title>Jane</title></head><body style="margin:0">
      <img src="${color("#456")}#one" style="display:block;width:1440px;height:800px"><p>${"Text ".repeat(40)}</p>
      <script>window.__t = 0; setInterval(function () { window.__t++; }, 50);</script></body></html>`);
    const p = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    const a = await page.evaluate(() => (window as unknown as { __t: number }).__t);
    await new Promise((r) => setTimeout(r, 300));
    const b = await page.evaluate(() => (window as unknown as { __t: number }).__t);
    await page.close();
    expect(p.imgs[0].hero).toBe(true);
    expect(b).toBeGreaterThan(a);
  });

  it("hero: a narrow panel of a triptych (Showit) under the screen centre", async () => {
    const p = await extract(`<div style="position:relative;height:900px">
      ${[0, 1, 2].map((i) => `<div style="position:absolute;top:0;left:${i * 480}px;width:480px;height:900px;background:url('${color("#a" + i + "a")}#t${i}') center/cover"></div>`).join("")}
      <div style="position:absolute;left:400px;top:400px;width:640px;color:#fff;font-size:40px">Timeless wedding photos</div></div>
      <img src="${color("#999")}#big" style="display:block;width:1440px;height:960px">`);
    const hero = p.imgs.find((i) => i.hero);
    expect(hero?.src).toMatch(/#t1$/);
    expect(p.imgs[0]).toBe(hero ? p.imgs[0] : undefined);
    expect(p.imgs[0].w).toBe(480);
  });

  it("hero: a background photo with pointer-events none (Squarespace)", async () => {
    const p = await extract(`<section style="position:relative;height:724px">
      <img src="${color("#456")}#sq" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none">
      <div style="position:relative;padding:300px 100px;color:#fff"><h1>Jane Doe</h1></div></section>`);
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#sq$/);
  });

  it("hero in the frame follows the slide the top window shows (the screenshot)", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const frameSlides = slides((i) => (i === 2 ? "opacity:1" : "opacity:0"));
    const srcdoc = `<!doctype html><body style="margin:0"><section style="position:relative;height:775px">${frameSlides}</section><p>${"Frame text ".repeat(20)}</p></body>`;
    await page.setContent(`<!doctype html><html><head><title>Jane</title></head><body style="margin:0">
      <section style="position:relative;height:775px">${slides(() => "")}</section>
      <iframe id="__hf" style="position:fixed;left:0;top:0;width:1440px;height:900px;border:0;opacity:0;pointer-events:none"></iframe></body></html>`);
    await page.evaluate((html) => new Promise<void>((done) => {
      const f = document.getElementById("__hf") as HTMLIFrameElement;
      f.onload = () => done();
      f.srcdoc = html;
    }), srcdoc);
    const p = JSON.parse((await page.evaluate(EXTRACT_SCRIPT)) as string) as PageData;
    await page.close();
    expect(p.frame).toBe(true);
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#s4$/);
  });

  it("hero: an <img> below a text overlay, and its largest srcset candidate", async () => {
    const p = await extract(`<div style="position:relative">
      <img src="${color("#123")}#small" srcset="${color("#123")}#w500 500w, ${color("#123")}#w2500 2500w, ${color("#123")}#w1000 1000w" sizes="1440px" style="display:block;width:1440px;height:900px">
      <div style="position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.3),rgba(0,0,0,.3))"><h1 style="margin:300px">Hello</h1></div></div>`);
    expect(p.imgs[0].hero).toBe(true);
    expect(p.imgs[0].src).toMatch(/#w2500$/);
  });

  it("image source: data-srcset, then data-src, then currentSrc", async () => {
    const p = await extract(`<div style="height:1000px"></div>
      <img src="${color("#111")}#a-cur" data-srcset="${color("#111")}#a-400 400w, ${color("#111")}#a-1600 1600w" style="display:block;width:600px;height:400px">
      <img src="${color("#222")}#b-cur" data-src="${color("#222")}#b-data" style="display:block;width:600px;height:400px">
      <img src="${color("#333")}#c-cur" style="display:block;width:600px;height:400px">`);
    const srcs = p.imgs.map((i) => i.src.replace(/^.*#/, ""));
    expect(srcs).toEqual(expect.arrayContaining(["a-1600", "b-data", "c-cur"]));
  });

  it("leaves out images above the page, opacity 0 or hidden, and keeps 300x200 ones", async () => {
    const p = await extract(`<img src="${color("#111")}#above" style="position:absolute;top:-1000px;left:0;width:1440px;height:900px">
      <div style="height:1000px"></div>
      <img src="${color("#222")}#faded" style="display:block;width:1200px;height:800px;opacity:0">
      <img src="${color("#333")}#hidden" style="display:block;width:1200px;height:800px;visibility:hidden">
      <img src="${color("#444")}#ok" style="display:block;width:300px;height:200px">
      <img src="${color("#555")}#small" style="display:block;width:299px;height:200px">`);
    const srcs = p.imgs.map((i) => i.src.replace(/^.*#/, ""));
    expect(srcs).toEqual(["ok"]);
    expect(p.imgs.some((i) => i.hero)).toBe(false);
  });

  it("hamburger: no visible links and a MENU button gives nav ['Menu']", async () => {
    const p = await extract(`<div style="position:relative;height:120px">
      <div style="position:absolute;right:40px;top:40px;font-size:14px;letter-spacing:.2em;cursor:pointer">MENU</div></div>
      <div style="position:fixed;inset:0;display:none"><div>Home</div><div>About</div></div>`);
    expect(p.nav).toEqual(["Menu"]);
    expect(p.navTop).toBe(true);
  });

  it("hamburger: a burger button reads the hidden menu container's links (skip links and duplicates out, max 8)", async () => {
    const items = ["Home", "About", "Portfolio", "Families", "Seniors", "Investment", "Blog", "Contact", "Shop"];
    const p = await extract(`<div style="padding:20px;height:80px"><button aria-label="Open navigation" class="nav-toggle" style="float:right;width:40px;height:30px"></button></div>
      <div class="site-menu" style="display:none"><a href="#main">Skip to content</a>${links(["Home", ...items])}</div>`);
    expect(p.nav).toEqual(items.slice(0, 8));
    expect(p.navTop).toBe(true);
  });

  it("hamburger: hidden link text with <br> and nested spans gets spaces, collapsed", async () => {
    const p = await extract(`<div style="position:relative;height:120px"><div style="position:absolute;right:40px;top:40px">MENU</div></div>
      <div class="site-menu" style="display:none"><a href="/w">workshop<br>for<span>photographers</span></a><a href="/m">  meet
        niki </a></div>`);
    expect(p.nav).toEqual(["workshop for photographers", "meet niki"]);
  });

  it("burger fallback: hidden header nav link with <br> reads with a space", async () => {
    const p = await extract(`<header style="padding:20px"><nav style="visibility:hidden"><a href="/a">About<br>Me</a><a href="/c">Contact</a></nav></header>`);
    expect(p.nav).toEqual(["About Me", "Contact"]);
  });

  it("no menu button and no links: nav stays empty", async () => {
    const p = await extract(`<div style="padding:20px">Jane Doe</div><div class="menu-wrapper" style="display:none"><a href="/x">Hidden</a></div>`);
    expect(p.nav).toEqual([]);
  });

  it("logo: an inline svg inside the empty-text brand link in the header", async () => {
    const p = await extract(`<header style="padding:20px;color:rgb(20, 30, 40)"><a href="/" aria-label="Jane Doe"><svg width="160" height="50" viewBox="0 0 160 50"><path d="M0 0h160v50H0z" fill="currentColor"/></svg></a>
      <nav>${links(["Home", "About", "Contact"])}</nav></header>`);
    expect(p.logo?.src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(p.logo!.src)).toContain("<svg");
    expect(p.logo?.w).toBe(160);
  });

  it("logo: an <img> inside the brand link is still found the old way", async () => {
    const p = await extract(`<header style="padding:20px"><a href="/"><img src="${color("#000")}#brand" alt="" style="width:180px;height:60px"></a>
      <nav>${links(["Home", "About", "Contact"])}</nav></header>`);
    expect(p.logo?.src).toMatch(/#brand$/);
  });

  it("returns no nav and navTop false when there are no nav links", async () => {
    const p = await extract(`<div style="padding:20px">Jane Doe</div>`);
    expect(p.nav).toEqual([]);
    expect(p.navTop).toBe(false);
  });
});
