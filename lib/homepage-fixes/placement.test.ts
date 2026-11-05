import { describe, expect, it } from "vitest";
import {
  candidates, faceCut, fallback, mapBox, overlapOf, peopleIn, searchPlacement, zoomFocus,
  type Measured, type PersonBox, type Placement, type Rect,
} from "./placement";

const PHOTO: Rect = { x: 0, y: 96, w: 1400, h: 782 };

describe("mapBox: photo-normalized box to frame pixels", () => {
  it("cover with a wide photo crops the sides by the focus", () => {
    // 2000x1000 photo into 1400x782: scale 0.782, drawn 1564 wide, 164 px of slack.
    const b: PersonBox = { box: [0, 0, 1000, 1000] };
    const left = mapBox(b, { w: 2000, h: 1000 }, PHOTO, "0% 50%");
    expect(left.x).toBeCloseTo(0, 6);
    expect(left.w).toBeCloseTo(1564, 6);
    expect(left.y).toBeCloseTo(96, 6);
    expect(left.h).toBeCloseTo(782, 6);
    const right = mapBox(b, { w: 2000, h: 1000 }, PHOTO, "100% 50%");
    expect(right.x).toBeCloseTo(-164, 6);
    const mid = mapBox({ box: [250, 500, 750, 600] }, { w: 2000, h: 1000 }, PHOTO, "50% 50%");
    expect(mid.x).toBeCloseTo(-82 + 0.5 * 1564, 6);
    expect(mid.w).toBeCloseTo(0.1 * 1564, 6);
    expect(mid.y).toBeCloseTo(96 + 0.25 * 782, 6);
  });

  it("a tall photo is cropped top and bottom by the vertical focus", () => {
    // 1000x2000 into 1400x782: scale 1.4, drawn 1400x2800, 2018 px of vertical slack.
    const b: PersonBox = { box: [0, 0, 100, 1000] };
    expect(mapBox(b, { w: 1000, h: 2000 }, PHOTO, "50% 0%").y).toBeCloseTo(96, 6);
    expect(mapBox(b, { w: 1000, h: 2000 }, PHOTO, "50% 40%").y).toBeCloseTo(96 - 0.4 * 2018, 6);
  });

  it("zoom scales about the focus point: the focus point stays put, the rest spreads out", () => {
    const n = { w: 1400, h: 782 }; // exactly the area: no slack
    const b: PersonBox = { box: [500, 500, 500, 500] }; // the center point
    const z = mapBox({ box: [0, 0, 1000, 1000] }, n, PHOTO, "50% 50%", 1.5);
    expect(z.w).toBeCloseTo(2100, 6);
    expect(z.x).toBeCloseTo(-350, 6);
    expect(mapBox(b, n, PHOTO, "50% 50%", 1.5).x).toBeCloseTo(700, 6);
    // Focus at the left edge: the left edge stays at 0, everything moves right.
    const l = mapBox({ box: [0, 500, 1000, 600] }, n, PHOTO, "0% 50%", 2);
    expect(l.x).toBeCloseTo(1400, 6);
    expect(l.w).toBeCloseTo(280, 6);
  });
});

