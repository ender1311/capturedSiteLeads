import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/lib/models";
import type { Facts } from "./facts";
import { SYSTEM_PROMPT, userMessage } from "./prompt";
import { fieldsOf, LIMITS, type RuleIssue } from "./rules";
import type { Fix, Layout, ReportContent, Usage } from "./types";

// The one judgment step: Gemini writes the diagnosis and copy, fixes failing fields, and checks
// the mockup. Every call is priced from the gateway's reported cost, or from token usage.

export type Written =
  | { fit: "hobby"; compliment: string }
  | {
      fit: "report"; photo_choice: 1 | 2 | 3; photo_focus: string; alt_photo_focus: string; layout: Layout; alt_layout: Layout;
      eyebrow: string; headline: string; subline: string; button: string;
      first_section_changes: [string, string, string]; fixes: [Fix, Fix]; notes_for_maggie: string;
    };

// Fixed-length arrays (not tuples) so the JSON schema uses minItems/maxItems, which Gemini supports.
const three = () => z.array(z.string()).length(3).transform((a) => a as [string, string, string]);
const layout = z.enum(["left", "right", "center", "box"]);
const fixSchema = z.object({ title: z.string(), noticed: z.string(), why: z.string(), changes: three() });

const reportSchema = z.object({
  fit: z.enum(["report"]),
  photo_choice: z.number().int().min(1).max(3).transform((n) => n as 1 | 2 | 3),
  photo_focus: z.string().describe('CSS background-position, like "50% 35%"'),
  alt_photo_focus: z.string(),
  layout,
  alt_layout: layout,
  eyebrow: z.string(),
  headline: z.string(),
  subline: z.string(),
  button: z.string(),
  first_section_changes: three(),
  fixes: z.array(fixSchema).length(2).transform((a) => a as [Fix, Fix]),
  notes_for_maggie: z.string(),
});
const hobbySchema = z.object({ fit: z.enum(["hobby"]), compliment: z.string() });

export const writtenSchema: z.ZodType<Written> = z.union([reportSchema, hobbySchema]);

// Lowest-cost Gemini settings, passed through by the AI Gateway to Google.
// NOT YET CONFIRMED LIVE: on 2026-11-03 the gateway refused the model ("Free tier users do not have
// access to this model"). If thinkingLevel "low" is rejected, try "minimal", then omit it.
const PROVIDER_OPTIONS = {
  google: { mediaResolution: "MEDIA_RESOLUTION_LOW", thinkingConfig: { thinkingLevel: "low" } },
};
const TEMPERATURE = 0.4;

type ModelArg = string | Exclude<LanguageModel, string>;
const modelId = (m: ModelArg) => (typeof m === "string" ? m : m.modelId);

export function costOf(u: { inputTokens: number; outputTokens: number }, model: string): number {
  const m = MODEL_OPTIONS.find((o) => o.id === model) ?? MODEL_OPTIONS.find((o) => o.id === DEFAULT_MODEL)!;
  return u.inputTokens * m.inputPerToken + u.outputTokens * m.outputPerToken;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    calls: a.calls + b.calls,
  };
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

function usageOf(
  r: { usage: { inputTokens?: number; outputTokens?: number }; providerMetadata?: Record<string, Record<string, unknown>> },
  model: ModelArg,
): Usage {
  const inputTokens = r.usage.inputTokens ?? 0;
  const outputTokens = r.usage.outputTokens ?? 0;
  const gatewayCost = Number(r.providerMetadata?.gateway?.cost);
  const costUsd = Number.isFinite(gatewayCost) && gatewayCost > 0 ? gatewayCost : costOf({ inputTokens, outputTokens }, modelId(model));
  return { inputTokens, outputTokens, costUsd, calls: 1 };
}

export async function writeReport(input: {
  firstName: string; website: string; goal: string; facts: Facts; contactSheet: Buffer; model?: ModelArg;
}): Promise<{ written: Written; usage: Usage }> {
  const model = input.model ?? DEFAULT_MODEL;
  const r = await generateObject({
    model,
    schema: writtenSchema,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: userMessage(input) },
        { type: "file", data: input.contactSheet, mediaType: "image/jpeg" },
      ],
    }],
    maxOutputTokens: 2000,
    temperature: TEMPERATURE,
    providerOptions: PROVIDER_OPTIONS,
  });
  return { written: r.object, usage: usageOf(r, model) };
}

// ---------- repair ----------

