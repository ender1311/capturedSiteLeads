import { DEFAULT_MODEL } from "@/lib/models";
import { captureSite, CaptureError, imageMime } from "./capture";
import { buildFacts, type Facts } from "./facts";
import { placeAfter, renderContactSheet, renderPdf, withBrowser } from "./render";
import { fillReport } from "./render-html";
import { autoFix, checkContent, checkText, fieldsOf, fixText, type RuleIssue } from "./rules";
import type { Asset, Capture, FirstSection, FitFlag, ReportContent, Usage } from "./types";
import { addUsage, locatePeople, lookCheck, repairFields, writeReport, type Written } from "./write";

// One report, end to end: capture → facts → fit flags → contact sheet → Gemini → rules →
// mockup + look check → PDF + overflow check. Delivery is the caller's job ("sent" = ready to send).

export type PipelineResult =
  | { outcome: "sent"; content: ReportContent; pdf: Buffer; before: Buffer; after: Buffer; facts: Facts; usage: Usage; model: string }
  | { outcome: "hobby"; compliment: string; facts: Facts; usage: Usage; model: string }
  | { outcome: "cant_see"; reason: FitFlag | "unreachable" | "bot_check" | "empty"; usage: Usage }
  | { outcome: "held"; reason: string; content: ReportContent; issues: RuleIssue[]; facts: Facts; usage: Usage; model: string };

export type Stages = {
  capture: typeof captureSite; write: typeof writeReport; repair: typeof repairFields; look: typeof lookCheck;
  locate: typeof locatePeople; placeAfter: typeof placeAfter; renderPdf: typeof renderPdf; renderContactSheet: typeof renderContactSheet;
  now: () => number; // injectable clock for the deadline
};

const REAL: Stages = {
  capture: captureSite, write: writeReport, repair: repairFields, look: lookCheck,
  locate: locatePeople, placeAfter, renderPdf, renderContactSheet, now: () => Date.now(),
};

// The route has 300 s; stop starting optional steps when less than two minutes of the budget are
// left, so delivery (Blob uploads, Resend, MailerLite, the row update) still fits.
export const DEFAULT_DEADLINE_MS = 270_000;
const MIN_LEFT_MS = 120_000;
// The Gemini write call is never optional, so it only starts (and only re-tries) with room for one
// attempt (40 s abort) plus what always follows it: the mockup render, the first look check and
// the PDF render (about 50 s together). Delivery runs in the 30 s between the 270 s budget and the
// route's 300 s maxDuration. Under this, the run throws OutOfTimeError and the lead is retried with
// a full budget instead of being killed mid-run.
export const WRITE_MIN_MS = 90_000;
// The hobby email's sentence when the model's compliment breaks a hard rule.
export const FALLBACK_COMPLIMENT = "Thanks so much for sharing your site with me.";

/** Not enough time left to finish safely: a plain (retryable) error, so the lead goes to retrying. */
export class OutOfTimeError extends Error {
  constructor(step: string) {
    super(`out of time before ${step}; retrying with a full budget`);
    this.name = "OutOfTimeError";
  }
}
const NEXT_PHOTO_FOCUS = "50% 40%";

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
const dataUri = (a: Asset) => `data:${a.mime};base64,${a.data.toString("base64")}`;

/** Re-checks every asset's type (a cached capture keeps what was stored): bad ones are re-sniffed or dropped. */
function cleanAssets(c: Capture): Capture {
  const clean = <T extends Asset>(a: T): T | null => {
    const mime = imageMime(a.mime, a.data);
    return mime ? { ...a, mime } : null;
  };
  const before = clean(c.before);
  if (!before) throw new CaptureError("empty", "The screenshot is not an image");
  return {
    ...c, before,
    logo: c.logo ? clean(c.logo) : null,
    photos: c.photos.map(clean).filter((p): p is Capture["photos"][number] => p !== null),
  };
}
const ext = (mime: string) => (/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : /gif/.test(mime) ? "gif" : /avif/.test(mime) ? "avif" : "jpg");
/** The key a photo goes by in content.json, the skill's convention: photos/photo-01.jpg. */
export const photoKey = (index: number, mime: string) => `photos/photo-${String(index + 1).padStart(2, "0")}.${ext(mime)}`;
const errors = (issues: RuleIssue[]) => issues.filter((i) => i.level === "error");

type Report = Extract<Written, { fit: "report" }>;

export function assembleContent(
  input: { firstName: string; website: string; goal: string }, facts: Facts, w: Report, photo: string,
): ReportContent {
  const first_section: FirstSection = {
    ...facts.mockup,
    photo, photo_focus: w.photo_focus, layout: w.layout,
    headline: w.headline, subline: w.subline, button: w.button,
  };
  if (w.eyebrow.trim()) first_section.eyebrow = w.eyebrow;
  return {
    first_name: input.firstName, website: input.website, goal: input.goal,
    first_section,
    first_section_changes: [...w.first_section_changes],
    fixes: [
      { ...w.fixes[0], changes: [...w.fixes[0].changes] },
      { ...w.fixes[1], changes: [...w.fixes[1].changes] },
    ],
    notes_for_maggie: w.notes_for_maggie,
  };
}

