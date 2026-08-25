// @vitest-environment jsdom
import cytoscape, { type EventObject } from "cytoscape";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphParentVertex, createCompoundGraphStylesheet } from "./index";
import { snapshotDelta } from "./cytoscape-utils";
import { absoluteCenter, compositeOuterBox } from "./layout-model";
import {
  applySubtreePositionsToCy,
  pinContainerToModel,
  viewportBoundsInGraphSpace,
} from "./compound-graph-core";

const TEST_PARENT = GraphParentVertex.create({
  id: "parent",
  label: "parent",
  color: "#64748b",
  children: [
    { id: "child-a", label: "child-a", color: "#94a3b8", x: -40, y: 0 },
    { id: "child-b", label: "child-b", color: "#a8b4c4", x: 40, y: 0 },
  ],
});

const DEMO_COMPOUND = GraphParentVertex.create({
  id: "wp-invoicing",
  label: "wp-invoicing",
  color: "#64748b",
  children: [
    { id: "wp-pdf-export", label: "wp-pdf-export", color: "#94a3b8", x: -60, y: 0 },
    { id: "wp-email-export", label: "wp-email-export", color: "#a8b4c4", x: 60, y: 0 },
  ],
});

const CYTOSCAPE_STYLESHEET = createCompoundGraphStylesheet();

function headlessCy(elements: cytoscape.ElementDefinition[]) {
  return cytoscape({
    headless: true,
    style: CYTOSCAPE_STYLESHEET,
    elements,
  });
}

function sizedDemoElements(): cytoscape.ElementDefinition[] {
  const elements = DEMO_COMPOUND.buildElements();
  const parent = elements[0];
  if (parent.data) {
    parent.data = {
      ...parent.data,
      compoundWidth: 420,
      compoundHeight: 280,
    };
  }
  return elements;
}

type ParentVertexInternals = {
  beginChildDrag(cy: cytoscape.Core, childId: string): void;
  syncChildDragByDelta(cy: cytoscape.Core, childId: string, delta: { x: number; y: number }): void;
  finishChildDrag(cy: cytoscape.Core): void;
  syncParentDragFromCy(cy: cytoscape.Core): void;
  measureFromCy(cy: cytoscape.Core): void;
  childDragActive: boolean;
  childDragSession: { childId: string } | null;
  referenceZoom: number;
};

function asInternal(parent: GraphParentVertex): ParentVertexInternals {
  return parent as unknown as ParentVertexInternals;
}

function withMutableModel(parent: GraphParentVertex) {
  return parent as unknown as ParentVertexInternals & {
    model: NonNullable<ReturnType<GraphParentVertex["getModel"]>> | null;
  };
}

function withPrivateMethods(parent: GraphParentVertex) {
  return parent as unknown as ParentVertexInternals & {
    model: NonNullable<ReturnType<GraphParentVertex["getModel"]>> | null;
    syncModelFromCy(cy: cytoscape.Core): ReturnType<GraphParentVertex["getModel"]>;
  };
}

