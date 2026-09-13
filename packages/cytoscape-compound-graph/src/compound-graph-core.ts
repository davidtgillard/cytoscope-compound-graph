import type { Core } from "cytoscape";
import type { VisualBox } from "./collision";
import {
  INITIAL_COMPOUND_SLACK,
  compoundSizeForContent,
  freezeDragLeafFootprint,
  measureLeafFootprint,
} from "./cytoscape-utils";
import {
  absoluteCenter,
  compositeOuterBox,
  leafFootprintFitsInterior,
  subtreeNodeIds,
  type LeafFootprint,
  type WorkPackageLayoutModel,
} from "./layout-model";

export interface RenderedBoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function renderedBoxRect(
  cy: Core,
  box: { x1: number; y1: number; x2: number; y2: number },
): RenderedBoxRect {
  const pan = cy.pan();
  const zoom = cy.zoom();
  return {
    left: box.x1 * zoom + pan.x,
    top: box.y1 * zoom + pan.y,
    width: (box.x2 - box.x1) * zoom,
    height: (box.y2 - box.y1) * zoom,
  };
}

export function renderedContainerBoxFromModel(
  cy: Core,
  model: WorkPackageLayoutModel,
  containerId: string,
): RenderedBoxRect | null {
  const box = compositeOuterBox(model, containerId);
  if (!box) {
    return null;
  }
  return renderedBoxRect(cy, box);
}

/**
 * Visible Cytoscape container bounds converted to graph coordinates for viewport
 * clamping during compound drag (inverse of {@link renderedBoxRect}).
 */
export function viewportBoundsInGraphSpace(cy: Core, paddingPx: number): VisualBox | null {
  const zoom = cy.zoom();
  if (!(zoom > 0)) {
    return null;
  }
  const pan = cy.pan();
  const width = cy.width();
  const height = cy.height();
  if (!(width > 0 && height > 0)) {
    return null;
  }
  const pad = Math.max(0, paddingPx);
  const renderedX1 = pad;
  const renderedY1 = pad;
  const renderedX2 = width - pad;
  const renderedY2 = height - pad;
  if (renderedX2 <= renderedX1 || renderedY2 <= renderedY1) {
    return null;
  }
  return {
    x1: (renderedX1 - pan.x) / zoom,
    y1: (renderedY1 - pan.y) / zoom,
    x2: (renderedX2 - pan.x) / zoom,
    y2: (renderedY2 - pan.y) / zoom,
  };
}

