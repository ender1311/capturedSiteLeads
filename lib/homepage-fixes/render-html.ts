import fs from "node:fs";
import path from "node:path";
import type { FirstSection, ReportContent } from "./types";

// Ported from the skill's scripts/build.mjs. Only change: images arrive as data URIs.

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** Escape, and keep the last word glued to the one before it (no lone last word). */
export function keepLast(s: string): string {
  return esc(s).replace(/ (\S+)$/, "&nbsp;$1");
}

const change = (t: string) =>
  `<div style="display:flex;gap:14px;align-items:flex-start"><span style="flex:none;width:20px;height:20px;box-sizing:border-box;border:2px solid #337A80;border-radius:4px;margin-top:2px" aria-hidden="true"></span><p style="margin:0;font-size:17px;line-height:1.45">${keepLast(t)}</p></div>`;

const gfont = (f?: string) =>
  f && !/^(serif|sans-serif|system-ui|-apple-system|Arial|Helvetica|Times New Roman|Georgia)$/i.test(f)
    ? `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@300;400;500;600;700`
    : "";

export function firstSectionHtml(s: FirstSection, photoDataUri: string, logoDataUri?: string): string {
  const layout = s.layout || "left";
  const hf = s.heading_font || "Playfair Display";
  const bf = s.body_font || "Montserrat";
  const fams = [gfont(hf), gfont(bf)].filter(Boolean).join("&");
  const navStyle = s.nav_style || "bar";
  const items = (s.nav_items || ["Home", "About", "Portfolio", "Contact"]).map((t) => `<span>${esc(t)}</span>`).join("");
  const brand = logoDataUri
    ? `<img src="${esc(logoDataUri)}" alt="" style="max-height:62px;max-width:300px;display:block${navStyle === "over" ? ";filter:brightness(0) invert(1)" : ""}">`
    : `<b style="font-family:'${hf}',serif;font-size:26px;font-weight:600;letter-spacing:.04em">${esc(s.logo_text || "")}</b>`;
  const navColor = navStyle === "over" ? "#FFFFFF" : s.nav_color || "#222222";
  const nav = `<div class="nav" style="height:96px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 64px;background:${navStyle === "over" ? "transparent" : s.nav_background || "#FFFFFF"};color:${navColor};${navStyle === "over" ? "position:absolute;left:0;right:0;top:0;z-index:2" : ""}">${brand}<div style="display:flex;gap:34px;font-family:'${bf}',sans-serif;font-size:15px;letter-spacing:.14em;text-transform:uppercase">${items}</div></div>`;
  const shade =
    layout === "left"
      ? "linear-gradient(90deg,rgba(0,0,0,.58) 0%,rgba(0,0,0,.32) 42%,rgba(0,0,0,0) 72%)"
      : layout === "right"
        ? "linear-gradient(270deg,rgba(0,0,0,.58) 0%,rgba(0,0,0,.32) 42%,rgba(0,0,0,0) 72%)"
        : layout === "center"
          ? "linear-gradient(180deg,rgba(0,0,0,.18),rgba(0,0,0,.42))"
          : "none";
  const big = s.headline.length > 42 ? 64 : 76;
  const head = `${s.eyebrow ? `<p style="margin:0 0 18px;font-family:'${bf}',sans-serif;font-size:17px;letter-spacing:.2em;text-transform:uppercase">${keepLast(s.eyebrow)}</p>` : ""}<h1 style="margin:0;font-family:'${hf}',serif;font-weight:${s.heading_weight || 500};font-size:${big}px;line-height:1.08;${s.uppercase_headline ? "text-transform:uppercase;letter-spacing:.04em;" : ""}text-wrap:balance">${keepLast(s.headline)}</h1>${s.subline ? `<p style="margin:24px 0 0;font-family:'${bf}',sans-serif;font-size:19px;line-height:1.5;letter-spacing:.14em;text-transform:uppercase;text-wrap:balance">${keepLast(s.subline)}</p>` : ""}${s.button ? `<span style="display:inline-block;margin-top:34px;font-family:'${bf}',sans-serif;font-size:16px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;padding:18px 40px;${s.accent ? `background:${s.accent};color:#FFFFFF;border:2px solid ${s.accent}` : "border:2px solid currentColor"}">${esc(s.button)}</span>` : ""}`;
  const copy =
    layout === "box"
      ? `<div style="position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);width:720px;box-sizing:border-box;background:rgba(255,255,255,.92);color:#222;padding:56px 60px;text-align:center">${head}</div>`
      : `<div style="position:absolute;${layout === "left" ? "left:96px;width:640px;text-align:left" : layout === "right" ? "right:96px;width:600px;text-align:left" : "left:50%;transform:translateX(-50%);width:900px;text-align:center"};top:${navStyle === "bar" ? "46%" : "52%"};translate:0 -50%;color:#FFFFFF">${head}</div>`;
  const photo = `<div style="position:relative;flex:1;background:url('${esc(photoDataUri)}') ${esc(s.photo_focus || "50% 40%")}/cover no-repeat"><div style="position:absolute;inset:0;background:${shade}"></div>${copy}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8">${fams ? `<link href="https://fonts.googleapis.com/css2?${fams}&display=swap" rel="stylesheet">` : ""}<style>html,body{margin:0}</style></head><body><div id="frame" style="position:relative;width:1400px;height:878px;overflow:hidden;display:flex;flex-direction:column;background:#fff">${s.nav_position === "bottom" ? photo + nav : nav + photo}</div></body></html>`;
}

