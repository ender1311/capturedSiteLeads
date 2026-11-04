import { toGoogleFont } from "./fonts";
import type { Capture, FirstSection, FitFlag, PageData } from "./types";

// Turns the capture into the compact fact sheet Gemini reads, plus the mockup settings.
// Everything here is scripted; the sheet never carries pixel numbers, only relative words.

export type ScriptMockup = Omit<FirstSection, "photo" | "photo_focus" | "layout" | "eyebrow" | "headline" | "subline" | "button">;
export type Facts = {
  flags: FitFlag[];
  sheet: string;        // compact fact lines, no pixel numbers
  trimmedText: string;  // ≤ 7,200 chars (~1,800 tokens)
  pageText: string;     // full visible text, for the quote check
  mockup: ScriptMockup;
};

const TRIM_LIMIT = 7200;
const MIN_PHOTO_W = 800;
// Same rules as the skill's capture.mjs.
const BOT_CHECK_RE = /just a moment|verify you are human|checking your browser|captcha|access denied|attention required|are you a robot/i;
const COMING_SOON_RE = /coming soon|under construction|launching soon|maintenance mode|site is currently unavailable/i;

type Block = {
  y: number; x: number; fs: number; fw: string; ff: string; tt: string; tag: string;
  href?: string; text: string; words: number;
};
type Role = "content" | "nav" | "logo" | "footer" | "noise" | "label";

// ---------- small text helpers ----------

const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const num = (n: number) => (n >= 0 && n <= 20 ? NUM[n] : String(n));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => norm(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, "").trim();
const wordCount = (s: string) => (norm(s) ? norm(s).split(" ").length : 0);
function clip(s: string, max: number): string {
  const t = norm(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 15)).replace(/[\s,;:.!-]+$/, "")}...`;
}
const q = (s: string, max = 120) => `"${clip(s, max)}"`;

// ---------- page structure ----------

const SOCIAL_RE = /instagram\.com|facebook\.com|pinterest\.|tiktok\.com|twitter\.com|x\.com\/|youtube\.com|linkedin\.com/i;
const CONTACT_RE = /contact|inquir|enquir|\bbook\b|booking|get in touch|get started|let'?s talk|work with|availability|reach out|schedule|mailto:/i;
const LOGISTICS_RE = /\b(now )?(booking|accepting|available|availability)\b|\b20\d\d\b|\bbased in\b|\bserving\b|\blocated\b|\bdates?\b|\bspots?\b|\bwaitlist\b|\bopen for\b/i;
const STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
  "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming", "District of Columbia", "Ontario", "British Columbia", "Alberta", "Quebec"];
const ABBR = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const LOCATION_RE = new RegExp(
  `\\b(${STATES.join("|")})\\b|\\b(based in|based out of|serving|located in|servicing)\\b|,\\s?(${ABBR})\\b|\\b(${ABBR})\\s?(&|and)\\s?(${ABBR})\\b`,
  "i",
);
// State abbreviations must be capitals ("IN", "OR"), so check that part case-sensitively.
const ABBR_CS_RE = new RegExp(`,\\s?(${ABBR})\\b|\\b(${ABBR})\\s?(&|and)\\s?(${ABBR})\\b`);
const hasLocation = (s: string) => {
  const m = s.match(LOCATION_RE);
  if (!m) return false;
  return m[1] || m[2] ? true : ABBR_CS_RE.test(s);
};
const TESTIMONIAL_HEAD_RE = /kind words|testimonials?|love notes|reviews?|what (my |our )?(clients|couples|families|people) (are )?say|praise|client love|happy clients/i;
const NOT_NAME_RE = /^(read|learn|view|see|contact|about|home|portfolio|follow|book|get|let|click|shop|more|meet|hello|hi)\b/i;
const NAME_RE = /^[-–—~\s]*[A-Z][\p{L}'’.-]+(\s+(&|and|[A-Z][\p{L}'’.-]*)){1,4}\s*$/u;
const INSTAGRAM_RE = /instagram/i;
const STEPS_RE = /\b(how it works|the process|my process|our process|what to expect|step one|step 1|first step|next steps?)\b/i;
const SERVICES_HEAD_RE = /\b(services|offerings|what i offer|what we offer|investment|packages|collections|pricing|sessions)\b/i;
const SERVICE_RE = /\b(weddings?|elopements?|engagements?|famil(?:y|ies)|seniors?|graduat\w*|engaged|married|profile pictures?|newborns?|maternity|portraits?|headshots?|couples?(?! of)|boudoir|branding|events?|births?|milestones?|pets?)\b/gi;
const ABOUT_HEAD_RE = /\babout\b|\bmeet\b|^(hi|hello|hey)\b|\bi'?m [A-Z]/i;
const WE_RE = /\b(we|we're|we've|we'll|our|ours|us)\b/gi;
const I_RE = /\b(I|I['’](m|ve|ll|d))(?![\w'’])/g;
const ME_RE = /\b(me|my|mine)\b/gi;
const YOU_RE = /\b(you|your|you're|yours|you'll|you've)\b/gi;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const iCount = (s: string) => count(s, I_RE) + count(s, ME_RE);

function sameStyle(a: Block, b: Block) {
  return a.fs === b.fs && a.ff === b.ff && a.fw === b.fw && a.tt === b.tt && a.href === b.href;
}

/** Dedupe repeated rows (sliders repeat their slides), join word-split rows into lines and lines into blocks. */
function toBlocks(page: PageData): Block[] {
  const seen = new Set<string>();
  const rows = page.rows
    .filter((r) => r.x > -1000 && r.x < 4000 && norm(r.text))
    .filter((r) => {
      const k = `${r.y}|${r.x}|${r.fs}|${norm(r.text)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // Lines: rows at the same height in the same style (Showit sets each word in its own span).
  type Line = Block & { parts: number; lastY: number };
  const lines: Line[] = [];
  for (const r of rows) {
    const b: Line = { y: r.y, x: r.x, fs: r.fs, fw: r.fw, ff: r.ff, tt: r.tt, tag: r.tag, href: r.href, text: norm(r.text), words: 0, parts: 1, lastY: r.y };
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.y - b.y) <= 3 && sameStyle(prev, b) && !b.href && b.x > prev.x &&
      b.x - prev.x <= prev.text.length * prev.fs * 0.75 + prev.fs * 2 && prev.text.length < 200 && b.text.length < 60) {
      prev.text = `${prev.text} ${b.text}`;
      prev.parts++;
    } else lines.push(b);
  }
  // Blocks: a heading set over several lines continues when it was word-split or breaks mid-sentence.
  const blocks: Line[] = [];
  for (const l of lines) {
    const prev = blocks[blocks.length - 1];
    const continues = prev && !l.href && sameStyle(prev, l) && l.y > prev.lastY && l.y - prev.lastY <= l.fs * 2.1 &&
      Math.abs(l.x - prev.x) < 600 && (prev.parts > 1 || /[,:;-]$/.test(prev.text) || /^[a-z]/.test(l.text));
    if (continues) {
      prev.text = `${prev.text} ${l.text}`;
      prev.parts++;
      prev.lastY = l.y;
    } else blocks.push({ ...l });
  }
  // Drop consecutive copies (slider slides shown again).
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && key(prev.text) === key(b.text) && !b.href) continue;
    out.push({ y: b.y, x: b.x, fs: b.fs, fw: b.fw, ff: b.ff, tt: b.tt, tag: b.tag, href: b.href, text: b.text, words: wordCount(b.text) });
  }
  return out;
}

