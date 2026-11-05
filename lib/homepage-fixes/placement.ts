import type { Layout } from "./types";

// Where the mockup's words go (Maggie's feedback, 2026-11-05): keep the headline, the line under
// it and the button off people's faces and upper bodies. Pure geometry; the renderer measures each
// candidate in Chromium and this module decides. All rects are frame pixels (the 1400x878 #frame).

/** One person from locatePeople: [ymin, xmin, ymax, xmax], 0 to 1000, normalized to the photo. */
export type PersonBox = { box: [number, number, number, number] };
export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };

/** What a candidate changes about the first section. Defaults: zoom 1, scale 1, layout width, glue on. */
export type Placement = {
  layout: Layout; photo_focus: string;
  photo_zoom?: number; headline_scale?: number; copy_width?: number;
  /** false: the headline's last two words may wrap apart (the glued pair did not fit). */
  headline_glue?: boolean;
};

/** What the renderer measured for one candidate. natural is the photo's own size (if it decoded). */
export type Measured = { copy: Rect; photo: Rect; overflow: boolean; natural?: Size };

export const COPY_PAD = 24;
export const FACE_BAND = 0.35; // top share of a person box treated as the face
export const FACE_WEIGHT = 4;
export const DEFAULT_WIDTH: Record<"left" | "right", number> = { left: 640, right: 600 };
/** Size steps for left/right: the default, then a smaller headline in a narrower column. */
export const SIZE_STEPS: Record<"left" | "right", { scale: number; width: number }[]> = {
  left: [{ scale: 1, width: 640 }, { scale: 0.85, width: 520 }, { scale: 0.72, width: 440 }],
  right: [{ scale: 1, width: 600 }, { scale: 0.85, width: 480 }, { scale: 0.72, width: 420 }],
};
export const ZOOMS = [1.25, 1.5];

export const parseFocus = (f: string): [number, number] => {
  const m = f.trim().match(/^(\d{1,3})% (\d{1,3})%$/);
  return m ? [Math.min(100, Number(m[1])), Math.min(100, Number(m[2]))] : [50, 40];
};
export const focusOf = (x: number, y: number) => `${Math.round(x)}% ${Math.round(y)}%`;

// ---------- rect helpers ----------

export const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
export const area = (r: Rect | null) => (r ? r.w * r.h : 0);
export const faceBand = (r: Rect): Rect => ({ x: r.x, y: r.y, w: r.w, h: r.h * FACE_BAND });

/**
 * A photo-normalized box in frame pixels, for a photo drawn as `background-size: cover` at
 * `background-position: fx% fy%` in `area`, then scaled by `zoom` about that same focus point
 * (the renderer's transform; identical to a background-size `zoom` times cover).
 */
export function mapBox(b: PersonBox, natural: Size, photo: Rect, focus: string, zoom = 1): Rect {
  const [fx, fy] = parseFocus(focus).map((v) => v / 100);
  const s = Math.max(photo.w / natural.w, photo.h / natural.h);
  const rw = natural.w * s, rh = natural.h * s;
  const ox = (photo.w - rw) * fx, oy = (photo.h - rh) * fy;
  const cx = photo.w * fx, cy = photo.h * fy;
  const pt = (u: number, v: number) => ({ x: photo.x + cx + (ox + u * rw - cx) * zoom, y: photo.y + cy + (oy + v * rh - cy) * zoom });
  const [ymin, xmin, ymax, xmax] = b.box.map((n) => n / 1000);
  const a = pt(xmin, ymin), c = pt(xmax, ymax);
  return { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
}

/** Overlap of the padded copy block with each visible person: plain area, and a score with faces x4. */
export function overlapOf(copy: Rect, people: Rect[], photo: Rect): { area: number; score: number } {
  const c = pad(copy, COPY_PAD);
  let a = 0, score = 0;
  for (const p of people) {
    const vis = intersect(p, photo);
    if (!vis) continue;
    const body = area(intersect(c, vis));
    const face = area(intersect(c, intersect(faceBand(p), photo) ?? { x: 0, y: 0, w: 0, h: 0 }));
    a += body;
    score += body + (FACE_WEIGHT - 1) * face;
  }
  return { area: a, score };
}

/** Share of the faces' area that falls outside the photo area (cut off by the frame). */
export function faceCut(people: Rect[], photo: Rect): number {
  let total = 0, inside = 0;
  for (const p of people) {
    const f = faceBand(p);
    total += area(f);
    inside += area(intersect(f, photo));
  }
  return total ? 1 - inside / total : 0;
}
const MAX_ZOOM_CUT = 0.05;

// ---------- candidates ----------

const opposite = (l: "left" | "right") => (l === "left" ? "right" : "left");
const sized = (layout: "left" | "right", focus: string, zoom?: number): Placement[] =>
  SIZE_STEPS[layout].map((st, i) => ({
    layout, photo_focus: focus,
    ...(zoom ? { photo_zoom: zoom } : {}),
    ...(i ? { headline_scale: st.scale, copy_width: st.width } : {}),
  }));

/**
 * Zoomed-in focus that pushes the people's center away from the text: toward 75% of the width when
 * the text is on the left, 25% when it is on the right. The vertical focus stays the model's unless
 * that cuts a face off the top or bottom, then the nearest focus that keeps faces in.
 */
export function zoomFocus(boxes: PersonBox[], natural: Size, photo: Rect, base: string, zoom: number, text: "left" | "right"): string {
  const [, by] = parseFocus(base);
  const union = (f: string) => {
    const rs = boxes.map((b) => mapBox(b, natural, photo, f, zoom));
    const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.w));
    return { rs, cx: (x0 + x1) / 2 };
  };
  const target = photo.x + photo.w * (text === "left" ? 0.75 : 0.25);
  let fx = 50, best = Infinity;
  for (let x = 0; x <= 100; x += 5) {
    const d = Math.abs(union(focusOf(x, by)).cx - target);
    if (d < best - 0.5) { best = d; fx = x; }
  }
  const ys = [by, ...Array.from({ length: 21 }, (_, i) => i * 5).sort((a, b) => Math.abs(a - by) - Math.abs(b - by))];
  const fy = ys.find((y) => faceCut(union(focusOf(fx, y)).rs, photo) <= MAX_ZOOM_CUT) ?? by;
  return focusOf(fx, fy);
}