describe("compound-graph internals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("liveSnapshot falls back to cy snapshot when drag metadata is incomplete", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);
    const internal = withMutableModel(TEST_PARENT);
    internal.childDragActive = true;
    internal.childDragSession = null;
    internal.model = null;
    expect(TEST_PARENT.liveSnapshot(cy)).toEqual(TEST_PARENT.snapshot(cy));
    internal.childDragActive = false;
  });

  it("ensureModelFromCy throws when sync leaves the model unset", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const cy = headlessCy(parent.buildElements());
    const internal = withPrivateMethods(parent);
    internal.syncModelFromCy = () => {
      internal.model = null;
      return null;
    };
    expect(() => parent.ensureModelFromCy(cy)).toThrow("layout model not initialized");
  });

  it("pinContainerToModel and applySubtreePositionsToCy tolerate missing nodes", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    const model = parent.getModel()!;
    expect(() => pinContainerToModel(cy, model, "missing")).not.toThrow();
    expect(() => applySubtreePositionsToCy(cy, model, "missing")).not.toThrow();
  });

  it("snapshotDelta reports zero drift when parent resizes", () => {
    const cy = headlessCy(TEST_PARENT.buildElements());

    TEST_PARENT.initializeFromCy(cy);
    const baseline = TEST_PARENT.snapshot(cy);

    const constraints = TEST_PARENT.computeResizeChildConstraints(cy);
    TEST_PARENT.resizeFromCorner("se", 50, 40, TEST_PARENT.cloneModel(), constraints);
    TEST_PARENT.syncToCy(cy);

    const live = TEST_PARENT.snapshot(cy);
    const deltas = snapshotDelta(baseline, live);

    for (const delta of Object.values(deltas)) {
      expect(Math.hypot(delta.dx, delta.dy)).toBeLessThan(0.5);
    }
  });

  it("finishChildDrag recovers when the model was cleared mid-gesture", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = withMutableModel(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.model = null;
    expect(() => internal.finishChildDrag(cy)).not.toThrow();
    expect(internal.childDragActive).toBe(false);
  });

  it("childDragVisual returns null when the session child is unknown", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.childDragSession = { childId: "missing" };
    expect(parent.childDragVisual(cy)).toBeNull();
    internal.finishChildDrag(cy);
  });

  it("beginChildDrag ignores duplicate and missing-element starts", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.beginChildDrag(cy, "child");
    internal.finishChildDrag(cy);

    cy.getElementById("child").remove();
    internal.beginChildDrag(cy, "child");
    expect(parent.isChildDragInProgress()).toBe(false);

    cy.getElementById("parent").remove();
    internal.beginChildDrag(cy, "child");
    expect(parent.isChildDragInProgress()).toBe(false);
  });

  it("syncChildDragByDelta ignores stale child ids", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    const before = parent.getModel()?.nodes.get("child")?.center;
    internal.syncChildDragByDelta(cy, "other", { x: 50, y: 50 });
    expect(parent.getModel()?.nodes.get("child")?.center).toEqual(before);
    internal.finishChildDrag(cy);
  });

  it("syncParentDragFromCy no-ops when the parent element is missing", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    const before = parent.getModel()?.nodes.get("parent")?.center;
    cy.getElementById("parent").remove();
    internal.syncParentDragFromCy(cy);
    expect(parent.getModel()?.nodes.get("parent")?.center).toEqual(before);
  });

  it("liveSnapshot falls back when drag session data is incomplete", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    parent.getModel()!.nodes.get("parent")!.size = undefined;
    expect(parent.liveSnapshot(cy)).toEqual(parent.snapshot(cy));
    internal.finishChildDrag(cy);
  });

  it("beginChildDrag aborts when the parent element is missing from cy", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    cy.getElementById("parent").remove();
    internal.beginChildDrag(cy, "child");
    expect(parent.isChildDragInProgress()).toBe(false);
  });

  it("attachParentDragHandlers ignores grab and free while child drag is active", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    const onGrab = vi.fn();
    const onChange = vi.fn();
    parent.attachParentDragHandlers(cy, { onGrab, onChange });
    cy.getElementById("parent").trigger("grab");
    cy.getElementById("parent").trigger("drag");
    cy.getElementById("parent").trigger("free");
    expect(onGrab).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    internal.finishChildDrag(cy);
  });

  it("syncParentDragFromCy skips child elements that are missing from cy", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    cy.getElementById("child").remove();
    cy.getElementById("parent").position({ x: 25, y: 15 });
    internal.syncParentDragFromCy(cy);
    expect(parent.getModel()?.nodes.get("parent")?.center.x).toBeCloseTo(25, 2);
  });

  it("measureFromCy skips child elements that are missing from cy", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [
        { id: "present", label: "present", color: "#111", x: 0, y: 0 },
        { id: "absent", label: "absent", color: "#222", x: 20, y: 0 },
      ],
    });
    const internal = asInternal(parent);
    const elements = parent.buildElements().filter((element) => element.data?.id !== "absent");
    const cy = headlessCy(elements);
    expect(() => internal.measureFromCy(cy)).not.toThrow();
    expect(cy.getElementById("parent").data("compoundWidth")).toBeGreaterThan(0);
  });

  it("renderedHandleBox returns null when the parent has no compound size in the model", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    cy.getElementById("parent").select();
    const internal = withMutableModel(parent);
    internal.model = parent.getModel();
    internal.model!.nodes.get("parent")!.size = undefined;
    expect(parent.renderedHandleBox(cy)).toBeNull();
  });

  it("ignores tapstart when a drag is already active", () => {
    const parent = asInternal(TEST_PARENT);
    const cy = headlessCy(TEST_PARENT.buildElements());
    TEST_PARENT.initializeFromCy(cy);

    let tapstartHandler: ((event: EventObject) => void) | undefined;
    const realOn = cy.on.bind(cy);
    vi.spyOn(cy, "on").mockImplementation(((eventName: string, selector: unknown, fn: unknown) => {
      if (eventName === "tapstart" && typeof selector === "string" && typeof fn === "function") {
        tapstartHandler = fn as (event: EventObject) => void;
      }
      return realOn(eventName as never, selector as never, fn as never);
    }) as typeof cy.on);

    const onStart = vi.fn();
    TEST_PARENT.attachChildDragHandlers(cy, { onStart });

    parent.beginChildDrag(cy, "child-a");
    tapstartHandler?.({
      target: cy.getElementById("child-b"),
      originalEvent: new MouseEvent("mousedown", { clientX: 0, clientY: 0 }),
    } as unknown as EventObject);
    expect(onStart).not.toHaveBeenCalled();
    parent.finishChildDrag(cy);
  });

  it("child drag repin keeps parent center stable", () => {
    const cy = headlessCy(sizedDemoElements());
    const compound = asInternal(DEMO_COMPOUND);

    const before = DEMO_COMPOUND.initializeFromCy(cy);
    const startAbsolute = DEMO_COMPOUND.snapshot(cy).children["wp-pdf-export"].absolute;
    const draggedDelta = { x: 60, y: 40 };
    const draggedAbsolute = { x: startAbsolute.x + draggedDelta.x, y: startAbsolute.y + draggedDelta.y };

    compound.beginChildDrag(cy, "wp-pdf-export");
    cy.getElementById("wp-invoicing").position({ x: 25, y: -15 });
    compound.syncChildDragByDelta(cy, "wp-pdf-export", draggedDelta);
    const during = DEMO_COMPOUND.liveSnapshot(cy);

    expect(during.parent.center.x).toBeCloseTo(before.parent.center.x, 3);
    expect(during.parent.center.y).toBeCloseTo(before.parent.center.y, 3);
    expect(during.parent.w).toBeCloseTo(before.parent.w, 3);
    expect(during.parent.h).toBeCloseTo(before.parent.h, 3);
    expect(during.children["wp-pdf-export"].absolute.x).toBeCloseTo(draggedAbsolute.x, 3);
    expect(during.children["wp-pdf-export"].absolute.y).toBeCloseTo(draggedAbsolute.y, 3);

    compound.finishChildDrag(cy);
    const after = DEMO_COMPOUND.snapshot(cy);
    const parentPos = cy.getElementById("wp-invoicing").position();
    const childPos = cy.getElementById("wp-pdf-export").position();

    expect(after.parent.center.x).toBeCloseTo(before.parent.center.x, 3);
    expect(after.parent.center.y).toBeCloseTo(before.parent.center.y, 3);
    expect(after.children["wp-pdf-export"].absolute.x).not.toBeCloseTo(
      before.children["wp-pdf-export"].absolute.x,
      1,
    );
    expect(parentPos.x).toBeCloseTo(before.parent.center.x, 3);
    expect(parentPos.y).toBeCloseTo(before.parent.center.y, 3);
    expect(childPos.x).toBeCloseTo(draggedAbsolute.x, 3);
    expect(childPos.y).toBeCloseTo(draggedAbsolute.y, 3);
  });

  it("parent drag sync copies the dragged center into the model", () => {
    const cy = headlessCy(sizedDemoElements());
    const compound = asInternal(DEMO_COMPOUND);

    DEMO_COMPOUND.initializeFromCy(cy);
    cy.getElementById("wp-invoicing").position({ x: 55, y: -25 });

    compound.syncParentDragFromCy(cy);

    expect(DEMO_COMPOUND.getModel()?.nodes.get("wp-invoicing")?.center.x).toBeCloseTo(55, 3);
    expect(DEMO_COMPOUND.getModel()?.nodes.get("wp-invoicing")?.center.y).toBeCloseTo(-25, 3);
  });

  it("syncParentDragFromCy clamps parent outer box to the visible viewport", () => {
    const cy = headlessCy(sizedDemoElements());
    vi.spyOn(cy, "width").mockReturnValue(600);
    vi.spyOn(cy, "height").mockReturnValue(500);
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
    const compound = asInternal(DEMO_COMPOUND);
    DEMO_COMPOUND.initializeFromCy(cy);
    cy.getElementById("wp-invoicing").position({ x: 0, y: 5000 });
    compound.syncParentDragFromCy(cy);
    const model = DEMO_COMPOUND.getModel();
    expect(model).not.toBeNull();
    const outer = compositeOuterBox(model!, "wp-invoicing")!;
    const bounds = viewportBoundsInGraphSpace(cy, 8);
    expect(bounds).not.toBeNull();
    expect(outer.x1).toBeGreaterThanOrEqual(bounds!.x1);
    expect(outer.y1).toBeGreaterThanOrEqual(bounds!.y1);
    expect(outer.x2).toBeLessThanOrEqual(bounds!.x2);
    expect(outer.y2).toBeLessThanOrEqual(bounds!.y2);

    DEMO_COMPOUND.setViewportPaddingPx(16);
    expect((DEMO_COMPOUND as unknown as { viewportPaddingPx: number }).viewportPaddingPx).toBe(16);

    DEMO_COMPOUND.setClampParentToViewport(false);
    cy.getElementById("wp-invoicing").position({ x: 0, y: 5000 });
    compound.syncParentDragFromCy(cy);
    expect(DEMO_COMPOUND.getModel()?.nodes.get("wp-invoicing")?.center.y).toBeCloseTo(5000, 3);
  });

  it("beginChildDrag keeps current model state instead of importing hidden cy drift", () => {
    const cy = headlessCy(sizedDemoElements());
    const compound = asInternal(DEMO_COMPOUND);

    DEMO_COMPOUND.initializeFromCy(cy);

    cy.getElementById("wp-pdf-export").position({ x: 70, y: 35 });
    const modelBefore = DEMO_COMPOUND.getModel();
    const expectedAbsolute = modelBefore && absoluteCenter(modelBefore, "wp-pdf-export");

    compound.beginChildDrag(cy, "wp-pdf-export");
    const during = DEMO_COMPOUND.liveSnapshot(cy);

    expect(expectedAbsolute).not.toBeNull();
    expect(during.children["wp-pdf-export"].absolute.x).toBeCloseTo(expectedAbsolute!.x, 3);
    expect(during.children["wp-pdf-export"].absolute.y).toBeCloseTo(expectedAbsolute!.y, 3);
    compound.finishChildDrag(cy);
  });

  it("setNodeOverlapPadding updates padding before the model exists", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    parent.setNodeOverlapPadding(14);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    expect(parent.getModel()?.nodeOverlapPadding).toBe(14);
  });

  it("setEdgeClearance no-ops when the model is absent", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    expect(() => parent.setEdgeClearance(8)).not.toThrow();
  });

  it("ensureModelFromCy re-syncs when compound outer boxes are missing", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = withMutableModel(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.model!.nodes.get("parent")!.size = undefined;
    const constraints = parent.computeResizeChildConstraints(cy);
    expect(parent.getModel()?.nodes.get("parent")?.size).toBeDefined();
    expect(constraints.childrenBox).not.toBeNull();
  });

  it("initializeFromCy uses a unit reference zoom when cy zoom is zero", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    vi.spyOn(cy, "zoom").mockImplementation(
      ((...args: Parameters<typeof cy.zoom>) => (args.length === 0 ? 0 : cy)) as typeof cy.zoom,
    );
    parent.initializeFromCy(cy);
    expect(internal.referenceZoom).toBe(1);
  });

  it("finishChildDrag without a session still resets drag state", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const internal = asInternal(parent);
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    internal.childDragActive = true;
    internal.childDragSession = null;
    expect(() => internal.finishChildDrag(cy)).not.toThrow();
    expect(internal.childDragActive).toBe(false);
  });

  it("computeResizeChildConstraints uses padding fallback when cy zoom is zero", () => {
    const parent = GraphParentVertex.create({
      id: "parent",
      label: "parent",
      color: "#000",
      children: [{ id: "child", label: "child", color: "#111" }],
    });
    const cy = headlessCy(parent.buildElements());
    parent.initializeFromCy(cy);
    vi.spyOn(cy, "zoom").mockImplementation(
      ((...args: Parameters<typeof cy.zoom>) => (args.length === 0 ? 0 : cy)) as typeof cy.zoom,
    );
    const constraints = parent.computeResizeChildConstraints(cy);
    expect(constraints.edgeClearance).toBeGreaterThan(0);
  });
});
