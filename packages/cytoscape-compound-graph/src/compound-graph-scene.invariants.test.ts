// @vitest-environment jsdom
/**
 * The same four positional requirements as layout-invariants.test.ts, but asserted on
 * what actually lands in Cytoscape rather than on the layout model:
 *
 * R1. Moving a node - container or leaf - must not change the position of any other node,
 *     except that a container carries its own subtree.
 * R2. Moving a container holds every descendant's offset within that container constant.
 * R3. Moving a container holds the extent of its boundary constant.
 * R4. Changing a container's extent moves nothing, including its own children.
 *
 * The model layer can satisfy all four and still render wrongly, because Cytoscape
 * positions are global while `LayoutNode.center` is parent-relative. A missing conversion
 * on the write-back path shows up only here - a nested container teleporting to its
 * parent-relative offset when any node inside it is dragged, for instance.
 *
 * Scene node `x`/`y` in these fixtures are absolute graph coordinates, matching
 * CompoundGraphScene.buildElements.
 */
import { describe, expect, it } from "vitest";
import cytoscape from "cytoscape";
import { CompoundGraphScene, type CompoundGraphSceneSpec } from "./compound-graph-scene";
import { ALL_LOOSE_EDGES, absoluteCenter, buildLayoutModel, childrenFitBoxAbsolute, compositeOuterBox, isLegalNodeRest, moveChild } from "./layout-model";
import { captureTapstartHandler, headlessCy, syntheticTapstart } from "../tests/helpers/fixtures";

interface RenderedNode {
  position: { x: number; y: number };
  size: { w: number; h: number } | null;
}

function renderedNodes(cy: cytoscape.Core): Map<string, RenderedNode> {
  const result = new Map<string, RenderedNode>();
  cy.nodes().forEach((node) => {
    const w = node.data("compoundWidth");
    const h = node.data("compoundHeight");
    result.set(node.id(), {
      position: { ...node.position() },
      size: w === undefined || h === undefined ? null : { w: Number(w), h: Number(h) },
    });
  });
  return result;
}

/**
 * Two root containers. The right one nests a container of its own so relative/absolute
 * confusion cannot hide behind a parent that happens to sit at the origin.
 */
function nestedSpec(overrides?: Partial<CompoundGraphSceneSpec>): CompoundGraphSceneSpec {
  return {
    nodes: [
      { id: "left", label: "left", color: "#000", kind: "container", x: 1000, y: 500, compoundWidth: 400, compoundHeight: 300 },
      { id: "left-a", label: "left-a", color: "#111", kind: "leaf", parent: "left", x: 910, y: 470 },
      { id: "left-b", label: "left-b", color: "#111", kind: "leaf", parent: "left", x: 1090, y: 470 },
      { id: "right", label: "right", color: "#000", kind: "container", x: 1800, y: 500, compoundWidth: 500, compoundHeight: 400 },
      { id: "mid", label: "mid", color: "#000", kind: "container", parent: "right", x: 1700, y: 500, compoundWidth: 220, compoundHeight: 180 },
      { id: "mid-a", label: "mid-a", color: "#111", kind: "leaf", parent: "mid", x: 1650, y: 500 },
    ],
    edges: [],
    clampParentToViewport: false,
    ...overrides,
  };
}

function initializedScene(spec = nestedSpec()) {
  const scene = CompoundGraphScene.fromSpec(spec);
  const cy = headlessCy(scene.buildElements());
  scene.initializeFromCy(cy);
  return { scene, cy };
}

/**
 * Rebuilds a scene from a saved layout the way a consumer does after a reload: the saved
 * entries hold parent-relative centres, and scene specs take absolute ones, so the
 * conversion runs through a layout model.
 */