describe("overlapOf: faces padded 40 px (hard), bodies padded 24 px (soft)", () => {
  const person = { body: { x: 500, y: 100, w: 200, h: 400 }, face: { x: 560, y: 110, w: 80, h: 100 } };
  it("bodies count inside the 24 px pad only", () => {
    expect(overlapOf({ x: 100, y: 300, w: 375, h: 100 }, [person], PHOTO).body).toBe(0); // 475 + 24 = 499
    expect(overlapOf({ x: 100, y: 300, w: 380, h: 100 }, [person], PHOTO).body).toBeGreaterThan(0);
  });

  it("faces count inside the 40 px pad: closer than 40 px is contact", () => {
    const near = overlapOf({ x: 100, y: 120, w: 421, h: 50 }, [person], PHOTO); // 521 + 40 = 561 > 560
    expect(near.face).toBeGreaterThan(0);
    const clear = overlapOf({ x: 100, y: 120, w: 419, h: 50 }, [person], PHOTO);
    expect(clear.face).toBe(0);
    expect(clear.body).toBeGreaterThan(0); // still on the body
  });

  it("score is face x 10 + body", () => {
    const o = overlapOf({ x: 560, y: 110, w: 80, h: 100 }, [person], PHOTO);
    expect(o.score).toBeCloseTo(10 * o.face + o.body, 6);
  });

  it("without a face box the face is the top 35% of the body box", () => {
    const [p] = peopleIn([{ box: [0, 0, 1000, 1000] }], { w: 1400, h: 782 }, PHOTO, "50% 50%");
    expect(p.face.h).toBeCloseTo(782 * 0.35, 6);
    const [q] = peopleIn([{ box: [0, 0, 1000, 1000], face: [100, 100, 200, 200] }], { w: 1400, h: 782 }, PHOTO, "50% 50%");
    expect(q.face).toEqual({ x: expect.closeTo(140, 6), y: expect.closeTo(96 + 78.2, 6), w: expect.closeTo(140, 6), h: expect.closeTo(78.2, 6) });
  });

  it("parts of a person outside the photo area do not count, and faceCut measures them", () => {
    const off = { body: { x: -300, y: 100, w: 200, h: 400 }, face: { x: -50, y: 100, w: 100, h: 100 } };
    expect(overlapOf({ x: -300, y: 100, w: 200, h: 400 }, [off], PHOTO).body).toBe(0);
    expect(faceCut([off], PHOTO)).toBeCloseTo(5000, 6);
    expect(faceCut([person], PHOTO)).toBe(0);
  });
});

describe("candidates", () => {
  const base: Placement = { layout: "left", photo_focus: "50% 40%" };
  it("as written, then size steps, then the opposite side, then center and box (no people)", () => {
    const c = candidates(base, [], undefined, undefined);
    expect(c).toEqual([
      { layout: "left", photo_focus: "50% 40%" },
      { layout: "left", photo_focus: "50% 40%", headline_scale: 0.85, copy_width: 520 },
      { layout: "left", photo_focus: "50% 40%", headline_scale: 0.72, copy_width: 440 },
      { layout: "right", photo_focus: "50% 40%" },
      { layout: "right", photo_focus: "50% 40%", headline_scale: 0.85, copy_width: 480 },
      { layout: "right", photo_focus: "50% 40%", headline_scale: 0.72, copy_width: 420 },
      { layout: "center", photo_focus: "50% 40%" },
      { layout: "box", photo_focus: "50% 40%" },
    ]);
  });

  it("with people: zoom 1.25 then 1.5, text on the side away from them, before center and box", () => {
    const boxes: PersonBox[] = [{ box: [100, 100, 600, 300] }]; // people on the left of the photo
    const c = candidates(base, boxes, { w: 2000, h: 1200 }, PHOTO, 300);
    const zoomed = c.filter((p) => p.photo_zoom);
    expect(zoomed.map((p) => [p.photo_zoom, p.layout, p.copy_width])).toEqual([
      [1.25, "right", undefined], [1.25, "right", 480], [1.25, "right", 420],
      [1.5, "right", undefined], [1.5, "right", 480], [1.5, "right", 420],
    ]);
    expect(c.indexOf(zoomed[0])).toBe(6);
    expect(c.slice(-2).map((p) => p.layout)).toEqual(["center", "box"]);
  });

  it("a center or box as-written choice is still tried first, then left and right", () => {
    const c = candidates({ layout: "center", photo_focus: "50% 40%" }, [], undefined, undefined);
    expect(c[0]).toEqual({ layout: "center", photo_focus: "50% 40%" });
    expect(c[1].layout).toBe("left");
    expect(c.filter((p) => p.layout === "center")).toHaveLength(1);
  });

  it("zoomFocus pushes the people's center toward the side away from the text", () => {
    const boxes: PersonBox[] = [{ box: [200, 400, 700, 600] }]; // centered
    const n = { w: 2000, h: 1200 };
    const toRight = zoomFocus(boxes, n, PHOTO, "50% 40%", 1.5, "left");
    const toLeft = zoomFocus(boxes, n, PHOTO, "50% 40%", 1.5, "right");
    const cx = (f: string) => { const r = mapBox(boxes[0], n, PHOTO, f, 1.5); return r.x + r.w / 2; };
    expect(cx(toRight!)).toBeGreaterThan(cx("50% 40%") + 100);
    expect(cx(toLeft!)).toBeLessThan(cx("50% 40%") - 100);
  });

  it("zoomFocus never pushes a face out of the photo area, and gives up when it must", () => {
    const n = { w: 2000, h: 1200 };
    const edge: PersonBox[] = [{ box: [0, 850, 500, 1000], face: [0, 900, 150, 1000] }]; // face at the right edge
    const f = zoomFocus(edge, n, PHOTO, "50% 40%", 1.5, "left");
    expect(f).not.toBeNull();
    expect(faceCut(peopleIn(edge, n, PHOTO, f!, 1.5), PHOTO)).toBeLessThanOrEqual(0.5);
    const huge: PersonBox[] = [{ box: [0, 0, 1000, 1000], face: [0, 0, 1000, 1000] }];
    expect(zoomFocus(huge, n, PHOTO, "50% 40%", 1.25, "left")).toBeNull();
    expect(candidates({ layout: "left", photo_focus: "50% 40%" }, huge, n, PHOTO, 700).some((p) => p.photo_zoom)).toBe(false);
  });
});

