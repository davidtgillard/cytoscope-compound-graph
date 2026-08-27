import type { Core, NodeSingular } from "cytoscape";
import { COMPOUND_MIN_HEIGHT, COMPOUND_MIN_WIDTH, COMPOUND_PADDING } from "./cytoscape-theme";
import {
  absoluteCenter,
  compositeOuterBox,
  type WorkPackageLayoutModel,
} from "./layout-model";
import type { VisualBox } from "./collision";

/** @internal */
export interface Point {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * Cytoscape stores every node's position in plain global graph coordinates. The
 * "container" node is a regular node (not a real compound parent - see
 * cytoscape-theme.ts for why), so there is no nesting to walk here; this helper
 * exists mainly for call-site readability/API stability.
 */
/** @internal */
export function compoundAbsolutePosition(node: NodeSingular): Point {
  const position = node.position();
  return { x: position.x, y: position.y };
}

/** @internal */
export function graphNodeModelPosition(node: NodeSingular): Point {
  return node.position();
}

function styleNumber(node: NodeSingular, key: string): number {
  const value = Number(node.data(key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Measures a leaf's true rendered footprint relative to its own center, using
 * Cytoscape's own label metrics (`boundingBox({ includeLabels })`) plus the line-box of
 * the label. `text-valign: bottom` means the label hangs below the shape and can be
 * wider than it. Cytoscape's label box is glyph ink, so a line of text still occupies
 * its em-box and `text-outline` extends beyond the ink; both are added here so a child
 * cannot sit on the parent perimeter and then jump back when the line-box is painted.
 * `labelMaxWidth` is only a cap, matching CSS `max-width` wrapping.
 */
/** @internal */
export function measureLeafFootprint(node: NodeSingular): {
  halfW: number;
  halfHTop: number;
  halfHBottom: number;
} {
  const center = node.position();
  const shapeBox = node.boundingBox({ includeLabels: false, includeOverlays: false });
  const fullBox = node.boundingBox({ includeLabels: true, includeOverlays: false });
  const outline = styleNumber(node, "labelOutlineWidth");
  const fontSize = styleNumber(node, "labelFontSize");
  const marginY = styleNumber(node, "labelMarginY");
  const nodeHeight = styleNumber(node, "nodeHeight");
  const maxWidth = styleNumber(node, "labelMaxWidth");
  const halfHTop = Math.max(center.y - shapeBox.y1, nodeHeight > 0 ? nodeHeight / 2 : 0);
  const inkHalfW = Math.max(center.x - fullBox.x1, fullBox.x2 - center.x, halfHTop);
  const inkBottom = fullBox.y2 - center.y;
  const lineBoxBottom = halfHTop + marginY + fontSize + outline;
  let halfW = inkHalfW + outline;
  if (maxWidth > 0) {
    halfW = Math.min(halfW, maxWidth / 2 + outline);
  }
  return {
    halfW,
    halfHTop,
    halfHBottom: Math.max(inkBottom + outline, lineBoxBottom),
  };
}

/** Copy live Cytoscape label/shape metrics into the layout model's leaf footprints. */
/** @internal */
export function syncLeafFootprintsFromCy(
  cy: Core,
  model: WorkPackageLayoutModel,
  parentId: string,
  skipIds?: ReadonlySet<string>,
): void {
  for (const childId of model.childrenOf.get(parentId) ?? []) {
    if (skipIds?.has(childId)) {
      continue;
    }
    const layoutNode = model.nodes.get(childId);
    const cyNode = cy.getElementById(childId);
    if (!layoutNode || layoutNode.isCompound || cyNode.empty()) {
      continue;
    }
    layoutNode.footprint = measureLeafFootprint(cyNode);
  }
}

/**
 * Child fit box using the model's authoritative center and Cytoscape's live rendered
 * extents. Shifts the bounding box when the model center has diverged from the hidden
 * Cytoscape node (e.g. mid detached child-drag).
 */
/** @internal */
export function childFitBoxAbsoluteFromCy(
  cy: Core,
  model: WorkPackageLayoutModel,
  childId: string,
): VisualBox | null {
  const layoutNode = model.nodes.get(childId);
  if (!layoutNode) {
    return null;
  }
  if (layoutNode.isCompound && layoutNode.size) {
    return compositeOuterBox(model, childId);
  }
  const cyNode = cy.getElementById(childId);
  if (cyNode.empty()) {
    return null;
  }

  const boundingBox = cyNode.boundingBox({ includeLabels: true, includeOverlays: false });
  const modelCenter = absoluteCenter(model, childId);
  const cyCenter = cyNode.position();
  const dx = modelCenter.x - cyCenter.x;
  const dy = modelCenter.y - cyCenter.y;
  return {
    x1: boundingBox.x1 + dx,
    y1: boundingBox.y1 + dy,
    x2: boundingBox.x2 + dx,
    y2: boundingBox.y2 + dy,
  };
}

/** @internal */
export function childrenFitBoxAbsoluteFromCy(
  cy: Core,
  model: WorkPackageLayoutModel,
  compositeId: string,
): VisualBox | null {
  const childIds = model.childrenOf.get(compositeId) ?? [];
  if (childIds.length === 0) {
    return null;
  }

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const childId of childIds) {
    const box = childFitBoxAbsoluteFromCy(cy, model, childId);
    if (!box) {
      continue;
    }
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  }
  if (!Number.isFinite(x1)) {
    return null;
  }
  return { x1, y1, x2, y2 };
}

/** @internal */
export function compoundSizeForContent(contentBox: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} | null): { w: number; h: number } {
  if (!contentBox) {
    return { w: COMPOUND_MIN_WIDTH, h: COMPOUND_MIN_HEIGHT };
  }
  const contentWidth = contentBox.x2 - contentBox.x1;
  const contentHeight = contentBox.y2 - contentBox.y1;
  return {
    w: Math.max(
      COMPOUND_MIN_WIDTH,
      contentWidth + COMPOUND_PADDING.left + COMPOUND_PADDING.right,
    ),
    h: Math.max(
      COMPOUND_MIN_HEIGHT,
      contentHeight + COMPOUND_PADDING.top + COMPOUND_PADDING.bottom,
    ),
  };
}

/**
 * Extra room (beyond the tight content+padding fit) baked into the compound's *initial*
 * size so the child starts with some room to be dragged around at all, rather than
 * spawning already touching every edge. This constant is added once to both width and
 * height and then split evenly on every side (the container is always centered on the
 * child - see measureAndPinCompound below) - so it's the dominant term in how far the
 * child can travel before hitting the (now tight) edge clamp, independent of
 * COMPOUND_PADDING. Kept small since the edges themselves are already only as far away
 * as COMPOUND_PADDING plus the child's own measured footprint demand.
 */
/** @internal */
export const INITIAL_COMPOUND_SLACK = 24;

/**
 * Resizes a plain (non-compound) node while keeping its top-left corner fixed.
 * Cytoscape resizes a plain node's shape around its existing center, so to keep
 * the top-left anchored we shift the position by half the size delta ourselves.
 */
/** @internal */
export function applyFrozenCompoundSize(node: NodeSingular, w: number, h: number): void {
  const beforeW = Number(node.data("compoundWidth"));
  const beforeH = Number(node.data("compoundHeight"));
  const hasBefore = Number.isFinite(beforeW) && Number.isFinite(beforeH);

  node.data("compoundWidth", w);
  node.data("compoundHeight", h);

  if (!hasBefore) {
    return;
  }
  const dw = w - beforeW;
  const dh = h - beforeH;
  if (dw === 0 && dh === 0) {
    return;
  }

  const position = node.position();
  node.position({ x: position.x + dw / 2, y: position.y + dh / 2 });
}

/**
 * One-time initialization for the "measured" scenario: size the container to fit
 * around the child's current bounding box, centering the container on the child so
 * the child's own (already-correct) position never needs to move. Since the
 * container is a plain node with no real Cytoscape children, sizing it can never
 * have the side effect of dragging the child along - unlike Cytoscape's native
 * compound bounds-fitting, which always keeps a lone child's own bounding box
 * pinned to a bias-anchored corner of the parent (see cytoscape-theme.ts).
 */
/** @internal */
export function measureAndPinCompound(
  container: NodeSingular,
  child: NodeSingular,
  w: number,
  h: number,
): void {
  const childPosition = child.position();
  container.data("compoundWidth", w);
  container.data("compoundHeight", h);
  container.position({ x: childPosition.x, y: childPosition.y });
}

/** Point-in-time graph state for parent size/position and child absolutes. */
export interface GraphSnapshot {
  parent: {
    center: { x: number; y: number };
    relative: { x: number; y: number };
    w: number;
    h: number;
    box: { x1: number; y1: number; x2: number; y2: number };
  };
  children: Record<
    string,
    {
      absolute: { x: number; y: number };
      relative: { x: number; y: number };
    }
  >;
}

/** @internal */
export function snapshotGraphState(cy: Core, parentId: string, childIds: string[]): GraphSnapshot {
  const parent = cy.getElementById(parentId);
  const w = Number(parent.data("compoundWidth"));
  const h = Number(parent.data("compoundHeight"));
  const center = compoundAbsolutePosition(parent);
  return {
    parent: {
      center,
      relative: parent.position(),
      w,
      h,
      box: {
        x1: center.x - w / 2,
        y1: center.y - h / 2,
        x2: center.x + w / 2,
        y2: center.y + h / 2,
      },
    },
    children: Object.fromEntries(
      childIds.map((id) => {
        const node = cy.getElementById(id);
        return [
          id,
          {
            absolute: compoundAbsolutePosition(node),
            relative: node.position(),
          },
        ];
      }),
    ),
  };
}

/** @internal Absolute-position deltas between two {@link GraphSnapshot} values. */
export function snapshotDelta(
  before: GraphSnapshot,
  after: GraphSnapshot,
): Record<string, { dx: number; dy: number }> {
  const delta: Record<string, { dx: number; dy: number }> = {};
  for (const [id, childBefore] of Object.entries(before.children)) {
    const childAfter = after.children[id];
    if (!childAfter) {
      continue;
    }
    delta[id] = {
      dx: childAfter.absolute.x - childBefore.absolute.x,
      dy: childAfter.absolute.y - childBefore.absolute.y,
    };
  }
  return delta;
}