function reloadedScene(
  spec: CompoundGraphSceneSpec,
  saved: Record<string, { x: number; y: number; w?: number; h?: number }>,
) {
  const model = buildLayoutModel(
    spec.nodes.map((node) => ({
      id: node.id,
      parent: node.parent,
      isCompound: node.kind === "container",
    })),
    saved,
  );
  return initializedScene({
    ...spec,
    nodes: spec.nodes.map((node) => {
      const absolute = absoluteCenter(model, node.id);
      const size = model.nodes.get(node.id)?.size;
      return {
        ...node,
        x: absolute.x,
        y: absolute.y,
        compoundWidth: size?.w ?? node.compoundWidth,
        compoundHeight: size?.h ?? node.compoundHeight,
      };
    }),
  });
}

/** Drives a container drag the way Cytoscape does: move the node, then sync. */
function dragContainer(
  scene: CompoundGraphScene,
  cy: cytoscape.Core,
  containerId: string,
  delta: { x: number; y: number },
): void {
  const start = cy.getElementById(containerId).position();
  cy.getElementById(containerId).position({ x: start.x + delta.x, y: start.y + delta.y });
  scene.applyContainerDragFromCy(cy, containerId);
}

/** Drives a detached leaf drag through the public tapstart/mousemove/mouseup path. */
function dragLeaf(
  scene: CompoundGraphScene,
  cy: cytoscape.Core,
  leafId: string,
  ...deltas: { x: number; y: number }[]
): void {
  const invokeTapstart = captureTapstartHandler(cy);
  const detach = scene.attachChildDragHandlers(cy, {});
  invokeTapstart(
    syntheticTapstart(cy, leafId, new MouseEvent("mousedown", { clientX: 0, clientY: 0 })),
  );
  for (const delta of deltas) {
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: delta.x * cy.zoom(), clientY: delta.y * cy.zoom() }),
    );
  }
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: 0, clientY: 0 }));
  detach();
}

function expectUnchanged(
  before: Map<string, RenderedNode>,
  after: Map<string, RenderedNode>,
  ids: string[],
): void {
  for (const id of ids) {
    expect({ id, node: after.get(id) }).toEqual({ id, node: before.get(id) });
  }
}

function expectTranslatedBy(
  before: Map<string, RenderedNode>,
  after: Map<string, RenderedNode>,
  ids: string[],
  delta: { x: number; y: number },
): void {
  for (const id of ids) {
    expect({ id, node: after.get(id) }).toEqual({
      id,
      node: {
        position: {
          x: before.get(id)!.position.x + delta.x,
          y: before.get(id)!.position.y + delta.y,
        },
        size: before.get(id)!.size,
      },
    });
  }
}

