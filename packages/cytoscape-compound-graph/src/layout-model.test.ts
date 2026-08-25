import { describe, expect, it } from "vitest";
import {
  ALL_LOOSE_EDGES,
  NODE_OVERLAP_PADDING,
  absoluteCenter,
  buildLayoutModel,
  canOverlap,
  cloneLayoutModel,
  compositeInteriorBox,
  compositeOuterBox,
  flatLayoutFromModel,
  isAncestor,
  minimumCompositeOuterBox,
  moveChild,
  moveComposite,
  nodesOverlapInModel,
  parentOuterBoundsFromChildFit,
  resizeCompoundBoxFromCorner,
  resizeComposite,
  resizeLooseEdgesFromOuter,
  subtreeNodeIds,
  visualBox,
} from "./layout-model";
import { COMPOUND_MIN_HEIGHT, COMPOUND_MIN_WIDTH, COMPOUND_PADDING } from "./cytoscape-theme";

describe("layout-model utilities", () => {
  const inputs = [
    { id: "root", isCompound: true },
    { id: "child", parent: "root", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
    { id: "grand", parent: "child", footprint: { halfW: 5, halfHTop: 5, halfHBottom: 5 } },
  ];

  const layout = {
    root: { x: 0, y: 0, w: 300, h: 200 },
    child: { x: 20, y: 10 },
    grand: { x: 5, y: 5 },
  };

  it("reports ancestry and subtree membership", () => {
    const model = buildLayoutModel(inputs, layout);
    expect(isAncestor(model, "root", "grand")).toBe(true);
    expect(isAncestor(model, "child", "root")).toBe(false);
    expect(subtreeNodeIds(model, "root").sort()).toEqual(["child", "grand", "root"].sort());
  });

  it("flatLayoutFromModel round-trips compound sizes", () => {
    const model = buildLayoutModel(inputs, layout);
    const flat = flatLayoutFromModel(model);
    expect(flat.root.w).toBe(300);
    expect(flat.child.x).toBeCloseTo(20, 3);
  });

  it("moveComposite translates descendants", () => {
    const model = buildLayoutModel(inputs, layout);
    const before = absoluteCenter(model, "grand");
    const moved = moveComposite(model, "root", { x: 40, y: -10 });
    const after = absoluteCenter(moved, "grand");
    expect(after.x - before.x).toBeCloseTo(40, 3);
    expect(after.y - before.y).toBeCloseTo(-10, 3);
  });

  it("canOverlap is true for the same node id", () => {
    const model = buildLayoutModel(inputs, layout);
    expect(canOverlap(model, "child", "child")).toBe(true);
  });

  it("isAncestor is false for unrelated nodes", () => {
    const model = buildLayoutModel(
      [
        { id: "a", isCompound: true },
        { id: "b", isCompound: true },
      ],
      {
        a: { x: 0, y: 0, w: 100, h: 100 },
        b: { x: 200, y: 0, w: 100, h: 100 },
      },
    );
    expect(isAncestor(model, "a", "b")).toBe(false);
  });

  it("canOverlap is true for ancestor/descendant pairs", () => {
    const model = buildLayoutModel(inputs, layout);
    expect(canOverlap(model, "child", "root")).toBe(true);
    expect(canOverlap(model, "root", "grand")).toBe(true);
    expect(canOverlap(model, "child", "missing")).toBe(false);
  });

  it("visualBox and nodesOverlapInModel detect leaf intersection", () => {
    const overlapping = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "a", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
        { id: "b", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
      ],
      {
        root: { x: 0, y: 0, w: 400, h: 400 },
        a: { x: 0, y: 0 },
        b: { x: 5, y: 0 },
      },
    );
    expect(visualBox(overlapping, "a")).not.toBeNull();
    expect(nodesOverlapInModel(overlapping, "a", "b")).toBe(true);
  });

  it("nodeOverlapPadding controls how close siblings may get before colliding", () => {
    const inputs = [
      { id: "root", isCompound: true },
      { id: "a", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
      { id: "b", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
    ];
    const layout = {
      root: { x: 0, y: 0, w: 400, h: 400 },
      a: { x: 0, y: 0 },
      b: { x: 50, y: 0 },
    };
    const tight = buildLayoutModel(inputs, layout, { nodeOverlapPadding: 0 });
    const padded = buildLayoutModel(inputs, layout, { nodeOverlapPadding: 8 });
    expect(nodesOverlapInModel(tight, "a", "b")).toBe(false);
    expect(nodesOverlapInModel(padded, "a", "b")).toBe(true);
  });

  it("resizeComposite no-ops for missing compound metadata", () => {
    const model = buildLayoutModel([{ id: "leaf" }], { leaf: { x: 0, y: 0 } });
    const next = resizeComposite(model, "leaf", "se", 10, 10);
    expect(next).toEqual(model);
  });

  it("resizeComposite applies default constraints when omitted", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        child: { x: 0, y: 0 },
      },
    );
    const resized = resizeComposite(model, "parent", "se", 30, 20);
    const outer = visualBox(resized, "parent");
    expect(outer!.x2 - outer!.x1).toBeGreaterThan(200);
  });

  it("resizeComposite supports every corner handle", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        child: { x: 0, y: 0 },
      },
    );
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      const resized = resizeComposite(model, "parent", corner, 15, 15);
      expect(visualBox(resized, "parent")).not.toBeNull();
    }
  });

  it("moveChild clamps inside parent interior", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        child: { x: 0, y: 0 },
      },
    );
    const moved = moveChild(model, "child", { x: 500, y: 500 });
    const absolute = absoluteCenter(moved, "child");
    expect(absolute.x).toBeLessThan(500);
    expect(absolute.y).toBeLessThan(500);
  });

  it("nodesOverlapInModel returns false for unknown nodes", () => {
    const model = buildLayoutModel([{ id: "solo" }], { solo: { x: 0, y: 0 } });
    expect(nodesOverlapInModel(model, "solo", "missing")).toBe(false);
  });
});

