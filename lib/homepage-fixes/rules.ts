import { cleanSection } from "./mockup-clean";
import type { ReportContent } from "./types";
import { stripSymbols } from "./glyphs";

export type RuleIssue = { field: string; level: "error" | "warning"; message: string };

export const LIMITS: Record<string, number> = {
  headline: 60,
  subline: 110,
  button: 24,
  eyebrow: 60,
  changeNote: 190,
  fixTitle: 52,
  noticed: 360,
  why: 260,
  fixChange: 130,
};

// Regexes ported verbatim from the skill's scripts/build.mjs.
const BANNED = /\b(elevate[sd]?|leverag\w*|seamless\w*|curated|aligned|authentic|autopilot|optimi[sz]\w*|unlock\w*|audit|conversion\w*|funnel\w*|game[- ]changer|synergy|delve|robust|crucial)\b/i;
const DASH = /[—–]/;
const BRACKET = /[\[\]{}]/;
const PRICE = /\$\s?\d|\bprice(s|d)?\b|\bpricing\b/i;
const EMAIL_ADVICE = /\b(email list|newsletter|freebie|lead magnet|opt-?in)\b/i;
const PRONOUN = /\b(she|her|hers|herself)\b/i;
const TECH_NUMBER = /\b\d+\s?(px|pixels|characters|%)\b/i;
const EXCLAIM = /!/;
const WHOLE_SITE = /\b(your whole site|entire site|every page of your)\b/i;

type Entry = [string, string, number | undefined];

function entries(c: ReportContent): Entry[] {
  const out: Entry[] = [];
  const s = c.first_section;
  out.push(["first_section.headline", s.headline, LIMITS.headline]);
  out.push(["first_section.subline", s.subline || "", LIMITS.subline]);
  out.push(["first_section.button", s.button || "", LIMITS.button]);
  if (s.eyebrow) out.push(["first_section.eyebrow", s.eyebrow, LIMITS.eyebrow]);
  c.first_section_changes.forEach((t, i) => out.push([`first_section_changes[${i + 1}]`, t, LIMITS.changeNote]));
  c.fixes.forEach((f, i) => {
    out.push([`fixes[${i + 1}].title`, f.title, LIMITS.fixTitle]);
    out.push([`fixes[${i + 1}].noticed`, f.noticed, LIMITS.noticed]);
    out.push([`fixes[${i + 1}].why`, f.why, LIMITS.why]);
    f.changes.forEach((t, j) => out.push([`fixes[${i + 1}].changes[${j + 1}]`, t, LIMITS.fixChange]));
  });
  return out;
}

export function fieldsOf(c: ReportContent): [string, string][] {
  return entries(c).map(([l, t]) => [l, t]);
}

const straighten = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

export function fixText(t: string): string {
  return straighten(stripSymbols(t))
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/(,\s*)+,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function autoFix(c: ReportContent): ReportContent {
  const n = structuredClone(c);
  n.first_section = cleanSection(n.first_section);
  const s = n.first_section;
  s.headline = fixText(s.headline);
  if (s.subline) s.subline = fixText(s.subline);
  if (s.button) s.button = fixText(s.button);
  if (s.eyebrow) s.eyebrow = fixText(s.eyebrow);
  n.first_section_changes = n.first_section_changes.map(fixText) as ReportContent["first_section_changes"];
  for (const f of n.fixes) {
    f.title = fixText(f.title);
    f.noticed = fixText(f.noticed);
    f.why = fixText(f.why);
    f.changes = f.changes.map(fixText) as typeof f.changes;
  }
  return n;
}

// Dash-insensitive: autoFix turns dashes into commas, so both sides map dashes and commas to ", ".
const normalize = (t: string) =>
  straighten(t).toLowerCase().replace(/\s*[—–-]\s*|\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
const normalizeQuote = (t: string) => normalize(t).replace(/[\s.,!?;:]+$/, "");

/** The hard-rule checks for one piece of copy (used for every report field and the hobby compliment). */
export function checkText(label: string, t: string, max: number | undefined, pageText: string): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, level: "error", message });
  const warn = (field: string, message: string) => issues.push({ field, level: "warning", message });
  const page = normalize(pageText);

  if (max && t.length > max) err(label, `is ${t.length} characters (limit ${max}, it has to fit the page).`);
  if (DASH.test(t)) err(label, "has a dash (— or –). Use a comma, period or colon.");
  if (BRACKET.test(t)) err(label, "has a bracket or fill-in. Never print a placeholder.");
  if (PRICE.test(t)) warn(label, "mentions a price. Never recommend adding pricing; one price point at most.");
  const banned = t.match(BANNED);
  if (banned) err(label, `uses a banned word ("${banned[0]}").`);
  if (EMAIL_ADVICE.test(t)) err(label, "email or freebie advice doesn't belong in this report.");
  if (PRONOUN.test(t)) warn(label, 'says she/her. If that\'s the visitor, write "the visitor" with they/their.');
  if (TECH_NUMBER.test(t)) err(label, 'has a technical number. Say "twice as large" or "a long way down the page" instead.');
  if (EXCLAIM.test(t)) warn(label, "has an exclamation point (only keep it if it's their own words in quotes).");

  if (WHOLE_SITE.test(t)) err(label, 'The fixes cover the homepage only. Remove "whole site" language.');

  for (const m of t.matchAll(/captured sites/gi)) {
    if (m[0] !== "Captured Sites") err(label, `spells Captured Sites as "${m[0]}". Use exactly "Captured Sites".`);
  }

  for (const m of straighten(t).matchAll(/"([^"]+)"/g)) {
    const q = normalizeQuote(m[1]);
    if (q.split(" ").filter(Boolean).length < 3) continue;
    if (!page.includes(q)) err(label, `quote "${m[1]}" was not found on the homepage text. Never invent quotes.`);
  }

  return issues;
}

export function checkContent(c: ReportContent, pageText: string): RuleIssue[] {
  return entries(c).flatMap(([label, t, max]) => checkText(label, t, max, pageText));
}