function hrefPath(href: string, base: string): { same: boolean; label: string } {
  if (/^mailto:/i.test(href)) return { same: false, label: "an email link" };
  if (/^tel:/i.test(href)) return { same: false, label: "a phone link" };
  try {
    const u = new URL(href, base);
    const b = new URL(base);
    const host = (h: string) => h.replace(/^www\./, "");
    if (host(u.hostname) !== host(b.hostname)) return { same: false, label: host(u.hostname) };
    if (u.hash && u.pathname === b.pathname) return { same: true, label: "a spot on the same page" };
    return { same: true, label: u.pathname === "/" ? "the homepage" : u.pathname };
  } catch {
    return { same: false, label: href };
  }
}

// ---------- colors ----------

function rgb(c: string | null): [number, number, number, number] | null {
  if (!c) return null;
  const m = c.match(/rgba?\(([^)]*)\)/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return [p[0], p[1], p[2], p.length >= 4 ? p[3] : 1];
  }
  const h = c.match(/^#([0-9a-f]{6})$/i);
  return h ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16), 1] : null;
}
const hex = (c: [number, number, number, number]) => `#${c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
function luminance([r, g, b]: [number, number, number, number]) {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: [number, number, number, number], b: [number, number, number, number]) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
const WHITE: [number, number, number, number] = [255, 255, 255, 1];

// ---------- main ----------

export function buildFacts(c: Capture): Facts {
  const page = c.page;
  const H = page.screenH > 0 ? page.screenH : 900;
  const base = page.finalUrl || c.url;
  const where = (y: number) => (y < H ? "in the first screen" : `about ${num(Math.max(1, Math.round(y / H)))} screen${Math.round(y / H) > 1 ? "s" : ""} down`);

  // Fit flags
  const flags: FitFlag[] = [];
  const titleSample = `${page.title} ${page.sample}`;
  if (BOT_CHECK_RE.test(titleSample)) flags.push("BOT_CHECK");
  if (COMING_SOON_RE.test(titleSample)) flags.push("COMING_SOON");
  if (page.textLength < 300) flags.push("TOO_LITTLE_TEXT");
  if (!page.imgs.some((i) => i.w >= MIN_PHOTO_W && !/\.svg(\?|$)/i.test(i.src))) flags.push("NO_PHOTO");

  // Blocks and their roles
  const blocks = toBlocks(page);
  const sampleLines = page.sample.split("\n").map(norm).filter(Boolean);
  // A glyph set as an image or a dropped span can lose a word from a row ("Gabby Photography"
  // vs the visible "Gabby J Photography"); prefer the page's own line when it holds the row's words plus more.
  for (const b of blocks) if (b.y < H) b.text = fromSample(b.text, sampleLines);
  // Capture coverage: some builders hide text until it scrolls into view.
  const rowChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const partial = page.textLength > 0 && rowChars < page.textLength * 0.5;
  const unchecked = "could not be checked, part of the page text could not be read";
  const navKeys = new Set(page.nav.map((n) => key(n)));
  const isNavText = (b: Block) => navKeys.has(key(b.text));
  const homePath = (href?: string) => {
    if (!href) return false;
    const p = hrefPath(href, base);
    return p.same && p.label === "the homepage";
  };
  const labelCounts = new Map<string, number>();
  for (const b of blocks) if (b.text.length <= 20) labelCounts.set(key(b.text), (labelCounts.get(key(b.text)) ?? 0) + 1);

  // Footer: a second copy of the menu, or the copyright line, near the end of the page.
  const pageEnd = Math.max(page.pageHeight, ...blocks.map((b) => b.y));
  let footerY = Infinity;
  for (const b of blocks) {
    if (b.y < H) continue;
    const navHere = blocks.filter((o) => o.href && isNavText(o) && Math.abs(o.y - b.y) <= 6).length;
    if ((b.href && isNavText(b) && navHere >= 2) || /©|all rights reserved/i.test(b.text)) {
      if (b.y > pageEnd - 1.5 * H) { footerY = b.y; break; }
    }
  }
  const roles: Role[] = blocks.map((b) => {
    if (b.y >= footerY) return "footer";
    if (/^(\d{1,2}\s*)+$/.test(b.text) || /^\(?required\)?$/i.test(b.text) || /^skip to/i.test(b.text)) return "noise";
    if ((labelCounts.get(key(b.text)) ?? 0) >= 4) return "label";
    // Menu links come in a row; a lone link with a menu word (a hero "Contact" button) is a button.
    const navRow = blocks.filter((o) => o.href && isNavText(o) && Math.abs(o.y - b.y) <= 6).length >= 2;
    if (b.href && isNavText(b) && navRow && (b.y < 180 || (b.y >= H - 180 && b.y < H + 40))) return "nav";
    if (b.y < 180 && homePath(b.href)) return "logo";
    return "content";
  });
  const content = blocks.filter((_, i) => roles[i] === "content");
  const labels = blocks.filter((_, i) => roles[i] === "label");
  const firstScreen = blocks.filter((b, i) => b.y < H && (roles[i] === "content" || roles[i] === "logo"));
  const firstContent = content.filter((b) => b.y < H);

  const paraBlocks = content.filter((b) => b.words >= 20);
  const bodyFs = paraBlocks.length ? paraBlocks.map((b) => b.fs).sort((a, b) => a - b)[Math.floor(paraBlocks.length / 2)] : 16;

  // Testimonials
  type Testimonial = { y: number; end: number; quote?: Block; name?: Block; heading?: Block };
  const testimonials: Testimonial[] = [];
  // A name line is small (about body size, never bigger than the quote) and is not a section heading.
  const serviceWord = new RegExp(SERVICE_RE.source, "i");
  const isName = (b: Block, quote: Block) => !b.href && b.text.length <= 40 && NAME_RE.test(b.text) && !NOT_NAME_RE.test(b.text) &&
    !isNavText(b) && b.fs <= bodyFs * 1.2 && b.fs <= quote.fs && !serviceWord.test(b.text) && !SERVICES_HEAD_RE.test(b.text) && !/^the\b/i.test(b.text);
  content.forEach((b, i) => {
    if (b.href || b.words < 8) return;
    // The name line comes right after the quote (a lone quote mark may sit between).
    const next = content.slice(i + 1, i + 3).find((n) => n.text.length > 3);
    const name = next && next.y - b.y <= 500 && isName(next, b) ? next : undefined;
    if (name) testimonials.push({ y: b.y, end: name.y, quote: b, name });
  });
  for (const b of content) {
    if (b.words <= 8 && TESTIMONIAL_HEAD_RE.test(b.text) && !b.href && !testimonials.some((t) => t.y >= b.y && t.y - b.y < H)) {
      testimonials.push({ y: b.y, end: b.y, heading: b });
    }
  }
  testimonials.sort((a, b) => a.y - b.y);
  const inTestimonial = (b: Block) => testimonials.some((t) => t.quote === b || t.name === b);

  // About / intro
  const aboutIdx = (() => {
    const head = content.findIndex((b) => b.words <= 8 && ABOUT_HEAD_RE.test(b.text) && !b.href);
    if (head >= 0) {
      const p = content.findIndex((b, i) => i > head && b.words >= 25 && b.y - content[head].y < 800 && !inTestimonial(b));
      if (p >= 0) return p;
    }
    const firstPerson = content.findIndex((b) => b.words >= 25 && iCount(b.text) >= 2 && !inTestimonial(b));
    if (firstPerson >= 0) return firstPerson;
    return content.findIndex((b) => b.words >= 25 && !inTestimonial(b));
  })();
  const aboutBlocks: Block[] = [];
  if (aboutIdx >= 0) {
    const p = content[aboutIdx];
    for (let i = aboutIdx - 1; i >= 0 && aboutBlocks.length < 2; i--) {
      const h = content[i];
      if (p.y - h.y > 250 || h.words > 12 || h.href) break;
      aboutBlocks.unshift(h);
    }
    aboutBlocks.push(p);
  }
  const aboutSet = new Set(aboutBlocks);

  // Buttons (outside the menu)
  const buttons = content.filter((b) => b.href && b.text.length < 40 && b.words <= 6 && !SOCIAL_RE.test(b.href));
  const isContact = (b: Block) => CONTACT_RE.test(`${b.href ?? ""} ${b.text}`);
  const broken = (href?: string) => {
    const s = href ? c.linkStatus[href] : undefined;
    return typeof s === "number" && s >= 400 ? ", the link is broken" : s === "no response" ? ", the link did not answer" : "";
  };
  const goes = (b: { href?: string }) => `goes to ${hrefPath(b.href ?? "", base).label}${broken(b.href)}`;

  // Instagram
  const insta = content.find((b) => (INSTAGRAM_RE.test(b.text) || (b.href && /instagram\.com/i.test(b.href))) && b.words <= 12);

  // Gallery: Squarespace-style repeated labels ("View fullsize"), else a run of photos.
  const gallery = (() => {
    const pts = labels.length >= 6
      ? labels.map((l) => ({ y: l.y, h: 0 }))
      : page.imgs.filter((i) => i.kind === "img" && i.y >= 0).map((i) => ({ y: i.y, h: i.h }));
    pts.sort((a, b) => a.y - b.y);
    let best: typeof pts = [];
    let cur: typeof pts = [];
    for (const p of pts) {
      if (cur.length && p.y - cur[cur.length - 1].y > H * 0.6) cur = [];
      cur.push(p);
      if (cur.length > best.length) best = [...cur];
    }
    if (best.length < 6) return null;
    const ys = [...new Set(best.map((p) => p.y))];
    const gaps = ys.slice(1).map((y, i) => y - ys[i]).sort((a, b) => a - b);
    const tile = Math.max(...best.map((p) => p.h), gaps.length ? gaps[Math.floor(gaps.length / 2)] : H / 3);
    const start = best[0].y;
    const end = Math.max(...best.map((p) => p.y + (p.h || tile)));
    return { start, screens: (end - start) / H, count: best.length };
  })();

  // Contact form, pricing, steps, services
  const formSubmit = content.find((b) => /^(submit|send|send message|send inquiry)$/i.test(b.text) &&
    content.some((o) => /^e-?mail\b/i.test(o.text) && b.y - o.y < 1200 && b.y > o.y));
  const prices = content.filter((b) => /\$\s?\d/.test(b.text));
  const stepsHead = content.find((b) => b.words <= 10 && STEPS_RE.test(b.text));
  const servicesHead = content.find((b) => b.words <= 6 && SERVICES_HEAD_RE.test(b.text) && !b.href);
  // Service tiles: short heading-like lines naming at least two different services, outside the form.
  const inForm = (b: Block) => !!formSubmit && b.y <= formSubmit.y && formSubmit.y - b.y < 1200;
  const serviceTiles = content.filter((b) => b.words <= 4 && !b.href && b.fs >= bodyFs && !/[?!]$/.test(b.text) &&
    (b.text.match(SERVICE_RE) ?? []).length > 0 && !inTestimonial(b) && !inForm(b));
  const tileServices = new Set(serviceTiles.flatMap((b) => (b.text.match(SERVICE_RE) ?? []).map((m) => m.toLowerCase().replace(/s$/, ""))));

  // ---------- sheet ----------
  const L: string[] = [];

  // 1. The hero
  if (firstScreen.length) {
    const maxFs = Math.max(...firstScreen.map((b) => b.fs));
    const rel = (fs: number) => {
      const r = fs / maxFs;
      return r >= 0.97 ? "largest" : r >= 0.8 ? "almost as large as the largest" : r >= 0.6 ? "about two thirds the largest"
        : r >= 0.4 ? "about half the largest" : r >= 0.28 ? "about a third of the largest" : "a quarter of the largest or smaller";
    };
    L.push("First screen text, top to bottom:");
    for (const b of firstScreen.slice(0, 10)) {
      const notes = [rel(b.fs)];
      if (b.tt === "uppercase") notes.push("all caps");
      if (b.href && roles[blocks.indexOf(b)] === "logo") notes.push("site name link");
      else if (b.href) notes.push(`a link that ${goes(b)}`);
      L.push(`- ${q(b.text)} (${notes.join(", ")})`);
    }
  } else L.push("First screen text: none besides the menu");
  L.push(page.nav.length
    ? `Menu: ${page.nav.join(", ")} (${page.navTop ? "top" : "bottom"} of the first screen, ${page.navOverPhoto ? "over the photo" : "on a solid bar"})`
    : "Menu: none found");
  const heroButton: { text: string; href?: string } | undefined = buttons.find((b) => b.y < H) ?? page.buttons.find((pb) => {
    if (pb.y >= H || /^skip to/i.test(pb.text) || SOCIAL_RE.test(pb.href) || (pb.y < 180 && homePath(pb.href))) return false;
    const navRow = page.buttons.filter((o) => navKeys.has(key(o.text)) && Math.abs(o.y - pb.y) <= 6).length >= 2;
    return !(navKeys.has(key(pb.text)) && navRow);
  });
  L.push(heroButton ? `First screen button: ${q(heroButton.text, 40)} (${goes(heroButton)})`
    : `First screen button: ${partial ? unchecked : "none"}`);
  const locBlock = blocks.find((b, i) => roles[i] !== "noise" && hasLocation(b.text));
  if (locBlock) {
    const sentence = locBlock.text.length > 160
      ? (locBlock.text.split(/(?<=[.!?])\s+/).find((s) => hasLocation(s)) ?? locBlock.text)
      : locBlock.text;
    const small = locBlock.fs <= bodyFs ? ", small text" : "";
    L.push(`Location: yes, ${q(sentence, 160)} (${where(locBlock.y)}${small})`);
  } else {
    const inSample = sampleLines.find((l) => hasLocation(l));
    if (inSample) L.push(`Location: yes, ${q(inSample, 160)} (position unknown)`);
    else if (hasLocation(page.metaDesc)) L.push(`Location: only in the page's search description, not seen on the page: ${q(page.metaDesc, 160)}`);
    else L.push(partial ? `Location: ${unchecked}` : "Location: not found anywhere on the homepage");
  }

  // 2. CTA reinforcement
  const navContact = page.nav.find((n) => CONTACT_RE.test(n));
  L.push(`Menu has a contact link: ${navContact ? `yes (${q(navContact, 40)})` : "no"}`);
  L.push(buttons.length
    ? `Buttons outside the menu, top to bottom: ${buttons.slice(0, 6).map((b) => `${q(b.text, 40)} (${where(b.y)}, ${goes(b)})`).join("; ")}`
    : "Buttons outside the menu: none");
  L.push(`First button outside the menu: ${buttons.length ? `${where(buttons[0].y)} (${q(buttons[0].text, 40)})` : "none"}`);
  const inquiry = buttons.filter(isContact);
  L.push(`Inquiry buttons outside the menu: ${inquiry.length ? inquiry.slice(0, 4).map((b) => `${q(b.text, 40)} ${where(b.y)}`).join("; ") : "none"}`);
  L.push(`Contact form on the homepage: ${formSubmit ? `yes, ${where(formSubmit.y)}` : "none"}`);

  // 3. Sequencing: trust and the person, and what comes after the proof
  if (testimonials.length) {
    const first = testimonials[0];
    const quoted = testimonials.filter((t) => t.quote).slice(0, 2).map((t) => `${q(t.quote!.text, 60)} from ${t.name!.text}`);
    const heading = testimonials.find((t) => t.heading)?.heading;
    const n = testimonials.filter((t) => t.quote).length;
    L.push(n
      ? `Testimonials: ${num(n)} found, ${n > 1 ? "the first " : ""}${where(first.y)} (${quoted.join("; ")})${heading ? `, under ${q(heading.text, 40)}` : ""}`
      : `Testimonials: a ${q(heading!.text, 40)} section ${where(first.y)}`);
  } else L.push(`Testimonials: ${partial ? unchecked : "none found on the homepage"}`);
  // An image-only feed or steps graphic leaves no text, so absence is only stated on a page with plenty of text.
  const wordsOnPage = content.reduce((sum, b) => sum + b.words, 0);
  const absent = (what: string) => (partial ? unchecked : wordsOnPage >= 300 ? "none found" : `no text found for ${what}, it may be images only`);
  L.push(`Instagram block: ${insta ? `yes, ${where(insta.y)} (${q(insta.text, 60)})` : absent("one")}`);
  if (testimonials.length) {
    const last = testimonials[testimonials.length - 1];
    const next = content.find((b) => b.y > last.end && !inTestimonial(b) && !(last.heading && b.y - last.end < H * 0.75 && b.words >= 8));
    const nextLabel = !next ? "only the footer"
      : next === insta || (insta && Math.abs(insta.y - next.y) < 150) ? `the Instagram block (${q(insta!.text, 60)})`
        : formSubmit && next.y > formSubmit.y - 900 && next.y <= formSubmit.y ? "the contact form"
          : q(next.text, 80);
    L.push(`After the last testimonial: ${nextLabel}`);
  }
  const order: { y: number; label: string }[] = [];
  if (aboutBlocks.length) order.push({ y: aboutBlocks[0].y, label: "intro or About" });
  if (gallery) order.push({ y: gallery.start, label: "photo gallery" });
  if (testimonials.length) order.push({ y: testimonials[0].y, label: "testimonials" });
  if (insta) order.push({ y: insta.y, label: "Instagram" });
  if (stepsHead) order.push({ y: stepsHead.y, label: "steps or process" });
  if (servicesHead) order.push({ y: servicesHead.y, label: "services" });
  if (prices.length >= 2) order.push({ y: prices[0].y, label: "prices" });
  if (inquiry.length) order.push({ y: inquiry[0].y, label: "first inquiry button" });
  if (formSubmit) order.push({ y: formSubmit.y, label: "contact form" });
  order.sort((a, b) => a.y - b.y);
  if (order.length) L.push(`Order down the page: ${order.map((o) => `${o.label} (${where(o.y)})`).join(", ")}`);

  // 4. Real visual hierarchy
  if (firstContent.length) {
    const biggest = firstContent.reduce((m, b) => (b.fs > m.fs ? b : m), firstContent[0]);
    const logistic = (b: Block) => LOGISTICS_RE.test(b.text) || (hasLocation(b.text) && b.words <= 6);
    const persuasive = firstContent.filter((b) => b !== biggest && !logistic(b) && b.words >= 2 && !b.href).sort((a, b) => b.fs - a.fs)[0];
    if (logistic(biggest) && persuasive) {
      const r = biggest.fs / persuasive.fs;
      const cmp = r >= 2 ? "more than twice the size of" : r >= 1.25 ? "bigger than" : r >= 0.8 ? "about the same size as" : "smaller than";
      L.push(`${q(biggest.text, 80)} is the biggest line in the first screen, ${cmp} ${q(persuasive.text, 80)}`);
    } else L.push(`Biggest line in the first screen: ${q(biggest.text, 80)}`);
  }
  const below = content.filter((b) => b.y >= H && b.fs >= bodyFs * 1.25 && b.words <= 20 && !inTestimonial(b)).sort((a, b) => b.fs - a.fs).slice(0, 3);
  if (below.length) {
    const vsBody = (fs: number) => { const r = fs / bodyFs; return r >= 2 ? "more than twice the body text" : r >= 1.5 ? "about one and a half times the body text" : "a bit bigger than the body text"; };
    L.push(`Largest lines below the first screen: ${below.map((b) => `${q(b.text, 60)} (${where(b.y)}, ${vsBody(b.fs)}${LOGISTICS_RE.test(b.text) || hasLocation(b.text) ? ", a location or booking line" : ""})`).join("; ")}`);
  }

  // 5. Coherence
  const sections: { name: string; text: string }[] = [
    { name: "first screen", text: firstContent.filter((b) => !aboutSet.has(b)).map((b) => b.text).join(" ") },
    { name: "About", text: aboutBlocks.map((b) => b.text).join(" ") },
    { name: "rest of the page", text: content.filter((b) => b.y >= H && !aboutSet.has(b) && !inTestimonial(b)).map((b) => b.text).join(" ") },
  ];
  const voices = sections.map((s) => {
    const we = count(s.text, WE_RE);
    const i = iCount(s.text);
    return { name: s.name, v: we > i ? "we/our" : i > we ? "I/my" : "" };
  }).filter((s) => s.v);
  if (!voices.length) L.push("Voice: no first person words found");
  else if (new Set(voices.map((v) => v.v)).size > 1) L.push(`Voice: ${voices.map((v) => `${v.name} mostly "${v.v}"`).join(", ")}; it switches between sections`);
  else L.push(`Voice: "${voices[0].v}" throughout`);
  const headings = content.filter((b) => b.fs >= bodyFs * 1.25 && b.words <= 20 && !inTestimonial(b));
  if (headings.length) {
    const fams = [...new Set(headings.map((b) => b.ff).filter(Boolean))];
    const caps = new Set(headings.map((b) => b.tt === "uppercase"));
    L.push(`Heading styles: ${fams.length === 1 ? "one font" : `${num(fams.length)} fonts`} (${fams.slice(0, 4).join(", ")}), ${caps.size > 1 ? "some in all caps and some not" : caps.has(true) ? "all in caps" : "none in all caps"}`);
  }

  // 6. Services summary, steps
  if (servicesHead) L.push(`Services summary on the homepage: yes (${q(servicesHead.text, 40)}), ${where(servicesHead.y)}`);
  else if (prices.length >= 2) L.push(`Services summary on the homepage: yes, a pricing section ${where(prices[0].y)}`);
  else if (tileServices.size >= 2) L.push(`Services summary on the homepage: yes, short lines like ${serviceTiles.slice(0, 4).map((b) => q(b.text, 40)).join(", ")}, ${where(serviceTiles[0].y)}`);
  else {
    const named = [...new Set(content.flatMap((b) => (b.text.match(SERVICE_RE) ?? []).map((s) => s.toLowerCase())))];
    L.push(named.length
      ? `Services summary on the homepage: none as its own section; named only inside paragraphs: ${named.slice(0, 8).join(", ")}`
      : "Services summary on the homepage: none");
  }
  L.push(`Steps or process section: ${stepsHead ? `yes (${q(stepsHead.text, 40)}), ${where(stepsHead.y)}` : absent("one")}`);

  // 7. Skimmability
  L.push(`Page length: about ${num(Math.max(1, Math.round(page.pageHeight / H)))} laptop screen${Math.round(page.pageHeight / H) > 1 ? "s" : ""}`);
  const longest = content.reduce<Block | null>((m, b) => (!m || b.words > m.words ? b : m), null);
  if (longest && longest.words >= 15) L.push(`Longest paragraph: about ${num(longest.words)} words (${q(longest.text, 50)}, ${where(longest.y)})`);
  const photoSpans = [
    ...page.imgs.filter((i) => i.kind === "img" && i.y >= H * 0.5).map((i) => ({ top: i.y, bottom: i.y + i.h })),
    ...labels.map((l) => ({ top: l.y, bottom: l.y + 1 })),
  ];
  const runs: Block[][] = [];
  let run: Block[] = [];
  for (const b of content.filter((x) => x.words >= 25 && !inTestimonial(x))) {
    const prev = run[run.length - 1];
    const beside = photoSpans.some((s) => s.top <= b.y + 50 && s.bottom >= b.y);
    const between = prev && photoSpans.some((s) => s.top > prev.y && s.top < b.y);
    if (beside || between) { if (run.length >= 3) runs.push(run); run = beside ? [] : [b]; continue; }
    run.push(b);
  }
  if (run.length >= 3) runs.push(run);
  L.push(`Runs of three or more text-only blocks in a row: ${runs.length ? `${num(runs.length)}, ${runs.length > 1 ? "the first " : ""}starting ${where(runs[0][0].y)}` : "none"}`);
  L.push(gallery
    ? `Gallery: about ${gallery.screens < 0.75 ? "half a screen" : `${num(Math.round(gallery.screens))} screen${Math.round(gallery.screens) > 1 ? "s" : ""}`} long, starting ${where(gallery.start)}`
    : "Gallery: no long photo gallery");

  // 8. About
  if (aboutBlocks.length) {
    const text = aboutBlocks.map((b) => b.text).join(" ");
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => wordCount(s) >= 3);
    let me = 0, them = 0;
    for (const s of sentences) {
      const i = iCount(s) + count(s, WE_RE);
      const y = count(s, YOU_RE);
      if (i > y) me++; else if (y > i) them++;
    }
    L.push(`About or intro, ${where(aboutBlocks[0].y)}, word for word:`);
    for (const b of aboutBlocks) L.push(`  ${clip(b.text, 1200)}`);
    L.push(`About focus: ${num(me)} sentence${me === 1 ? "" : "s"} mostly about the photographer, ${num(them)} mostly about the visitor`);
  } else L.push(`About or intro: ${partial ? unchecked : "none found on the homepage"}`);

  if (partial) L.unshift("Capture note: part of the page text could not be measured, so some sections may be missing from these facts; the extra text at the end of the homepage text is from the top of the page, in reading order");

  // ---------- trimmed text ----------
  type T = { text: string; keep: boolean };
  const lines: T[] = [];
  let galleryNoted = false;
  let lastKey = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const role = roles[i];
    if (role === "label") {
      if (!galleryNoted && gallery) { lines.push({ text: `(photo gallery, about ${gallery.screens < 0.75 ? "half a screen" : `${num(Math.round(gallery.screens))} screens`} long)`, keep: false }); galleryNoted = true; }
      continue;
    }
    if (role !== "content" && role !== "logo") continue;
    const k = key(b.text);
    if (!k || k === lastKey) continue;
    lastKey = k;
    lines.push({ text: b.text, keep: b.y < H || aboutSet.has(b) || inTestimonial(b) });
  }
  if (partial) {
    const have = new Set(lines.map((l) => key(l.text)));
    const extra = page.sample.split("\n").map(norm)
      .filter((s) => s.length > 1 && !have.has(key(s)) && !navKeys.has(key(s)) && !/^skip to/i.test(s) && (labelCounts.get(key(s)) ?? 0) < 4)
      .filter((s) => { const k = key(s); if (have.has(k)) return false; have.add(k); return true; });
    if (extra.length) lines.push({ text: "(more text from the top of the page)", keep: false }, ...extra.map((text) => ({ text, keep: false })));
  }
  const total = () => lines.reduce((s, l) => s + l.text.length + 1, 0);
  for (let guard = 0; total() > TRIM_LIMIT && guard < 1000; guard++) {
    const long = lines.filter((l) => !l.keep && l.text.length > 240).sort((a, b) => b.text.length - a.text.length)[0];
    if (long) { long.text = clip(long.text, Math.floor(long.text.length / 2)); continue; }
    const idx = lines.map((l) => l.keep).lastIndexOf(false);
    if (idx >= 0) { lines.splice(idx, 1); continue; }
    const big = lines.reduce((m, l) => (l.text.length > m.text.length ? l : m), lines[0]);
    big.text = clip(big.text, Math.floor(big.text.length * 0.7));
  }
  const trimmedText = lines.map((l) => l.text).join("\n").slice(0, TRIM_LIMIT);

  // ---------- page text for the quote check ----------
  const pageText = [...new Set([...blocks.map((b) => b.text), ...page.nav, ...page.sample.split("\n").map(norm).filter(Boolean)])].join("\n");

  // ---------- mockup ----------
  const mockup: ScriptMockup = {
    nav_position: page.navTop ? "top" : "bottom",
    nav_style: page.navOverPhoto ? "over" : "bar",
    nav_items: page.nav,
    heading_font: toGoogleFont(page.fonts.heading, "heading"),
    body_font: toGoogleFont(page.fonts.body || mostCommon(paraBlocks.map((b) => b.ff)) || "", "body"),
    uppercase_headline: page.uppercaseHeadings,
  };
  const weight = parseInt(page.fonts.headingWeight, 10);
  if (weight >= 100 && weight <= 900) mockup.heading_weight = weight;
  if (!page.navOverPhoto) {
    const bg = rgb(page.navBg);
    const solidBg = bg && bg[3] > 0.5 ? bg : null;
    if (solidBg) mockup.nav_background = hex(solidBg);
    // The menu color can come from the site title link; only trust it if it reads on the bar.
    const fg = rgb(page.navColor);
    if (fg && contrast(fg, solidBg ?? WHITE) >= 3) mockup.nav_color = hex(fg);
  }
  if (c.logo) mockup.logo_image = `logo.${logoExt(c.logo.mime)}`;
  else mockup.logo_text = siteName(page, blocks, base);
  // Accent fills the button behind white text, so it must read with white on it.
  const accent = rgb(page.accent);
  if (accent && accent[3] > 0.5 && contrast(accent, WHITE) >= 3) mockup.accent = hex(accent);

  return { flags, sheet: L.join("\n"), trimmedText, pageText, mockup };
}