const REPAIR_SYSTEM = `You fix single lines of copy for Captured Sites' "Your Top Homepage Fixes" report, written in Maggie's warm, plain voice to a photographer as "you". For each field, rewrite only what the listed problems need and keep the meaning, the voice and any of their exact quoted words. Stay under each field's character limit.
Rules: no em or en dashes; no brackets or fill-ins; website visitors are "the visitor" with they/their; no technical numbers; no exclamation points outside their quotes; homepage only; never recommend pricing; no email list, newsletter or freebie advice; never use audit, conversion, funnel, optimize, leverage, elevate, seamless, curated, aligned, authentic, autopilot, unlock, game changer, synergy, delve, robust or crucial; spell "Captured Sites" exactly. If a quote was not found on their homepage, drop the quotation marks and say it plainly in your own words. Never invent facts.
Return every field you were given, with its label unchanged.`;

const repairSchema = z.object({ fields: z.array(z.object({ field: z.string(), text: z.string() })) });

function limitFor(label: string): number | undefined {
  const fs = label.match(/^first_section\.(headline|subline|button|eyebrow)$/);
  if (fs) return LIMITS[fs[1]];
  if (/^first_section_changes\[\d\]$/.test(label)) return LIMITS.changeNote;
  if (/^fixes\[\d\]\.changes\[\d\]$/.test(label)) return LIMITS.fixChange;
  const fx = label.match(/^fixes\[\d\]\.(title|noticed|why)$/);
  if (fx) return LIMITS[fx[1] === "title" ? "fixTitle" : fx[1]];
  return undefined;
}

// Labels come from rules.fieldsOf: 1-based indexes.
function setField(c: ReportContent, label: string, text: string): boolean {
  let m = label.match(/^first_section\.(headline|subline|button|eyebrow)$/);
  if (m) { c.first_section[m[1] as "headline"] = text; return true; }
  m = label.match(/^first_section_changes\[([1-3])\]$/);
  if (m) { c.first_section_changes[Number(m[1]) - 1] = text; return true; }
  m = label.match(/^fixes\[([12])\]\.changes\[([1-3])\]$/);
  if (m) { c.fixes[Number(m[1]) - 1].changes[Number(m[2]) - 1] = text; return true; }
  m = label.match(/^fixes\[([12])\]\.(title|noticed|why)$/);
  if (m) { c.fixes[Number(m[1]) - 1][m[2] as "title"] = text; return true; }
  return false;
}

export async function repairFields(input: {
  content: ReportContent; issues: RuleIssue[]; model?: ModelArg;
}): Promise<{ content: ReportContent; usage: Usage }> {
  const current = new Map(fieldsOf(input.content));
  const problems = new Map<string, string[]>();
  for (const i of input.issues) {
    if (!current.has(i.field)) continue;
    problems.set(i.field, [...(problems.get(i.field) ?? []), i.message]);
  }
  if (problems.size === 0) return { content: input.content, usage: { ...ZERO } };

  const list = [...problems].map(([label, msgs]) => {
    const limit = limitFor(label);
    return `Field: ${label}${limit ? ` (limit ${limit} characters)` : ""}\nText: ${current.get(label)}\nProblems: ${msgs.join(" ")}`;
  }).join("\n\n");

  const model = input.model ?? DEFAULT_MODEL;
  const r = await generateObject({
    model,
    schema: repairSchema,
    system: REPAIR_SYSTEM,
    prompt: list,
    maxOutputTokens: 1000,
    temperature: TEMPERATURE,
    providerOptions: PROVIDER_OPTIONS,
  });

  const content = structuredClone(input.content);
  for (const f of r.object.fields) {
    if (problems.has(f.field) && f.text.trim()) setField(content, f.field, f.text.trim());
  }
  return { content, usage: usageOf(r, model) };
}

// ---------- look check ----------

const lookSchema = z.object({ faces_ok: z.boolean(), headline_readable: z.boolean(), looks_like_template: z.boolean() });

const LOOK_PROMPT = `This is a mockup of a photographer's new homepage first section. Answer three yes/no questions:
faces_ok: Are all faces fully in frame, none cut off by the edges or covered by the words? (true if there are no faces)
headline_readable: Is the headline easy to read against the photo?
looks_like_template: Does it look like a generic template rather than the photographer's own site?`;

export async function lookCheck(after: Buffer, model: ModelArg = DEFAULT_MODEL): Promise<{
  ok: boolean; faces_ok: boolean; headline_readable: boolean; looks_like_template: boolean; usage: Usage;
}> {
  const r = await generateObject({
    model,
    schema: lookSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: LOOK_PROMPT },
        { type: "file", data: after, mediaType: "image/jpeg" },
      ],
    }],
    maxOutputTokens: 200,
    temperature: TEMPERATURE,
    providerOptions: PROVIDER_OPTIONS,
  });
  const o = r.object;
  return { ...o, ok: o.faces_ok && o.headline_readable && !o.looks_like_template, usage: usageOf(r, model) };
}
