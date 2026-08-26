/**
 * Guardrails for the four positional requirements every gesture must satisfy. They are
 * stated once here, in one place, because they cut across `collision.ts` (clamp maths),
 * `layout-model.ts` (move/resize) and `layout-unjam.ts` (load-time separation), and each
 * of those has broken one of them at least once:
 *
 * R1. Moving a node - container or leaf - must not change the position of any other node.
 *     The sole exception is a container, which carries its own subtree with it.
 * R2. Moving a container must hold every descendant's position *relative to* that
 *     container constant.
 * R3. Moving a container must hold the extent of its boundary constant.
 * R4. Changing the extent of a container's boundary must not change the position of any
 *     other node, including its own children.
 *
 * Two supporting invariants make R1-R4 meaningful rather than vacuous, and are pinned
 * alongside them because a clamp can trivially satisfy R1-R4 by refusing to move at all,
 * or by moving somewhere illegal:
 *
 * R5. A resolved gesture never leaves the moving node overlapping a node it may not
 *     overlap.
 * R6. A resolved gesture never pushes the moving node outside a boundary it started
 *     inside - a leaf stays within its container's interior, a container stays within the
 *     viewport.
 */
import { describe, expect, it } from "vitest";
import { containmentShift, type VisualBox } from "./collision";
import {
  ALL_LOOSE_EDGES,
  absoluteCenter,
  buildLayoutModel,
  compositeInteriorBox,
  compositeOuterBox,
  growCompositeToFitChildren,
  moveChild,
  moveComposite,
  nodesOverlapInModel,
  resizeComposite,
  subtreeNodeIds,
  visualBox,
  type LayoutNodeInput,
  type WorkPackageLayoutModel,
} from "./layout-model";
import { unjamLayoutModel } from "./layout-unjam";

const LEAF = { halfW: 20, halfHTop: 20, halfHBottom: 20 };

interface Pose {
  relative: { x: number; y: number };
  absolute: { x: number; y: number };
  size: { w: number; h: number } | null;
}

function poses(model: WorkPackageLayoutModel): Map<string, Pose> {
  const result = new Map<string, Pose>();
  for (const [id, node] of model.nodes) {
    result.set(id, {
      relative: { ...node.center },
      absolute: absoluteCenter(model, id),
      size: node.size ? { ...node.size } : null,
    });
  }
  return result;
}

/** Ids whose pose is allowed to change when `movedId` is the gesture subject. */
function subtreeOf(model: WorkPackageLayoutModel, movedId: string): Set<string> {
  return new Set(subtreeNodeIds(model, movedId));
}

/** R1: every node outside the gesture subject's own subtree is byte-identical. */
function expectOnlySubtreeMoved(
  before: WorkPackageLayoutModel,
  after: WorkPackageLayoutModel,
  movedId: string,
): void {
  const beforePoses = poses(before);
  const afterPoses = poses(after);
  const subtree = subtreeOf(before, movedId);
  for (const id of beforePoses.keys()) {
    if (subtree.has(id)) {
      continue;
    }
    expect({ id, pose: afterPoses.get(id) }).toEqual({ id, pose: beforePoses.get(id) });
  }
}

/** R2 + R3: descendants keep their offsets inside `movedId`, whose extent is unchanged. */
function expectRigidSubtree(
  before: WorkPackageLayoutModel,
  after: WorkPackageLayoutModel,
  movedId: string,
): void {
  const beforePoses = poses(before);
  const afterPoses = poses(after);
  expect(afterPoses.get(movedId)!.size).toEqual(beforePoses.get(movedId)!.size);

  const delta = {
    x: afterPoses.get(movedId)!.absolute.x - beforePoses.get(movedId)!.absolute.x,
    y: afterPoses.get(movedId)!.absolute.y - beforePoses.get(movedId)!.absolute.y,
  };
  for (const id of subtreeOf(before, movedId)) {
    if (id === movedId) {
      continue;
    }
    expect({ id, relative: afterPoses.get(id)!.relative }).toEqual({
      id,
      relative: beforePoses.get(id)!.relative,
    });
    expect({ id, absolute: afterPoses.get(id)!.absolute }).toEqual({
      id,
      absolute: {
        x: beforePoses.get(id)!.absolute.x + delta.x,
        y: beforePoses.get(id)!.absolute.y + delta.y,
      },
    });
  }
}

