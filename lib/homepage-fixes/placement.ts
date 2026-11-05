import type { Layout } from "./types";

// Where the mockup's words go (Maggie's feedback, 2026-11-05): keep the headline, the line under
// it and the button off people's faces and upper bodies. Pure geometry; the renderer measures each
// candidate in Chromium and this module decides. All rects are frame pixels (the 1400x878 #frame).

/** One person from locatePeople: [ymin, xmin, ymax, xmax], 0 to 1000, normalized to the photo.
 * box: head to waist; face: the face alone (optional, older callers send only box). */
export type PersonBox = { box: [number, number, number, number]; face?: [number, number, number, number] };
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
export type Measured = {
  copy: Rect; photo: Rect; overflow: boolean; natural?: Size;
  /** When only the headline is too wide (a word longer than the column): its width / the width it needs. */
  fit?: number;
};

export const COPY_PAD = 24; // against bodies
export const FACE_PAD = 40; // against faces
export const FACE_BAND = 0.35; // top share of a body box used as the face when there is no face box
export const FACE_WEIGHT = 10;
export const DEFAULT_WIDTH: Record<"left" | "right", number> = { left: 640, right: 600 };
/** Size steps for left/right: the default, then a smaller headline in a narrower column. */
export const SIZE_STEPS: Record<"left" | "right", { scale: number; width: number }[]> = {
  left: [{ scale: 1, width: 640 }, { scale: 0.85, width: 520 }, { scale: 0.72, width: 440 }],
  right: [{ scale: 1, width: 600 }, { scale: 0.85, width: 480 }, { scale: 0.72, width: 420 }],
};
export const ZOOMS = [1.25, 1.5];
/** Smallest headline scale the shrink-to-fit step may use (a single word wider than its column). */
export const MIN_FIT_SCALE = 0.6;

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

/** Where a person's face is in frame pixels: their face box, or the top of the body box without one. */
export function faceOf(b: PersonBox, natural: Size, photo: Rect, focus: string, zoom = 1): Rect {
  return b.face ? mapBox({ box: b.face }, natural, photo, focus, zoom) : faceBand(mapBox(b, natural, photo, focus, zoom));
}

export type Person = { body: Rect; face: Rect };
export const peopleIn = (boxes: PersonBox[], natural: Size, photo: Rect, focus: string, zoom = 1): Person[] =>
  boxes.map((b) => ({ body: mapBox(b, natural, photo, focus, zoom), face: faceOf(b, natural, photo, focus, zoom) }));

/**
 * How much the copy block touches people, counting only what is visible in the photo area.
 * face: the copy padded 40 px against each face (the hard rule). body: padded 24 px against each
 * head-to-waist box (the soft rule). score = face x 10 + body.
 */
export function overlapOf(copy: Rect, people: Person[], photo: Rect): { face: number; body: number; score: number } {
  const cf = pad(copy, FACE_PAD), cb = pad(copy, COPY_PAD);
  let face = 0, body = 0;
  for (const p of people) {
    face += area(intersect(cf, intersect(p.face, photo) ?? NONE));
    body += area(intersect(cb, intersect(p.body, photo) ?? NONE));
  }
  return { face, body, score: FACE_WEIGHT * face + body };
}
const NONE: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** Area of the faces that falls outside the photo area (cut off by the frame), in px². */
export function faceCut(people: Person[], photo: Rect): number {
  return people.reduce((sum, p) => sum + area(p.face) - area(intersect(p.face, photo)), 0);
}
const cutsFace = (people: Person[], photo: Rect) => faceCut(people, photo) > 0.5;

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
 * the text is on the left, 25% when it is on the right, keeping every face wholly in the photo area
 * (ties: the vertical focus nearest the model's). null when no focus keeps the faces in.
 */
export function zoomFocus(boxes: PersonBox[], natural: Size, photo: Rect, base: string, zoom: number, text: "left" | "right"): string | null {
  const [, by] = parseFocus(base);
  const target = photo.x + photo.w * (text === "left" ? 0.75 : 0.25);
  let best: { f: string; d: number; dy: number } | null = null;
  for (let x = 0; x <= 100; x += 5) {
    for (let y = 0; y <= 100; y += 5) {
      const f = focusOf(x, y);
      const ps = peopleIn(boxes, natural, photo, f, zoom);
      if (cutsFace(ps, photo)) continue;
      const cx = (Math.min(...ps.map((p) => p.body.x)) + Math.max(...ps.map((p) => p.body.x + p.body.w))) / 2;
      const d = Math.abs(cx - target), dy = Math.abs(y - by);
      if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && dy < best.dy)) best = { f, d, dy };
    }
  }
  return best?.f ?? null;
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
    for (const z of ZOOMS) {
      const f = zoomFocus(boxes, natural, photo, base.photo_focus, z, text);
      if (f) out.push(...sized(text, f, z));
    }
  }
  for (const l of ["center", "box"] as const) out.push({ layout: l, photo_focus: base.photo_focus });
  const key = (p: Placement) => JSON.stringify([p.layout, p.photo_focus, p.photo_zoom, p.headline_scale, p.copy_width]);
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(key(p)) && !!seen.add(key(p)));
}

// ---------- search ----------

export type Tried = {
  placement: Placement; measured: Measured;
  /** px² of padded copy on faces (hard) and on bodies (soft); score = face x 10 + body. */
  face: number; overlap: number; score: number;
  /** A zoom that pushes part of a face out of the photo area: never chosen. */
  rejected: boolean; ok: boolean;
};

function judge(p: Placement, m: Measured, boxes: PersonBox[]): Tried {
  const zoom = p.photo_zoom ?? 1;
  const people = m.natural ? peopleIn(boxes, m.natural, m.photo, p.photo_focus, zoom) : [];
  const { face, body, score } = overlapOf(m.copy, people, m.photo);
  const rejected = zoom > 1 && cutsFace(people, m.photo);
  const ok = !m.overflow && face === 0 && body === 0 && !rejected;
  return { placement: p, measured: m, face, overlap: body, score, rejected, ok };
}

const side = (t: Tried) => t.placement.layout === "left" || t.placement.layout === "right";
const least = (ts: Tried[], by: (t: Tried) => number) => ts.reduce((a, b) => (by(b) < by(a) ? b : a));

/** With no clean candidate: no overflow if any avoids it; then no face contact (side layouts first, least body overlap); else the lowest score. Ties: the earlier one. */
export function fallback(tried: Tried[]): Tried {
  const usable = tried.some((t) => !t.rejected) ? tried.filter((t) => !t.rejected) : tried;
  const pool = usable.some((t) => !t.measured.overflow) ? usable.filter((t) => !t.measured.overflow) : usable;
  const faceFree = pool.filter((t) => t.face === 0);
  if (faceFree.length) {
    const sides = faceFree.filter(side);
    return least(sides.length ? sides : faceFree, (t) => t.overlap);
  }
  return least(pool, (t) => t.score);
}

/**
 * Tries candidates in order and returns the first with no overflow, no face contact and no body
 * overlap. A headline that overflows with its last two words glued is measured again unglued.
 * If none is clean, see fallback.
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
    // Still too wide unglued: one word is longer than the column. Shrink the headline just enough.
    if (m.overflow && m.fit && m.fit < 1) {
      const scale = Math.floor((q.headline_scale ?? 1) * m.fit * 100) / 100 - 0.01;
      if (scale >= MIN_FIT_SCALE) {
        const r = { ...q, headline_scale: scale };
        const m2 = await measure(r);
        if (!m2.overflow) { q = r; m = m2; }
      }
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
  return { chosen: fallback(tried), tried };
}
