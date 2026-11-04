import { getBrowser } from "@/lib/pdf";
import { firstSectionHtml, contactSheetHtml } from "./render-html";
import type { FirstSection } from "./types";

// Serialize renders per instance: concurrent @sparticuz/chromium extractions race on /tmp (ETXTBSY).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function withPage<T>(
  viewport: { width: number; height: number; deviceScaleFactor?: number },
  fn: (page: import("puppeteer-core").Page) => Promise<T>
): Promise<T> {
  const browser = await getBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function load(page: import("puppeteer-core").Page, html: string) {
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

export function renderAfter(s: FirstSection, photoUri: string, logoUri?: string): Promise<Buffer> {
  return serial(() =>
    withPage({ width: 1400, height: 878, deviceScaleFactor: 2 }, async (page) => {
      await load(page, firstSectionHtml(s, photoUri, logoUri));
      const el = await page.$("#frame");
      return Buffer.from(await el!.screenshot({ type: "jpeg", quality: 90 }));
    })
  );
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
