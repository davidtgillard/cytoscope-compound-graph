/**
 * Pure box/position geometry shared by every clamp in layout-model.ts (child-in-parent,
 * compound-vs-compound, resize-vs-sibling). None of these functions know what a "child"
 * or a "compound" is - they only deal in boxes and centers - so the same math keeps
 * working unchanged as more objects (e.g. additional children of one parent) are added;
 * callers just need to supply a longer `obstacles` list. This module has no dependency
 * on layout-model.ts (it's the other way around) so it stays reusable and easy to test
 * in isolation.
 */

/** @internal */
export interface VisualBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** @internal */
export interface Point {
  x: number;
  y: number;
}

/** @internal */
export function boxesOverlap(left: VisualBox, right: VisualBox): boolean {
  return left.x1 < right.x2 && left.x2 > right.x1 && left.y1 < right.y2 && left.y2 > right.y1;
}

/** True if `box` overlaps any of the given obstacle boxes. */
/** @internal */
export function detectCollision(box: VisualBox, obstacles: VisualBox[]): boolean {
  return obstacles.some((obstacle) => boxesOverlap(box, obstacle));
}

/** The translation that brings `box` fully inside `bounds` ({dx:0, dy:0} if already inside). */
export function containmentShift(box: VisualBox, bounds: VisualBox): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (box.x1 < bounds.x1) {
    dx = bounds.x1 - box.x1;
  } else if (box.x2 > bounds.x2) {
    dx = bounds.x2 - box.x2;
  }
  if (box.y1 < bounds.y1) {
    dy = bounds.y1 - box.y1;
  } else if (box.y2 > bounds.y2) {
    dy = bounds.y2 - box.y2;
  }
  return { dx, dy };
}

/** Intersects `box` with `bounds` by clamping each edge independently. */
export function clampBoxEdgesToBounds(box: VisualBox, bounds: VisualBox): VisualBox {
  return {
    x1: Math.max(box.x1, bounds.x1),
    y1: Math.max(box.y1, bounds.y1),
    x2: Math.min(box.x2, bounds.x2),
    y2: Math.min(box.y2, bounds.y2),
  };
}

function keepInside(
  center: Point,
  bounds: VisualBox | null,
  boxForCenter: (center: Point) => VisualBox | null,
): Point {
  if (!bounds) {
    return center;
  }
  const box = boxForCenter(center);
  if (!box) {
    return center;
  }
  const { dx, dy } = containmentShift(box, bounds);
  return { x: center.x + dx, y: center.y + dy };
}

/**
 * Binary-searches the line from `from` to `to` for the point closest to `to` whose box
 * does not collide with any `obstacles`. Assumes `from` itself is collision-free (it's
 * the last known-good position), matching how a drag/resize gesture always starts from a
 * valid state.
 */
function resolveAgainstObstacles(
  from: Point,
  to: Point,
  obstacles: VisualBox[],
  boxForCenter: (center: Point) => VisualBox | null,
): Point {
  if (obstacles.length === 0) {
    return to;
  }

  const collidesAt = (center: Point): boolean => {
    const box = boxForCenter(center);
    return box === null || detectCollision(box, obstacles);
  };

  if (!collidesAt(to)) {
    return to;
  }

  let low = 0;
  let high = 1;
  let best = { ...from };

  for (let iteration = 0; iteration < 40; iteration++) {
    const mid = (low + high) / 2;
    const candidate = {
      x: from.x + (to.x - from.x) * mid,
      y: from.y + (to.y - from.y) * mid,
    };
    if (collidesAt(candidate)) {
      high = mid;
    } else {
      best = candidate;
      low = mid;
    }
  }

  return best;
}

/**
 * Resolves a proposed move from `from` to `to` in exactly two ordered steps: pull the
 * *target* inside `bounds`, then binary-search the `from`→target segment for the point
 * closest to the target that clears `obstacles`.
 *
 * The order matters, and so does the fact that nothing runs after the obstacle search.
 * Containment is a set of linear inequalities on the center (`center.x >= bounds.x1 +
 * halfW`, and so on), so it is convex: every point interpolated between two centers
 * whose boxes fit inside `bounds` also fits inside `bounds`. Because `from` is the last
 * known-good rest position and the target has already been pulled inside, the search
 * therefore cannot hand back an out-of-bounds center - which is why no second
 * containment pass is needed. Adding one back would be actively harmful: a containment
 * shift applied *after* the search is a blind translation that can slide the box into an
 * obstacle the search just cleared.
 *
 * Two invariants follow, and {@link file://./collision.test.ts} pins both:
 * - the result never overlaps an obstacle, since the obstacle search has the last word;
 * - if `from` satisfied `bounds`, so does the result. When `from` starts outside
 *   `bounds` (a box larger than the viewport, say) containment is merely best-effort,
 *   and staying clear of obstacles wins.
 */
/** @internal */
export function resolvePosition(params: {
  from: Point;
  to: Point;
  bounds?: VisualBox | null;
  obstacles?: VisualBox[];
  boxForCenter: (center: Point) => VisualBox | null;
}): Point {
  const { from, to, bounds = null, obstacles = [], boxForCenter } = params;
  const boundedTarget = keepInside(to, bounds, boxForCenter);
  return resolveAgainstObstacles(from, boundedTarget, obstacles, boxForCenter);
}
