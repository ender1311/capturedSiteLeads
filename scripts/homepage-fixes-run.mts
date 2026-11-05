// Spike CLI for "Your Top Homepage Fixes": runs the real pipeline on one site and writes every
// artifact to out/<first-name>-<domain>/ (git-ignored).
//
//   npx vite-node --config vitest.config.ts scripts/homepage-fixes-run.mts -- \
//     <first-name> <url> "<goal>" [--model id] [--capture-only] [--from-capture <out-folder>]
//
// --capture-only   capture + facts + contact sheet only (no Gemini): before.*, contact.jpg, facts.txt, capture.json
// --from-capture   reuse a saved capture.json and its images instead of calling Firecrawl
// Every run saves the capture, so a later Gemini run can reuse it with --from-capture.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Firecrawl } from "@mendable/firecrawl-js";
import { captureSite, CaptureError } from "@/lib/homepage-fixes/capture";
import { buildFacts, type Facts } from "@/lib/homepage-fixes/facts";
import { photoKey, runHomepageFixes, type PipelineResult } from "@/lib/homepage-fixes/pipeline";
import { placeAfter, renderContactSheet } from "@/lib/homepage-fixes/render";
import type { Asset, Capture } from "@/lib/homepage-fixes/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: homepage-fixes-run.mts <first-name> <url> "<goal>" [--model id] [--capture-only] [--from-capture <out-folder>]');
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  let model: string | undefined;
  let captureOnly = false;
  let fromCapture: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--model") model = argv[++i] ?? usage("--model needs an id");
    else if (a === "--capture-only") captureOnly = true;
    else if (a === "--from-capture") fromCapture = argv[++i] ?? usage("--from-capture needs a folder");
    else if (a.startsWith("--")) usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  const [firstName, url, goal = ""] = pos;
  if (!firstName || !url) usage();
  if (!captureOnly && !goal.trim()) usage("a goal is required unless --capture-only");
  return { firstName, url, goal, model, captureOnly, fromCapture };
}

