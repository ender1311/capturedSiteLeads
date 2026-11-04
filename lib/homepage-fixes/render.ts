import { AsyncLocalStorage } from "node:async_hooks";
import type { Browser, Page } from "puppeteer-core";
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
