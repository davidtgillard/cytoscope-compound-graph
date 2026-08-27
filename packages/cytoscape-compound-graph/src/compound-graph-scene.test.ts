// @vitest-environment jsdom
import cytoscape from "cytoscape";
import { describe, expect, it, vi } from "vitest";
import {
  CompoundGraphScene,
  OVERFLOW_NODE_PREFIX,
  mergeCompoundGraphStylesheet,
} from "@dgillard/cytoscape-compound-graph";
import { absoluteCenter, buildLayoutModel, moveComposite, nodesOverlapInModel } from "./layout-model";
import { captureTapstartHandler, headlessCy, syntheticTapstart } from "../tests/helpers/fixtures";

function twoCompoundScene(): CompoundGraphScene {
  return CompoundGraphScene.fromSpec({
    nodes: [
      {
        id: "compound-a",
        label: "A",
        color: "#64748b",
        kind: "container",
        x: 0,
        y: 0,
        compoundWidth: 200,
        compoundHeight: 160,
      },
      {
        id: "compound-b",
        label: "B",
        color: "#64748b",
        kind: "container",
        x: 280,
        y: 0,
        compoundWidth: 200,
        compoundHeight: 160,
      },
    ],
    edges: [],
  });
}

function nestedCompoundScene(): CompoundGraphScene {
  return CompoundGraphScene.fromSpec({
    nodes: [
      {
        id: "outer",
        label: "outer",
        color: "#64748b",
        kind: "container",
        compoundWidth: 360,
        compoundHeight: 280,
      },
      {
        id: "inner",
        label: "inner",
        color: "#475569",
        kind: "container",
        parent: "outer",
        x: 40,
        y: 40,
        compoundWidth: 160,
        compoundHeight: 120,
      },
      { id: "inner-leaf", label: "leaf", color: "#94a3b8", kind: "leaf", parent: "inner", x: 0, y: 0 },
      { id: "outer-leaf", label: "outer-leaf", color: "#a8b4c4", kind: "leaf", parent: "outer", x: -80, y: 60 },
    ],
    edges: [],
  });
}

function singleCompoundWithLeaves(): CompoundGraphScene {
  return CompoundGraphScene.fromSpec({
    nodes: [
      {
        id: "parent",
        label: "parent",
        color: "#64748b",
        kind: "container",
        compoundWidth: 220,
        compoundHeight: 180,
      },
      { id: "child-a", label: "child-a", color: "#94a3b8", kind: "leaf", parent: "parent", x: -30, y: 0 },
      { id: "child-b", label: "child-b", color: "#a8b4c4", kind: "leaf", parent: "parent", x: 30, y: 0 },
    ],
    edges: [],
  });
}

