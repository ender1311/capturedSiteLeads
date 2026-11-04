import { DEFAULT_MODEL } from "@/lib/models";
import { captureSite, CaptureError } from "./capture";
import { buildFacts, type Facts } from "./facts";
import { renderAfter, renderContactSheet, renderPdf } from "./render";
import { fillReport } from "./render-html";
import { autoFix, checkContent, fieldsOf, type RuleIssue } from "./rules";
import type { Asset, Capture, FirstSection, FitFlag, ReportContent, Usage } from "./types";
import { addUsage, lookCheck, repairFields, writeReport, type Written } from "./write";

// One report, end to end: capture → facts → fit flags → contact sheet → Gemini → rules →
// mockup + look check → PDF + overflow check. Delivery is the caller's job ("sent" = ready to send).

export type PipelineResult =
  | { outcome: "sent"; content: ReportContent; pdf: Buffer; before: Buffer; after: Buffer; facts: Facts; usage: Usage; model: string }
  | { outcome: "hobby"; compliment: string; facts: Facts; usage: Usage; model: string }
  | { outcome: "cant_see"; reason: FitFlag | "unreachable" | "bot_check" | "empty"; usage: Usage }
  | { outcome: "held"; reason: string; content: ReportContent; issues: RuleIssue[]; facts: Facts; usage: Usage; model: string };

export type Stages = {
  capture: typeof captureSite; write: typeof writeReport; repair: typeof repairFields; look: typeof lookCheck;
  renderAfter: typeof renderAfter; renderPdf: typeof renderPdf; renderContactSheet: typeof renderContactSheet;
  now: () => number; // injectable clock for the deadline
};

const REAL: Stages = {
  capture: captureSite, write: writeReport, repair: repairFields, look: lookCheck,
  renderAfter, renderPdf, renderContactSheet, now: () => Date.now(),
};

// The route has 300 s; stop starting optional steps when less than a minute of the budget is left.
export const DEFAULT_DEADLINE_MS = 270_000;
const MIN_LEFT_MS = 60_000;
const NEXT_PHOTO_FOCUS = "50% 40%";

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
const dataUri = (a: Asset) => `data:${a.mime};base64,${a.data.toString("base64")}`;
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

export async function runHomepageFixes(
  input: { firstName: string; website: string; goal: string; model?: string; capture?: Capture; deadlineMs?: number },
  stages: Partial<Stages> = {},
): Promise<PipelineResult> {
  const s: Stages = { ...REAL, ...stages };
  const deadline = s.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const hasTime = () => deadline - s.now() >= MIN_LEFT_MS;
  const model = input.model ?? DEFAULT_MODEL;
  let usage: Usage = { ...ZERO };

  // 1. Capture (one Firecrawl scrape), unless the caller already has it.
  let capture: Capture;
  try {
    capture = input.capture ?? (await s.capture(input.website));
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
  const w = await s.write({
    firstName: input.firstName, website: input.website, goal: input.goal,
    facts, contactSheet, photoCount: capture.photos.length, model,
  });
  usage = addUsage(usage, w.usage);
  const written = w.written;
  if (written.fit === "hobby") return { outcome: "hobby", compliment: written.compliment, facts, usage, model };

  const photoIndex = Math.min(Math.max(written.photo_choice, 1), capture.photos.length) - 1;
  let content = autoFix(assembleContent(input, facts, written, photoKey(photoIndex, capture.photos[photoIndex].mime)));
  const held = (reason: string, issues: RuleIssue[]): PipelineResult =>
    ({ outcome: "held", reason, content, issues, facts, usage, model });

  // 4. Rule check; one repair call for error-level issues only. Warnings never block.
  let issues = checkContent(content, facts.pageText);
  if (errors(issues).length) {
    if (!hasTime()) return held("out of time", issues);
    const r = await s.repair({ content, issues, model });
    usage = addUsage(usage, r.usage);
    content = autoFix(r.content);
    issues = checkContent(content, facts.pageText);
    if (errors(issues).length) return held("rule check failed after one repair", issues);
  }

  // 5. Mockup and look check: as written, then the alternate layout and focus, then the next photo.
  const look = async (section: FirstSection, index: number) => {
    const after = await s.renderAfter(section, photoUris[index], logoUri);
    const l = await s.look(after, model);
    usage = addUsage(usage, l.usage);
    return { after, l };
  };
  const lookIssue = (l: { faces_ok: boolean; headline_readable: boolean; looks_like_template: boolean }): RuleIssue => ({
    field: "first_section", level: "error",
    message: `look check: ${[
      !l.faces_ok && "a face is cut off or covered",
      !l.headline_readable && "the headline is hard to read",
      l.looks_like_template && "it looks like a generic template",
    ].filter(Boolean).join("; ")}.`,
  });

  const base = content.first_section;
  let section = base;
  let shot = await look(section, photoIndex);
  if (!shot.l.ok) {
    if (!hasTime()) return held("out of time", [...issues, lookIssue(shot.l)]);
    section = { ...base, layout: written.alt_layout, photo_focus: written.alt_photo_focus };
    shot = await look(section, photoIndex);
  }
  if (!shot.l.ok) {
    const n = capture.photos.length;
    const next = n > 1 ? (photoIndex + 1) % n : -1;
    if (next < 0) return held("look check failed", [...issues, lookIssue(shot.l)]);
    if (!hasTime()) return held("out of time", [...issues, lookIssue(shot.l)]);
    section = { ...base, photo: photoKey(next, capture.photos[next].mime), photo_focus: NEXT_PHOTO_FOCUS };
    shot = await look(section, next);
    if (!shot.l.ok) return held("look check failed", [...issues, lookIssue(shot.l)]);
  }
  content = { ...content, first_section: section };
  const after = shot.after;
  const imgs = { before: beforeUri, after: dataUri({ data: after, mime: "image/jpeg" }) };

  // 6. PDF and overflow check; one repair call asking to shorten the overflowing fields.
  let rendered = await s.renderPdf(fillReport(content, imgs));
  if (rendered.overflow.length) {
    const over = overflowIssues(content, rendered.overflow);
    const where = rendered.overflow.map((o) => `page ${o.page}`).join(", ");
    if (!over.length) return held(`PDF overflow on ${where}`, issues);
    if (!hasTime()) return held("out of time", [...issues, ...over]);
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
