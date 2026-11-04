import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseScrape } from "./capture";
import { buildFacts } from "./facts";
import { toGoogleFont } from "./fonts";
import type { Capture, PageData, TextRow } from "./types";

const fixturePage = (name: string): PageData =>
  parseScrape(JSON.parse(fs.readFileSync(path.join(__dirname, `fixtures/${name}`), "utf8"))).page;

const row = (y: number, text: string, over: Partial<TextRow> = {}): TextRow => ({
  y, x: 100, tag: "p", fs: 16, fw: "400", ff: "Lato", tt: "none", text, ...over,
});

const LONG = "I love photographing families and couples across the city. ".repeat(6);

function page(over: Partial<PageData> = {}): PageData {
  return {
    title: "Jane Doe Photography", finalUrl: "https://janedoe.com/", pageHeight: 4000, metaDesc: "",
    rows: [row(1200, LONG)], imgs: [{ src: "https://janedoe.com/a.jpg", w: 1440, h: 800, y: 0, alt: "", kind: "img" }],
    nav: ["Home", "About", "Contact"], navTop: true, navOverPhoto: false, navBg: "rgb(255, 255, 255)", navColor: "rgb(34, 34, 34)",
    logo: null, fonts: { heading: "Lora", headingWeight: "400", body: "Lato" },
    uppercaseHeadings: false, accent: null, buttons: [], textLength: 400, sample: "Hello there",
    dismissed: [], frame: true, screenH: 900, ...over,
  };
}

function capture(p: PageData): Capture {
  return {
    url: p.finalUrl, page: p, before: { data: Buffer.from([1]), mime: "image/png" },
    // One qualified photo by default; NO_PHOTO is decided in capture by the downloaded file.
    photos: [{ data: Buffer.from([1]), mime: "image/jpeg", firstScreen: true,
      candidate: p.imgs[0] ?? { src: "https://janedoe.com/a.jpg", w: 1440, h: 800, y: 0, alt: "", kind: "img" } }],
    logo: null, linkStatus: {}, capturedAt: "2026-11-03T00:00:00.000Z",
  };
}

const facts = (over: Partial<PageData> = {}) => buildFacts(capture(page(over)));
const sheetLine = (sheet: string, start: string) => sheet.split("\n").find((l) => l.startsWith(start));

describe("fit flags", () => {
  it("BOT_CHECK for a Cloudflare title", () => {
    expect(facts({ title: "Just a moment..." }).flags).toContain("BOT_CHECK");
  });
  it("COMING_SOON for a placeholder page", () => {
    expect(facts({ sample: "Coming soon! Our new site launches in May." }).flags).toContain("COMING_SOON");
  });
  it("TOO_LITTLE_TEXT under 300 characters", () => {
    expect(facts({ textLength: 299 }).flags).toContain("TOO_LITTLE_TEXT");
    expect(facts({ textLength: 300 }).flags).not.toContain("TOO_LITTLE_TEXT");
  });
  it("NO_PHOTO only when no photo qualified (downloaded) in the capture", () => {
    const p = page({ imgs: [{ src: "https://janedoe.com/a.jpg", w: 484, h: 484, y: 700, alt: "", kind: "img" }] });
    // A small displayed photo whose file is large enough qualified in capture: no flag.
    expect(buildFacts(capture(p)).flags).toEqual([]);
    // A big displayed photo that did not qualify (no downloaded photo): flagged.
    expect(buildFacts({ ...capture(page()), photos: [] }).flags).toContain("NO_PHOTO");
  });
});

