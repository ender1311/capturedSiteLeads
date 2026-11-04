// Maps a site's computed font family to a Google Font the mockup can load.

const SERIF = [
  "Cormorant Garamond", "Cormorant", "EB Garamond", "Playfair Display", "Playfair", "Lora", "Libre Baskerville",
  "Libre Caslon Text", "Libre Caslon Display", "Merriweather", "Crimson Text", "Crimson Pro", "Cinzel",
  "Bodoni Moda", "Prata", "Vollkorn", "Spectral", "Noto Serif", "PT Serif", "Source Serif 4", "Source Serif Pro",
  "DM Serif Display", "DM Serif Text", "Gilda Display", "Marcellus", "Cardo", "Old Standard TT", "Italiana",
  "Abril Fatface", "Bellefair", "Fraunces", "Newsreader", "Instrument Serif", "Bodoni", "Rozha One", "Lusitana",
  "Courier Prime", "Roboto Slab", "Arvo",
];
const SANS = [
  "Montserrat", "Manrope", "Poppins", "Work Sans", "Lato", "Open Sans", "Raleway", "Roboto", "Inter", "Nunito",
  "Nunito Sans", "Mulish", "Josefin Sans", "Quicksand", "Karla", "DM Sans", "Rubik", "Source Sans Pro",
  "Source Sans 3", "Barlow", "Jost", "Outfit", "Figtree", "Urbanist", "Questrial", "Oswald", "Archivo",
  "Hind", "PT Sans", "Cabin", "Libre Franklin", "Space Grotesk", "Plus Jakarta Sans", "Syne", "Tenor Sans",
  "Didact Gothic", "Lexend", "Red Hat Display", "Kumbh Sans", "League Spartan", "Spartan", "Arimo",
];
const SCRIPT = ["Great Vibes", "Dancing Script", "Pinyon Script", "Allura", "Parisienne", "Sacramento", "Alex Brush", "Pacifico", "Satisfy", "Tangerine"];

const GOOGLE = [...SERIF, ...SANS, ...SCRIPT];
const SERIF_RE = /garamond|caslon|baskerville|bodoni|didot|playfair|cormorant|libre|serif|times|georgia|minion|freight|canela|chronicle|mrs eaves|lora|slab|tiempos|editorial|didone|recoleta/;
const SCRIPT_RE = /script|hand|signature|brush|calligraph|vibes|allura/;
const DISPLAY_RE = /display/;

const key = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
// Vendor suffixes that do not change the family: "Pro", "Std", "LT", "W01", weights, "Regular".
const strip = (s: string) =>
  key(s).replace(/\b(pro|std|lt|w0\d|mt|regular|book|medium|light|bold|semibold|variable|vf|web|webfont)\b/g, "").replace(/\s+/g, " ").trim();

const SANS_SERIF_RE = /sans/;

export function toGoogleFont(family: string, role: "heading" | "body"): string {
  const k = key(family);
  const s = strip(family);
  const exact = GOOGLE.find((g) => key(g) === k || key(g) === s);
  if (exact) return exact;
  if (SCRIPT_RE.test(k)) return role === "heading" ? "Playfair Display" : "Montserrat";
  if (SANS_SERIF_RE.test(k)) return "Montserrat";
  if (SERIF_RE.test(k)) return "Cormorant Garamond";
  if (DISPLAY_RE.test(k)) return role === "heading" ? "Playfair Display" : "Montserrat";
  return "Montserrat";
}
