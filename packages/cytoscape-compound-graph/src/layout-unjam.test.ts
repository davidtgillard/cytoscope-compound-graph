import { describe, expect, it, vi } from "vitest";
import {
  buildLayoutModel,
  flatLayoutFromModel,
  nodesOverlapInModel,
} from "./layout-model";
import * as layoutModel from "./layout-model";
import {
  isFullyImpeded,
  isLocallyFree,
  isValidRest,
  unjamLayoutModel,
} from "./layout-unjam";

describe("layout-unjam", () => {
  // Models the post-clone stacked layout: siblings share (0, 0) and drag feels frozen.
  const stackedSiblingsInputs = [
    { id: "root", isCompound: true },
    { id: "a", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
    { id: "b", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
    { id: "c", parent: "root", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
  ];

  const stackedLayout = {
    root: { x: 0, y: 0, w: 400, h: 400 },
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0 },
    c: { x: 0, y: 0 },
  };

  it("treats overlapping siblings at origin as fully impeded", () => {
    const model = buildLayoutModel(stackedSiblingsInputs, stackedLayout);
    expect(isValidRest(model, "a")).toBe(false);
    expect(isLocallyFree(model, "a")).toBe(false);
    expect(isFullyImpeded(model, "a")).toBe(true);
    expect(isFullyImpeded(model, "b")).toBe(true);
  });

  it("separates stacked siblings and restores local freedom", () => {
    const model = buildLayoutModel(stackedSiblingsInputs, stackedLayout);
    const { model: unjammed, changed } = unjamLayoutModel(model, { bootstrap: true });
    expect(changed).toBe(true);
    expect(nodesOverlapInModel(unjammed, "a", "b")).toBe(false);
    expect(nodesOverlapInModel(unjammed, "b", "c")).toBe(false);
    expect(isValidRest(unjammed, "a")).toBe(true);
    expect(isLocallyFree(unjammed, "a")).toBe(true);
    expect(isLocallyFree(unjammed, "b")).toBe(true);
    expect(isLocallyFree(unjammed, "c")).toBe(true);
  });

  it("leaves a valid spaced layout unchanged in selective mode", () => {
    const spacedLayout = {
      root: { x: 0, y: 0, w: 400, h: 400 },
      a: { x: -120, y: 0 },
      b: { x: 0, y: 0 },
      c: { x: 120, y: 0 },
    };
    const model = buildLayoutModel(stackedSiblingsInputs, spacedLayout);
    expect(isFullyImpeded(model, "a")).toBe(false);
    expect(isFullyImpeded(model, "b")).toBe(false);

    const { model: unjammed, changed } = unjamLayoutModel(model);
    expect(changed).toBe(false);
    expect(flatLayoutFromModel(unjammed)).toEqual(flatLayoutFromModel(model));
  });

  it("leaves free siblings unchanged in selective mode", () => {
    const partialLayout = {
      root: { x: 0, y: 0, w: 400, h: 400 },
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      c: { x: 150, y: 0 },
    };
    const model = buildLayoutModel(stackedSiblingsInputs, partialLayout);
    expect(isFullyImpeded(model, "a")).toBe(true);
    expect(isFullyImpeded(model, "b")).toBe(true);
    expect(isFullyImpeded(model, "c")).toBe(false);

    const before = flatLayoutFromModel(model);
    const { model: unjammed, changed } = unjamLayoutModel(model);
    const after = flatLayoutFromModel(unjammed);

    expect(changed).toBe(true);
    expect(after.c).toEqual(before.c);
    expect(nodesOverlapInModel(unjammed, "a", "b")).toBe(false);
    expect(isValidRest(unjammed, "a")).toBe(true);
    expect(isValidRest(unjammed, "b")).toBe(true);
    expect(isLocallyFree(unjammed, "a")).toBe(true);
    expect(isLocallyFree(unjammed, "b")).toBe(true);
  });

  it("treats overflow nodes as valid rest and not impeded", () => {
    const model = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "overflow", parent: "root", isOverflow: true },
      ],
      {
        root: { x: 0, y: 0, w: 200, h: 200 },
        overflow: { x: 0, y: 0 },
      },
    );
    expect(isValidRest(model, "overflow")).toBe(true);
    expect(isLocallyFree(model, "overflow")).toBe(true);
    expect(isFullyImpeded(model, "overflow")).toBe(false);
  });

  it("reports invalid rest for missing visual boxes and parent interior", () => {
    const missingSize = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "child", parent: "root", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        root: { x: 0, y: 0 },
        child: { x: 0, y: 0 },
      },
    );
    missingSize.nodes.get("root")!.size = undefined;
    expect(isValidRest(missingSize, "child")).toBe(false);

    const outsideParent = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "child", parent: "root", footprint: { halfW: 10, halfHTop: 10, halfHBottom: 10 } },
      ],
      {
        root: { x: 0, y: 0, w: 80, h: 80 },
        child: { x: 200, y: 200 },
      },
    );
    expect(isValidRest(outsideParent, "child")).toBe(false);
  });

  it("returns not locally free when probe resolution does not move the node", () => {
    const spacedLayout = {
      root: { x: 0, y: 0, w: 400, h: 400 },
      a: { x: -120, y: 0 },
      b: { x: 0, y: 0 },
      c: { x: 120, y: 0 },
    };
    const model = buildLayoutModel(stackedSiblingsInputs, spacedLayout);
    vi.spyOn(layoutModel, "moveChild").mockImplementation((current) => current);
    expect(isValidRest(model, "a")).toBe(true);
    expect(isLocallyFree(model, "a")).toBe(false);
    expect(isFullyImpeded(model, "a")).toBe(true);
    vi.restoreAllMocks();
  });

  it("separates stacked root-level siblings", () => {
    const rootStackInputs = [
      { id: "a", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
      { id: "b", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
      { id: "c", footprint: { halfW: 20, halfHTop: 20, halfHBottom: 20 } },
    ];
    const rootStackLayout = {
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      c: { x: 0, y: 0 },
    };
    const model = buildLayoutModel(rootStackInputs, rootStackLayout);
    expect(isFullyImpeded(model, "a")).toBe(true);

    const { model: unjammed, changed } = unjamLayoutModel(model, { bootstrap: true });
    expect(changed).toBe(true);
    expect(nodesOverlapInModel(unjammed, "a", "b")).toBe(false);
    expect(isLocallyFree(unjammed, "a")).toBe(true);
  });

  it("uses fallback placement when ring search is disabled", () => {
    const model = buildLayoutModel(stackedSiblingsInputs, stackedLayout);
    const beforeA = { ...model.nodes.get("a")!.center };
    const { model: unjammed, changed } = unjamLayoutModel(model, {
      bootstrap: true,
      maxRings: 0,
      ringStep: 120,
    });
    expect(changed).toBe(true);
    expect(unjammed.nodes.get("a")!.center).not.toEqual(beforeA);
    expect(isValidRest(unjammed, "a")).toBe(true);
  });

  it("grows a tight parent during ring search and after sibling placement", () => {
    const tightParentInputs = [
      { id: "root", isCompound: true },
      { id: "a", parent: "root", footprint: { halfW: 18, halfHTop: 18, halfHBottom: 18 } },
      { id: "b", parent: "root", footprint: { halfW: 18, halfHTop: 18, halfHBottom: 18 } },
      { id: "c", parent: "root", footprint: { halfW: 18, halfHTop: 18, halfHBottom: 18 } },
    ];
    const tightLayout = {
      root: { x: 0, y: 0, w: 90, h: 90 },
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      c: { x: 0, y: 0 },
    };
    const model = buildLayoutModel(tightParentInputs, tightLayout);
    const beforeOuter = model.nodes.get("root")!.size!;
    const { model: unjammed, changed } = unjamLayoutModel(model, { bootstrap: true, ringStep: 30 });
    expect(changed).toBe(true);
    const afterOuter = unjammed.nodes.get("root")!.size!;
    expect(afterOuter.w * afterOuter.h).toBeGreaterThanOrEqual(beforeOuter.w * beforeOuter.h);
    expect(nodesOverlapInModel(unjammed, "a", "b")).toBe(false);
  });

  it("skips sibling groups that contain only overflow children", () => {
    const overflowOnlyInputs = [
      { id: "root", isCompound: true },
      { id: "hidden-a", parent: "root", isOverflow: true },
      { id: "hidden-b", parent: "root", isOverflow: true },
    ];
    const layout = {
      root: { x: 0, y: 0, w: 200, h: 200 },
      "hidden-a": { x: 0, y: 0 },
      "hidden-b": { x: 0, y: 0 },
    };
    const model = buildLayoutModel(overflowOnlyInputs, layout);
    const { changed } = unjamLayoutModel(model);
    expect(changed).toBe(false);
  });

  it("probes compound nodes through moveComposite", () => {
    const model = buildLayoutModel(
      [
        { id: "a", isCompound: true },
        { id: "b", isCompound: true },
      ],
      {
        a: { x: -200, y: 0, w: 120, h: 120 },
        b: { x: 200, y: 0, w: 120, h: 120 },
      },
    );
    expect(isLocallyFree(model, "a")).toBe(true);
  });

  it("tolerates parent compounds without size during grow-only passes", () => {
    const model = buildLayoutModel(
      [
        { id: "root", isCompound: true },
        { id: "a", parent: "root", footprint: { halfW: 15, halfHTop: 15, halfHBottom: 15 } },
      ],
      {
        root: { x: 0, y: 0 },
        a: { x: 0, y: 0 },
      },
    );
    model.nodes.get("root")!.size = undefined;
    const { changed } = unjamLayoutModel(model, { bootstrap: true });
    expect(changed).toBe(true);
  });

  it("unjams nested composites deepest-first and grows parent when needed", () => {
    const nestedInputs = [
      { id: "root", isCompound: true },
      { id: "outer", parent: "root", isCompound: true },
      { id: "inner-a", parent: "outer", footprint: { halfW: 15, halfHTop: 15, halfHBottom: 15 } },
      { id: "inner-b", parent: "outer", footprint: { halfW: 15, halfHTop: 15, halfHBottom: 15 } },
    ];
    const nestedLayout = {
      root: { x: 0, y: 0, w: 500, h: 500 },
      outer: { x: 0, y: 0, w: 200, h: 200 },
      "inner-a": { x: 0, y: 0 },
      "inner-b": { x: 0, y: 0 },
    };
    const model = buildLayoutModel(nestedInputs, nestedLayout);
    const { model: unjammed, changed } = unjamLayoutModel(model, { bootstrap: true });
    expect(changed).toBe(true);
    expect(nodesOverlapInModel(unjammed, "inner-a", "inner-b")).toBe(false);
    expect(isLocallyFree(unjammed, "inner-a")).toBe(true);
    expect(isLocallyFree(unjammed, "inner-b")).toBe(true);
    const outer = unjammed.nodes.get("outer");
    expect(outer?.size?.w).toBeGreaterThanOrEqual(200);
  });
});
