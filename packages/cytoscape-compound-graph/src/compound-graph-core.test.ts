// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applySubtreePositionsToCy,
  childDragVisualMetrics,
  enableContainerDragging,
  enableRootLeafDragging,
  measureContainerFromCy,
  pinContainerToModel,
  pinLeafToModel,
  renderedContainerBoxFromModel,
  restoreLeafVisibility,
  viewportBoundsInGraphSpace,
} from "./compound-graph-core";
import { buildLayoutModel } from "./layout-model";
import { createCompoundGraphStylesheet } from "./cytoscape-theme";
import cytoscape from "cytoscape";

describe("compound-graph-core", () => {
  it("measureContainerFromCy no-ops for missing parents, pinned parents, and empty child lists", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "pinned", kind: "container" }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf", label: "child" }, position: { x: 0, y: 0 } },
      ],
    });
    cy.getElementById("pinned").data("compoundWidth", 100);
    expect(() => measureContainerFromCy(cy, "missing", ["child"])).not.toThrow();
    expect(() => measureContainerFromCy(cy, "pinned", ["child"])).not.toThrow();
    expect(() => measureContainerFromCy(cy, "pinned", ["ghost"])).not.toThrow();
    expect(cy.getElementById("pinned").data("compoundWidth")).toBe(100);
  });

  it("measureContainerFromCy sizes a parent from nested container children", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container" }, position: { x: 0, y: 0 } },
        {
          data: { id: "nested", kind: "container", compoundWidth: 80, compoundHeight: 60 },
          position: { x: 12, y: 8 },
        },
      ],
    });
    measureContainerFromCy(cy, "parent", ["nested"]);
    expect(Number(cy.getElementById("parent").data("compoundWidth"))).toBeGreaterThan(80);
    expect(Number(cy.getElementById("parent").data("compoundHeight"))).toBeGreaterThan(60);
  });

  it("childDragVisualMetrics falls back when footprint or zoom is missing", () => {
    const model = buildLayoutModel([{ id: "child" }], { child: { x: 0, y: 0 } });
    const missing = childDragVisualMetrics(model, "missing", 0);
    expect(missing.footprint).toEqual({ halfW: 18, halfHTop: 18, halfHBottom: 26 });
    expect(missing.labelMaxWidthPx).toBe(36);
    const known = childDragVisualMetrics(model, "child", -1);
    expect(known.labelMaxWidthPx).toBe(known.footprint.halfW * 2);
  });

  it("pinContainerToModel and renderedContainerBoxFromModel tolerate missing data", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [],
    });
    const model = buildLayoutModel([{ id: "parent", isCompound: true }], {
      parent: { x: 0, y: 0, w: 100, h: 80 },
    });
    expect(() => pinContainerToModel(cy, model, "parent")).not.toThrow();
    expect(renderedContainerBoxFromModel(cy, model, "missing")).toBeNull();
  });

  it("applySubtreePositionsToCy skips missing cy nodes", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container" }, position: { x: 0, y: 0 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 100, h: 80 },
        child: { x: 5, y: 5 },
      },
    );
    expect(() => applySubtreePositionsToCy(cy, model, "parent")).not.toThrow();
  });

  it("pinLeafToModel writes the model centre onto a leaf and skips missing ids", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 100, compoundHeight: 80 } },
        { data: { id: "child", kind: "leaf" }, position: { x: 0, y: 0 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 10, y: 20, w: 100, h: 80 },
        child: { x: 5, y: 7 },
      },
    );
    expect(() => pinLeafToModel(cy, model, "missing")).not.toThrow();
    pinLeafToModel(cy, model, "child");
    expect(cy.getElementById("child").position()).toEqual({ x: 15, y: 27 });
  });

  it("enableContainerDragging and restoreLeafVisibility skip missing elements", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [],
    });
    expect(() => enableContainerDragging(cy, ["missing"])).not.toThrow();
    expect(() => enableRootLeafDragging(cy, ["missing"])).not.toThrow();
    expect(() => restoreLeafVisibility(cy, ["missing"])).not.toThrow();
  });

  it("enableRootLeafDragging grabifies existing leaves", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [{ data: { id: "leaf", kind: "leaf" }, position: { x: 0, y: 0 } }],
    });
    cy.getElementById("leaf").ungrabify();
    enableRootLeafDragging(cy, ["leaf"]);
    expect(cy.getElementById("leaf").grabbable()).toBe(true);
  });

  it("viewportBoundsInGraphSpace inverts pan and zoom into graph coordinates", () => {
    const cy = {
      width: () => 400,
      height: () => 300,
      pan: () => ({ x: 50, y: 40 }),
      zoom: () => 2,
    } as cytoscape.Core;
    expect(viewportBoundsInGraphSpace(cy, 0)).toEqual({
      x1: -25,
      y1: -20,
      x2: 175,
      y2: 130,
    });
    expect(viewportBoundsInGraphSpace(cy, 10)).toEqual({
      x1: -20,
      y1: -15,
      x2: 170,
      y2: 125,
    });
  });

  it("viewportBoundsInGraphSpace returns null for invalid dimensions", () => {
    const cy = {
      width: () => 0,
      height: () => 300,
      pan: () => ({ x: 0, y: 0 }),
      zoom: () => 1,
    } as cytoscape.Core;
    expect(viewportBoundsInGraphSpace(cy, 8)).toBeNull();
  });

  it("viewportBoundsInGraphSpace returns null for non-positive zoom", () => {
    const cy = {
      width: () => 400,
      height: () => 300,
      pan: () => ({ x: 0, y: 0 }),
      zoom: () => 0,
    } as cytoscape.Core;
    expect(viewportBoundsInGraphSpace(cy, 8)).toBeNull();
  });
});
