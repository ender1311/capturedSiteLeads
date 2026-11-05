import { AsyncLocalStorage } from "node:async_hooks";
import type { Browser, Page } from "puppeteer-core";
import { getBrowser } from "@/lib/pdf";
import { firstSectionHtml, contactSheetHtml } from "./render-html";
import { searchPlacement, type Measured, type PersonBox, type Placement, type Size } from "./placement";
import type { FirstSection } from "./types";

// Serialize renders per instance: concurrent @sparticuz/chromium extractions race on /tmp (ETXTBSY).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// One Chromium per report run (spec section 7): withBrowser scopes a browser to everything the
// run renders (AsyncLocalStorage, so two runs on one instance never share or close each other's),
// launched on the first render and closed when the run ends, however it ends. Each render gets a
// new page. Outside withBrowser a render launches and closes its own browser.
const runBrowser = new AsyncLocalStorage<{ browser?: Promise<Browser> }>();

export async function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const slot: { browser?: Promise<Browser> } = {};
  try {
    return await runBrowser.run(slot, fn);
  } finally {
    if (slot.browser) await slot.browser.then((b) => b.close()).catch(() => {});
  }
}

async function withPage<T>(
  viewport: { width: number; height: number; deviceScaleFactor?: number },
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const slot = runBrowser.getStore();
  if (slot) slot.browser ??= getBrowser();
  const browser = slot ? await slot.browser! : await getBrowser();
  let page: Page | undefined;
  try {
    page = await browser.newPage();
    // Nothing rendered here needs scripts (fonts load through <link>; page.evaluate still works),
    // and none of the page's content may run any.
    await page.setJavaScriptEnabled(false);
    await page.setViewport(viewport);
    return await fn(page);
  } finally {
    if (slot) await page?.close().catch(() => {});
    else await browser.close();
  }
}