/** R4: the whole graph is frozen apart from `resizedId`'s own extent. */
function expectExtentChangeOnly(
  before: WorkPackageLayoutModel,
  after: WorkPackageLayoutModel,
  resizedId: string,
): void {
  const beforePoses = poses(before);
  const afterPoses = poses(after);
  for (const id of beforePoses.keys()) {
    if (id === resizedId) {
      continue;
    }
    expect({ id, absolute: afterPoses.get(id)!.absolute }).toEqual({
      id,
      absolute: beforePoses.get(id)!.absolute,
    });
    expect({ id, size: afterPoses.get(id)!.size }).toEqual({
      id,
      size: beforePoses.get(id)!.size,
    });
  }
}

/**
 * R5: `nodeId` overlaps nothing it is forbidden from overlapping.
 *
 * Pairs the boxes exactly as the clamps do (`boxForCenter` against `obstacleBoxesFor` in
 * layout-model.ts): the moving node contributes its bare footprint and each obstacle
 * contributes its padded visual box, so `nodeOverlapPadding` is charged once per pair
 * rather than twice.
 */
function expectNoForbiddenOverlap(model: WorkPackageLayoutModel, nodeId: string): void {
  const moving = movingBoxOf(model, nodeId);
  for (const otherId of model.nodes.keys()) {
    if (otherId === nodeId || subtreeOf(model, nodeId).has(otherId)) {
      continue;
    }
    if (subtreeOf(model, otherId).has(nodeId)) {
      continue;
    }
    const obstacle = visualBoxOf(model, otherId);
    const overlaps =
      moving.x1 < obstacle.x2 &&
      moving.x2 > obstacle.x1 &&
      moving.y1 < obstacle.y2 &&
      moving.y2 > obstacle.y1;
    expect({ nodeId, otherId, overlaps }).toEqual({ nodeId, otherId, overlaps: false });
  }
}

function boxIsInside(box: VisualBox, bounds: VisualBox): boolean {
  const { dx, dy } = containmentShift(box, bounds);
  return Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6;
}

/**
 * Two containers side by side, the left one holding two leaves and the right one holding
 * a nested container with its own leaf. Deep enough that a relative/absolute mix-up in
 * any layer shows up as a wrong number.
 */
function nestedScenario(): WorkPackageLayoutModel {
  const inputs: LayoutNodeInput[] = [
    { id: "left", isCompound: true },
    { id: "left-a", parent: "left", footprint: LEAF },
    { id: "left-b", parent: "left", footprint: LEAF },
    { id: "right", isCompound: true },
    { id: "mid", parent: "right", isCompound: true },
    { id: "mid-a", parent: "mid", footprint: LEAF },
  ];
  return buildLayoutModel(inputs, {
    left: { x: 1000, y: 500, w: 400, h: 300 },
    "left-a": { x: -90, y: -30 },
    "left-b": { x: 90, y: -30 },
    right: { x: 1600, y: 500, w: 500, h: 400 },
    mid: { x: -100, y: 0, w: 220, h: 180 },
    "mid-a": { x: -50, y: 0 },
  });
}

