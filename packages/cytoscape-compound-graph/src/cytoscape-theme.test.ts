import cytoscape from "cytoscape";
import { describe, expect, it, vi } from "vitest";
import {
  applyReferenceZoomToLeafMetrics,
  createCompoundGraphStylesheet,
  DEFAULT_COMPOUND_GRAPH_THEME,
  LEAF_NODE_DIAMETER,
} from "./cytoscape-theme";

function leafCy(nodeWidth = LEAF_NODE_DIAMETER) {
  return cytoscape({
    headless: true,
    styleEnabled: true,
    style: createCompoundGraphStylesheet(),
    elements: [
      {
        data: {
          id: "parent",
          kind: "container",
          compoundWidth: 400,
          compoundHeight: 400,
        },
        position: { x: 0, y: 0 },
      },
      {
        data: {
          id: "child",
          kind: "leaf",
          label: "child",
          nodeWidth,
          nodeHeight: nodeWidth,
          labelFontSize: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize,
          labelOutlineWidth: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.outlineWidth,
          labelMarginY: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.marginY,
          selectionOutlineWidth: DEFAULT_COMPOUND_GRAPH_THEME.leafSelection.outlineWidth,
        },
        position: { x: 0, y: 0 },
      },
    ],
  });
}

describe("applyReferenceZoomToLeafMetrics", () => {
  it("converts theme-default screen pixels into model units at the fit zoom", () => {
    const cy = leafCy();
    expect(applyReferenceZoomToLeafMetrics(cy, 0.5)).toBe(true);
    expect(cy.getElementById("child").data("nodeWidth")).toBeCloseTo(LEAF_NODE_DIAMETER / 0.5);
    expect(cy.getElementById("child").data("nodeHeight")).toBeCloseTo(LEAF_NODE_DIAMETER / 0.5);
    expect(cy.getElementById("child").data("labelFontSize")).toBeCloseTo(
      DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize / 0.5,
    );
  });

  it("does not convert twice or overwrite already-compensated diameters", () => {
    const cy = leafCy();
    applyReferenceZoomToLeafMetrics(cy, 0.5);
    expect(applyReferenceZoomToLeafMetrics(cy, 0.5)).toBe(false);
    expect(cy.getElementById("child").data("nodeWidth")).toBeCloseTo(LEAF_NODE_DIAMETER / 0.5);
  });

  it("leaves custom leaf diameters alone", () => {
    const cy = leafCy(50);
    applyReferenceZoomToLeafMetrics(cy, 0.5);
    expect(cy.getElementById("child").data("nodeWidth")).toBe(50);
    expect(cy.getElementById("child").data("labelFontSize")).toBeCloseTo(
      DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize / 0.5,
    );
  });

  it("treats a non-positive zoom as unit zoom and does not resize", () => {
    const cy = leafCy();
    expect(applyReferenceZoomToLeafMetrics(cy, 0)).toBe(false);
    expect(applyReferenceZoomToLeafMetrics(cy, Number.NaN)).toBe(false);
    expect(cy.getElementById("child").data("nodeWidth")).toBe(LEAF_NODE_DIAMETER);
  });

  it("skips fields whose current values are not finite numbers", () => {
    const cy = leafCy();
    cy.getElementById("child").data("nodeWidth", "wide");
    applyReferenceZoomToLeafMetrics(cy, 0.5);
    expect(cy.getElementById("child").data("nodeWidth")).toBe("wide");
  });
});

describe("live-zoom leaf stylesheet", () => {
  it("keeps the themed on-screen diameter when zoom changes before initialize", () => {
    const cy = leafCy();
    expect(cy.getElementById("child").numericStyle("width")).toBeCloseTo(LEAF_NODE_DIAMETER);
    cy.zoom(0.5);
    expect(cy.getElementById("child").numericStyle("width")).toBeCloseTo(LEAF_NODE_DIAMETER / 0.5);
    expect(cy.getElementById("child").numericStyle("width") * cy.zoom()).toBeCloseTo(
      LEAF_NODE_DIAMETER,
    );
  });

  it("uses fallback defaults when leaf size data is missing", () => {
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      style: createCompoundGraphStylesheet(),
      elements: [{ data: { id: "child", kind: "leaf", label: "child" }, position: { x: 0, y: 0 } }],
    });
    cy.zoom(0.5);
    expect(cy.getElementById("child").numericStyle("width")).toBeCloseTo(LEAF_NODE_DIAMETER / 0.5);
  });

  it("stops tracking live zoom after metrics are frozen into model space", () => {
    const cy = leafCy();
    applyReferenceZoomToLeafMetrics(cy, 0.5);
    const frozen = Number(cy.getElementById("child").data("nodeWidth"));
    cy.zoom(0.25);
    cy.emit("zoom");
    expect(cy.getElementById("child").numericStyle("width")).toBeCloseTo(frozen);
  });

  it("refreshLeafStyle no-ops when the style API cannot update", () => {
    const cy = leafCy();
    vi.spyOn(cy, "style").mockImplementation((() => ({})) as typeof cy.style);
    cy.zoom(0.4);
    cy.emit("zoom");
    expect(cy.getElementById("child").data("kind")).toBe("leaf");
  });

  it("keeps screen-pixel width when live zoom is not positive", () => {
    const cy = leafCy();
    vi.spyOn(cy, "zoom").mockImplementation(
      ((...args: Parameters<typeof cy.zoom>) => (args.length === 0 ? 0 : cy)) as typeof cy.zoom,
    );
    expect(cy.getElementById("child").numericStyle("width")).toBeCloseTo(LEAF_NODE_DIAMETER);
  });
});