describe("searchPlacement with a fake measure", () => {
  const base: Placement = { layout: "left", photo_focus: "50% 40%" };
  const N = { w: 1400, h: 782 }; // no slack: boxes map straight onto the photo area
  // A person left of center: x 420..630, y 96..487 (face band 96..233).
  const PEOPLE: PersonBox[] = [{ box: [0, 300, 500, 450] }];
  const leftCopy = (w: number): Rect => ({ x: 96, y: 300, w, h: 300 });
  const rightCopy = (w: number): Rect => ({ x: 1304 - w, y: 300, w, h: 300 });

  function fake(over: (p: Placement) => Partial<Measured> = () => ({})) {
    const calls: Placement[] = [];
    const measure = async (p: Placement): Promise<Measured> => {
      calls.push(p);
      const w = p.copy_width ?? (p.layout === "right" ? 600 : 640);
      const copy = p.layout === "right" ? rightCopy(w) : p.layout === "left" ? leftCopy(w) : { x: 250, y: 300, w: 900, h: 300 };
      return { copy, photo: PHOTO, overflow: false, natural: N, ...over(p) };
    };
    return { calls, measure };
  }

  it("the first clean candidate wins and nothing after it is measured", async () => {
    const f = fake();
    // Copy at 96..736 (padded) hits the person at 420..630; 520 and 440 wide still do (padded to 640, 560);
    // the right side, 704..1304 padded to 680, is clear.
    const r = await searchPlacement(base, PEOPLE, f.measure);
    expect(r.chosen.ok).toBe(true);
    expect(r.chosen.placement).toEqual({ layout: "right", photo_focus: "50% 40%" });
    expect(f.calls).toHaveLength(4);
  });

  it("a zoom that pushes a face out of the photo area is rejected even with no overlap", async () => {
    const f = fake();
    const edgeFace: PersonBox[] = [{ box: [0, 900, 300, 1000], face: [0, 950, 100, 1000] }]; // face at the right edge
    const zoomed: Placement = { layout: "left", photo_focus: "0% 0%", photo_zoom: 2 }; // pushes the right edge out
    const r = await searchPlacement(zoomed, edgeFace, f.measure);
    expect(r.tried[0].rejected).toBe(true);
    expect(r.tried[0].ok).toBe(false);
    expect(r.chosen.placement.photo_zoom ?? 1).not.toBe(2);
  });

  it("as written wins straight away when nobody is under the words", async () => {
    const f = fake();
    const r = await searchPlacement(base, [], f.measure);
    expect(r.chosen.placement).toEqual(base);
    expect(f.calls).toHaveLength(1);
  });

  it("a glued headline that overflows is measured again unglued", async () => {
    const f = fake((p) => ({ overflow: p.headline_glue !== false }));
    const r = await searchPlacement(base, [], f.measure);
    expect(r.chosen.placement).toEqual({ ...base, headline_glue: false });
    expect(f.calls).toEqual([base, { ...base, headline_glue: false }]);
  });

  it("a word wider than the column shrinks the headline just enough (not below 0.6)", async () => {
    // The headline needs 652 px at full size in a 640 px column, so fit = 640 / 652 at any width.
    const f = fake((p) => {
      const need = 652 * (p.headline_scale ?? 1), width = p.copy_width ?? 640;
      return need > width ? { overflow: true, fit: width / need } : {};
    });
    const r = await searchPlacement(base, [], f.measure);
    expect(r.chosen.measured.overflow).toBe(false);
    expect(r.chosen.placement).toMatchObject({ layout: "left", headline_glue: false, headline_scale: 0.97 });
    expect(f.calls).toHaveLength(3); // glued, unglued, shrunk

    const g = fake((p) => ({ overflow: true, fit: 0.5 * (p.headline_scale ?? 1) })); // would need under 0.6
    const r2 = await searchPlacement(base, [], g.measure);
    expect(r2.tried.every((t) => (t.placement.headline_scale ?? 1) >= 0.6)).toBe(true);
  });

  it("overflowing candidates are rejected even when they overlap nobody", async () => {
    const f = fake((p) => ({ overflow: !p.copy_width }));
    const r = await searchPlacement(base, [], f.measure);
    expect(r.chosen.placement).toMatchObject({ layout: "left", headline_scale: 0.85, copy_width: 520 });
    expect(r.chosen.measured.overflow).toBe(false);
  });

  it("with no clean candidate, a face-free side layout beats a face-free center with less body overlap", async () => {
    const f = fake((p) => {
      if (p.layout === "right" && !p.photo_zoom && p.copy_width === 420) return { copy: { x: 600, y: 300, w: 300, h: 150 } }; // body only
      if (p.layout === "center") return { copy: { x: 600, y: 400, w: 20, h: 20 } }; // body only, tiny
      if (p.layout === "box") return { overflow: true, copy: { x: 1000, y: 700, w: 10, h: 10 } }; // clear, but overflows
      return { copy: { x: 400, y: 100, w: 400, h: 300 } }; // on the face
    });
    const r = await searchPlacement(base, PEOPLE, f.measure);
    expect(r.chosen.ok).toBe(false);
    expect(r.chosen.face).toBe(0);
    expect(r.chosen.placement).toMatchObject({ layout: "right", copy_width: 420 });
  });

});

