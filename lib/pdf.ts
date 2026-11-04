import puppeteer from "puppeteer-core";

export async function getBrowser() {
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