/**
 * Candidates in order (the brief's design): as written; smaller headline + narrower column; the
 * opposite side; the photo zoomed and shifted so the people sit away from the text (text on the
 * emptier side); then center and box. The as-written one is always first, whatever its layout.
 */
export function candidates(base: Placement, boxes: PersonBox[], natural: Size | undefined, photo: Rect | undefined, peopleCenter?: number): Placement[] {
  const out: Placement[] = [base];
  const sides: ("left" | "right")[] = base.layout === "left" || base.layout === "right" ? [base.layout, opposite(base.layout)] : ["left", "right"];
  for (const side of sides) out.push(...sized(side, base.photo_focus));
  if (boxes.length && natural && photo) {
    // Text goes where the people are not: the side away from their center in the as-written render.
    const text: "left" | "right" = peopleCenter !== undefined && peopleCenter < photo.x + photo.w / 2 ? "right" : "left";
    for (const z of ZOOMS) out.push(...sized(text, zoomFocus(boxes, natural, photo, base.photo_focus, z, text), z));
  }
  for (const l of ["center", "box"] as const) out.push({ layout: l, photo_focus: base.photo_focus });
  const key = (p: Placement) => JSON.stringify([p.layout, p.photo_focus, p.photo_zoom, p.headline_scale, p.copy_width]);
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(key(p)) && !!seen.add(key(p)));
}

// ---------- search ----------

export type Tried = { placement: Placement; measured: Measured; overlap: number; score: number; cut: number; ok: boolean };

function judge(p: Placement, m: Measured, boxes: PersonBox[]): Tried {
  const people = m.natural ? boxes.map((b) => mapBox(b, m.natural!, m.photo, p.photo_focus, p.photo_zoom ?? 1)) : [];
  const { area: overlap, score } = overlapOf(m.copy, people, m.photo);
  const cut = faceCut(people, m.photo);
  const ok = !m.overflow && overlap === 0 && (!(p.photo_zoom && p.photo_zoom > 1) || cut <= MAX_ZOOM_CUT);
  return { placement: p, measured: m, overlap, score, cut, ok };
}

/**
 * Tries candidates in order and returns the first with no overflow and no overlap. A headline that
 * overflows with its last two words glued is measured again unglued. If none passes: the
 * non-overflowing candidate with the lowest face-weighted overlap (ties: the earlier one).
 */
export async function searchPlacement(
  base: Placement, boxes: PersonBox[], measure: (p: Placement) => Promise<Measured>,
): Promise<{ chosen: Tried; tried: Tried[] }> {
  const tried: Tried[] = [];
  const run = async (p: Placement) => {
    let m = await measure(p);
    let q = p;
    if (m.overflow) {
      q = { ...p, headline_glue: false };
      m = await measure(q);
    }
    const t = judge(q, m, boxes);
    tried.push(t);
    return t;
  };
  const first = await run(base);
  if (first.ok) return { chosen: first, tried };
  const m = first.measured;
  const people = m.natural ? boxes.map((b) => mapBox(b, m.natural!, m.photo, base.photo_focus)) : [];
  const center = people.length ? (Math.min(...people.map((r) => r.x)) + Math.max(...people.map((r) => r.x + r.w))) / 2 : undefined;
  for (const p of candidates(base, boxes, m.natural, m.photo, center).slice(1)) {
    const t = await run(p);
    if (t.ok) return { chosen: t, tried };
  }
  const pool = tried.some((t) => !t.measured.overflow) ? tried.filter((t) => !t.measured.overflow) : tried;
  const chosen = pool.reduce((a, b) => (b.score < a.score ? b : a));
  return { chosen, tried };
}