describe("fallback", () => {
  const m = (overflow = false): Measured => ({ copy: { x: 0, y: 0, w: 1, h: 1 }, photo: PHOTO, overflow });
  const t = (layout: Placement["layout"], face: number, overlap: number, extra: { overflow?: boolean; rejected?: boolean } = {}) => ({
    placement: { layout, photo_focus: "50% 40%" }, measured: m(extra.overflow), face, overlap, score: 10 * face + overlap,
    rejected: !!extra.rejected, ok: false,
  });
  it("prefers zero face contact over any score", () => {
    expect(fallback([t("left", 10, 0), t("right", 0, 5000)]).placement.layout).toBe("right");
  });
  it("among face-free ones: sides first, then least body overlap", () => {
    expect(fallback([t("center", 0, 10), t("left", 0, 900), t("right", 0, 400)]).placement.layout).toBe("right");
    expect(fallback([t("center", 0, 10), t("box", 0, 5), t("left", 3, 0)]).placement.layout).toBe("box");
  });
  it("all touching faces: the lowest face x 10 + body", () => {
    expect(fallback([t("left", 100, 0), t("right", 50, 400)]).placement.layout).toBe("right");
  });
  it("never picks a rejected zoom or an overflowing one when another exists", () => {
    expect(fallback([t("left", 0, 0, { rejected: true }), t("right", 0, 0, { overflow: true }), t("center", 5, 5)]).placement.layout).toBe("center");
  });
});