describe("CompoundGraphScene positional requirements", () => {
  it("R1: dragging a leaf moves only that leaf", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);

    dragLeaf(scene, cy, "left-a", { x: 20, y: 30 });
    const after = renderedNodes(cy);

    expect(after.get("left-a")!.position).toEqual({ x: 930, y: 500 });
    expectUnchanged(before, after, ["left", "left-b", "right", "mid", "mid-a"]);
  });

  it("R1: a later colliding frame does not throw a leaf back to the grab point", () => {
    const { scene, cy } = initializedScene();
    const startModel = scene.cloneModel();
    const startRelative = startModel.nodes.get("left-a")!.center;
    const liftRelative = { x: startRelative.x, y: startRelative.y - 80 };
    const dropRelative = { x: startRelative.x + 180, y: startRelative.y };

    dragLeaf(scene, cy, "left-a", { x: 0, y: -80 }, { x: 180, y: 0 });

    const liveModel = scene.cloneModel();
    const liveFootprint = liveModel.nodes.get("left-a")!.footprint;
    if (liveFootprint) {
      startModel.nodes.get("left-a")!.footprint = { ...liveFootprint };
    }
    const landed = absoluteCenter(liveModel, "left-a");
    const sequential = absoluteCenter(
      moveChild(moveChild(startModel, "left-a", liftRelative), "left-a", dropRelative),
      "left-a",
    );
    const replayedFromGrab = absoluteCenter(moveChild(startModel, "left-a", dropRelative), "left-a");

    expect(landed).toEqual(sequential);
    expect(landed).not.toEqual(replayedFromGrab);
  });

  it("R3 + R6: dragging a labelled leaf into a wall keeps the parent extent and a legal rest", () => {
    const spec: CompoundGraphSceneSpec = {
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#000",
          kind: "container",
          x: 0,
          y: 0,
          compoundWidth: 420,
          compoundHeight: 280,
        },
        {
          id: "child",
          label: "a wrapping child title that must occupy two lines of text",
          color: "#111",
          kind: "leaf",
          parent: "parent",
          x: 0,
          y: 0,
        },
      ],
      edges: [],
      clampParentToViewport: false,
    };
    const { scene, cy } = initializedScene(spec);
    const before = renderedNodes(cy);
    const start = absoluteCenter(scene.cloneModel(), "child");

    dragLeaf(scene, cy, "child", { x: -40, y: 20 }, { x: -400, y: -300 });

    const after = renderedNodes(cy);
    expect(after.get("parent")!.size).toEqual(before.get("parent")!.size);
    expect(after.get("parent")!.position).toEqual(before.get("parent")!.position);
    const model = scene.cloneModel();
    expect(isLegalNodeRest(model, "child")).toBe(true);
    const landed = absoluteCenter(model, "child");
    expect(landed).not.toEqual(start);
  });

  it("R1: dragging a leaf inside a nested container moves only that leaf", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);

    dragLeaf(scene, cy, "mid-a", { x: 15, y: -25 });
    const after = renderedNodes(cy);

    expect(after.get("mid-a")!.position).toEqual({ x: 1665, y: 475 });
    expectUnchanged(before, after, ["left", "left-a", "left-b", "right", "mid"]);
  });

  it("R1 + R2 + R3: dragging a root container translates its subtree rigidly", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);
    const delta = { x: -120, y: 70 };

    dragContainer(scene, cy, "left", delta);
    const after = renderedNodes(cy);

    expectTranslatedBy(before, after, ["left", "left-a", "left-b"], delta);
    expectUnchanged(before, after, ["right", "mid", "mid-a"]);
  });

  it("R1 + R2 + R3: dragging a nested container translates its subtree rigidly", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);
    const delta = { x: 40, y: -20 };

    dragContainer(scene, cy, "mid", delta);
    const after = renderedNodes(cy);

    expectTranslatedBy(before, after, ["mid", "mid-a"], delta);
    expectUnchanged(before, after, ["left", "left-a", "left-b", "right"]);
  });

  it("R4: resizing a container moves nothing else", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);

    const constraints = scene.computeResizeChildConstraints(cy, "left");
    scene.resizeFromCorner("left", "se", 90, 60, scene.cloneModel(), {
      ...constraints,
      childrenBox: null,
      looseEdges: ALL_LOOSE_EDGES,
    });
    scene.syncToCy(cy);
    const after = renderedNodes(cy);

    expect(after.get("left")!.size).toEqual({ w: 490, h: 360 });
    expectUnchanged(before, after, ["left-a", "left-b", "right", "mid", "mid-a"]);
  });

  it("R4: resizing a nested container moves nothing else", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);

    const constraints = scene.computeResizeChildConstraints(cy, "mid");
    scene.resizeFromCorner("mid", "nw", -50, -40, scene.cloneModel(), {
      ...constraints,
      childrenBox: null,
      looseEdges: ALL_LOOSE_EDGES,
    });
    scene.syncToCy(cy);
    const after = renderedNodes(cy);

    expect(after.get("mid")!.size).toEqual({ w: 270, h: 220 });
    expectUnchanged(before, after, ["left", "left-a", "left-b", "right", "mid-a"]);
  });

  it("R4: shrinking a parent toward a labelled child does not change the child's size", () => {
    const spec: CompoundGraphSceneSpec = {
      nodes: [
        {
          id: "parent",
          label: "parent",
          color: "#000",
          kind: "container",
          x: 0,
          y: 0,
          compoundWidth: 400,
          compoundHeight: 300,
        },
        {
          id: "child",
          label: "a wide labelled child",
          color: "#111",
          kind: "leaf",
          parent: "parent",
          x: 80,
          y: 40,
        },
      ],
      edges: [],
      clampParentToViewport: false,
    };
    const { scene, cy } = initializedScene(spec);
    const child = cy.getElementById("child");
    const beforePosition = { ...child.position() };
    const beforeSize = {
      w: child.data("nodeWidth"),
      h: child.data("nodeHeight"),
    };

    const constraints = scene.computeResizeChildConstraints(cy, "parent");
    scene.resizeFromCorner("parent", "se", -1000, -1000, scene.cloneModel(), constraints);
    scene.syncToCy(cy);

    expect(child.position()).toEqual(beforePosition);
    expect(child.data("nodeWidth")).toBe(beforeSize.w);
    expect(child.data("nodeHeight")).toBe(beforeSize.h);

    const model = scene.getModel()!;
    const outer = compositeOuterBox(model, "parent")!;
    const childrenBox = childrenFitBoxAbsolute(model, "parent")!;
    expect(outer.x2).toBeGreaterThanOrEqual(childrenBox.x2 - 1e-6);
    expect(outer.y2).toBeGreaterThanOrEqual(childrenBox.y2 - 1e-6);
  });

  /**
   * The resize gesture is the only one that changes more saved entries than the node the
   * user grabbed, so it is the only one where "nothing moved" on screen can still become
   * "children moved" after a reload. `flatLayoutForSubtree` is what a consumer must save.
   */
  it("R4: a resize saved by subtree re-loads to the same picture", () => {
    const spec = nestedSpec();
    const { scene, cy } = initializedScene(spec);
    const before = renderedNodes(cy);
    const saved = scene.flatLayout();

    const constraints = scene.computeResizeChildConstraints(cy, "left");
    scene.resizeFromCorner("left", "se", 120, 80, scene.cloneModel(), constraints);
    scene.syncToCy(cy);
    expectUnchanged(renderedNodes(cy), before, ["left-a", "left-b"]);

    const reloaded = reloadedScene(spec, { ...saved, ...scene.flatLayoutForSubtree("left") });
    const after = renderedNodes(reloaded.cy);

    expect(after.get("left")!.size).toEqual({ w: 520, h: 380 });
    expectUnchanged(before, after, ["left-a", "left-b", "right", "mid", "mid-a"]);
  });

  it("R1: a container drag blocked by a neighbour leaves the neighbour alone", () => {
    const { scene, cy } = initializedScene();
    const before = renderedNodes(cy);

    dragContainer(scene, cy, "left", { x: 800, y: 0 });
    const after = renderedNodes(cy);

    expectUnchanged(before, after, ["right", "mid", "mid-a"]);
    const delta = {
      x: after.get("left")!.position.x - before.get("left")!.position.x,
      y: after.get("left")!.position.y - before.get("left")!.position.y,
    };
    expect(delta.x).toBeGreaterThan(0);
    expect(delta.x).toBeLessThan(800);
    expectTranslatedBy(before, after, ["left-a", "left-b"], delta);
  });

  it("keeps the requirements after load-time unjam has separated a jammed scene", () => {
    const spec = nestedSpec();
    spec.nodes = spec.nodes.map((node) =>
      node.id === "left-a" || node.id === "left-b" ? { ...node, x: 1000, y: 500 } : node,
    );
    const { scene, cy } = initializedScene(spec);

    expect(scene.unjamLoadedLayout(cy, { bootstrap: true }).changed).toBe(true);
    const before = renderedNodes(cy);
    expect(before.get("left-a")!.position).not.toEqual(before.get("left-b")!.position);

    const delta = { x: 60, y: -40 };
    dragContainer(scene, cy, "left", delta);
    const after = renderedNodes(cy);

    expectTranslatedBy(before, after, ["left", "left-a", "left-b"], delta);
    expectUnchanged(before, after, ["right", "mid", "mid-a"]);
  });
});