const flat = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** Map the PDF's overflowing elements (innerText, first 60 characters) back to the copy fields they show. */
export function overflowIssues(c: ReportContent, overflow: { page: number; hits: string[] }[]): RuleIssue[] {
  const fields = fieldsOf(c).filter(([label]) => !label.startsWith("first_section."));
  const out: RuleIssue[] = [];
  for (const { page, hits } of overflow) {
    for (const hit of hits) {
      const h = flat(hit);
      if (h.length < 12) continue;
      const match = fields.find(([, text]) => flat(text).startsWith(h.slice(0, 50)));
      if (match && !out.some((i) => i.field === match[0])) {
        out.push({
          field: match[0], level: "error",
          message: `runs past the bottom of page ${page} of the report. Shorten it by about a quarter, keeping the meaning and the voice.`,
        });
      }
    }
  }
  return out;
}

type RunInput = {
  firstName: string; website: string; goal: string; model?: string; capture?: Capture; deadlineMs?: number;
  /** The lead still has a retry left: an optional step's time cutoff retries instead of holding. */
  canRetry?: boolean;
};

/** One report run; every render in it shares one Chromium, closed when the run ends. */
export function runHomepageFixes(input: RunInput, stages: Partial<Stages> = {}): Promise<PipelineResult> {
  return withBrowser(() => run(input, stages));
}

