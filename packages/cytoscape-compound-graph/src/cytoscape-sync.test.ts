import cytoscape from "cytoscape";
import { describe, expect, it, vi } from "vitest";
import { createCompoundGraphStylesheet } from "./cytoscape-theme";
import { applyLayoutModelToCy, layoutModelFromCy } from "./cytoscape-sync";
import { compoundAbsolutePosition } from "./cytoscape-utils";
import { buildLayoutModel, resizeComposite } from "./layout-model";

describe("cytoscape-sync", () => {
  it("layoutModelFromCy preserves missing elements from inputs", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 180, compoundHeight: 120 }, position: { x: 0, y: 0 } },
      ],
    });
    const model = layoutModelFromCy(cy, [
      { id: "parent", isCompound: true },
      { id: "missing-child", parent: "parent" },
    ]);
    expect(model.nodes.has("missing-child")).toBe(true);
  });

  it("layoutModelFromCy keeps absolute centers when parent cy nodes are missing", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [{ data: { id: "child", kind: "leaf", label: "child" } }],
    });
    cy.getElementById("child").position({ x: 12, y: 8 });
    const model = layoutModelFromCy(cy, [{ id: "child", parent: "missing-parent" }]);
    expect(model.nodes.get("child")?.center).toEqual({ x: 12, y: 8 });
  });

  it("applyLayoutModelToCy writes compound sizes before descendant positions", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container" }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf", label: "child" }, position: { x: 0, y: 0 } },
      ],
    });
    let model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 220, h: 160 },
        child: { x: 10, y: 5 },
      },
    );
    model = resizeComposite(model, "parent", "se", 20, 10);
    applyLayoutModelToCy(cy, model);
    expect(Number(cy.getElementById("parent").data("compoundWidth"))).toBeGreaterThan(220);
    expect(cy.getElementById("child").position().x).not.toBe(0);
  });

  it("applyLayoutModelToCy does not call cy.resize so leaf diameters are not frozen mid-style", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container", compoundWidth: 200, compoundHeight: 160 }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf", nodeWidth: 72, nodeHeight: 72 }, position: { x: 0, y: 0 } },
      ],
    });
    const resize = vi.spyOn(cy, "resize");
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
      ],
      {
        parent: { x: 0, y: 0, w: 200, h: 160 },
        child: { x: 8, y: 4 },
      },
    );
    applyLayoutModelToCy(cy, model);
    expect(resize).not.toHaveBeenCalled();
    expect(cy.getElementById("child").data("nodeWidth")).toBe(72);
    expect(cy.getElementById("child").data("nodeHeight")).toBe(72);
    resize.mockRestore();
  });

  it("applyLayoutModelToCy skips missing cy nodes and overflow nodes", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        { data: { id: "parent", kind: "container" }, position: { x: 0, y: 0 } },
        { data: { id: "child", kind: "leaf", label: "child" }, position: { x: 0, y: 0 } },
      ],
    });
    const model = buildLayoutModel(
      [
        { id: "parent", isCompound: true },
        { id: "child", parent: "parent" },
        { id: "missing", parent: "parent", isOverflow: true },
        { id: "ghost", isCompound: true },
      ],
      {
        parent: { x: 0, y: 0, w: 180, h: 120 },
        child: { x: 10, y: 5 },
        missing: { x: 1, y: 1 },
        ghost: { x: 50, y: 50, w: 90, h: 70 },
      },
    );
    applyLayoutModelToCy(cy, model);
    expect(cy.getElementById("child").position().x).toBeCloseTo(10, 3);
    expect(cy.getElementById("parent").data("compoundWidth")).toBe(180);
  });

  it("model sync keeps child absolute position on SE resize", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        {
          data: { id: "wp-invoicing", kind: "container", compoundWidth: 420, compoundHeight: 280 },
          position: { x: 0, y: 0 },
        },
        {
          data: { id: "wp-pdf-export", kind: "leaf" },
          position: { x: 0, y: 0 },
        },
      ],
    });

    const inputs = [
      { id: "wp-invoicing", isCompound: true },
      { id: "wp-pdf-export", parent: "wp-invoicing" },
    ];
    let model = buildLayoutModel(inputs, {
      "wp-invoicing": { x: 0, y: 0, w: 420, h: 280 },
      "wp-pdf-export": { x: 0, y: 0 },
    });
    applyLayoutModelToCy(cy, model);

    const before = compoundAbsolutePosition(cy.getElementById("wp-pdf-export"));
    model = resizeComposite(model, "wp-invoicing", "se", 80, 60);
    applyLayoutModelToCy(cy, model);
    const after = compoundAbsolutePosition(cy.getElementById("wp-pdf-export"));

    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it("layoutModelFromCy round-trips after resize", () => {
    const cy = cytoscape({
      headless: true,
      style: createCompoundGraphStylesheet(),
      elements: [
        {
          data: { id: "wp-invoicing", kind: "container", compoundWidth: 420, compoundHeight: 280 },
          position: { x: 10, y: 20 },
        },
        {
          data: { id: "wp-pdf-export", kind: "leaf" },
          position: { x: -40, y: 10 },
        },
      ],
    });

    const inputs = [
      { id: "wp-invoicing", isCompound: true },
      { id: "wp-pdf-export", parent: "wp-invoicing" },
    ];
    let model = layoutModelFromCy(cy, inputs);
    model = resizeComposite(model, "wp-invoicing", "nw", -30, -20);
    applyLayoutModelToCy(cy, model);
    const roundTrip = layoutModelFromCy(cy, inputs);
    const child = roundTrip.nodes.get("wp-pdf-export");
    expect(child?.center.x).toBeCloseTo(model.nodes.get("wp-pdf-export")!.center.x, 3);
    expect(child?.center.y).toBeCloseTo(model.nodes.get("wp-pdf-export")!.center.y, 3);
  });
});
