import { describe, expect, it } from "vitest";
import { boxesOverlap, detectCollision, resolvePosition } from "./collision";

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
