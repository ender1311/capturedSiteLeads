// Deterministic tidying of the mockup's brand text and nav items, applied where they are built
// (facts), after generation (autoFix) and in the renderer, so whatever path a first section
// takes, the mockup never shows a footer copyright or a messy menu.

export const MAX_NAV_ITEMS = 6;
const CONTACT_RE = /\b(contact|inquire|inquiry|enquire|enquiry|get in touch|book(ing)? now|let'?s (talk|chat|connect))\b/i;

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

// Copyright markers at either end: ©, (c), "Copyright", a year or year range, "All rights reserved".
const LEADING = /^(?:©|\(c\)|copyright\b|(?:19|20)\d{2}(?:\s*[-–—]\s*(?:(?:19|20)\d{2}|present))?(?=\s|$)|[\s.,|·•:-]+)\s*/i;
const TRAILING = /\s*(?:©|\(c\)|all rights reserved\.?|(?<=[\s©)]|^)(?:19|20)\d{2}(?:\s*[-–—]\s*(?:(?:19|20)\d{2}|present))?|[\s.,|·•:-]+)$/i;

/** A brand name without any copyright line around it: "© 2026 WillowAnn Photography" → "WillowAnn Photography". */
export function cleanBrand(text: string): string {
  const original = squeeze(text);
  if (!/©|\(c\)|copyright|all rights reserved/i.test(original)) return original;
  let s = original;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(LEADING, "").replace(TRAILING, "");
  }
  return s || original;
}

const navKey = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/^the\s+/, "");

/**
 * At most 6 menu items: whitespace squeezed, case-insensitive duplicates dropped (also "experience"
 * next to "the experience"), the first 6 kept in order, except a Contact-style item that would be
 * cut replaces the 6th.
 */
export function cleanNav(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = squeeze(raw);
    const k = navKey(t);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length <= MAX_NAV_ITEMS) return out;
  const first = out.slice(0, MAX_NAV_ITEMS);
  if (first.some((t) => CONTACT_RE.test(t))) return first;
  const contact = out.slice(MAX_NAV_ITEMS).find((t) => CONTACT_RE.test(t));
  return contact ? [...first.slice(0, MAX_NAV_ITEMS - 1), contact] : first;
}

export function cleanSection<T extends { logo_text?: string; nav_items?: string[] }>(s: T): T {
  const out = { ...s };
  if (typeof out.logo_text === "string") out.logo_text = cleanBrand(out.logo_text);
  if (Array.isArray(out.nav_items)) out.nav_items = cleanNav(out.nav_items);
  return out;
}