const ext = (mime: string) => (/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : /svg/.test(mime) ? "svg" : /gif/.test(mime) ? "gif" : /avif/.test(mime) ? "avif" : "jpg");
const dataUri = (a: Asset) => `data:${a.mime};base64,${a.data.toString("base64")}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
const host = (url: string) => {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); } catch { return slug(url); }
};

// ---------- capture.json: the capture with its images saved as files next to it ----------

type SavedAsset = { file: string; mime: string };
type SavedCapture = Omit<Capture, "before" | "photos" | "logo"> & {
  before: SavedAsset;
  photos: (SavedAsset & { candidate: Capture["photos"][number]["candidate"]; firstScreen: boolean })[];
  logo: SavedAsset | null;
};

function saveCapture(dir: string, c: Capture): void {
  fs.mkdirSync(path.join(dir, "photos"), { recursive: true });
  const put = (file: string, a: Asset): SavedAsset => {
    fs.writeFileSync(path.join(dir, file), a.data);
    return { file, mime: a.mime };
  };
  const saved: SavedCapture = {
    url: c.url, page: c.page, linkStatus: c.linkStatus, capturedAt: c.capturedAt,
    before: put(`before.${ext(c.before.mime)}`, c.before),
    photos: c.photos.map((p, i) => ({ ...put(photoKey(i, p.mime), p), candidate: p.candidate, firstScreen: p.firstScreen })),
    logo: c.logo ? put(`logo.${ext(c.logo.mime)}`, c.logo) : null,
  };
  fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(saved, null, 1));
}

function loadCapture(dir: string): Capture {
  const s = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8")) as SavedCapture;
  const get = (a: SavedAsset): Asset => ({ data: fs.readFileSync(path.join(dir, a.file)), mime: a.mime });
  return {
    url: s.url, page: s.page, linkStatus: s.linkStatus, capturedAt: s.capturedAt,
    before: get(s.before),
    photos: s.photos.map((p) => ({ ...get(p), candidate: p.candidate, firstScreen: p.firstScreen })),
    logo: s.logo ? get(s.logo) : null,
  };
}

function factsText(f: Facts, c: Capture): string {
  const screens = c.page.screenH > 0 ? (c.page.pageHeight / c.page.screenH).toFixed(1) : "?";
  return [
    `Flags: ${f.flags.length ? f.flags.join(", ") : "none"}`,
    `Page: ${screens} screens, ${c.photos.length} photo candidate(s), nav ${JSON.stringify(c.page.nav)}, fonts ${JSON.stringify(c.page.fonts)}, logo ${c.logo ? c.logo.mime : "none"}, dismissed ${JSON.stringify(c.page.dismissed)}`,
    ...c.photos.map((p, i) => `Photo ${i + 1}: ${p.candidate.w}x${p.candidate.h} at y=${p.candidate.y}${p.firstScreen ? " (first screen)" : ""} ${p.candidate.kind} ${p.candidate.src}`),
    "",
    "# Fact sheet",
    f.sheet,
    "",
    "# Mockup settings",
    JSON.stringify(f.mockup, null, 1),
    "",
    "# Trimmed text",
    f.trimmedText,
  ].join("\n");
}

async function remainingCredits(): Promise<number | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;
  try {
    const u = await new Firecrawl({ apiKey }).getCreditUsage();
    return typeof u.remainingCredits === "number" ? u.remainingCredits : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = path.join(ROOT, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PUPPETEER_EXECUTABLE_PATH && process.platform === "darwin") {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  const dir = path.join(ROOT, "out", `${slug(args.firstName)}-${host(args.url)}`);
  fs.mkdirSync(dir, { recursive: true });
  const write = (file: string, data: string | Buffer) => fs.writeFileSync(path.join(dir, file), data);
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 100) / 10;

  // Capture: from a saved folder, or one Firecrawl scrape (saved right away either way).
  let firecrawlCredits: number | null = 0;
  let capture: Capture | undefined;
  if (args.fromCapture) {
    capture = loadCapture(path.resolve(args.fromCapture));
    saveCapture(dir, capture);
  } else {
    const before = await remainingCredits();
    try {
      capture = await captureSite(args.url);
      saveCapture(dir, capture);
    } catch (e) {
      if (!(e instanceof CaptureError)) throw e;
      const result = { outcome: "cant_see", reason: e.kind, message: e.message, elapsedSeconds: elapsed() };
      write("result.json", JSON.stringify(result, null, 1));
      console.log(JSON.stringify(result, null, 1));
      return;
    } finally {
      const after = await remainingCredits();
      firecrawlCredits = before !== null && after !== null ? before - after : null;
    }
  }
  const captureSeconds = elapsed();

  if (args.captureOnly) {
    const facts = buildFacts(capture);
    write("facts.txt", factsText(facts, capture));
    write("contact.jpg", await renderContactSheet(dataUri(capture.before), capture.photos.map(dataUri)));
    const result = {
      outcome: "captured", flags: facts.flags, photos: capture.photos.length,
      screens: capture.page.screenH > 0 ? +(capture.page.pageHeight / capture.page.screenH).toFixed(1) : null,
      nav: capture.page.nav, fonts: capture.page.fonts, mockup: facts.mockup,
      firecrawlCredits, captureSeconds, elapsedSeconds: elapsed(),
    };
    write("result.json", JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, null, 1));
    return;
  }

  const facts = buildFacts(capture);
  write("facts.txt", factsText(facts, capture));
  let lastAfter: Buffer | undefined;
  let afterRenders = 0;
  const placements: unknown[] = [];
  let r: PipelineResult;
  try {
    r = await runHomepageFixes(
      { firstName: args.firstName, website: args.url, goal: args.goal, model: args.model, capture },
      {
        renderContactSheet: async (b, p) => {
          const sheet = await renderContactSheet(b, p);
          write("contact.jpg", sheet);
          return sheet;
        },
        placeAfter: async (section, photo, logo, boxes) => {
          const placed = await placeAfter(section, photo, logo, boxes);
          lastAfter = placed.image;
          write(afterRenders++ ? `after-${afterRenders}.jpg` : "after.jpg", lastAfter);
          placements.push({ boxes, placement: placed.placement, overlap: Math.round(placed.overlap), clean: placed.clean, tried: placed.tried });
          return placed;
        },
      },
    );
  } catch (e) {
    const result = { outcome: "error", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), firecrawlCredits, elapsedSeconds: elapsed() };
    write("result.json", JSON.stringify(result, null, 1));
    console.error(JSON.stringify(result, null, 1));
    process.exitCode = 1;
    return;
  }

  if (r.outcome === "sent") {
    write("report.pdf", r.pdf);
    write("after.jpg", r.after);
  }
  if (r.outcome === "sent" || r.outcome === "held") write("content.json", JSON.stringify(r.content, null, 1));
  if (r.outcome === "hobby") write("content.json", JSON.stringify({ compliment: r.compliment }, null, 1));

  const result = {
    outcome: r.outcome,
    ...("reason" in r ? { reason: r.reason } : {}),
    ...(r.outcome === "held" ? { issues: r.issues } : {}),
    ...("model" in r ? { model: r.model } : {}),
    usage: r.usage, costUsd: +r.usage.costUsd.toFixed(5), afterRenders, placements,
    firecrawlCredits, captureSeconds, elapsedSeconds: elapsed(),
  };
  write("result.json", JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  console.log(`wrote ${path.relative(ROOT, dir)}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
