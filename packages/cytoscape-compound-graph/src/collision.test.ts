import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  containmentShift,
  detectCollision,
  resolvePosition,
  type Point,
  type VisualBox,
} from "./collision";

describe("collision", () => {
  it("boxesOverlap detects intersection", () => {
    expect(
      boxesOverlap({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 5, x2: 15, y2: 15 }),
    ).toBe(true);
    expect(
      boxesOverlap({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 20, y1: 20, x2: 30, y2: 30 }),
    ).toBe(false);
  });

  it("detectCollision finds obstacles", () => {
    const box = { x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(detectCollision(box, [{ x1: 8, y1: 8, x2: 20, y2: 20 }])).toBe(true);
    expect(detectCollision(box, [{ x1: 20, y1: 20, x2: 30, y2: 30 }])).toBe(false);
  });

  it("resolvePosition returns target when no bounds or obstacles", () => {
    const boxForCenter = (center: { x: number; y: number }) => ({
      x1: center.x - 1,
      y1: center.y - 1,
      x2: center.x + 1,
      y2: center.y + 1,
    });
    expect(
      resolvePosition({
        from: { x: 0, y: 0 },
        to: { x: 10, y: 10 },
        boxForCenter,
      }),
    ).toEqual({ x: 10, y: 10 });
  });

  it("resolvePosition clamps each bound axis independently", () => {
    const bounds = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const boxForCenter = (center: { x: number; y: number }) => ({
      x1: center.x - 10,
      y1: center.y - 10,
      x2: center.x + 10,
      y2: center.y + 10,
    });
    const left = resolvePosition({
      from: { x: 50, y: 50 },
      to: { x: -50, y: 50 },
      bounds,
      boxForCenter,
    });
    expect(left.x).toBe(10);
    const top = resolvePosition({
      from: { x: 50, y: 50 },
      to: { x: 50, y: -50 },
      bounds,
      boxForCenter,
    });
    expect(top.y).toBe(10);
    const right = resolvePosition({
      from: { x: 50, y: 50 },
      to: { x: 150, y: 50 },
      bounds,
      boxForCenter,
    });
    expect(right.x).toBe(90);
    const bottom = resolvePosition({
      from: { x: 50, y: 50 },
      to: { x: 50, y: 150 },
      bounds,
      boxForCenter,
    });
    expect(bottom.y).toBe(90);
  });

  it("resolvePosition avoids obstacles along the drag segment", () => {
    const bounds = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const obstacle = { x1: 40, y1: 40, x2: 60, y2: 60 };
    const boxForCenter = (center: { x: number; y: number }) => ({
      x1: center.x - 5,
      y1: center.y - 5,
      x2: center.x + 5,
      y2: center.y + 5,
    });
    const result = resolvePosition({
      from: { x: 10, y: 10 },
      to: { x: 50, y: 50 },
      bounds,
      obstacles: [obstacle],
      boxForCenter,
    });
    expect(detectCollision(boxForCenter(result)!, [obstacle])).toBe(false);
  });

  it("resolvePosition avoids obstacles after viewport pre-clamp diverts drag", () => {
    const bounds = { x1: 3.654, y1: -269.272, x2: 424.987, y2: -47.272 };
    const obstacle = { x1: 360, y1: -110, x2: 680, y2: 110 };
    const boxForCenter = (center: { x: number; y: number }) => ({
      x1: center.x - 210,
      y1: center.y - 140,
      x2: center.x + 210,
      y2: center.y + 140,
    });
    const result = resolvePosition({
      from: { x: 0, y: 0 },
      to: { x: 800, y: 0 },
      bounds,
      obstacles: [obstacle],
      boxForCenter,
    });
    expect(detectCollision(boxForCenter(result)!, [obstacle])).toBe(false);
    expect(result.x).toBeLessThan(200);
  });

  /**
   * The two invariants documented on resolvePosition. Both have been broken in the past
   * by adding a containment pass after the obstacle search (which reintroduces overlap)
   * or by dropping containment whenever the clamp would collide (which lets a node walk
   * out of its container or off the viewport), so they are swept rather than sampled.
   */
  describe("resolvePosition invariants", () => {
    const seedRandom = (seed: number) => {
      let state = seed;
      return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    const boxAround = (halfW: number, halfH: number) => (center: Point): VisualBox => ({
      x1: center.x - halfW,
      y1: center.y - halfH,
      x2: center.x + halfW,
      y2: center.y + halfH,
    });

    const isInside = (box: VisualBox, bounds: VisualBox) => {
      const { dx, dy } = containmentShift(box, bounds);
      return Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6;
    };

    it("never lands on an obstacle, and never leaves bounds it started inside", () => {
      const random = seedRandom(20260826);
      let clearedStartsInsideBounds = 0;

      for (let iteration = 0; iteration < 5000; iteration++) {
        const boundsX = -300 + random() * 600;
        const boundsY = -300 + random() * 600;
        const bounds = {
          x1: boundsX,
          y1: boundsY,
          x2: boundsX + 300 + random() * 600,
          y2: boundsY + 300 + random() * 500,
        };
        // Half the sweep uses a box that fits inside `bounds` and starts there, so the
        // containment invariant is actually exercised; the rest deliberately generates
        // boxes too big for `bounds`, where containment is only best-effort.
        const fits = random() < 0.5;
        const halfW = fits
          ? 10 + random() * ((bounds.x2 - bounds.x1) / 2 - 20)
          : 20 + random() * 400;
        const halfH = fits
          ? 10 + random() * ((bounds.y2 - bounds.y1) / 2 - 20)
          : 20 + random() * 300;
        const boxForCenter = boxAround(halfW, halfH);

        const obstacles: VisualBox[] = [];
        for (let index = 0; index < 1 + Math.floor(random() * 3); index++) {
          const x1 = -600 + random() * 1200;
          const y1 = -600 + random() * 1200;
          obstacles.push({
            x1,
            y1,
            x2: x1 + 30 + random() * 300,
            y2: y1 + 30 + random() * 300,
          });
        }
        const from = fits
          ? {
              x: bounds.x1 + halfW + random() * (bounds.x2 - bounds.x1 - 2 * halfW),
              y: bounds.y1 + halfH + random() * (bounds.y2 - bounds.y1 - 2 * halfH),
            }
          : { x: -400 + random() * 800, y: -400 + random() * 800 };
        const to = { x: -1200 + random() * 2400, y: -1200 + random() * 2400 };

        // Every clamp assumes the gesture starts from a collision-free rest pose.
        if (detectCollision(boxForCenter(from), obstacles)) {
          continue;
        }

        const resolved = resolvePosition({ from, to, bounds, obstacles, boxForCenter });
        const resolvedBox = boxForCenter(resolved);

        expect(detectCollision(resolvedBox, obstacles)).toBe(false);
        if (isInside(boxForCenter(from), bounds)) {
          clearedStartsInsideBounds++;
          expect(isInside(resolvedBox, bounds)).toBe(true);
        }
      }

      // Guards against the sweep silently degenerating into "nothing was checked".
      expect(clearedStartsInsideBounds).toBeGreaterThan(1000);
    });
  });

  it("resolvePosition returns center unchanged when boxForCenter returns null inside bounds", () => {
    const bounds = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const result = resolvePosition({
      from: { x: 50, y: 50 },
      to: { x: 200, y: 200 },
      bounds,
      boxForCenter: () => null,
    });
    expect(result).toEqual({ x: 200, y: 200 });
  });
});
