import puppeteer from "puppeteer-core";

async function getBrowser() {
  // Local dev: point PUPPETEER_EXECUTABLE_PATH at an installed Chrome.
  // On Vercel, @sparticuz/chromium provides the binary.
  const localExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;

  if (localExecutable) {
    return puppeteer.launch({
      executablePath: localExecutable,
      headless: true,
    });
  }

  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

async function renderOnce(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.evaluateHandle("document.fonts.ready");
    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// Fluid Compute reuses a warm instance across concurrent requests, so two
// PDF renders can race to extract the @sparticuz/chromium binary into /tmp
// and fail with ETXTBSY. Serialize renders per instance — volume is tiny, so
// the queueing cost is irrelevant.
let renderChain: Promise<unknown> = Promise.resolve();

export function htmlToPdf(html: string): Promise<Buffer> {
  const run = renderChain.then(
    () => renderOnce(html),
    () => renderOnce(html)
  );
  renderChain = run.catch(() => {});
  return run;
}