export function measureContainerFromCy(cy: Core, containerId: string, childIds: string[]): void {
  cy.batch(() => {
    const parent = cy.getElementById(containerId);
    if (parent.empty() || parent.data("compoundWidth") !== undefined) {
      return;
    }

    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    let hasChild = false;
    for (const childId of childIds) {
      const child = cy.getElementById(childId);
      if (child.empty()) {
        continue;
      }
      hasChild = true;
      const center = child.position();
      if (child.data("kind") === "leaf") {
        const footprint = measureLeafFootprint(child);
        x1 = Math.min(x1, center.x - footprint.halfW);
        y1 = Math.min(y1, center.y - footprint.halfHTop);
        x2 = Math.max(x2, center.x + footprint.halfW);
        y2 = Math.max(y2, center.y + footprint.halfHBottom);
      } else {
        const box = child.boundingBox({ includeLabels: true, includeOverlays: false });
        x1 = Math.min(x1, box.x1);
        y1 = Math.min(y1, box.y1);
        x2 = Math.max(x2, box.x2);
        y2 = Math.max(y2, box.y2);
      }
    }
    if (!hasChild) {
      return;
    }

    const fit = compoundSizeForContent({ x1, y1, x2, y2 });
    const w = fit.w + INITIAL_COMPOUND_SLACK;
    const h = fit.h + INITIAL_COMPOUND_SLACK;
    parent.data("compoundWidth", w);
    parent.data("compoundHeight", h);
    parent.position({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
  });
}

/**
 * Writes a container's model size and position back to Cytoscape.
 *
 * Cytoscape positions are always global, while `LayoutNode.center` is relative to the
 * node's immediate parent (see layoutModelFromCy), so this must go through
 * {@link absoluteCenter}. Writing the relative center straight through happens to work
 * for a root container but teleports a nested one to its parent-relative offset.
 */
export function pinContainerToModel(
  cy: Core,
  model: WorkPackageLayoutModel,
  containerId: string,
): void {
  const parentNode = model.nodes.get(containerId);
  const parentSize = parentNode?.size;
  if (!parentNode || !parentSize) {
    return;
  }
  const cyParent = cy.getElementById(containerId);
  if (cyParent.empty()) {
    return;
  }
  const absolute = absoluteCenter(model, containerId);
  cy.batch(() => {
    cyParent.data("compoundWidth", parentSize.w);
    cyParent.data("compoundHeight", parentSize.h);
    cyParent.position({ x: absolute.x, y: absolute.y });
  });
}

/** Writes a leaf's model centre onto its Cytoscape node, including while it is hidden mid-drag. */
export function pinLeafToModel(
  cy: Core,
  model: WorkPackageLayoutModel,
  leafId: string,
): void {
  const cyLeaf = cy.getElementById(leafId);
  if (cyLeaf.empty()) {
    return;
  }
  cyLeaf.position(absoluteCenter(model, leafId));
}

export function applySubtreePositionsToCy(
  cy: Core,
  model: WorkPackageLayoutModel,
  rootId: string,
): void {
  for (const nodeId of subtreeNodeIds(model, rootId)) {
    if (nodeId === rootId) {
      continue;
    }
    const cyNode = cy.getElementById(nodeId);
    if (cyNode.empty()) {
      continue;
    }
    cyNode.position(absoluteCenter(model, nodeId));
  }
}

export function enableContainerDragging(cy: Core, containerIds: string[]): void {
  for (const containerId of containerIds) {
    const parent = cy.getElementById(containerId);
    if (!parent.empty()) {
      parent.unlock();
      parent.grabify();
    }
  }
}

/**
 * Keep parentless leaves natively grabbable. Detached child-drag only covers
 * parented leaves; root leaves need Cytoscape grab/drag/free.
 */
export function enableRootLeafDragging(cy: Core, leafIds: string[]): void {
  for (const leafId of leafIds) {
    const leaf = cy.getElementById(leafId);
    if (!leaf.empty()) {
      leaf.unlock();
      leaf.grabify();
    }
  }
}

export function configureDetachedChildDrag(cy: Core, leafIds: string[]): void {
  for (const childId of leafIds) {
    const child = cy.getElementById(childId);
    if (!child.empty()) {
      child.ungrabify();
    }
  }
}

export function restoreLeafVisibility(cy: Core, leafIds: string[]): void {
  for (const childId of leafIds) {
    const child = cy.getElementById(childId);
    if (!child.empty()) {
      child.removeStyle();
    }
  }
}

/**
 * Freeze the painted drag footprint on the model. Returns false when the box cannot
 * fit in the parent interior, in which case child drag must not start.
 */
export function prepareChildDragFootprint(
  cy: Core,
  model: WorkPackageLayoutModel,
  childId: string,
): boolean {
  freezeDragLeafFootprint(cy, model, childId);
  return leafFootprintFitsInterior(model, childId);
}

export function childDragVisualMetrics(
  model: WorkPackageLayoutModel,
  childId: string,
  referenceZoom: number,
): { footprint: LeafFootprint; labelMaxWidthPx: number } {
  const fallback: LeafFootprint = { halfW: 18, halfHTop: 18, halfHBottom: 26 };
  const footprint = model.nodes.get(childId)?.footprint ?? fallback;
  const zoom = referenceZoom > 0 ? referenceZoom : 1;
  return {
    footprint: { ...footprint },
    labelMaxWidthPx: footprint.halfW * 2 * zoom,
  };
}
