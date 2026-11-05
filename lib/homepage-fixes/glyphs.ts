// The PDF's text is set in Lato from Google Fonts, which only serves its "latin" and "latin-ext"
// subsets. Vercel's serverless Chromium has no system fonts to fall back on, so any character
// outside these ranges prints as a missing-glyph box (a local Chrome hides this by borrowing from
// macOS fonts). Icons in the template are inline SVG for that reason; model copy is cleaned below.
const COVERED: [number, number][] = [
  // latin
  [0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6],
  [0x02da, 0x02da], [0x02dc, 0x02dc], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329],
  [0x2000, 0x206f], [0x2074, 0x2074], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191],
  [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd],
  // latin-ext
  [0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7], [0x02dd, 0x02ff],
  [0x1e00, 0x1eff], [0x2020, 0x20cf], [0x2113, 0x2113], [0x2c60, 0x2c7f], [0xa720, 0xa7ff],
];

/** The distinct characters in `text` that Lato (latin + latin-ext) can't draw. */
export function missingGlyphs(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!COVERED.some(([a, b]) => cp >= a && cp <= b)) out.add(ch);
  }
  return [...out];
}

// Emoji, arrows, dingbats, stars and other symbols the model or a quoted site might use.
const SYMBOLS = /[\p{Extended_Pictographic}←-⇿⌀-⏿■-➿⤀-⥿⬀-⯿️‍]/gu;

/** Drops symbols the PDF font can't draw (letters are left alone). */
export function stripSymbols(t: string): string {
  return t.replace(SYMBOLS, "");
}