describe("sheet", () => {
  it("says when no button is in the first screen", () => {
    const f = facts({
      rows: [
        row(40, "Home", { tag: "a", href: "https://janedoe.com/" }),
        row(40, "About", { tag: "a", x: 200, href: "https://janedoe.com/about" }),
        row(400, "Ready to make memories?", { tag: "h1", fs: 40 }),
        row(1500, "Book now", { tag: "a", href: "https://janedoe.com/contact" }),
        row(1600, LONG),
      ],
      buttons: [{ text: "Home", href: "https://janedoe.com/", y: 40 }, { text: "About", href: "https://janedoe.com/about", y: 40 }, { text: "Book now", href: "https://janedoe.com/contact", y: 1500 }],
    });
    expect(f.sheet.split("\n")).toContain("First screen button: none");
  });

  it("names a first screen button and where it goes", () => {
    const f = facts({
      rows: [row(400, "Ready to make memories?", { tag: "h1", fs: 40 }), row(600, "Book now", { tag: "a", href: "https://janedoe.com/contact" }), row(1600, LONG)],
      buttons: [{ text: "Book now", href: "https://janedoe.com/contact", y: 600 }],
    });
    expect(sheetLine(f.sheet, "First screen button:")).toMatch(/"Book now".*\/contact/);
  });

  it("flags a logistics line bigger than the headline", () => {
    const f = facts({
      rows: [row(300, "Now booking 2026", { tag: "h2", fs: 48 }), row(420, "Ready to make memories?", { tag: "h1", fs: 22 }), row(1600, LONG)],
    });
    expect(f.sheet).toContain('"Now booking 2026" is the biggest line in the first screen, more than twice the size of "Ready to make memories?"');
  });

  it("finds a location line", () => {
    const f = facts({ rows: [row(400, "Hello", { fs: 40 }), row(2000, "based in Birmingham, Alabama"), row(1600, LONG)] });
    expect(f.sheet).toContain('Location: yes, "based in Birmingham, Alabama"');
  });

  it("says when no location is found", () => {
    const f = facts({ rows: [row(400, "Hello there friend", { fs: 40 }), row(1600, LONG)] });
    expect(f.sheet).toContain("Location: not found anywhere on the homepage");
  });

  it("detects a testimonial from a quote and a name line, with its position", () => {
    const f = facts({
      rows: [
        row(400, "Hello there friend", { fs: 40 }),
        row(1600, LONG),
        row(2300, "She made us feel so comfortable and the photos are stunning!", { tag: "h3", fs: 24 }),
        row(2420, "Sarah Miller", { tag: "h4" }),
      ],
    });
    expect(sheetLine(f.sheet, "Testimonials:")).toMatch(/^Testimonials: one found, about three screens down.*Sarah Miller/);
  });

  it("does not take a section heading after a paragraph for a testimonial name", () => {
    const f = facts({
      rows: [
        row(400, "Hello", { fs: 40 }),
        row(1600, LONG),
        row(1900, "Family Sessions", { tag: "h2", fs: 30 }),
        row(2000, "The Experience", { tag: "h3", fs: 16 }),
        row(2600, "Relaxed sessions where everyone gets to be themselves and laugh a lot."),
        row(2700, "Senior Portraits", { tag: "h4", fs: 16 }),
      ],
    });
    expect(sheetLine(f.sheet, "Testimonials:")).toBe("Testimonials: none found on the homepage");
  });

  it("counts a lone hero link with a menu word as a first screen button (menu at the bottom)", () => {
    const nav = (x: number, text: string) => row(830, text, { tag: "a", x, href: `https://janedoe.com/${text.toLowerCase()}` });
    const f = facts({
      navTop: false,
      rows: [row(300, "Ready to make memories?", { tag: "h1", fs: 44 }), row(760, "Contact", { tag: "a", href: "https://janedoe.com/contact" }),
        nav(100, "Home"), nav(200, "About"), nav(300, "Contact"), row(1600, LONG)],
    });
    expect(sheetLine(f.sheet, "First screen button:")).toMatch(/^First screen button: "Contact"/);
  });

  it("checks page.buttons before saying there is no first screen button", () => {
    const f = facts({
      rows: [row(300, "Ready to make memories?", { tag: "h1", fs: 44 }), row(1600, LONG)],
      buttons: [{ text: "Inquire", href: "https://janedoe.com/inquire", y: 600 }],
    });
    expect(sheetLine(f.sheet, "First screen button:")).toMatch(/^First screen button: "Inquire".*\/inquire/);
  });

  it("hedges absences when the capture is partial", () => {
    const f = facts({
      textLength: 5000,
      sample: "Jane Doe\nWedding photographer based in Austin, Texas\nAbout me",
      rows: [row(300, "Hello there", { tag: "h1", fs: 44 }), row(1600, "Light, laughter and long walks. ".repeat(4))],
    });
    const lines = f.sheet.split("\n");
    expect(lines[0]).toMatch(/^Capture note:/);
    expect(sheetLine(f.sheet, "Location:")).toBe('Location: yes, "Wedding photographer based in Austin, Texas" (position unknown)');
    for (const start of ["First screen button:", "Testimonials:", "Instagram block:", "About or intro:"]) {
      expect(sheetLine(f.sheet, start)).toMatch(/could not be checked/);
    }
  });

  it("finds a location only in the meta description", () => {
    const f = facts({ metaDesc: "Family photographer in Denver, Colorado", rows: [row(300, "Hello there", { fs: 44 }), row(1600, LONG)] });
    expect(sheetLine(f.sheet, "Location:")).toMatch(/^Location: only in the page's search description/);
  });

  it("hedges an Instagram or steps absence on a page with little text", () => {
    const f = facts();
    expect(sheetLine(f.sheet, "Instagram block:")).toMatch(/no text found for one/);
    expect(sheetLine(f.sheet, "Steps or process section:")).toMatch(/no text found for one/);
  });

  it("detects a testimonial heading", () => {
    const f = facts({ rows: [row(400, "Hello", { fs: 40 }), row(1600, LONG), row(1900, "Kind Words", { tag: "h2", fs: 32 }), row(2000, "Everything was perfect from start to end, thank you.")] });
    expect(sheetLine(f.sheet, "Testimonials:")).toMatch(/Kind Words/);
  });

  it("says when no testimonials are found", () => {
    expect(sheetLine(facts().sheet, "Testimonials:")).toBe("Testimonials: none found on the homepage");
  });

  it("detects an Instagram block right after the last testimonial", () => {
    const f = facts({
      rows: [
        row(400, "Hello", { fs: 40 }),
        row(1600, LONG),
        row(2300, "She made us feel so comfortable and the photos are stunning!", { tag: "h3", fs: 24 }),
        row(2420, "Sarah Miller", { tag: "h4" }),
        row(2700, "Follow along on Instagram", { tag: "h4" }),
      ],
    });
    expect(sheetLine(f.sheet, "Instagram block:")).toMatch(/^Instagram block: yes/);
    expect(sheetLine(f.sheet, "After the last testimonial:")).toMatch(/Instagram/);
  });

  it("detects an Instagram block from an instagram link", () => {
    const f = facts({ rows: [row(400, "Hello", { fs: 40 }), row(1600, LONG), row(2700, "@janedoe", { tag: "a", href: "https://www.instagram.com/janedoe" })] });
    expect(sheetLine(f.sheet, "Instagram block:")).toMatch(/^Instagram block: yes/);
  });

  it("flags a voice switch from we to I", () => {
    const f = facts({
      rows: [
        row(300, "We capture your story", { tag: "h1", fs: 44 }),
        row(500, "Our team travels everywhere", { fs: 18 }),
        row(1500, "About me", { tag: "h2", fs: 30 }),
        row(1600, "Hi, I'm Jane. I started taking photos when I was ten and my camera goes everywhere with me. I love it when I get to meet new people and hear their stories."),
      ],
    });
    const voice = sheetLine(f.sheet, "Voice:");
    expect(voice).toMatch(/first screen.*we\/our/);
    expect(voice).toMatch(/About.*I\/my/);
    expect(voice).toMatch(/switches/);
  });

  it("reports skimmability: page length, longest paragraph, text-only runs", () => {
    const para = (y: number) => row(y, "word ".repeat(60).trim());
    const f = facts({ pageHeight: 4500, imgs: [{ src: "https://janedoe.com/a.jpg", w: 1440, h: 800, y: 0, alt: "", kind: "img" }], rows: [row(400, "Hello", { fs: 40 }), para(1000), para(1300), para(1600), row(2000, "word ".repeat(120).trim())] });
    expect(sheetLine(f.sheet, "Page length:")).toBe("Page length: about five laptop screens");
    expect(sheetLine(f.sheet, "Longest paragraph:")).toMatch(/^Longest paragraph: about 120 words/);
    expect(sheetLine(f.sheet, "Runs of three or more text-only blocks in a row:")).toMatch(/one/);
  });
});

describe("trimmedText", () => {
  it("shortens other text first and keeps the first screen, About and testimonials whole", () => {
    const about = `Hi, I'm Jane. ${"I love meeting new families and hearing their stories. ".repeat(20)}`;
    const filler = (y: number) => row(y, `Gallery caption ${y}. ${"Golden light on the hills at dusk. ".repeat(30)}`);
    const f = facts({
      pageHeight: 30000,
      rows: [
        row(300, "Your family, as it really is", { tag: "h1", fs: 44 }),
        row(1000, "About me", { tag: "h2", fs: 30 }),
        row(1100, about),
        ...Array.from({ length: 20 }, (_, i) => filler(2000 + i * 1000)),
        row(23000, "She made us feel so comfortable and the photos are stunning!", { tag: "h3", fs: 24 }),
        row(23100, "Sarah Miller", { tag: "h4" }),
      ],
    });
    expect(f.trimmedText.length).toBeLessThanOrEqual(7200);
    expect(f.trimmedText).toContain("Your family, as it really is");
    expect(f.trimmedText).toContain(about.trim());
    expect(f.trimmedText).toContain("Sarah Miller");
    expect(f.trimmedText.indexOf("Your family")).toBeLessThan(f.trimmedText.indexOf("Sarah Miller"));
  });
});

describe("fixtures", () => {
  const gabby = buildFacts(capture(fixturePage("firecrawl-gabby.json")));
  const wjohns = buildFacts(capture(fixturePage("firecrawl-wjohns.json")));

  it("trimmedText removes nav and footer rows and stays under 7,200 chars", () => {
    expect(gabby.trimmedText.length).toBeLessThanOrEqual(7200);
    expect(gabby.trimmedText).not.toMatch(/© 2026/);
    expect(gabby.trimmedText).not.toMatch(/^(HOME|Home)$/m);
    expect(gabby.trimmedText).toContain("Hi I'm Gabrielle");
    // the slider repeats each slide four times; it appears once
    expect(gabby.trimmedText.match(/steps of life/gi)?.length).toBe(1);
    expect(wjohns.trimmedText.length).toBeLessThanOrEqual(7200);
    expect(wjohns.trimmedText).not.toMatch(/View fullsize/);
  });

  it("sheet contains no px or % numbers", () => {
    for (const f of [gabby, wjohns]) expect(f.sheet).not.toMatch(/\d\s*(px|%)/i);
  });

  it("sheet and trimmed text fit the token budget", () => {
    for (const f of [gabby, wjohns]) expect(f.sheet.length + f.trimmedText.length).toBeLessThanOrEqual(10000);
  });

  it("gabby facts match what Maggie saw", () => {
    expect(gabby.sheet.split("\n")).toContain("First screen button: none");
    expect(sheetLine(gabby.sheet, "Location:")).toMatch(/^Location: yes, "Gabby J Photography: Alabama Based, Travel Ready"/);
    expect(sheetLine(gabby.sheet, "Testimonials:")).toMatch(/Holleigh Colvin/);
    expect(sheetLine(gabby.sheet, "After the last testimonial:")).toMatch(/Instagram/);
    expect(gabby.sheet).toContain("Hi I'm Gabrielle");
    expect(gabby.flags).toEqual([]);
  });

  it("wjohns facts match what Maggie saw", () => {
    expect(wjohns.sheet.split("\n")).toContain("First screen button: none");
    expect(sheetLine(wjohns.sheet, "First button outside the menu:")).toMatch(/five screens down/);
    expect(sheetLine(wjohns.sheet, "Testimonials:")).toBe("Testimonials: none found on the homepage");
    expect(sheetLine(wjohns.sheet, "Gallery:")).toMatch(/screens long/);
  });

  it("pageText holds the full visible text, nav and footer included", () => {
    expect(gabby.pageText).toContain("© 2026 GabbyJPhotography");
    expect(gabby.pageText).toContain("Holleigh Colvin");
  });

  it("mockup from fixture", () => {
    const p = fixturePage("firecrawl-gabby.json");
    expect(gabby.mockup.nav_items).toEqual(p.nav);
    expect(gabby.mockup.nav_position).toBe("bottom");
    expect(gabby.mockup.nav_style).toBe("bar");
    expect(gabby.mockup.uppercase_headline).toBe(true);
    expect(gabby.mockup.heading_font).toBe("Vollkorn");
    expect(gabby.mockup.body_font).toBe("Work Sans");
    expect(gabby.mockup.logo_text).toBe("Gabby J Photography");
    expect(gabby.mockup.accent).toBeUndefined(); // light beige: white button text would not read
    expect(wjohns.mockup.nav_position).toBe("top");
    expect(wjohns.mockup.nav_style).toBe("bar");
    expect(wjohns.mockup.body_font).toBe("Poppins");
    expect(wjohns.mockup.nav_items).toEqual(["Home", "Portfolio", "About", "Investment", "Contact", "My Favorite Venues"]);
    expect(wjohns.mockup.heading_font).toBe("Manrope");
    expect(wjohns.mockup.logo_text).toBe("William Johns Photography");
  });

  it("logo_image when the capture has a logo", () => {
    const c = capture(page());
    c.logo = { data: Buffer.from([1]), mime: "image/png" };
    expect(buildFacts(c).mockup.logo_image).toBe("logo.png");
    expect(buildFacts(c).mockup.logo_text).toBeUndefined();
  });
});

describe("toGoogleFont", () => {
  it("maps fonts to Google families", () => {
    expect(toGoogleFont("brandon-grotesque", "body")).toBe("Montserrat");
    expect(toGoogleFont("Cormorant Garamond", "heading")).toBe("Cormorant Garamond");
    expect(toGoogleFont("Adobe Garamond Pro", "heading")).toBe("Cormorant Garamond");
    expect(toGoogleFont("work-sans", "body")).toBe("Work Sans");
    expect(toGoogleFont("Great Vibes Script", "heading")).toBe("Playfair Display");
    expect(toGoogleFont("SignPainter Handwritten", "body")).toBe("Montserrat");
    expect(toGoogleFont("", "heading")).toBe("Montserrat");
  });
});
