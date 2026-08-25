// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applySubtreePositionsToCy,
  enableContainerDragging,
  measureContainerFromCy,
  pinContainerToModel,
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

  it("enableContainerDragging and restoreLeafVisibility skip missing elements", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [],
    });
    expect(() => enableContainerDragging(cy, ["missing"])).not.toThrow();
    expect(() => restoreLeafVisibility(cy, ["missing"])).not.toThrow();
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
