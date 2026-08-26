// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CompoundGraphScene } from "./compound-graph-scene";
import { nodesOverlapInModel } from "./layout-model";
import { captureTapstartHandler, headlessCy, syntheticTapstart } from "../tests/helpers/fixtures";

type SceneInternals = {
  model: CompoundGraphScene["getModel"] extends () => infer R ? R : never;
  childDragActive: boolean;
  childDragSession: { childId: string } | null;
  nodeSpecs: Map<string, { id: string; label: string; color: string; kind: string }>;
  referenceZoom: number;
  syncModelFromCy(cy: cytoscape.Core): ReturnType<CompoundGraphScene["getModel"]>;
  beginChildDrag(cy: cytoscape.Core, childId: string): void;
  finishChildDrag(cy: cytoscape.Core): void;
  syncParentDragFromCy(cy: cytoscape.Core, containerId: string): void;
  syncChildDragByDelta(cy: cytoscape.Core, childId: string, delta: { x: number; y: number }): void;
};

function asInternal(scene: CompoundGraphScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

describe("CompoundGraphScene internals", () => {
  it("measures unpinned containers from child bounding boxes", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container" },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 20, y: 10 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(Number(cy.getElementById("parent").data("compoundWidth"))).toBeGreaterThan(0);
    expect(Number(cy.getElementById("parent").data("compoundHeight"))).toBeGreaterThan(0);
  });

  it("finishChildDrag recovers when the model was cleared mid-gesture", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.model = null;
    expect(() => internal.finishChildDrag(cy)).not.toThrow();
    expect(internal.childDragActive).toBe(false);
  });

  it("syncParentDragFromCy clamps composite drag against sibling obstacles", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          x: 0,
          y: 0,
          compoundWidth: 420,
          compoundHeight: 280,
        },
        {
          id: "neighbor",
          label: "neighbor",
          color: "#64748b",
          kind: "container",
          x: 520,
          y: 0,
          compoundWidth: 320,
          compoundHeight: 220,
        },
      ],
      edges: [],
      clampParentToViewport: false,
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    cy.getElementById("parent").position({ x: 800, y: 0 });

    internal.syncParentDragFromCy(cy, "parent");

    const model = scene.getModel();
    expect(model).not.toBeNull();
    expect(nodesOverlapInModel(model!, "parent", "neighbor")).toBe(false);
    expect(model!.nodes.get("neighbor")?.center).toEqual({ x: 520, y: 0 });
  });

  it("syncParentDragFromCy clamps against neighbors with viewport clamp enabled", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          x: 0,
          y: 0,
          compoundWidth: 420,
          compoundHeight: 280,
        },
        {
          id: "neighbor",
          label: "neighbor",
          color: "#64748b",
          kind: "container",
          x: 520,
          y: 0,
          compoundWidth: 320,
          compoundHeight: 220,
        },
      ],
      edges: [],
      clampParentToViewport: true,
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    vi.spyOn(cy, "width").mockReturnValue(900);
    vi.spyOn(cy, "height").mockReturnValue(700);
    cy.zoom(1);
    cy.pan({ x: 120, y: 80 });
    scene.initializeFromCy(cy);
    cy.getElementById("parent").position({ x: 800, y: 0 });

    internal.syncParentDragFromCy(cy, "parent");

    const model = scene.getModel();
    expect(model).not.toBeNull();
    expect(nodesOverlapInModel(model!, "parent", "neighbor")).toBe(false);
    expect(model!.nodes.get("neighbor")?.center).toEqual({ x: 520, y: 0 });
  });

  it("syncParentDragFromCy clamps against neighbors with children and viewport clamp", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          x: 0,
          y: 0,
          compoundWidth: 420,
          compoundHeight: 280,
        },
        {
          id: "child-a",
          label: "child-a",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
          x: -90,
          y: -30,
        },
        {
          id: "child-b",
          label: "child-b",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
          x: 90,
          y: -30,
        },
        {
          id: "neighbor",
          label: "neighbor",
          color: "#64748b",
          kind: "container",
          x: 520,
          y: 0,
          compoundWidth: 320,
          compoundHeight: 220,
        },
        {
          id: "neighbor-child",
          label: "neighbor-child",
          color: "#94a3b8",
          kind: "leaf",
          parent: "neighbor",
          x: 0,
          y: 0,
        },
      ],
      edges: [],
      clampParentToViewport: true,
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    vi.spyOn(cy, "width").mockReturnValue(900);
    vi.spyOn(cy, "height").mockReturnValue(700);
    cy.zoom(1);
    cy.pan({ x: 120, y: 80 });
    scene.initializeFromCy(cy);
    cy.getElementById("parent").position({ x: 800, y: 0 });

    internal.syncParentDragFromCy(cy, "parent");

    const model = scene.getModel();
    expect(model).not.toBeNull();
    expect(nodesOverlapInModel(model!, "parent", "neighbor")).toBe(false);
    expect(model!.nodes.get("neighbor")?.center).toEqual({ x: 520, y: 0 });
  });

  it("syncParentDragFromCy no-ops when the container element is missing", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const before = scene.getModel()?.nodes.get("parent")?.center;
    cy.getElementById("parent").remove();
    internal.syncParentDragFromCy(cy, "parent");
    expect(scene.getModel()?.nodes.get("parent")?.center).toEqual(before);
  });

  it("attachParentDragHandlers ignores events while child drag is active", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");

    const onChange = vi.fn();
    scene.attachParentDragHandlers(cy, { onChange });
    cy.getElementById("parent").trigger("grab");
    cy.getElementById("parent").position({ x: 40, y: 0 });
    cy.getElementById("parent").trigger("drag");
    expect(onChange).not.toHaveBeenCalled();

    internal.finishChildDrag(cy);
  });

  it("renderedHandleBox returns null when container is not selected", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(scene.renderedHandleBox(cy, "parent")).toBeNull();
  });

  it("childDragVisual returns null when session child is unknown", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.childDragSession = { childId: "missing" };
    expect(scene.childDragVisual(cy)).toBeNull();
    internal.finishChildDrag(cy);
  });

  it("beginChildDrag ignores duplicate starts and missing parent metadata", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
        { id: "orphan", label: "orphan", color: "#111", kind: "leaf", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    internal.beginChildDrag(cy, "child");
    internal.finishChildDrag(cy);

    internal.beginChildDrag(cy, "orphan");
    expect(scene.isChildDragInProgress()).toBe(false);

    cy.getElementById("child").remove();
    internal.beginChildDrag(cy, "child");
    expect(scene.isChildDragInProgress()).toBe(false);
  });

  it("syncChildDragByDelta ignores stale child ids", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    const before = scene.getModel()?.nodes.get("child")?.center;
    internal.syncChildDragByDelta(cy, "other", { x: 50, y: 50 });
    expect(scene.getModel()?.nodes.get("child")?.center).toEqual(before);
    internal.finishChildDrag(cy);
  });

  it("childDragVisual returns null when drag is inactive", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(scene.childDragVisual(cy)).toBeNull();
  });

  it("refreshFootprintsFromCy is a no-op before initialization", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [{ id: "parent", label: "parent", color: "#000", kind: "container" }],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.refreshFootprintsFromCy(cy);
    expect(scene.getModel()).toBeNull();
  });

  it("setEdgeClearance is a no-op before initialization", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [{ id: "parent", label: "parent", color: "#000", kind: "container" }],
      edges: [],
    });
    expect(() => scene.setEdgeClearance(5)).not.toThrow();
  });

  it("attachChildDragHandlers ignores tapstart without a client point", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    const onStart = vi.fn();
    scene.attachChildDragHandlers(cy, { onStart });
    invokeTapstart(syntheticTapstart(cy, "child", new Event("custom")));
    expect(onStart).not.toHaveBeenCalled();
  });

  it("attachChildDragHandlers ignores move events without a client point", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    const onMove = vi.fn();
    scene.attachChildDragHandlers(cy, { onMove });
    invokeTapstart(
      syntheticTapstart(cy, "child", new MouseEvent("mousedown", { clientX: 10, clientY: 20 })),
    );
    window.dispatchEvent(new TouchEvent("touchmove", { touches: [] }));
    expect(onMove).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 20 }));
  });

  it("attachParentDragHandlers ignores free on leaf nodes", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const onChange = vi.fn();
    scene.attachParentDragHandlers(cy, { onChange });
    cy.getElementById("child").trigger("free");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("attachParentDragHandlers free without drag does not call onChange", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const onChange = vi.fn();
    scene.attachParentDragHandlers(cy, { onChange });
    cy.getElementById("parent").trigger("grab");
    cy.getElementById("parent").trigger("free");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("computeResizeChildConstraints handles empty containers", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const constraints = scene.computeResizeChildConstraints(cy, "parent");
    expect(constraints.looseEdges).toEqual({
      west: false,
      east: false,
      north: false,
      south: false,
    });
  });

  it("syncToCy is a no-op before initialization", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [{ id: "parent", label: "parent", color: "#000", kind: "container" }],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    expect(() => scene.syncToCy(cy)).not.toThrow();
  });

  it("attachChildDragHandlers ignores a second tapstart while drag is active", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child-a", label: "child-a", color: "#94a3b8", kind: "leaf", parent: "parent", x: -20, y: 0 },
        { id: "child-b", label: "child-b", color: "#a8b4c4", kind: "leaf", parent: "parent", x: 20, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    const onStart = vi.fn();
    scene.attachChildDragHandlers(cy, { onStart });
    invokeTapstart(
      syntheticTapstart(cy, "child-a", new MouseEvent("mousedown", { clientX: 10, clientY: 20 })),
    );
    invokeTapstart(
      syntheticTapstart(cy, "child-b", new MouseEvent("mousedown", { clientX: 30, clientY: 20 })),
    );
    expect(onStart).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 20 }));
  });

  it("attachChildDragHandlers ignores leaves that are not in the scene spec", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy([
      ...scene.buildElements(),
      { data: { id: "stranger", kind: "leaf", label: "stranger" }, position: { x: 0, y: 0 } },
    ]);
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    const onStart = vi.fn();
    scene.attachChildDragHandlers(cy, { onStart });
    invokeTapstart(
      syntheticTapstart(cy, "stranger", new MouseEvent("mousedown", { clientX: 0, clientY: 0 })),
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it("buildElements infers overflow from id prefix", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        {
          id: "__overflow__:more",
          label: "+2",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
        },
      ],
      edges: [{ id: "e1", source: "parent", target: "__overflow__:more" }],
    });
    const leaf = scene.buildElements().find((element) => element.data?.id === "__overflow__:more");
    expect(leaf?.data?.isOverflow).toBe(true);
  });

  it("initializeFromCy skips nodes that are absent from cy", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "ghost", label: "ghost", color: "#111", kind: "leaf", parent: "parent" },
      ],
      edges: [],
    });
    const elements = scene.buildElements().filter((element) => element.data?.id !== "ghost");
    const cy = headlessCy(elements);
    expect(() => scene.initializeFromCy(cy)).not.toThrow();
  });

  it("attachParentDragHandlers ignores grab on unknown ids", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const onGrab = vi.fn();
    scene.attachParentDragHandlers(cy, { onGrab });
    cy.add({
      group: "nodes",
      data: { id: "stranger", kind: "container", label: "stranger" },
      position: { x: 0, y: 0 },
    });
    cy.getElementById("stranger").trigger("grab");
    expect(onGrab).not.toHaveBeenCalled();
  });

  it("visual helpers return empty results before initialization or for missing nodes", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    expect(scene.parentDragVisuals(cy).size).toBe(0);
    expect(scene.renderedHandleBox(cy, "parent")).toBeNull();
    expect(scene.renderedHandleBox(cy, "missing")).toBeNull();

    scene.initializeFromCy(cy);
    cy.getElementById("parent").select();
    expect(scene.renderedHandleBox(cy, "missing")).toBeNull();
  });

  it("attachParentDragHandlers ignores free while child drag is active", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    const onChange = vi.fn();
    scene.attachParentDragHandlers(cy, { onChange });
    cy.getElementById("parent").trigger("free");
    expect(onChange).not.toHaveBeenCalled();
    internal.finishChildDrag(cy);
  });

  it("attachParentDragHandlers ignores grab and drag while child drag is active", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.beginChildDrag(cy, "child");
    const onGrab = vi.fn();
    const onChange = vi.fn();
    scene.attachParentDragHandlers(cy, { onGrab, onChange });
    cy.getElementById("parent").trigger("grab");
    cy.getElementById("parent").trigger("drag");
    expect(onGrab).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    internal.finishChildDrag(cy);
  });

  it("buildElements forwards classes and custom passthrough fields", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          compoundWidth: 200,
          compoundHeight: 160,
          classes: "compound-a",
          customFlag: true,
        },
        {
          id: "child",
          label: "child",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
          classes: "leaf-b",
          tooltip: "hint",
        },
      ],
      edges: [{ id: "e1", source: "child", target: "parent", label: "link" }],
    });
    const elements = scene.buildElements();
    const parent = elements.find((element) => element.data?.id === "parent");
    const child = elements.find((element) => element.data?.id === "child");
    const edge = elements.find((element) => element.data?.id === "e1");
    expect(parent?.data?.classes).toBe("compound-a");
    expect(parent?.data?.customFlag).toBe(true);
    expect(child?.data?.classes).toBe("leaf-b");
    expect(child?.data?.tooltip).toBe("hint");
    expect(edge?.data?.label).toBe("link");
  });

  it("setNodeOverlapPadding updates padding before the model exists", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    scene.setNodeOverlapPadding(12);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(scene.getModel()?.nodeOverlapPadding).toBe(12);
  });

  it("ensureModelFromCy re-syncs when compound outer boxes are missing", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.model!.nodes.get("parent")!.size = undefined;
    const constraints = scene.computeResizeChildConstraints(cy, "parent");
    expect(constraints.looseEdges).toEqual({ west: false, east: false, north: false, south: false });
    expect(scene.getModel()?.nodes.get("parent")?.size).toBeDefined();
  });

  it("ensureModelFromCy throws when sync leaves the model unset", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    internal.syncModelFromCy = () => {
      internal.model = null;
      return null;
    };
    expect(() => scene.ensureModelFromCy(cy)).toThrow("layout model not initialized");
  });

  it("setClampParentToViewport and setViewportPaddingPx update scene settings", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    scene.setClampParentToViewport(true);
    scene.setViewportPaddingPx(12);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(scene.getModel()).not.toBeNull();
  });

  it("renderedHandleBox returns bounds for a selected container with a model", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    cy.getElementById("parent").select();
    const box = scene.renderedHandleBox(cy, "parent");
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  it("unjamLoadedLayout separates jammed nodes and syncs cytoscape when changed", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 400, compoundHeight: 400 },
        { id: "a", label: "a", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
        { id: "b", label: "b", color: "#a8b4c4", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const { changed } = scene.unjamLoadedLayout(cy, { bootstrap: true });
    expect(changed).toBe(true);
    expect(cy.getElementById("a").position("x")).not.toBeCloseTo(cy.getElementById("b").position("x"), 0);
  });

  it("unjamLoadedLayout reports unchanged for a free layout", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 400, compoundHeight: 400 },
        { id: "a", label: "a", color: "#94a3b8", kind: "leaf", parent: "parent", x: -80, y: 0 },
        { id: "b", label: "b", color: "#a8b4c4", kind: "leaf", parent: "parent", x: 80, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    expect(scene.unjamLoadedLayout(cy)).toEqual({ changed: false });
  });

  it("unjamLoadedLayout throws when the layout model is missing", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    internal.model = null;
    expect(() => scene.unjamLoadedLayout(cy)).toThrow("layout model not initialized");
  });

  it("flatLayoutForSubtree throws when the layout model is missing", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    asInternal(scene).model = null;
    expect(() => scene.flatLayoutForSubtree("parent")).toThrow("layout model not initialized");
  });

  it("renderedHandleBox returns null when the model was cleared", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    cy.getElementById("parent").select();
    internal.model = null;
    expect(scene.renderedHandleBox(cy, "parent")).toBeNull();
  });

  it("parentDragVisuals skips containers without specs or compound boxes", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "other", label: "other", color: "#475569", kind: "container", compoundWidth: 180, compoundHeight: 140, x: 300, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    cy.getElementById("parent").select();
    cy.getElementById("other").select();
    internal.nodeSpecs.delete("parent");
    internal.model!.nodes.get("other")!.size = undefined;
    expect(scene.parentDragVisuals(cy).size).toBe(0);
  });

  it("initializeFromCy uses a unit reference zoom when cy zoom is zero", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    vi.spyOn(cy, "zoom").mockImplementation(
      ((...args: Parameters<typeof cy.zoom>) => (args.length === 0 ? 0 : cy)) as typeof cy.zoom,
    );
    scene.initializeFromCy(cy);
    expect(internal.referenceZoom).toBe(1);
  });

  it("finishChildDrag without a session still resets drag state", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.childDragActive = true;
    internal.childDragSession = null;
    expect(() => internal.finishChildDrag(cy)).not.toThrow();
    expect(internal.childDragActive).toBe(false);
  });

  it("setEdgeClearance tolerates missing container nodes in the model", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "parent", label: "parent", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
      ],
      edges: [],
    });
    const internal = asInternal(scene);
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    internal.model!.nodes.delete("parent");
    expect(() => scene.setEdgeClearance(8)).not.toThrow();
  });
});
