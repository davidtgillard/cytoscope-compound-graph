import type { NodeSingular } from "cytoscape";
import cytoscape from "cytoscape";
import { describe, expect, it } from "vitest";
import { createCompoundGraphStylesheet } from "./cytoscape-theme";
import { GraphParentVertex } from "./compound-graph";
import {
  applyFrozenCompoundSize,
  childFitBoxAbsoluteFromCy,
  childrenFitBoxAbsoluteFromCy,
  compoundAbsolutePosition,
  compoundSizeForContent,
  graphNodeModelPosition,
  measureAndPinCompound,
  measureLeafFootprint,
  measurePaintedLeafFootprint,
  snapshotDelta,
  snapshotGraphState,
  syncLeafFootprintsFromCy,
  type GraphSnapshot,
} from "./cytoscape-utils";
import {
  ALL_LOOSE_EDGES,
  buildLayoutModel,
  compositeOuterBox,
  parentOuterBoundsFromChildFit,
  resizeComposite,
} from "./layout-model";
import { applyLayoutModelToCy, layoutModelFromCy } from "./cytoscape-sync";

describe("cytoscape-utils", () => {
  it("compoundSizeForContent falls back to minimum compound size", () => {
    expect(compoundSizeForContent(null).w).toBeGreaterThan(0);
    expect(
      compoundSizeForContent({ x1: 0, y1: 0, x2: 200, y2: 100 }).w,
    ).toBeGreaterThan(200);
  });

  it("syncLeafFootprintsFromCy skips missing and compound nodes", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 200, compoundHeight: 200 }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf", label: "child" }, position: { x: 0, y: 0 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
        { id: "missing", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        child: { x: 0, y: 0 },
        missing: { x: 10, y: 10 },
      },
    );
    syncLeafFootprintsFromCy(cy, model, "parent");
    expect(model.nodes.get("child")?.footprint).toBeDefined();
    expect(model.nodes.get("missing")?.footprint).toBeUndefined();
  });

  it("childFitBoxAbsoluteFromCy returns null for unknown ids", () => {
    const cy = cytoscape({ headless: true, elements: [] });
    const model = buildLayoutModel([], {});
    expect(childFitBoxAbsoluteFromCy(cy, model, "missing")).toBeNull();
  });

  it("applyFrozenCompoundSize skips position shift on first size write", () => {
    const cy = cytoscape({
      headless: true,
      elements: [{ data: { id: "parent", kind: "container" }, position: { x: 5, y: 5 } }],
    });
    const node = cy.getElementById("parent");
    node.position({ x: 5, y: 5 });
    applyFrozenCompoundSize(node, 120, 80);
    expect(node.position()).toEqual({ x: 5, y: 5 });
  });

  it("snapshotDelta ignores children removed in the after snapshot", () => {
    const before: GraphSnapshot = {
      parent: {
        center: { x: 0, y: 0 },
        relative: { x: 0, y: 0 },
        w: 100,
        h: 100,
        box: { x1: -50, y1: -50, x2: 50, y2: 50 },
      },
      children: {
        kept: { absolute: { x: 1, y: 2 }, relative: { x: 1, y: 2 } },
        dropped: { absolute: { x: 3, y: 4 }, relative: { x: 3, y: 4 } },
      },
    };
    const after: GraphSnapshot = {
      ...before,
      children: {
        kept: { absolute: { x: 4, y: 6 }, relative: { x: 4, y: 6 } },
      },
    };
    expect(snapshotDelta(before, after)).toEqual({
      kept: { dx: 3, dy: 4 },
    });
  });

  it("applyFrozenCompoundSize skips position shift when size is unchanged", () => {
    const cy = cytoscape({
      headless: true,
      elements: [{ data: { id: "parent", kind: "container", compoundWidth: 120, compoundHeight: 80 } }],
    });
    const node = cy.getElementById("parent");
    node.position({ x: 10, y: 20 });
    applyFrozenCompoundSize(node, 120, 80);
    expect(node.position()).toEqual({ x: 10, y: 20 });
  });

  it("childFitBoxAbsoluteFromCy uses composite outer box for compound children", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 200, compoundHeight: 150 }, position: { x: 0, y: 0 } },
        { data: { id: "nested", kind: "container", compoundWidth: 80, compoundHeight: 60 }, position: { x: 10, y: 10 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "nested", parent: "parent", isCompound: true },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 150 },
        nested: { x: 10, y: 10, w: 80, h: 60 },
      },
    );
    expect(childFitBoxAbsoluteFromCy(cy, model, "nested")).toEqual(compositeOuterBox(model, "nested"));
  });

  it("childrenFitBoxAbsoluteFromCy returns null when every child is missing", () => {
    const cy = cytoscape({ headless: true, elements: [] });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "ghost-a", parent: "parent" },
        { id: "ghost-b", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 100, h: 100 },
        "ghost-a": { x: 0, y: 0 },
        "ghost-b": { x: 5, y: 5 },
      },
    );
    expect(childrenFitBoxAbsoluteFromCy(cy, model, "parent")).toBeNull();
  });

  it("childrenFitBoxAbsoluteFromCy merges visible child boxes", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 200, compoundHeight: 200 }, position: { x: 0, y: 0 } },
        { data: { id: "left", kind: "leaf", label: "left" }, position: { x: -20, y: 0 } },
        { data: { id: "right", kind: "leaf", label: "right" }, position: { x: 20, y: 0 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "left", parent: "parent" },
        { id: "right", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 200 },
        left: { x: -20, y: 0 },
        right: { x: 20, y: 0 },
      },
    );
    const merged = childrenFitBoxAbsoluteFromCy(cy, model, "parent");
    expect(merged).not.toBeNull();
    expect(merged!.x1).toBeLessThan(merged!.x2);
  });

  it("snapshotGraphState captures parent box and child absolutes", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 120, compoundHeight: 80 } },
        { data: { id: "child", kind: "leaf", label: "child" } },
      ],
    });
    cy.getElementById("parent").position({ x: 5, y: 6 });
    cy.getElementById("child").position({ x: 10, y: 12 });
    const snap = snapshotGraphState(cy, "parent", ["child"]);
    expect(snap.parent.w).toBe(120);
    expect(snap.parent.box.x1).toBeCloseTo(5 - 60, 3);
    expect(snap.children.child.absolute).toEqual(compoundAbsolutePosition(cy.getElementById("child")));
  });

  it("graphNodeModelPosition and measureLeafFootprint read live node geometry", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [{ data: { id: "leaf", kind: "leaf", label: "leaf" } }],
    });
    const node = cy.getElementById("leaf");
    node.position({ x: 3, y: 4 });
    expect(graphNodeModelPosition(node)).toEqual({ x: 3, y: 4 });
    const footprint = measureLeafFootprint(node);
    expect(footprint.halfW).toBeGreaterThan(0);
    expect(footprint.halfHBottom).toBeGreaterThan(0);
  });

  it("measureLeafFootprint includes the label outline and line-box", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        {
          data: {
            id: "leaf",
            kind: "leaf",
            label: "a longish label",
            nodeWidth: 36,
            nodeHeight: 36,
            labelFontSize: 11,
            labelOutlineWidth: 2,
            labelMarginY: 6,
            labelMaxWidth: 120,
          },
        },
      ],
    });
    const node = cy.getElementById("leaf");
    node.position({ x: 0, y: 0 });
    const footprint = measureLeafFootprint(node);
    expect(footprint.halfHTop).toBeGreaterThanOrEqual(18);
    expect(footprint.halfHBottom).toBeGreaterThanOrEqual(18 + 6 + 11 + 2);
    expect(footprint.halfW).toBeGreaterThanOrEqual(18 + 2);
    expect(footprint.halfW).toBeLessThanOrEqual(120 / 2 + 2);
  });

  it("measurePaintedLeafFootprint grows height for wrapped lines and includes the selection ring", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        {
          data: {
            id: "leaf",
            kind: "leaf",
            label: "a wrapping child title that must occupy two lines of text",
            nodeWidth: 36,
            nodeHeight: 36,
            labelFontSize: 11,
            labelOutlineWidth: 2,
            labelMarginY: 6,
            labelMaxWidth: 120,
            selectionOutlineWidth: 3,
          },
        },
      ],
    });
    const node = cy.getElementById("leaf");
    node.position({ x: 0, y: 0 });
    const oneLineFloor = 18 + 6 + 11 + 2;
    const layoutFootprint = measureLeafFootprint(node);
    expect(layoutFootprint.halfHBottom).toBeGreaterThan(oneLineFloor);
    const painted = measurePaintedLeafFootprint(node, { includeSelectionRing: true });
    expect(painted.halfHTop).toBeGreaterThanOrEqual(layoutFootprint.halfHTop + 3 - 1e-6);
    expect(painted.halfHBottom).toBeGreaterThanOrEqual(layoutFootprint.halfHBottom);
  });

  it("measureAndPinCompound and applyFrozenCompoundSize keep anchors stable", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container" }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf" }, position: { x: 10, y: 5 } },
      ],
    });

    const parent = cy.getElementById("parent") as NodeSingular;
    const child = cy.getElementById("child") as NodeSingular;
    child.position({ x: 10, y: 5 });
    measureAndPinCompound(parent, child, 200, 120);
    expect(parent.data("compoundWidth")).toBe(200);
    expect(parent.position()).toEqual({ x: 10, y: 5 });

    parent.data("compoundWidth", 200);
    parent.data("compoundHeight", 120);
    parent.position({ x: 0, y: 0 });
    applyFrozenCompoundSize(parent, 240, 160);
    expect(parent.data("compoundWidth")).toBe(240);
    expect(parent.position().x).toBeCloseTo(20, 3);
    expect(parent.position().y).toBeCloseTo(20, 3);
  });

  it("SE shrink with live cy child fit box stops at fit plus reservedEdge", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        {
          data: { id: "parent", kind: "container", compoundWidth: 240, compoundHeight: 240 },
          position: { x: 0, y: 0 },
        },
        {
          data: {
            id: "child",
            kind: "leaf",
            label: "child",
            color: "#94a3b8",
            nodeWidth: 36,
            nodeHeight: 36,
            labelMarginY: 6,
            labelFontSize: 11,
          },
          position: { x: 40, y: 20 },
        },
      ],
    });

    const inputs = [
      { id: "parent", isCompound: true },
      { id: "child", parent: "parent" },
    ];
    let model = layoutModelFromCy(cy, inputs);
    const reservedEdge = 2;
    model.nodes.get("parent")!.reservedEdge = reservedEdge;
    applyLayoutModelToCy(cy, model);

    const childrenBox = childrenFitBoxAbsoluteFromCy(cy, model, "parent");
    expect(childrenBox).not.toBeNull();

    model = resizeComposite(model, "parent", "se", -1000, 0, {
      childrenBox: childrenBox!,
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    });
    const outer = compositeOuterBox(model, "parent")!;

    expect(outer.x2).toBeCloseTo(childrenBox!.x2 + reservedEdge, 2);
    expect(outer.x2).toBeGreaterThanOrEqual(childrenBox!.x2 - 1e-6);
  });

  it("SE shrink on sized demo parent only moves dragged east and south edges", () => {
    const DEMO_COMPOUND = GraphParentVertex.create({
      id: "wp-invoicing",
      label: "wp-invoicing",
      color: "#64748b",
      children: [
        { id: "wp-pdf-export", label: "wp-pdf-export", color: "#94a3b8", x: -60, y: 0 },
        { id: "wp-email-export", label: "wp-email-export", color: "#a8b4c4", x: 60, y: 0 },
      ],
    });
    const elements = DEMO_COMPOUND.buildElements();
    const parentEl = elements[0];
    if (parentEl.data) {
      parentEl.data = { ...parentEl.data, compoundWidth: 420, compoundHeight: 280 };
    }
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements,
    });

    DEMO_COMPOUND.initializeFromCy(cy);
    const reservedEdge = 2;
    DEMO_COMPOUND.setEdgeClearance(reservedEdge);

    const model = DEMO_COMPOUND.getModel()!;
    const startOuter = compositeOuterBox(model, "wp-invoicing")!;
    const childrenBox = childrenFitBoxAbsoluteFromCy(cy, model, "wp-invoicing");
    expect(childrenBox).not.toBeNull();

    const target = parentOuterBoundsFromChildFit(childrenBox!, reservedEdge);
    const resized = resizeComposite(model, "wp-invoicing", "se", -1000, -1000, {
      childrenBox: childrenBox!,
      edgeClearance: reservedEdge,
      looseEdges: ALL_LOOSE_EDGES,
    });
    const outer = compositeOuterBox(resized, "wp-invoicing")!;

    expect(outer.x1).toBeCloseTo(startOuter.x1, 1);
    expect(outer.y1).toBeCloseTo(startOuter.y1, 1);
    expect(outer.x2).toBeCloseTo(target.x2, 1);
    expect(outer.y2).toBeCloseTo(target.y2, 1);
  });
});