describe("positional requirements", () => {
  describe("R1: a gesture moves nothing outside its own subtree", () => {
    it("holds when a leaf is dragged", () => {
      const before = nestedScenario();
      const after = moveChild(before, "left-a", { x: 40, y: 60 });
      expect(absoluteCenter(after, "left-a")).toEqual({ x: 1040, y: 560 });
      expectOnlySubtreeMoved(before, after, "left-a");
    });

    it("holds when a leaf inside a nested container is dragged", () => {
      const before = nestedScenario();
      const after = moveChild(before, "mid-a", { x: 50, y: -20 });
      expect(absoluteCenter(after, "mid-a")).toEqual({ x: 1550, y: 480 });
      expectOnlySubtreeMoved(before, after, "mid-a");
    });

    it("holds when a root container is dragged", () => {
      const before = nestedScenario();
      const after = moveComposite(before, "left", { x: 950, y: 450 });
      expectOnlySubtreeMoved(before, after, "left");
    });

    it("holds when a nested container is dragged", () => {
      const before = nestedScenario();
      const after = moveComposite(before, "mid", { x: -80, y: 40 });
      expect(absoluteCenter(after, "mid")).toEqual({ x: 1520, y: 540 });
      expectOnlySubtreeMoved(before, after, "mid");
    });

    it("holds when a drag is blocked by a neighbour", () => {
      const before = nestedScenario();
      // Dead centre of "right", so the clamp has to stop the drag short.
      const after = moveComposite(before, "left", { x: 1600, y: 500 });
      expectOnlySubtreeMoved(before, after, "left");
      expectNoForbiddenOverlap(after, "left");
      expect(absoluteCenter(after, "left").x).toBeLessThan(1600);
    });
  });

  describe("R2 + R3: a container drag is a rigid translation", () => {
    it("carries a root container's subtree without deforming it", () => {
      const before = nestedScenario();
      const after = moveComposite(before, "right", { x: 1600, y: 900 });
      expectRigidSubtree(before, after, "right");
    });

    it("carries a nested container's subtree without deforming it", () => {
      const before = nestedScenario();
      const after = moveComposite(before, "mid", { x: -60, y: 30 });
      expectRigidSubtree(before, after, "mid");
    });

    it("keeps the extent constant even when the drag is clamped short", () => {
      const before = nestedScenario();
      const after = moveComposite(
        before,
        "left",
        { x: 4000, y: 500 },
        { viewportBounds: { x1: 700, y1: 200, x2: 2200, y2: 900 } },
      );
      expectRigidSubtree(before, after, "left");
      expectOnlySubtreeMoved(before, after, "left");
    });
  });

  describe("R4: changing a container's extent moves nothing", () => {
    it("holds for a root container resize", () => {
      const before = nestedScenario();
      // "left" starts as 800..1200 x 350..650; dragging the se corner out by (120, 80)
      // must extend exactly those two edges.
      const after = resizeComposite(before, "left", "se", 120, 80, {
        childrenBox: null,
        edgeClearance: 8,
        looseEdges: ALL_LOOSE_EDGES,
      });
      expect(compositeOuterBox(after, "left")).toEqual({
        x1: 800,
        y1: 350,
        x2: 1320,
        y2: 730,
      });
      expectExtentChangeOnly(before, after, "left");
    });

    it("holds for a nested container resize", () => {
      const before = nestedScenario();
      // "mid" starts as 1390..1610 x 410..590, offset -100 from "right" at x 1600. The
      // new box is asserted absolutely, so storing an absolute centre in the
      // parent-relative field would double the offset and fail here.
      const after = resizeComposite(before, "mid", "nw", -40, -30, {
        childrenBox: null,
        edgeClearance: 8,
        looseEdges: ALL_LOOSE_EDGES,
      });
      expect(compositeOuterBox(after, "mid")).toEqual({
        x1: 1350,
        y1: 380,
        x2: 1610,
        y2: 590,
      });
      expectExtentChangeOnly(before, after, "mid");
    });

    it("holds for every corner of a nested container", () => {
      const before = nestedScenario();
      for (const corner of ["nw", "ne", "sw", "se"] as const) {
        for (const [dx, dy] of [
          [40, 30],
          [-40, -30],
          [40, -30],
          [-40, 30],
        ]) {
          const after = resizeComposite(before, "mid", corner, dx, dy, {
            childrenBox: null,
            edgeClearance: 8,
            looseEdges: ALL_LOOSE_EDGES,
          });
          expectExtentChangeOnly(before, after, "mid");
        }
      }
    });

    it("holds when load-time unjam grows a container to fit its children", () => {
      // `a` sits outside a too-small container: the grow pass must enlarge the box
      // around it rather than sliding the box and dragging `a` along.
      const before = buildLayoutModel(
        [
          { id: "root", isCompound: true },
          { id: "a", parent: "root", footprint: LEAF },
        ],
        {
          root: { x: 500, y: 300, w: 90, h: 90 },
          a: { x: 120, y: 0 },
        },
      );
      const after = structuredCloneModel(before);
      expect(growCompositeToFitChildren(after, "root")).toBe(true);
      expectExtentChangeOnly(before, after, "root");
      expect(
        boxIsInside(visualBoxOf(after, "a"), compositeOuterBox(after, "root")!),
      ).toBe(true);
    });

    it("holds for a nested container grown by the unjam pass", () => {
      const before = nestedScenario();
      before.nodes.get("mid-a")!.center = { x: -150, y: 0 };
      const after = structuredCloneModel(before);
      expect(growCompositeToFitChildren(after, "mid")).toBe(true);
      expectExtentChangeOnly(before, after, "mid");
    });

    it("reports no change when the container already fits its children", () => {
      const model = nestedScenario();
      expect(growCompositeToFitChildren(model, "left")).toBe(false);
      expect(growCompositeToFitChildren(model, "left-a")).toBe(false);
    });

    it("holds when load-time unjam enlarges an undersized container", () => {
      // The child is already a valid, unobstructed rest, so unjam relocates nothing. The
      // container is merely below the compound minimum size with its child off-centre, so
      // the grow pass has to enlarge it asymmetrically - which shifts the container's
      // centre, and every relative offset underneath it. The child must not ride along.
      const before = buildLayoutModel(
        [
          { id: "root", isCompound: true },
          { id: "a", parent: "root", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
        ],
        {
          root: { x: 500, y: 300, w: 100, h: 70 },
          a: { x: 30, y: 0 },
        },
      );
      const { model: after, changed } = unjamLayoutModel(before);

      expect(changed).toBe(true);
      expect(after.nodes.get("root")!.size).toEqual({ w: 120, h: 80 });
      expect(absoluteCenter(after, "root")).toEqual({ x: 510, y: 300 });
      expectExtentChangeOnly(before, after, "root");
    });

    it("holds when a resize is clamped to the viewport", () => {
      const before = nestedScenario();
      // Dragging "left"'s se corner out by (30, 300) clears every neighbour but overruns
      // the viewport's south edge, so only the viewport clamp shortens the box - and that
      // clamp must not disturb the children.
      const after = resizeComposite(
        before,
        "left",
        "se",
        30,
        300,
        { childrenBox: null, edgeClearance: 8, looseEdges: ALL_LOOSE_EDGES },
        { viewportBounds: { x1: 700, y1: 200, x2: 1300, y2: 900 } },
      );
      expect(compositeOuterBox(after, "left")).toEqual({
        x1: 800,
        y1: 350,
        x2: 1230,
        y2: 900,
      });
      expectExtentChangeOnly(before, after, "left");
    });
  });

  describe("R5 + R6: clamps keep gestures legal", () => {
    it("keeps a dragged leaf inside its container's interior", () => {
      const model = nestedScenario();
      for (const target of [
        { x: 5000, y: 0 },
        { x: -5000, y: 0 },
        { x: 0, y: 5000 },
        { x: 0, y: -5000 },
        { x: 5000, y: 5000 },
        { x: -5000, y: -5000 },
      ]) {
        const after = moveChild(model, "left-a", target);
        expect({
          target,
          inside: boxIsInside(
            childFitBoxOf(after, "left-a"),
            compositeInteriorBox(after, "left")!,
          ),
        }).toEqual({ target, inside: true });
        expectNoForbiddenOverlap(after, "left-a");
      }
    });

    it("keeps a dragged container inside the viewport", () => {
      const model = nestedScenario();
      const viewportBounds = { x1: 700, y1: 200, x2: 2200, y2: 1000 };
      for (const target of [
        { x: 9000, y: 500 },
        { x: -9000, y: 500 },
        { x: 1000, y: 9000 },
        { x: 1000, y: -9000 },
      ]) {
        const after = moveComposite(model, "left", target, { viewportBounds });
        expect({
          target,
          inside: boxIsInside(compositeOuterBox(after, "left")!, viewportBounds),
        }).toEqual({ target, inside: true });
        expectNoForbiddenOverlap(after, "left");
      }
    });

    it("prefers clearing an obstacle over reaching the viewport edge", () => {
      // "left" cannot both hug the viewport's east edge and stay clear of "right";
      // overlap is the worse outcome, so the drag stops short instead.
      const model = nestedScenario();
      const after = moveComposite(
        model,
        "left",
        { x: 9000, y: 500 },
        { viewportBounds: { x1: 1200, y1: 200, x2: 2000, y2: 1000 } },
      );
      expectNoForbiddenOverlap(after, "left");
      expectRigidSubtree(model, after, "left");
    });
  });
});

/** Randomised sweep: the requirements must hold for arbitrary gestures, not just the fixtures. */
describe("positional requirements hold under randomised gestures", () => {
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

  it("survives 400 random drags and resizes", () => {
    const random = seedRandom(4242);
    const target = () => ({ x: -600 + random() * 1200, y: -600 + random() * 1200 });

    for (let iteration = 0; iteration < 400; iteration++) {
      const before = nestedScenario();
      const viewportBounds = random() < 0.5 ? { x1: 700, y1: 150, x2: 2300, y2: 1050 } : null;

      const leafId = random() < 0.5 ? "left-a" : "mid-a";
      const draggedLeaf = moveChild(before, leafId, target());
      expectOnlySubtreeMoved(before, draggedLeaf, leafId);
      expectNoForbiddenOverlap(draggedLeaf, leafId);

      const containerId = random() < 0.5 ? "left" : "mid";
      const draggedContainer = moveComposite(before, containerId, target(), {
        viewportBounds,
      });
      expectOnlySubtreeMoved(before, draggedContainer, containerId);
      expectRigidSubtree(before, draggedContainer, containerId);
      expectNoForbiddenOverlap(draggedContainer, containerId);

      const corner = (["nw", "ne", "sw", "se"] as const)[Math.floor(random() * 4)]!;
      const resized = resizeComposite(
        before,
        containerId,
        corner,
        -200 + random() * 400,
        -200 + random() * 400,
        { childrenBox: null, edgeClearance: 8, looseEdges: ALL_LOOSE_EDGES },
        viewportBounds ? { viewportBounds } : undefined,
      );
      expectExtentChangeOnly(before, resized, containerId);
    }
  });
});

describe("load-time unjam respects the positional requirements", () => {
  it("leaves already-valid nodes exactly where they were", () => {
    const before = nestedScenario();
    const { model: after, changed } = unjamLayoutModel(before);
    expect(changed).toBe(false);
    expect(poses(after)).toEqual(poses(before));
  });

  it("separates a jammed group without moving nodes in other containers", () => {
    const before = nestedScenario();
    before.nodes.get("left-a")!.center = { x: 0, y: 0 };
    before.nodes.get("left-b")!.center = { x: 0, y: 0 };
    const untouched = ["right", "mid", "mid-a"];
    const beforePoses = poses(before);

    const { model: after, changed } = unjamLayoutModel(before);

    expect(changed).toBe(true);
    expect(nodesOverlapInModel(after, "left-a", "left-b")).toBe(false);
    for (const id of untouched) {
      expect({ id, pose: poses(after).get(id) }).toEqual({ id, pose: beforePoses.get(id) });
    }
  });

  it("keeps every separated node inside its container", () => {
    const before = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "a", parent: "root", footprint: LEAF },
        { id: "b", parent: "root", footprint: LEAF },
        { id: "c", parent: "root", footprint: LEAF },
      ],
      {
        root: { x: 400, y: 400, w: 120, h: 120 },
        a: { x: 0, y: 0 },
        b: { x: 0, y: 0 },
        c: { x: 0, y: 0 },
      },
    );
    const { model: after } = unjamLayoutModel(before, { bootstrap: true });
    const interior = compositeInteriorBox(after, "root")!;
    for (const id of ["a", "b", "c"]) {
      expect({ id, inside: boxIsInside(childFitBoxOf(after, id), interior) }).toEqual({
        id,
        inside: true,
      });
      expectNoForbiddenOverlap(after, id);
    }
  });
});