describe("CompoundGraphScene", () => {
  it("two compounds on one canvas clamp collision when dragging", () => {
    const sharedModel = buildLayoutModel(
      [
        { id: "compound-a", isCompound: true },
        { id: "compound-b", isCompound: true },
      ],
      {
        "compound-a": { x: 0, y: 0, w: 200, h: 160 },
        "compound-b": { x: 280, y: 0, w: 200, h: 160 },
      },
    );
    const clamped = moveComposite(sharedModel, "compound-b", { x: 0, y: 0 });
    expect(nodesOverlapInModel(clamped, "compound-a", "compound-b")).toBe(false);

    const scene = twoCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const startX = absoluteCenter(scene.getModel()!, "compound-b").x;

    scene.attachParentDragHandlers(cy, {});
    const compoundB = cy.getElementById("compound-b");
    compoundB.trigger("grab");
    compoundB.position({ x: 0, y: 0 });
    compoundB.trigger("drag");
    compoundB.trigger("free");

    const endX = absoluteCenter(scene.getModel()!, "compound-b").x;
    expect(endX).toBeLessThan(startX);
    expect(nodesOverlapInModel(scene.getModel()!, "compound-a", "compound-b")).toBe(false);
  });

  it("nested compound outer resize preserves inner child absolutes", () => {
    const scene = nestedCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const model = scene.getModel()!;
    const beforeInnerLeaf = absoluteCenter(model, "inner-leaf");

    const constraints = scene.computeResizeChildConstraints(cy, "outer");
    const startModel = scene.cloneModel();
    scene.resizeFromCorner("outer", "se", 40, 30, startModel, constraints);
    scene.syncToCy(cy);

    const after = absoluteCenter(scene.getModel()!, "inner-leaf");
    expect(after.x).toBeCloseTo(beforeInnerLeaf.x, 1);
    expect(after.y).toBeCloseTo(beforeInnerLeaf.y, 1);
  });

  it("overflow leaf is in elements and model but excluded from flatLayout and drag", () => {
    const overflowId = `${OVERFLOW_NODE_PREFIX}extra`;
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          compoundWidth: 200,
          compoundHeight: 160,
        },
        { id: "child", label: "child", color: "#94a3b8", kind: "leaf", parent: "parent", x: 0, y: 0 },
        {
          id: overflowId,
          label: "+3",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
          isOverflow: true,
          x: 40,
          y: 0,
        },
      ],
      edges: [],
    });

    const elements = scene.buildElements();
    expect(elements.some((element) => element.data?.id === overflowId)).toBe(true);

    const cy = headlessCy(elements);
    scene.initializeFromCy(cy);
    expect(scene.getModel()?.nodes.get(overflowId)?.isOverflow).toBe(true);
    expect(scene.flatLayout()[overflowId]).toBeUndefined();

    const fireTapstart = captureTapstartHandler(cy);
    scene.attachChildDragHandlers(cy, {
      onStart: () => {
        throw new Error("overflow drag should not start");
      },
    });
    fireTapstart(syntheticTapstart(cy, overflowId, new Event("pointerdown")));
    expect(scene.isChildDragInProgress()).toBe(false);
  });

  it("multi-compound resize keeps sibling compound absolutes unchanged", () => {
    const scene = twoCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const beforeB = absoluteCenter(scene.getModel()!, "compound-b");

    const constraints = scene.computeResizeChildConstraints(cy, "compound-a");
    const startModel = scene.cloneModel();
    scene.resizeFromCorner("compound-a", "se", 30, 20, startModel, constraints);
    scene.syncToCy(cy);

    const afterB = absoluteCenter(scene.getModel()!, "compound-b");
    expect(afterB.x).toBeCloseTo(beforeB.x, 1);
    expect(afterB.y).toBeCloseTo(beforeB.y, 1);
  });

  it("flatLayout round-trip includes container sizes and relative child positions", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "box",
          label: "box",
          color: "#64748b",
          kind: "container",
          compoundWidth: 220,
          compoundHeight: 180,
        },
        { id: "leaf", label: "leaf", color: "#94a3b8", kind: "leaf", parent: "box", x: -30, y: 10 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);

    const flat = scene.flatLayout();
    expect(flat.box).toMatchObject({ w: 220, h: 180 });
    expect(flat.leaf).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(flat.leaf.w).toBeUndefined();
    expect(flat.leaf.h).toBeUndefined();
  });

  it("attachChildDragHandlers cleanup removes listeners", () => {
    const scene = twoCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);

    const onSpy = vi.spyOn(cy, "on");
    const removeSpy = vi.spyOn(cy, "removeListener");

    const cleanup = scene.attachChildDragHandlers(cy, {});
    expect(onSpy).toHaveBeenCalledWith("tapstart", "node[kind = 'leaf']", expect.any(Function));

    cleanup();
    expect(removeSpy).toHaveBeenCalledWith("tapstart", "node[kind = 'leaf']", expect.any(Function));
  });

  it("attachParentDragHandlers cleanup removes listeners", () => {
    const scene = twoCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);

    const removeSpy = vi.spyOn(cy, "removeListener");
    const cleanup = scene.attachParentDragHandlers(cy, {});
    cleanup();

    expect(removeSpy).toHaveBeenCalledWith("grab", "node[kind = 'container']", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("drag", "node[kind = 'container']", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("free", "node[kind = 'container']", expect.any(Function));
  });

  it("parentDragVisuals returns selected containers only", () => {
    const scene = twoCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);

    cy.getElementById("compound-a").select();
    const visuals = scene.parentDragVisuals(cy);
    expect(visuals.size).toBe(1);
    expect(visuals.has("compound-a")).toBe(true);
    expect(visuals.get("compound-a")?.label).toBe("A");
  });

  it("mergeCompoundGraphStylesheet appends compound rules", () => {
    const base = [{ selector: "node", style: { color: "#fff" } }] as cytoscape.StylesheetStyle[];
    const result = mergeCompoundGraphStylesheet(base);
    expect(result.length).toBeGreaterThan(base.length);
    expect(result[0]).toEqual(base[0]);
  });

  it("fromSpec rejects duplicate node ids", () => {
    expect(() =>
      CompoundGraphScene.fromSpec({
        nodes: [
          { id: "dup", label: "a", color: "#000", kind: "leaf" },
          { id: "dup", label: "b", color: "#111", kind: "leaf" },
        ],
        edges: [],
      }),
    ).toThrow(/duplicate scene node id/);
  });

  it("child drag handlers fire lifecycle callbacks", () => {
    const scene = singleCompoundWithLeaves();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);

    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();
    scene.attachChildDragHandlers(cy, { onStart, onMove, onEnd });

    invokeTapstart(
      syntheticTapstart(cy, "child-a", new MouseEvent("mousedown", { clientX: 100, clientY: 200 })),
    );
    expect(onStart).toHaveBeenCalledWith("child-a");
    expect(scene.isChildDragInProgress()).toBe(true);
    expect(scene.childDragVisual(cy)?.label).toBe("child-a");

    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, clientY: 230 }));
    expect(onMove).toHaveBeenCalled();

    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 130, clientY: 230 }));
    expect(onEnd).toHaveBeenCalled();
    expect(scene.isChildDragInProgress()).toBe(false);
  });

  it("nested compound inner container can be dragged via parent handlers", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        { id: "outer", label: "outer", color: "#64748b", kind: "container", compoundWidth: 360, compoundHeight: 280 },
        {
          id: "inner",
          label: "inner",
          color: "#475569",
          kind: "container",
          parent: "outer",
          x: 40,
          y: 40,
          compoundWidth: 160,
          compoundHeight: 120,
        },
        { id: "inner-leaf", label: "leaf", color: "#94a3b8", kind: "leaf", parent: "inner", x: 0, y: 0 },
      ],
      edges: [],
    });
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const before = absoluteCenter(scene.getModel()!, "inner");
    scene.attachParentDragHandlers(cy, {});
    const inner = cy.getElementById("inner");
    inner.trigger("grab");
    inner.position({ x: before.x + 20, y: before.y + 10 });
    inner.trigger("drag");
    inner.trigger("free");
    const after = absoluteCenter(scene.getModel()!, "inner");
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  it("nested compound child drag stays inside inner interior", () => {
    const scene = nestedCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const invokeTapstart = captureTapstartHandler(cy);
    scene.attachChildDragHandlers(cy, {});

    invokeTapstart(
      syntheticTapstart(cy, "inner-leaf", new MouseEvent("mousedown", { clientX: 50, clientY: 50 })),
    );
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500, clientY: 500 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 500, clientY: 500 }));

    const model = scene.getModel()!;
    const parentId = model.parentOf.get("inner-leaf");
    expect(parentId).toBe("inner");
    const inner = model.nodes.get("inner");
    const leaf = model.nodes.get("inner-leaf");
    expect(inner?.size).toBeDefined();
    expect(Math.abs(leaf!.center.x)).toBeLessThan(inner!.size!.w / 2);
    expect(Math.abs(leaf!.center.y)).toBeLessThan(inner!.size!.h / 2);
  });

  it("cloneModel and flatLayout throw before initialization", () => {
    const scene = twoCompoundScene();
    expect(() => scene.cloneModel()).toThrow(/layout model not initialized/);
    expect(() => scene.flatLayout()).toThrow(/layout model not initialized/);
  });

  it("setEdgeClearance and setNodeOverlapPadding update the model", () => {
    const scene = singleCompoundWithLeaves();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    scene.setEdgeClearance(12);
    scene.setNodeOverlapPadding(6);
    expect(scene.getModel()?.nodes.get("parent")?.reservedEdge).toBe(12);
    expect(scene.getModel()?.nodeOverlapPadding).toBe(6);
  });

  it("setEdgeClearance rejects a negative value so children cannot sit on the perimeter", () => {
    const scene = singleCompoundWithLeaves();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    scene.setEdgeClearance(-5);
    expect(scene.getModel()?.nodes.get("parent")?.reservedEdge).toBe(0);
  });

  it("refreshFootprintsFromCy syncs leaf footprints for all containers", () => {
    const scene = nestedCompoundScene();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    scene.refreshFootprintsFromCy(cy);
    expect(scene.getModel()?.nodes.get("inner-leaf")?.footprint).toBeDefined();
    expect(scene.getModel()?.nodes.get("outer-leaf")?.footprint).toBeDefined();
  });

  it("buildElements includes edges and passthrough node data", () => {
    const scene = CompoundGraphScene.fromSpec({
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#64748b",
          kind: "container",
          nodeType: "work-package",
          compoundWidth: 100,
          compoundHeight: 80,
        },
        {
          id: "leaf",
          label: "leaf",
          color: "#94a3b8",
          kind: "leaf",
          parent: "parent",
          classes: "extra",
        },
      ],
      edges: [{ id: "e1", source: "leaf", target: "parent", label: "dep" }],
    });
    const elements = scene.buildElements();
    const parent = elements.find((element) => element.data?.id === "parent");
    const edge = elements.find((element) => element.data?.id === "e1");
    expect(parent?.data?.type).toBe("work-package");
    expect(edge?.data?.label).toBe("dep");
  });

  it("syncToCy and resizeFromCorner update the live model", () => {
    const scene = singleCompoundWithLeaves();
    const cy = headlessCy(scene.buildElements());
    scene.initializeFromCy(cy);
    const constraints = scene.computeResizeChildConstraints(cy, "parent");
    scene.resizeFromCorner("parent", "se", 20, 15, scene.cloneModel(), constraints);
    scene.syncToCy(cy);
    expect(scene.getModel()?.nodes.get("parent")?.size?.w).toBeGreaterThan(220);
  });
});