const TOUR = "https://capturedsites.com/tour/";
const TOUR_UTM = `${TOUR}?utm_source=homepage-fixes&utm_medium=pdf&utm_campaign=homepage-fixes`;
const MIME: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

let templateCache: { html: string; dir: string } | null = null;
function template() {
  if (!templateCache) {
    const dir = path.join(process.cwd(), "lib/homepage-fixes/skill/template");
    templateCache = { html: fs.readFileSync(path.join(dir, "report.html"), "utf8"), dir };
  }
  return templateCache;
}

export function fillReport(c: ReportContent, imgs: { before: string; after: string }): string {
  const { html: tpl, dir } = template();
  const name = c.first_name.trim();
  const vals: Record<string, string> = {
    FIRST_NAME: escAttr(name),
    NAME_POSS: escAttr(name + "'s"),
    P4_CHANGE_1: keepLast(c.first_section_changes[0]),
    P4_CHANGE_2: keepLast(c.first_section_changes[1]),
    P4_CHANGE_3: keepLast(c.first_section_changes[2]),
  };
  c.fixes.forEach((f, i) => {
    const k = i + 1;
    vals[`F${k}_TITLE`] = keepLast(f.title);
    vals[`F${k}_NOTICED`] = keepLast(f.noticed);
    vals[`F${k}_WHY`] = keepLast(f.why);
    vals[`F${k}_CHANGES`] = f.changes.map(change).join("");
  });
  // Function replacers throughout: data URIs and copy never get "$&" style expansion.
  return tpl
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, k: string) => {
      if (!(k in vals)) throw new Error("No value for " + k);
      return vals[k];
    })
    .replaceAll('src="after.jpg"', () => `src="${imgs.after}"`)
    .replaceAll('src="before.jpg"', () => `src="${imgs.before}"`)
    .replace(/src="(assets\/[^"]+)"/g, (_m, rel: string) => {
      const file = path.join(dir, rel);
      const mime = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return `src="data:${mime};base64,${fs.readFileSync(file).toString("base64")}"`;
    })
    .replaceAll(`href="${TOUR}"`, () => `href="${TOUR_UTM}"`);
}

/** 1600x900 sheet for the look check: today's homepage on the left, up to 3 numbered photos on the right, each shown whole. */
export function contactSheetHtml(before: string, photos: string[]): string {
  const ps = photos.slice(0, 3);
  // TODAY sits bottom-left so it does not cover the site's logo; photo numbers stay top-left.
  const label = (t: string, corner: "top" | "bottom" = "top") =>
    `<div style="position:absolute;left:12px;${corner}:12px;background:#000;color:#fff;font:700 28px Arial,sans-serif;padding:6px 14px">${t}</div>`;
  const cells = ps
    .map(
      (p, i) =>
        `<div style="position:relative;flex:1;min-height:0;background:#1a1a1a"><img src="${esc(p)}" alt="" style="width:100%;height:100%;object-fit:contain;display:block">${label(String(i + 1))}</div>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><div id="sheet" style="width:1600px;height:900px;display:flex;gap:8px;background:#fff;overflow:hidden"><div style="position:relative;width:796px;height:900px;background:#222"><img src="${esc(before)}" alt="" style="width:100%;height:100%;object-fit:contain;object-position:top;display:block">${label("TODAY", "bottom")}</div><div style="width:796px;height:900px;display:flex;flex-direction:column;gap:8px">${cells}</div></div></body></html>`;
}

export function pdfFileName(firstName: string): string {
  const slug = firstName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `your-top-homepage-fixes-${slug || "you"}.pdf`;
}