/** The sample (innerText) line that holds all of the row's words in order plus a few more, else the row text. */
function fromSample(text: string, sampleLines: string[]): string {
  const want = key(text).split(" ").filter(Boolean);
  if (!want.length) return text;
  const rowCaps = text === text.toUpperCase();
  for (const line of sampleLines) {
    const have = key(line).split(" ").filter(Boolean);
    if (have.length <= want.length || have.length > want.length + 3) continue;
    // innerText applies text-transform; keep the row's own casing unless the row is caps too.
    if (line === line.toUpperCase() && !rowCaps) continue;
    let i = 0;
    for (const w of have) if (w === want[i]) i++;
    if (i === want.length) return line;
  }
  return text;
}

function mostCommon(xs: string[]): string | undefined {
  const m = new Map<string, number>();
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function logoExt(mime: string): string {
  if (/svg/.test(mime)) return "svg";
  if (/jpe?g/.test(mime)) return "jpg";
  if (/webp/.test(mime)) return "webp";
  return "png";
}

/** The business name: the title part that matches the site-name link, else the most name-like part. */
function siteName(page: PageData, blocks: Block[], base: string): string {
  const homeLink = blocks.find((b) => b.y < 180 && b.href && hrefPath(b.href, base).label === "the homepage" && b.words <= 6);
  const parts = page.title.split(/\s+[-|–—:·•]\s+|\s*[|–—·•]\s*|(?<=[a-z])-(?=[A-Z])/).map(norm).filter(Boolean);
  const cands = [...parts, ...(homeLink ? [homeLink.text] : [])];
  if (!cands.length) {
    try { return new URL(base).hostname.replace(/^www\./, ""); } catch { return ""; }
  }
  const score = (p: string) =>
    (homeLink && key(homeLink.text) === key(p) ? 5 : 0) +
    (/photo|studio|films?|creative|\bco\b/i.test(p) ? 1 : 0) -
    (/photographer\b|based|wedding|ready|serving|&/i.test(p) ? 2 : 0);
  const best = cands.reduce((m, p) => (score(p) > score(m) ? p : m), cands[0]);
  return best.includes(" ") ? best : best.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}
