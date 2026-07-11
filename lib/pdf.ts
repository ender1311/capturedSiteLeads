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

export async function htmlToPdf(html: string): Promise<Buffer> {
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