describe("layout-model box helpers", () => {
  it("cloneLayoutModel deep-copies nodes, maps, and nested fields", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent", footprint: { halfW: 10, halfHTop: 8, halfHBottom: 12 } },
      ],
      {
        parent: { x: 5, y: 10, w: 200, h: 150 },
        child: { x: 20, y: 15 },
      },
    );
    const clone = cloneLayoutModel(model);
    expect(clone).not.toBe(model);
    expect(clone.nodes).not.toBe(model.nodes);
    expect(clone.nodes.get("parent")?.size).toEqual(model.nodes.get("parent")?.size);
    expect(clone.nodes.get("parent")?.size).not.toBe(model.nodes.get("parent")?.size);
    expect(clone.nodes.get("child")?.footprint).toEqual(model.nodes.get("child")?.footprint);
    clone.nodes.get("parent")!.size!.w = 999;
    expect(model.nodes.get("parent")?.size?.w).toBe(200);
  });

  it("compositeInteriorBox shrinks outer by reserved edge clearance", () => {
    const model = buildLayoutModel(
      [{ id: "parent", isCompound: true }],
      { parent: { x: 0, y: 0, w: 200, h: 100 } },
    );
    model.nodes.get("parent")!.reservedEdge = 12;
    const interior = compositeInteriorBox(model, "parent");
    const outer = visualBox(model, "parent")!;
    expect(interior!.x1).toBeCloseTo(outer.x1 + 12, 3);
    expect(interior!.y2).toBeCloseTo(outer.y2 - 12, 3);
    expect(compositeInteriorBox(buildLayoutModel([], {}), "missing")).toBeNull();
  });

  it("minimumCompositeOuterBox floors empty compounds at minimum size", () => {
    const model = buildLayoutModel(
      [{ id: "parent", isCompound: true }],
      { parent: { x: 0, y: 0, w: 40, h: 30 } },
    );
    const minBox = minimumCompositeOuterBox(model, "parent")!;
    expect(minBox.x2 - minBox.x1).toBeCloseTo(COMPOUND_MIN_WIDTH, 3);
    expect(minBox.y2 - minBox.y1).toBeCloseTo(COMPOUND_MIN_HEIGHT, 3);
  });

  it("minimumCompositeOuterBox expands tight child fits to minimum size", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent", footprint: { halfW: 5, halfHTop: 5, halfHBottom: 5 } },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        child: { x: 0, y: 0 },
      },
    );
    const minBox = minimumCompositeOuterBox(model, "parent")!;
    expect(minBox.x2 - minBox.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(minBox.y2 - minBox.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("parentOuterBoundsFromChildFit pads children on every side", () => {
    const childrenBox = { x1: 10, y1: 20, x2: 30, y2: 40 };
    expect(parentOuterBoundsFromChildFit(childrenBox, 8)).toEqual({
      x1: 2,
      y1: 12,
      x2: 38,
      y2: 48,
    });
  });

  it("resizeLooseEdgesFromOuter reports each loose edge independently", () => {
    const childrenBox = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const bounds = parentOuterBoundsFromChildFit(childrenBox, 10);
    const loose = resizeLooseEdgesFromOuter(
      { x1: bounds.x1 - 5, y1: bounds.y1, x2: bounds.x2, y2: bounds.y2 + 5 },
      childrenBox,
      10,
    );
    expect(loose).toEqual({ west: true, east: false, north: false, south: true });
  });

  it("resizeCompoundBoxFromCorner returns a copy for zero delta", () => {
    const start = { x1: 0, y1: 0, x2: 100, y2: 80 };
    const result = resizeCompoundBoxFromCorner(start, "se", 0, 0, {
      childrenBox: null,
      edgeClearance: 10,
      looseEdges: { west: true, east: true, north: true, south: true },
    });
    expect(result).toEqual(start);
    expect(result).not.toBe(start);
  });

  it("resizeCompoundBoxFromCorner enforces minimum size without children", () => {
    const start = { x1: 0, y1: 0, x2: 20, y2: 20 };
    const result = resizeCompoundBoxFromCorner(start, "se", -15, -15, {
      childrenBox: null,
      edgeClearance: 10,
      looseEdges: { west: true, east: true, north: true, south: true },
    });
    expect(result.x2 - result.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("resizeCompoundBoxFromCorner enforces minimum width and height independently without children", () => {
    const narrow = resizeCompoundBoxFromCorner(
      { x1: 0, y1: 0, x2: 10, y2: COMPOUND_MIN_HEIGHT },
      "se",
      -5,
      0,
      { childrenBox: null, edgeClearance: 10, looseEdges: ALL_LOOSE_EDGES },
    );
    expect(narrow.x2 - narrow.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);

    const short = resizeCompoundBoxFromCorner(
      { x1: 0, y1: 0, x2: COMPOUND_MIN_WIDTH, y2: 10 },
      "se",
      0,
      -5,
      { childrenBox: null, edgeClearance: 10, looseEdges: ALL_LOOSE_EDGES },
    );
    expect(short.y2 - short.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("resizeCompoundBoxFromCorner supports north-west handles without children", () => {
    const start = { x1: 0, y1: 0, x2: COMPOUND_MIN_WIDTH, y2: COMPOUND_MIN_HEIGHT };
    const result = resizeCompoundBoxFromCorner(start, "nw", 50, 50, {
      childrenBox: null,
      edgeClearance: 10,
      looseEdges: { west: true, east: true, north: true, south: true },
    });
    expect(result.x2 - result.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("resizeCompoundBoxFromCorner enforces minimum width after south-only shrink without children", () => {
    const result = resizeCompoundBoxFromCorner(
      { x1: 0, y1: 0, x2: 5, y2: 100 },
      "se",
      0,
      -90,
      { childrenBox: null, edgeClearance: 10, looseEdges: ALL_LOOSE_EDGES },
    );
    expect(result.x2 - result.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("resizeCompoundBoxFromCorner enforces minimum height after west-only shrink without children", () => {
    const result = resizeCompoundBoxFromCorner(
      { x1: 0, y1: 0, x2: 100, y2: 5 },
      "sw",
      -90,
      0,
      { childrenBox: null, edgeClearance: 10, looseEdges: ALL_LOOSE_EDGES },
    );
    expect(result.x2 - result.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });
});

describe("layout-model move and resize branches", () => {
  it("moveComposite stops short of sibling compound collisions", () => {
    const model = buildLayoutModel(
      [
        { id: "left", isCompound: true },
        { id: "right", isCompound: true },
      ],
      {
        left: { x: 0, y: 0, w: 100, h: 100 },
        right: { x: 200, y: 0, w: 100, h: 100 },
      },
    );
    const moved = moveComposite(model, "right", { x: 0, y: 0 });
    const rightCenter = absoluteCenter(moved, "right");
    expect(rightCenter.x).toBeGreaterThan(50);
    expect(nodesOverlapInModel(moved, "left", "right")).toBe(false);
  });

  it("moveComposite no-ops for non-compound ids", () => {
    const model = buildLayoutModel([{ id: "leaf" }], { leaf: { x: 0, y: 0 } });
    expect(moveComposite(model, "leaf", { x: 10, y: 10 })).toEqual(model);
  });

  it("moveComposite clamps the outer box inside viewport bounds", () => {
    const model = buildLayoutModel(
      [{ id: "parent", isCompound: true }],
      { parent: { x: 0, y: 0, w: 100, h: 80 } },
    );
    const viewportBounds = { x1: 0, y1: 0, x2: 200, y2: 200 };
    const moved = moveComposite(model, "parent", { x: 500, y: 500 }, { viewportBounds });
    const outer = compositeOuterBox(moved, "parent")!;
    expect(outer.x1).toBeGreaterThanOrEqual(viewportBounds.x1);
    expect(outer.y1).toBeGreaterThanOrEqual(viewportBounds.y1);
    expect(outer.x2).toBeLessThanOrEqual(viewportBounds.x2);
    expect(outer.y2).toBeLessThanOrEqual(viewportBounds.y2);
  });

  it("resizeComposite clamps the outer box inside viewport bounds", () => {
    const model = buildLayoutModel(
      [{ id: "parent", isCompound: true }],
      { parent: { x: 0, y: 0, w: 100, h: 80 } },
    );
    const viewportBounds = { x1: 0, y1: 0, x2: 150, y2: 150 };
    const resized = resizeComposite(model, "parent", "se", 500, 500, undefined, { viewportBounds });
    const outer = compositeOuterBox(resized, "parent")!;
    expect(outer.x1).toBeGreaterThanOrEqual(viewportBounds.x1);
    expect(outer.y1).toBeGreaterThanOrEqual(viewportBounds.y1);
    expect(outer.x2).toBeLessThanOrEqual(viewportBounds.x2);
    expect(outer.y2).toBeLessThanOrEqual(viewportBounds.y2);
  });

  it("moveChild no-ops when parent metadata is missing", () => {
    const model = buildLayoutModel([{ id: "orphan" }], { orphan: { x: 0, y: 0 } });
    expect(moveChild(model, "orphan", { x: 50, y: 50 })).toEqual(model);
  });

  it("flatLayoutFromModel skips overflow nodes", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "overflow", parent: "parent", isOverflow: true },
      ],
      {
        parent: { x: 0, y: 0, w: 100, h: 100 },
        overflow: { x: 5, y: 5 },
      },
    );
    expect(flatLayoutFromModel(model)).toEqual({
      parent: { x: 0, y: 0, w: 100, h: 100 },
    });
  });

  it("absoluteCenter returns zero for unknown nodes and broken parent chains", () => {
    const model = buildLayoutModel([{ id: "solo" }], { solo: { x: 3, y: 4 } });
    expect(absoluteCenter(model, "missing")).toEqual({ x: 0, y: 0 });
    model.parentOf.set("solo", "ghost-parent");
    expect(absoluteCenter(model, "solo")).toEqual({ x: 3, y: 4 });
  });

  it("minimumCompositeOuterBox returns null when compound outer cannot be derived", () => {
    const model = buildLayoutModel([{ id: "leaf" }], { leaf: { x: 0, y: 0 } });
    expect(minimumCompositeOuterBox(model, "leaf")).toBeNull();
  });

  it("buildLayoutModel infers compound nodes from saved width and height", () => {
    const model = buildLayoutModel([{ id: "box" }], { box: { x: 0, y: 0, w: 50, h: 40 } });
    expect(model.nodes.get("box")?.isCompound).toBe(true);
  });

  it("minimumCompositeOuterBox handles child lists whose fit boxes are all missing", () => {
    const model = buildLayoutModel(
      [{ id: "parent", isCompound: true }],
      { parent: { x: 0, y: 0, w: 100, h: 100 } },
    );
    model.childrenOf.set("parent", ["ghost"]);
    expect(minimumCompositeOuterBox(model, "parent")?.x2).toBeGreaterThan(model.nodes.get("parent")!.center.x);
  });

  it("minimumCompositeOuterBox includes nested compound children", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "nested", parent: "parent", isCompound: true },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        nested: { x: 10, y: 10, w: 60, h: 40 },
      },
    );
    const minBox = minimumCompositeOuterBox(model, "parent");
    expect(minBox).not.toBeNull();
    expect(minBox!.x2 - minBox!.x1).toBeGreaterThan(60);
  });

  it("resizeCompoundBoxFromCorner expands width independently when height already satisfies minimum", () => {
    const start = { x1: 0, y1: 0, x2: 30, y2: COMPOUND_MIN_HEIGHT };
    const result = resizeCompoundBoxFromCorner(start, "se", -25, 0, {
      childrenBox: null,
      edgeClearance: 10,
      looseEdges: { west: true, east: true, north: true, south: true },
    });
    expect(result.x2 - result.x1).toBeGreaterThanOrEqual(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBe(COMPOUND_MIN_HEIGHT);
  });

  it("resizeCompoundBoxFromCorner expands height independently when width already satisfies minimum", () => {
    const start = { x1: 0, y1: 0, x2: COMPOUND_MIN_WIDTH, y2: 30 };
    const result = resizeCompoundBoxFromCorner(start, "se", 0, -25, {
      childrenBox: null,
      edgeClearance: 10,
      looseEdges: { west: true, east: true, north: true, south: true },
    });
    expect(result.x2 - result.x1).toBe(COMPOUND_MIN_WIDTH);
    expect(result.y2 - result.y1).toBeGreaterThanOrEqual(COMPOUND_MIN_HEIGHT);
  });

  it("resizeComposite avoids overlapping sibling compounds while growing", () => {
    const model = buildLayoutModel(
      [
        { id: "left", isCompound: true },
        { id: "right", isCompound: true },
        { id: "child", parent: "right", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        left: { x: 0, y: 0, w: 120, h: 120 },
        right: { x: 180, y: 0, w: 120, h: 120 },
        child: { x: 0, y: 0 },
      },
    );
    const before = absoluteCenter(model, "child");
    const resized = resizeComposite(model, "right", "sw", -200, 0);
    const after = absoluteCenter(resized, "child");
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(nodesOverlapInModel(resized, "left", "right")).toBe(false);
  });

  it("SE shrink uses reservedEdge clearance matching child drag bounds", () => {
    const footprint = { halfW: 18, halfHTop: 18, halfHBottom: 26 };
    const reservedEdge = -2;
    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child", parent: "parent", footprint },
    ];
    let model = buildLayoutModel(inputs, {
      parent: { x: 0, y: 0, w: 200, h: 200 },
      child: { x: 50, y: 30 },
    });
    model.nodes.get("parent")!.reservedEdge = reservedEdge;

    const childFitRight = 50 + footprint.halfW;
    const expectedMinRight = childFitRight + reservedEdge;
    const legacyMinRight = childFitRight + NODE_OVERLAP_PADDING + COMPOUND_PADDING.right;

    model = resizeComposite(model, "parent", "se", -1000, 0, {
      childrenBox: {
        x1: 50 - footprint.halfW,
        y1: 30 - footprint.halfHTop,
        x2: 50 + footprint.halfW,
        y2: 30 + footprint.halfHBottom,
      },
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    });
    const outer = compositeOuterBox(model, "parent")!;

    expect(outer.x2).toBeCloseTo(expectedMinRight, 3);
    expect(outer.x2).toBeLessThan(legacyMinRight);
  });

  it("SE drag keeps the opposite NW corner fixed", () => {
    const footprint = { halfW: 18, halfHTop: 18, halfHBottom: 26 };
    const reservedEdge = -2;
    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child", parent: "parent", footprint },
    ];
    const model = buildLayoutModel(inputs, {
      parent: { x: 0, y: 0, w: 420, h: 280 },
      child: { x: 0, y: 0 },
    });
    model.nodes.get("parent")!.reservedEdge = reservedEdge;
    const startOuter = compositeOuterBox(model, "parent")!;
    const constraints = {
      childrenBox: {
        x1: -footprint.halfW,
        y1: -footprint.halfHTop,
        x2: footprint.halfW,
        y2: footprint.halfHBottom,
      },
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    };
    const after = resizeComposite(model, "parent", "se", -80, -60, constraints);
    const outer = compositeOuterBox(after, "parent")!;
    expect(outer.x1).toBeCloseTo(startOuter.x1, 6);
    expect(outer.y1).toBeCloseTo(startOuter.y1, 6);
  });

  it("starting a new corner drag does not snap on zero movement", () => {
    const footprint = { halfW: 18, halfHTop: 18, halfHBottom: 26 };
    const reservedEdge = -2;
    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child", parent: "parent", footprint },
    ];
    let model = buildLayoutModel(inputs, {
      parent: { x: 0, y: 0, w: 420, h: 280 },
      child: { x: 0, y: 0 },
    });
    model.nodes.get("parent")!.reservedEdge = reservedEdge;

    const childrenBox = {
      x1: -footprint.halfW,
      y1: -footprint.halfHTop,
      x2: footprint.halfW,
      y2: footprint.halfHBottom,
    };
    const seConstraints = {
      childrenBox,
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    };
    model = resizeComposite(model, "parent", "se", -1000, -1000, seConstraints);
    const afterSe = compositeOuterBox(model, "parent")!;

    const nwConstraints = {
      childrenBox,
      edgeClearance: reservedEdge,
      looseEdges: resizeLooseEdgesFromOuter(afterSe, childrenBox, reservedEdge),
    };

    model = resizeComposite(model, "parent", "nw", 0, 0, nwConstraints);
    const outer = compositeOuterBox(model, "parent")!;
    expect(outer.x1).toBeCloseTo(afterSe.x1, 6);
    expect(outer.y1).toBeCloseTo(afterSe.y1, 6);
    expect(outer.x2).toBeCloseTo(afterSe.x2, 6);
    expect(outer.y2).toBeCloseTo(afterSe.y2, 6);
  });

  it("zero drag delta leaves the parent box unchanged even with loose edges", () => {
    const footprint = { halfW: 18, halfHTop: 18, halfHBottom: 26 };
    const reservedEdge = -2;
    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child", parent: "parent", footprint },
    ];
    const model = buildLayoutModel(inputs, {
      parent: { x: 0, y: 0, w: 420, h: 280 },
      child: { x: 0, y: 0 },
    });
    model.nodes.get("parent")!.reservedEdge = reservedEdge;
    const before = compositeOuterBox(model, "parent")!;
    const constraints = {
      childrenBox: {
        x1: -footprint.halfW,
        y1: -footprint.halfHTop,
        x2: footprint.halfW,
        y2: footprint.halfHBottom,
      },
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    };
    const after = resizeComposite(model, "parent", "se", 0, 0, constraints);
    const outer = compositeOuterBox(after, "parent")!;
    expect(outer.x1).toBeCloseTo(before.x1, 6);
    expect(outer.y1).toBeCloseTo(before.y1, 6);
    expect(outer.x2).toBeCloseTo(before.x2, 6);
    expect(outer.y2).toBeCloseTo(before.y2, 6);
  });

  it("multi-child resize clamps each edge by the extremal child", () => {
    const footprint = { halfW: 10, halfHTop: 10, halfHBottom: 10 };
    const reservedEdge = 0;
    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child-a", parent: "parent", footprint },
      { id: "child-b", parent: "parent", footprint },
    ];
    const layout = {
      parent: { x: 0, y: 0, w: 400, h: 400 },
      "child-a": { x: -150, y: -150 },
      "child-b": { x: 150, y: 150 },
    };

    let model = buildLayoutModel(inputs, layout);
    model.nodes.get("parent")!.reservedEdge = reservedEdge;

    const expectedMinLeft = -150 - footprint.halfW - reservedEdge;
    const expectedMinTop = -150 - footprint.halfHTop - reservedEdge;
    const expectedMinRight = 150 + footprint.halfW + reservedEdge;
    const expectedMinBottom = 150 + footprint.halfHBottom + reservedEdge;

    model = resizeComposite(model, "parent", "nw", 1000, 1000);
    let outer = compositeOuterBox(model, "parent")!;
    const startOuter = compositeOuterBox(buildLayoutModel(inputs, layout), "parent")!;
    expect(outer.x1).toBeCloseTo(expectedMinLeft, 3);
    expect(outer.y1).toBeCloseTo(expectedMinTop, 3);
    expect(outer.x2).toBeCloseTo(startOuter.x2, 3);
    expect(outer.y2).toBeCloseTo(startOuter.y2, 3);

    model = buildLayoutModel(inputs, layout);
    model.nodes.get("parent")!.reservedEdge = reservedEdge;
    model = resizeComposite(model, "parent", "se", -1000, -1000);
    outer = compositeOuterBox(model, "parent")!;
    expect(outer.x2).toBeCloseTo(expectedMinRight, 3);
    expect(outer.y2).toBeCloseTo(expectedMinBottom, 3);
    expect(outer.x1).toBeCloseTo(startOuter.x1, 3);
    expect(outer.y1).toBeCloseTo(startOuter.y1, 3);
  });

  it("resizeComposite tolerates descendant nodes removed from the model map", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 160 },
        child: { x: 10, y: 10 },
      },
    );
    model.nodes.delete("child");
    expect(() => resizeComposite(model, "parent", "se", 20, 20)).not.toThrow();
  });

  it("resizeComposite skips descendants whose parent metadata disappears mid-resize", () => {
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 160 },
        child: { x: 10, y: 10 },
      },
    );
    model.parentOf.delete("child");
    expect(() => resizeComposite(model, "parent", "se", 20, 20)).not.toThrow();
  });
});