async function run(input: RunInput, stages: Partial<Stages>): Promise<PipelineResult> {
  const s: Stages = { ...REAL, ...stages };
  const deadline = s.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const hasTime = () => deadline - s.now() >= MIN_LEFT_MS;
  const ensureWriteTime = (step: string) => {
    if (deadline - s.now() < WRITE_MIN_MS) throw new OutOfTimeError(step);
  };
  const model = input.model ?? DEFAULT_MODEL;
  let usage: Usage = { ...ZERO };

  // 1. Capture (one Firecrawl scrape), unless the caller already has it.
  let capture: Capture;
  try {
    capture = cleanAssets(input.capture ?? (await s.capture(input.website)));
  } catch (e) {
    if (e instanceof CaptureError) return { outcome: "cant_see", reason: e.kind, usage };
    throw e;
  }

  // 2. Facts and fit flags, all scripted. A capture with no downloaded photo has nothing to mock up.
  const facts = buildFacts(capture);
  if (facts.flags.length) return { outcome: "cant_see", reason: facts.flags[0], usage };
  if (!capture.photos.length) return { outcome: "cant_see", reason: "NO_PHOTO", usage };

  const beforeUri = dataUri(capture.before);
  const photoUris = capture.photos.map(dataUri);
  const logoUri = capture.logo ? dataUri(capture.logo) : undefined;

  // 3. Gemini writes the diagnosis and copy from the fact sheet and the contact sheet.
  const contactSheet = await s.renderContactSheet(beforeUri, photoUris);
  ensureWriteTime("the write call");
  const w = await s.write({
    firstName: input.firstName, website: input.website, goal: input.goal,
    facts, contactSheet, photoCount: capture.photos.length, model,
    beforeRetry: () => ensureWriteTime("the second write attempt"),
  });
  usage = addUsage(usage, w.usage);
  const written = w.written;
  if (written.fit === "hobby") {
    // Goes straight into the email, so it gets the same hard rules; a failure uses a safe sentence.
    const fixed = fixText(written.compliment);
    const bad = checkText("compliment", fixed, undefined, facts.pageText).some((i) => i.level === "error");
    return { outcome: "hobby", compliment: bad || !fixed ? FALLBACK_COMPLIMENT : fixed, facts, usage, model };
  }

  const photoIndex = Math.min(Math.max(written.photo_choice, 1), capture.photos.length) - 1;
  let content = autoFix(assembleContent(input, facts, written, photoKey(photoIndex, capture.photos[photoIndex].mime)));
  const held = (reason: string, issues: RuleIssue[]): PipelineResult =>
    ({ outcome: "held", reason, content, issues, facts, usage, model });
  // An optional step's time cutoff: retry with a full budget while the lead has a retry left, else hold.
  const outOfTime = (step: string, issues: RuleIssue[]): PipelineResult => {
    if (input.canRetry) throw new OutOfTimeError(step);
    return held("out of time", issues);
  };

  // 4. Rule check; one repair call for error-level issues only. Warnings never block.
  let issues = checkContent(content, facts.pageText);
  if (errors(issues).length) {
    if (!hasTime()) return outOfTime("the repair call", issues);
    const r = await s.repair({ content, issues, model });
    usage = addUsage(usage, r.usage);
    content = autoFix(r.content);
    issues = checkContent(content, facts.pageText);
    if (errors(issues).length) return held("rule check failed after one repair", issues);
  }

  // 5. Mockup and look check. Gemini finds the people in the photo, the renderer places the words
  // off them (placement.ts: smaller, narrower, the other side, or the photo shifted), and the look
  // check judges the result. If it fails: the next photo, the same way.
  const look = async (sec: FirstSection, index: number) => {
    const photo = capture.photos[index];
    const loc = await s.locate(photo.data, photo.mime, model);
    usage = addUsage(usage, loc.usage);
    const placed = await s.placeAfter(sec, photoUris[index], logoUri, loc.boxes);
    const l = await s.look(placed.image, model);
    usage = addUsage(usage, l.usage);
    return { after: placed.image, section: placed.section, l };
  };
  type Look = { faces_ok: boolean; headline_readable: boolean; looks_like_template: boolean };
  const lookProblems = (l: Look) => [
    !l.faces_ok && "a face is cut off or covered",
    !l.headline_readable && "the headline is hard to read",
    l.looks_like_template && "it looks like a generic template",
  ].filter((p): p is string => !!p);
  const lookMessage = (l: Look) => `look check: ${lookProblems(l).join("; ")}.`;
  const lookIssue = (l: Look): RuleIssue => ({ field: "first_section", level: "error", message: lookMessage(l) });

  // Every render tried, so the best one can go out if none passes.
  // The section stored is the one rendered (the placement's layout, focus, zoom and sizes).
  const shots: { section: FirstSection; shot: Awaited<ReturnType<typeof look>> }[] = [];
  const tryLook = async (sec: FirstSection, index: number) => {
    const shot = await look(sec, index);
    shots.push({ section: shot.section, shot });
    return shot;
  };

  const base = content.first_section;
  let shot = await tryLook(base, photoIndex);
  let section = shot.section;
  let lookFlag: string | null = null;
  if (!shot.l.ok) {
    const n = capture.photos.length;
    const next = n > 1 ? (photoIndex + 1) % n : -1;
    if (next >= 0) {
      if (!hasTime()) return outOfTime("the next-photo look check", [...issues, lookIssue(shot.l)]);
      shot = await tryLook({ ...base, photo: photoKey(next, capture.photos[next].mime), photo_focus: NEXT_PHOTO_FOCUS }, next);
      section = shot.section;
    }
  }
  if (!shot.l.ok) {
    // Still failing after the last allowed re-render: the look check is advisory, not a hold (controller
    // ruling, 2026-11-04). Send the render with the fewest problems (ties: the latest), keep the
    // problem as a warning, and tell Maggie in her notes. Copy rule errors still hold, above.
    const best = shots.reduce((m, c) => (lookProblems(c.shot.l).length <= lookProblems(m.shot.l).length ? c : m));
    section = best.section;
    shot = best.shot;
    lookFlag = lookMessage(shot.l);
    issues = [...issues, { field: "first_section", level: "warning", message: lookFlag }];
  }
  content = { ...content, first_section: section };
  if (lookFlag) {
    const note = `Mockup photo check flagged: ${lookFlag}`;
    content = { ...content, notes_for_maggie: content.notes_for_maggie ? `${content.notes_for_maggie}\n${note}` : note };
  }
  const after = shot.after;
  const imgs = { before: beforeUri, after: dataUri({ data: after, mime: "image/jpeg" }) };

  // 6. PDF and overflow check; one repair call asking to shorten the overflowing fields.
  let rendered = await s.renderPdf(fillReport(content, imgs));
  if (rendered.overflow.length) {
    const over = overflowIssues(content, rendered.overflow);
    const where = rendered.overflow.map((o) => `page ${o.page}`).join(", ");
    if (!over.length) return held(`PDF overflow on ${where}`, issues);
    if (!hasTime()) return outOfTime("the overflow repair", [...issues, ...over]);
    const r = await s.repair({ content, issues: over, model });
    usage = addUsage(usage, r.usage);
    content = autoFix(r.content);
    issues = checkContent(content, facts.pageText);
    if (errors(issues).length) return held("rule check failed after the overflow repair", issues);
    rendered = await s.renderPdf(fillReport(content, imgs));
    if (rendered.overflow.length) {
      return held(`PDF overflow on ${rendered.overflow.map((o) => `page ${o.page}`).join(", ")} after one repair`,
        [...issues, ...overflowIssues(content, rendered.overflow)]);
    }
  }

  return { outcome: "sent", content, pdf: rendered.pdf, before: capture.before.data, after, facts, usage, model };
}
