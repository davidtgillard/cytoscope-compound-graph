// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOUND_GRAPH_THEME,
  GraphParentVertex,
  CompoundGraphScene,
  buildLayoutModel,
  flatLayoutFromModel,
  cloneLayoutModel,
  layoutModelFromCy,
  applyLayoutModelToCy,
  OVERFLOW_NODE_PREFIX,
  isOverflowNodeId,
  mergeCompoundGraphStylesheet,
  createCompoundGraphStylesheet,
  leafDomVisualStyle,
} from "@dgillard/cytoscape-compound-graph";
import {
  TEST_PARENT,
  captureTapstartHandler,
  headlessCy,
  syntheticTapstart,
} from "./helpers/fixtures";

describe("public API", () => {
  it("createCompoundGraphStylesheet accepts partial theme overrides", () => {
    const sheet = createCompoundGraphStylesheet({
      leafLabel: { color: "#ff0000" },
    } as Parameters<typeof createCompoundGraphStylesheet>[0]);
    expect(sheet.length).toBeGreaterThan(0);
  });

  it("leafDomVisualStyle reflects theme defaults and overrides", () => {
    const defaults = leafDomVisualStyle();
    expect(defaults.fontSize).toBe(DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize);
    const custom = leafDomVisualStyle({ leafNode: { diameter: 48 } });
    expect(custom.nodeWidth).toBe(48);
  });

  it("initializeFromCy returns a snapshot with child absolutes", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());

    const snap = TEST_PARENT.initializeFromCy(cy);
    expect(snap.children["child-a"].absolute).toBeDefined();
    expect(snap.parent.w).toBeGreaterThan(0);
    expect(snap.parent.h).toBeGreaterThan(0);
  });

  it("visual helpers work after initialization", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    cy.getElementById("parent").select();

    expect(TEST_PARENT.renderedHandleBox(cy)).not.toBeNull();
    expect(TEST_PARENT.parentDragVisual(cy)).not.toBeNull();
    expect(TEST_PARENT.getChild("child-a")?.label).toBe("child-a");
  });

  it("attachParentDragHandlers fires onChange when parent moves", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    let changed = false;
    let grabbed = false;
    TEST_PARENT.attachParentDragHandlers(cy, {
      onGrab: () => { grabbed = true; },
      onChange: () => { changed = true; },
    });

    const parent = cy.getElementById("parent");
    parent.trigger("grab");
    expect(grabbed).toBe(true);
    parent.position({ x: 42, y: -18 });
    parent.trigger("drag");
    parent.trigger("free");

    expect(changed).toBe(true);
    expect(TEST_PARENT.getModel()?.nodes.get("parent")?.center.x).toBeCloseTo(42, 2);
  });

  it("attachParentDragHandlers ignores grab on the wrong node id", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    let grabbed = false;
    TEST_PARENT.attachParentDragHandlers(cy, { onGrab: () => { grabbed = true; } });
    cy.getElementById("child-a").trigger("grab");
    expect(grabbed).toBe(false);
  });

  it("refreshFootprintsFromCy is a no-op before initialization", () => {
    const fresh = GraphParentVertex.create({
      id: "fresh-parent",
      label: "fresh",
      color: "#000",
      children: [{ id: "fresh-child", label: "fresh-child", color: "#111" }],
    });
    const cy = headlessCy(fresh.buildElements());
    fresh.refreshFootprintsFromCy(cy);
    expect(fresh.getModel()).toBeNull();
  });

  it("refreshFootprintsFromCy syncs footprints after initialization", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    TEST_PARENT.refreshFootprintsFromCy(cy);
    expect(TEST_PARENT.getModel()?.nodes.get("child-a")?.footprint).toBeDefined();
  });

  it("parentDragVisual returns null when the parent is absent from cy", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    cy.getElementById("parent").remove();
    expect(TEST_PARENT.parentDragVisual(cy)).toBeNull();
  });

  it("liveSnapshot reads the layout model during child drag", () => {
    const parent = GraphParentVertex.create({
      id: "live-snap-parent",
      label: "parent",
      color: "#64748b",
      children: [
        { id: "live-snap-a", label: "child-a", color: "#94a3b8", x: -40, y: 0 },
        { id: "live-snap-b", label: "child-b", color: "#a8b4c4", x: 40, y: 0 },
      ],
    });
    const elements = parent.buildElements();
    if (elements[0]?.data) {
      elements[0].data = {
        ...elements[0].data,
        compoundWidth: 420,
        compoundHeight: 280,
      };
    }
    const cy = headlessCy(elements);
    parent.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    parent.attachChildDragHandlers(cy, {});

    invokeTapstart(
      syntheticTapstart(cy, "live-snap-a", new MouseEvent("mousedown", { clientX: 100, clientY: 200 })),
    );
    expect(parent.isChildDragInProgress()).toBe(true);
    const visual = parent.childDragVisual(cy);
    expect(visual).not.toBeNull();
    expect(visual!.label).toBe("child-a");

    const live = parent.liveSnapshot(cy);
    expect(live.parent.w).toBe(420);
    expect(live.parent.h).toBe(280);
    expect(live.children["live-snap-a"]).toEqual({
      absolute: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      relative: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    });

    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 100, clientY: 200 }));
    expect(parent.childDragVisual(cy)).toBeNull();
    expect(parent.isChildDragInProgress()).toBe(false);
  });

  it("setNodeOverlapPadding updates the live layout model", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);

    TEST_PARENT.setNodeOverlapPadding(2);
    expect(TEST_PARENT.getModel()?.nodeOverlapPadding).toBe(2);

    TEST_PARENT.ensureModelFromCy(cy);
    expect(TEST_PARENT.getModel()?.nodeOverlapPadding).toBe(2);
  });

  it("SE resize through GraphParentVertex preserves child absolutes", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());

    TEST_PARENT.initializeFromCy(cy);
    TEST_PARENT.setEdgeClearance(0);

    const beforeA = cy.getElementById("child-a").position();
    const beforeB = cy.getElementById("child-b").position();

    const constraints = TEST_PARENT.computeResizeChildConstraints(cy);
    const startModel = TEST_PARENT.cloneModel();
    TEST_PARENT.resizeFromCorner("se", 40, 30, startModel, constraints);
    TEST_PARENT.syncToCy(cy);

    const afterA = cy.getElementById("child-a").position();
    const afterB = cy.getElementById("child-b").position();

    expect(afterA.x).toBeCloseTo(beforeA.x, 2);
    expect(afterA.y).toBeCloseTo(beforeA.y, 2);
    expect(afterB.x).toBeCloseTo(beforeB.x, 2);
    expect(afterB.y).toBeCloseTo(beforeB.y, 2);
  });

  it("attachParentDragHandlers ignores gestures during child drag", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    let changed = false;
    TEST_PARENT.attachParentDragHandlers(cy, { onChange: () => { changed = true; } });
    const invokeTapstart = captureTapstartHandler(cy);
    TEST_PARENT.attachChildDragHandlers(cy, {});

    invokeTapstart(
      syntheticTapstart(cy, "child-a", new MouseEvent("mousedown", { clientX: 100, clientY: 200 })),
    );

    const node = cy.getElementById("parent");
    node.trigger("grab");
    node.position({ x: 80, y: 20 });
    node.trigger("drag");
    node.trigger("free");

    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 100, clientY: 200 }));
    expect(changed).toBe(false);
  });

  it("getChild returns undefined for unknown ids", () => {
    expect(TEST_PARENT.getChild("missing")).toBeUndefined();
  });

  it("computeResizeChildConstraints handles empty compounds", () => {
    const empty = GraphParentVertex.create({
      id: "empty",
      label: "empty",
      color: "#000",
      children: [],
    });
    const cy = headlessCy(empty.buildElements());
    empty.initializeFromCy(cy);
    const constraints = empty.computeResizeChildConstraints(cy);
    expect(constraints.childrenBox).toBeNull();
    expect(constraints.looseEdges).toEqual({
      west: false,
      east: false,
      north: false,
      south: false,
    });
  });

  it("renderedHandleBox is null when the parent is not selected", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    expect(TEST_PARENT.renderedHandleBox(cy)).toBeNull();
  });

  it("cloneModel throws before initialization", () => {
    const fresh = GraphParentVertex.create({
      id: "fresh",
      label: "fresh",
      color: "#000",
      children: [{ id: "c", label: "c", color: "#111" }],
    });
    expect(() => fresh.cloneModel()).toThrow();
  });

  it("syncToCy is a no-op before the model exists", () => {
    const fresh = GraphParentVertex.create({
      id: "solo",
      label: "solo",
      color: "#000",
      children: [{ id: "c", label: "c", color: "#111" }],
    });
    const cy = headlessCy(fresh.buildElements());
    fresh.syncToCy(cy);
    expect(fresh.getModel()).toBeNull();
  });

  it("resize preserves child absolute positions in snapshot", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());

    TEST_PARENT.initializeFromCy(cy);
    const baseline = TEST_PARENT.snapshot(cy);

    const constraints = TEST_PARENT.computeResizeChildConstraints(cy);
    TEST_PARENT.resizeFromCorner("se", 50, 40, TEST_PARENT.cloneModel(), constraints);
    TEST_PARENT.syncToCy(cy);

    const live = TEST_PARENT.snapshot(cy);
    for (const childId of ["child-a", "child-b"] as const) {
      const before = baseline.children[childId].absolute;
      const after = live.children[childId].absolute;
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.5);
    }
  });

  it("attachParentDragHandlers ignores drag while child drag is active", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    TEST_PARENT.attachChildDragHandlers(cy, {});
    invokeTapstart(
      syntheticTapstart(cy, "child-a", new MouseEvent("mousedown", { clientX: 100, clientY: 200 })),
    );

    let changed = false;
    TEST_PARENT.attachParentDragHandlers(cy, { onChange: () => { changed = true; } });
    cy.getElementById("parent").trigger("drag");
    expect(changed).toBe(false);

    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 100, clientY: 200 }));
  });

  it("exports layout-model, sync, scene, and stylesheet merge helpers", () => {
    expect(typeof buildLayoutModel).toBe("function");
    expect(typeof flatLayoutFromModel).toBe("function");
    expect(typeof cloneLayoutModel).toBe("function");
    expect(typeof layoutModelFromCy).toBe("function");
    expect(typeof applyLayoutModelToCy).toBe("function");
    expect(OVERFLOW_NODE_PREFIX).toBe("__overflow__:");
    expect(isOverflowNodeId(`${OVERFLOW_NODE_PREFIX}x`)).toBe(true);
    expect(typeof CompoundGraphScene.fromSpec).toBe("function");
    expect(mergeCompoundGraphStylesheet([]).length).toBeGreaterThan(0);
  });
});