function structuredCloneModel(model: WorkPackageLayoutModel): WorkPackageLayoutModel {
  return {
    nodes: new Map(
      [...model.nodes].map(([id, node]) => [
        id,
        { ...node, center: { ...node.center }, size: node.size ? { ...node.size } : undefined },
      ]),
    ),
    parentOf: new Map(model.parentOf),
    childrenOf: new Map(model.childrenOf),
    rootIds: [...model.rootIds],
    nodeOverlapPadding: model.nodeOverlapPadding,
  };
}

function visualBoxOf(model: WorkPackageLayoutModel, nodeId: string): VisualBox {
  return visualBox(model, nodeId)!;
}

/** The box a clamp translates for `nodeId`: outer box for a container, footprint for a leaf. */
function movingBoxOf(model: WorkPackageLayoutModel, nodeId: string): VisualBox {
  return model.nodes.get(nodeId)!.isCompound
    ? compositeOuterBox(model, nodeId)!
    : childFitBoxOf(model, nodeId);
}

/** Containment box used by the child-in-parent clamp: footprint without overlap padding. */
function childFitBoxOf(model: WorkPackageLayoutModel, childId: string): VisualBox {
  const center = absoluteCenter(model, childId);
  const footprint = model.nodes.get(childId)!.footprint ?? LEAF;
  return {
    x1: center.x - footprint.halfW,
    y1: center.y - footprint.halfHTop,
    x2: center.x + footprint.halfW,
    y2: center.y + footprint.halfHBottom,
  };
}