async function load(page: Page, html: string) {
  await page.setContent(html, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
  await page.evaluate("document.fonts.ready");
}

export function renderContactSheet(beforeUri: string, photoUris: string[]): Promise<Buffer> {
  return serial(() =>
    withPage({ width: 1600, height: 900 }, async (page) => {
      await load(page, contactSheetHtml(beforeUri, photoUris));
      const el = await page.$("#sheet");
      return Buffer.from(await el!.screenshot({ type: "jpeg", quality: 80 }));
    })
  );
}

// Runs in the mockup page (page.evaluate works with JavaScript off). The copy block is the union of
// what its lines actually cover (a range per line of text, the button's own box), or the white box
// for the "box" layout. Overflow: text wider than its column, or copy outside the photo area.
const MEASURE = `(() => {
  const r = (b) => ({ x: b.left, y: b.top, w: b.width, h: b.height });
  const copy = document.getElementById("copy"), photo = document.getElementById("photo");
  if (!copy || !photo) return null;
  const h1 = copy.querySelector("h1");
  let box;
  if (copy.style.background) box = copy.getBoundingClientRect();
  else {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of copy.children) {
      let b;
      if (el.tagName === "SPAN") b = el.getBoundingClientRect();
      else { const g = document.createRange(); g.selectNodeContents(el); b = g.getBoundingClientRect(); }
      if (!b.width || !b.height) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    box = x0 === Infinity ? copy.getBoundingClientRect() : { left: x0, top: y0, width: x1 - x0, height: y1 - y0, right: x1, bottom: y1 };
  }
  const p = photo.getBoundingClientRect();
  const overflow = copy.scrollWidth > copy.clientWidth + 1 || (!!h1 && h1.scrollWidth > h1.clientWidth + 1)
    || box.top < p.top - 1 || box.top + box.height > p.bottom + 1 || box.left < p.left - 1 || box.left + box.width > p.right + 1;
  return { copy: r(box), photo: r(p), overflow };
})()`;

/** The photo's own size, decoded in the page from its data URI. */
async function naturalSize(page: Page, uri: string): Promise<Size | undefined> {
  const n = await page
    .evaluate(async (u: string) => {
      const i = new Image();
      i.src = u;
      await i.decode();
      return { w: i.naturalWidth, h: i.naturalHeight };
    }, uri)
    .catch(() => undefined);
  return n && typeof n === "object" && n.w > 0 && n.h > 0 ? n : undefined;
}

const sectionWith = (s: FirstSection, p: Placement): FirstSection => {
  const { photo_zoom: _z, headline_scale: _k, copy_width: _w, headline_glue: _g, ...rest } = s;
  void _z; void _k; void _w; void _g;
  return {
    ...rest, layout: p.layout, photo_focus: p.photo_focus,
    ...(p.photo_zoom && p.photo_zoom !== 1 ? { photo_zoom: p.photo_zoom } : {}),
    ...(p.headline_scale && p.headline_scale !== 1 ? { headline_scale: p.headline_scale } : {}),
    ...(p.copy_width ? { copy_width: p.copy_width } : {}),
    ...(p.headline_glue === false ? { headline_glue: false } : {}),
  };
};

export type Placed = {
  image: Buffer;
  /** The section as rendered: the chosen layout, focus and any zoom, scale, width or glue change. */
  section: FirstSection;
  placement: Placement; overlap: number; score: number; clean: boolean;
  /** Every candidate measured, in order (for the run log). */
  tried: { placement: Placement; overflow: boolean; overlap: number; score: number }[];
};

/**
 * The mockup with its words kept off the people: tries placements on one page (placement.ts),
 * measuring each, and screenshots only the chosen one. With no boxes, it only guards against
 * the headline overflowing its column.
 */
export function placeAfter(s: FirstSection, photoUri: string, logoUri?: string, boxes: PersonBox[] = []): Promise<Placed> {
  return serial(() =>
    withPage({ width: 1400, height: 878, deviceScaleFactor: 2 }, async (page) => {
      let natural: Size | undefined;
      let shown = "";
      const show = async (sec: FirstSection) => {
        const html = firstSectionHtml(sec, photoUri, logoUri);
        if (html === shown) return;
        await load(page, html);
        shown = html;
      };
      const base: Placement = {
        layout: s.layout || "left", photo_focus: s.photo_focus,
        ...(s.photo_zoom ? { photo_zoom: s.photo_zoom } : {}),
        ...(s.headline_scale ? { headline_scale: s.headline_scale } : {}),
        ...(s.copy_width ? { copy_width: s.copy_width } : {}),
      };
      const measure = async (p: Placement): Promise<Measured> => {
        await show(sectionWith(s, p));
        const m = (await page.evaluate(MEASURE)) as Omit<Measured, "natural"> | null;
        if (boxes.length && !natural) natural = await naturalSize(page, photoUri);
        // No measurement (a fake page in tests): nothing to compare, so the first candidate wins.
        if (!m || typeof m !== "object" || !("copy" in m)) {
          const zero = { x: 0, y: 0, w: 0, h: 0 };
          return { copy: zero, photo: zero, overflow: false };
        }
        return { ...m, natural };
      };
      const { chosen, tried } = await searchPlacement(base, boxes, measure);
      const section = sectionWith(s, chosen.placement);
      await show(section);
      const el = await page.$("#frame");
      const image = Buffer.from(await el!.screenshot({ type: "jpeg", quality: 90 }));
      return { image, section, placement: chosen.placement, overlap: chosen.overlap, score: chosen.score, clean: chosen.ok,
        tried: tried.map((t) => ({ placement: t.placement, overflow: t.measured.overflow, overlap: Math.round(t.overlap), score: Math.round(t.score) })) };
    })
  );
}

/** The mockup for a stored first section, as stored (only re-placed if its headline overflows). */
export async function renderAfter(s: FirstSection, photoUri: string, logoUri?: string): Promise<Buffer> {
  return (await placeAfter(s, photoUri, logoUri)).image;
}

export function renderPdf(html: string): Promise<{ pdf: Buffer; overflow: { page: number; hits: string[] }[] }> {
  return serial(() =>
    withPage({ width: 816, height: 1056 }, async (page) => {
      await load(page, html);
      const pdf = await page.pdf({ width: "816px", height: "1056px", printBackground: true, preferCSSPageSize: true });
      const overflow = (await page.evaluate(`
        [...document.querySelectorAll('section.pg')].map((pg, i) => {
          const box = pg.getBoundingClientRect(); const hits = [];
          pg.querySelectorAll('p,h1,h2,h3,h4,a,img,span').forEach(el => { const r = el.getBoundingClientRect(); if (r.height && (r.bottom > box.bottom - 20 || r.right > box.right + 1)) hits.push((el.innerText || el.alt || el.tagName).slice(0, 60)); });
          return { page: i + 1, hits };
        }).filter(p => p.hits.length)
      `)) as { page: number; hits: string[] }[];
      return { pdf: Buffer.from(pdf), overflow };
    })
  );
}
