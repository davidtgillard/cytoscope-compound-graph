import type { Core } from "cytoscape";
import { graphNodeModelPosition, measureLeafFootprint } from "./cytoscape-utils";
import {
  absoluteCenter,
  buildLayoutModel,
  type LayoutModelBuildOptions,
  type LayoutNodeInput,
  type WorkPackageLayoutModel,
} from "./layout-model";

function modelDepth(model: WorkPackageLayoutModel, nodeId: string): number {
  let depth = 0;
  let parentId = model.parentOf.get(nodeId);
  while (parentId) {
    depth += 1;
    parentId = model.parentOf.get(parentId);
  }
  return depth;
}

/**
 * Cytoscape always reports node positions in global graph coordinates. Our layout
 * model, however, stores each node's "center" relative to its immediate parent (see
 * absoluteCenter/moveChild in layout-model.ts). So when reading a child back out of
 * Cytoscape we must subtract its parent's global position to land back in the
 * model's relative frame.
 */
export function layoutModelFromCy(
  cy: Core,
  inputs: LayoutNodeInput[],
  options?: LayoutModelBuildOptions,
): WorkPackageLayoutModel {
  const flat: Record<string, { x: number; y: number; w?: number; h?: number }> = {};
  const measuredInputs: LayoutNodeInput[] = [];
  for (const input of inputs) {
    const node = cy.getElementById(input.id);
    if (node.empty()) {
      measuredInputs.push(input);
      continue;
    }
    const absolute = graphNodeModelPosition(node);
    let center = { x: absolute.x, y: absolute.y };
    if (input.parent) {
      const parentNode = cy.getElementById(input.parent);
      if (!parentNode.empty()) {
        const parentAbsolute = graphNodeModelPosition(parentNode);
        center = { x: absolute.x - parentAbsolute.x, y: absolute.y - parentAbsolute.y };
      }
    }
    const position: { x: number; y: number; w?: number; h?: number } = center;
    const width = node.data("compoundWidth");
    const height = node.data("compoundHeight");
    if (width !== undefined && height !== undefined) {
      position.w = Number(width);
      position.h = Number(height);
    }
    flat[input.id] = position;
    measuredInputs.push(
      !input.isCompound && input.parent
        ? { ...input, footprint: input.footprint ?? measureLeafFootprint(node) }
        : input,
    );
  }
  return buildLayoutModel(measuredInputs, flat, options);
}

/**
 * Model centre is authoritative. The container is a plain node (see cytoscape-theme.ts),
 * so writing every node's absolute center directly is all that's needed.
 *
 * Do not call `cy.resize()` here. That API is for when the HTML container's pixel size
 * changes: it clears the canvas and defers the next paint. After load-time unjam the
 * consumer often still has to write zoom-compensated `nodeWidth`/`nodeHeight`; a deferred
 * paint from `resize()` can freeze leaves at the default 36px diameter until a later
 * gesture forces a redraw.
 */
function applyModelSync(cy: Core, model: WorkPackageLayoutModel): void {
  const sortedIds = [...model.nodes.keys()].sort(
    (leftId, rightId) => modelDepth(model, leftId) - modelDepth(model, rightId),
  );

  cy.batch(() => {
    for (const nodeId of sortedIds) {
      const layoutNode = model.nodes.get(nodeId);
      if (!layoutNode || layoutNode.isOverflow || !layoutNode.isCompound || !layoutNode.size) {
        continue;
      }
      const cyNode = cy.getElementById(nodeId);
      if (cyNode.empty()) {
        continue;
      }
      cyNode.data("compoundWidth", layoutNode.size.w);
      cyNode.data("compoundHeight", layoutNode.size.h);
    }

    for (const nodeId of sortedIds) {
      const layoutNode = model.nodes.get(nodeId);
      if (!layoutNode || layoutNode.isOverflow) {
        continue;
      }
      const cyNode = cy.getElementById(nodeId);
      if (cyNode.empty()) {
        continue;
      }
      const absolute = absoluteCenter(model, nodeId);
      cyNode.position({ x: absolute.x, y: absolute.y });
    }
  });
}

export function applyLayoutModelToCy(cy: Core, model: WorkPackageLayoutModel): void {
  applyModelSync(cy, model);
}
