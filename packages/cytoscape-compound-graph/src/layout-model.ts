import {
  CHILD_EDGE_CLEARANCE_PX,
  COMPOUND_MIN_HEIGHT,
  COMPOUND_MIN_WIDTH,
  COMPOUND_PADDING,
  NODE_OVERLAP_PADDING,
} from "./cytoscape-theme";
import {
  boxesOverlap,
  clampBoxEdgesToBounds,
  detectCollision,
  resolvePosition,
  type Point,
  type VisualBox,
} from "./collision";

interface NodePosition {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export const OVERFLOW_NODE_PREFIX = "__overflow__:";
export function isOverflowNodeId(id: string): boolean {
  return id.startsWith(OVERFLOW_NODE_PREFIX);
}

/**
 * Fallback label-inclusive leaf footprint half-extents in model units, used only when a
 * node has no measured `footprint` (see LeafFootprint below). Real leaf nodes get a
 * precise, asymmetric footprint measured from Cytoscape's own rendered label bounds
 * (see measureLeafFootprint in cytoscape-utils.ts), since a label hangs below the shape
 * and can be wider than it - a single symmetric half-height/width can't represent that.
 */
export const LEAF_VISUAL_HALF_W = 18;
export const LEAF_VISUAL_HALF_H = 26;

/** @deprecated Use {@link NODE_OVERLAP_PADDING} from cytoscape-theme or {@link WorkPackageLayoutModel.nodeOverlapPadding}. */
export { NODE_OVERLAP_PADDING };

/**
 * A leaf's true visual footprint relative to its own center: how far its rendered shape
 * and label actually extend on each side. Asymmetric because `text-valign: bottom` means
 * only the shape (not the label) extends above center, while below center the label may
 * reach further out than the shape, and the label can also be wider than the shape.
 */
export interface LeafFootprint {
  halfW: number;
  halfHTop: number;
  halfHBottom: number;
}

export interface LayoutNodeInput {
  id: string;
  parent?: string;
  isCompound?: boolean;
  isOverflow?: boolean;
  footprint?: LeafFootprint;
}

export interface LayoutNode {
  id: string;
  center: { x: number; y: number };
  size?: { w: number; h: number };
  isCompound: boolean;
  isOverflow: boolean;
  footprint?: LeafFootprint;
  /**
   * Model-unit equivalent of CHILD_EDGE_CLEARANCE_PX at the current zoom (see
   * GraphParentVertex.setEdgeClearance), applied to all four interior edges - including the
   * top, since the title now renders above the compound's perimeter (see
   * `.compound-parent-label` in App.css) and no longer needs its own interior clearance.
   * Recomputed every render tick because zoom can change at any time; falls back to
   * COMPOUND_PADDING.left (see compositeInteriorBox) until the first tick lands.
   */
  reservedEdge?: number;
}

function leafFootprint(node: LayoutNode | undefined): LeafFootprint {
  return (
    node?.footprint ?? {
      halfW: LEAF_VISUAL_HALF_W,
      halfHTop: LEAF_VISUAL_HALF_H,
      halfHBottom: LEAF_VISUAL_HALF_H,
    }
  );
}

export interface WorkPackageLayoutModel {
  nodes: Map<string, LayoutNode>;
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  rootIds: string[];
  /** Model-unit gap added around leaf footprints for sibling collision tests. */
  nodeOverlapPadding: number;
}

/** Options when building a {@link WorkPackageLayoutModel}. */
export interface LayoutModelBuildOptions {
  nodeOverlapPadding?: number;
}

/** Corner identifier for compound resize handles. */
export type ResizeCorner = "nw" | "ne" | "sw" | "se";

/** Which compound edges may shrink below the child-fit minimum during a resize gesture. */
export interface ResizeLooseEdges {
  west: boolean;
  east: boolean;
  north: boolean;
  south: boolean;
}

/** Frozen at pointer-down so a resize gesture does not re-snap edges mid-drag. */
export interface ResizeChildConstraints {
  /** Child footprint bounds in absolute model coordinates, or null if unknown. */
  childrenBox: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Model-unit edge clearance (see {@link GraphParentVertex.setEdgeClearance}). */
  edgeClearance: number;
  /** Which edges may shrink below the child-fit minimum during this gesture. */
  looseEdges: ResizeLooseEdges;
}

export const ALL_LOOSE_EDGES: ResizeLooseEdges = {
  west: true,
  east: true,
  north: true,
  south: true,
};

export function cloneLayoutModel(model: WorkPackageLayoutModel): WorkPackageLayoutModel {
  const nodes = new Map<string, LayoutNode>();
  for (const [id, node] of model.nodes) {
    nodes.set(id, {
      ...node,
      center: { ...node.center },
      size: node.size ? { ...node.size } : undefined,
      footprint: node.footprint ? { ...node.footprint } : undefined,
    });
  }
  return {
    nodes,
    parentOf: new Map(model.parentOf),
    childrenOf: new Map(model.childrenOf),
    rootIds: [...model.rootIds],
    nodeOverlapPadding: model.nodeOverlapPadding,
  };
}

function setNodeCenter(model: WorkPackageLayoutModel, id: string, center: { x: number; y: number }): void {
  const node = model.nodes.get(id);
  /* v8 ignore start -- defensive: callers only invoke this for existing nodes */
  if (!node) {
    return;
  }
  /* v8 ignore stop */
  node.center = { x: center.x, y: center.y };
}

export function buildLayoutModel(
  inputs: LayoutNodeInput[],
  flatLayout: Record<string, NodePosition> | undefined,
  options?: LayoutModelBuildOptions,
): WorkPackageLayoutModel {
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const compoundIds = new Set<string>();

  for (const input of inputs) {
    if (input.parent) {
      parentOf.set(input.id, input.parent);
      const siblings = childrenOf.get(input.parent) ?? [];
      siblings.push(input.id);
      childrenOf.set(input.parent, siblings);
    }
    if (input.isCompound) {
      compoundIds.add(input.id);
    }
  }

  for (const [parentId, childIds] of childrenOf) {
    if (childIds.length > 0) {
      compoundIds.add(parentId);
    }
  }

  const nodes = new Map<string, LayoutNode>();
  for (const input of inputs) {
    const saved = flatLayout?.[input.id];
    const isCompound =
      compoundIds.has(input.id) ||
      (saved?.w !== undefined && saved?.h !== undefined);
    const isOverflow = Boolean(input.isOverflow) || isOverflowNodeId(input.id);
    nodes.set(input.id, {
      id: input.id,
      center: {
        x: saved?.x ?? 0,
        y: saved?.y ?? 0,
      },
      size:
        isCompound && saved?.w !== undefined && saved?.h !== undefined
          ? { w: saved.w, h: saved.h }
          : undefined,
      isCompound,
      isOverflow,
      footprint: !isCompound ? input.footprint : undefined,
    });
  }

  const rootIds = inputs
    .filter((input) => !input.parent && nodes.has(input.id))
    .map((input) => input.id);

  return {
    nodes,
    parentOf,
    childrenOf,
    rootIds,
    nodeOverlapPadding: options?.nodeOverlapPadding ?? NODE_OVERLAP_PADDING,
  };
}

/**
 * Serialises the model to one `{x, y, w?, h?}` entry per node, `x`/`y` being the stored
 * parent-relative centre.
 *
 * Because the centres are relative, an entry is only meaningful alongside its ancestors'
 * entries. Most gestures still touch a single entry - {@link moveChild} and
 * {@link moveComposite} change one centre and nothing else - but {@link resizeComposite}
 * re-bases every descendant, so saving one entry from a resize is never enough. See
 * `CompoundGraphScene.flatLayoutForSubtree`.
 */
export function flatLayoutFromModel(model: WorkPackageLayoutModel): Record<string, NodePosition> {
  const layout: Record<string, NodePosition> = {};
  for (const [id, node] of model.nodes) {
    if (node.isOverflow) {
      continue;
    }
    const entry: NodePosition = { x: node.center.x, y: node.center.y };
    if (node.isCompound && node.size) {
      entry.w = node.size.w;
      entry.h = node.size.h;
    }
    layout[id] = entry;
  }
  return layout;
}

export function isAncestor(model: WorkPackageLayoutModel, ancestorId: string, nodeId: string): boolean {
  let current = model.parentOf.get(nodeId);
  while (current) {
    if (current === ancestorId) {
      return true;
    }
    current = model.parentOf.get(current);
  }
  return false;
}

export function canOverlap(
  model: WorkPackageLayoutModel,
  leftId: string,
  rightId: string,
): boolean {
  if (leftId === rightId) {
    return true;
  }
  return isAncestor(model, leftId, rightId) || isAncestor(model, rightId, leftId);
}

export function absoluteCenter(
  model: WorkPackageLayoutModel,
  nodeId: string,
): { x: number; y: number } {
  const node = model.nodes.get(nodeId);
  if (!node) {
    return { x: 0, y: 0 };
  }

  let x = node.center.x;
  let y = node.center.y;
  let parentId = model.parentOf.get(nodeId);
  while (parentId) {
    const parent = model.nodes.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.center.x;
    y += parent.center.y;
    parentId = model.parentOf.get(parentId);
  }
  return { x, y };
}

export function compositeOuterBox(model: WorkPackageLayoutModel, compositeId: string): VisualBox | null {
  const node = model.nodes.get(compositeId);
  if (!node?.isCompound || !node.size) {
    return null;
  }
  const center = absoluteCenter(model, compositeId);
  const halfW = node.size.w / 2;
  const halfH = node.size.h / 2;
  return {
    x1: center.x - halfW,
    y1: center.y - halfH,
    x2: center.x + halfW,
    y2: center.y + halfH,
  };
}

/** Negative clearance lets a child sit on the parent perimeter and then jump back. */
function nonNegativeClearance(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compositeEdgeClearance(model: WorkPackageLayoutModel, compositeId: string): number {
  const reserved = model.nodes.get(compositeId)?.reservedEdge;
  if (typeof reserved === "number" && Number.isFinite(reserved)) {
    return nonNegativeClearance(reserved);
  }
  return COMPOUND_PADDING.left;
}

/**
 * Edge clearance for a live gesture: prefer a non-negative reserved edge already on the
 * model (set from screen pixels via {@link GraphParentVertex.setEdgeClearance}), otherwise
 * convert {@link CHILD_EDGE_CLEARANCE_PX} at the current zoom. Negative theme values are
 * treated as 0 so a child cannot sit on — then jump back from — the parent perimeter.
 */
export function resolvedEdgeClearance(
  model: WorkPackageLayoutModel,
  compositeId: string,
  zoom: number,
): number {
  const reserved = model.nodes.get(compositeId)?.reservedEdge;
  if (typeof reserved === "number" && Number.isFinite(reserved)) {
    return nonNegativeClearance(reserved);
  }
  if (zoom > 0) {
    return nonNegativeClearance(CHILD_EDGE_CLEARANCE_PX) / zoom;
  }
  return COMPOUND_PADDING.left;
}

export function compositeInteriorBox(model: WorkPackageLayoutModel, compositeId: string): VisualBox | null {
  const outer = compositeOuterBox(model, compositeId);
  if (!outer) {
    return null;
  }
  const edgeClearance = compositeEdgeClearance(model, compositeId);
  return {
    x1: outer.x1 + edgeClearance,
    y1: outer.y1 + edgeClearance,
    x2: outer.x2 - edgeClearance,
    y2: outer.y2 - edgeClearance,
  };
}

export function visualBox(model: WorkPackageLayoutModel, nodeId: string): VisualBox | null {
  const node = model.nodes.get(nodeId);
  if (!node) {
    return null;
  }

  if (node.isCompound && node.size) {
    return compositeOuterBox(model, nodeId);
  }

  const center = absoluteCenter(model, nodeId);
  const pad = model.nodeOverlapPadding;
  const footprint = leafFootprint(node);
  return {
    x1: center.x - footprint.halfW - pad,
    y1: center.y - footprint.halfHTop - pad,
    x2: center.x + footprint.halfW + pad,
    y2: center.y + footprint.halfHBottom + pad,
  };
}

/**
 * The obstacle list for a given moving node: every other node's current box, except
 * ones it's allowed to overlap (its own ancestors/descendants - e.g. a child is always
 * allowed inside its own parent). Shared by every clamp below so "what counts as an
 * obstacle" is defined in exactly one place, and automatically grows to include more
 * objects (e.g. a second child of the same parent) without any call site changing.
 */
function obstacleBoxesFor(model: WorkPackageLayoutModel, subjectId: string): VisualBox[] {
  const boxes: VisualBox[] = [];
  for (const [otherId] of model.nodes) {
    if (otherId === subjectId || canOverlap(model, subjectId, otherId)) {
      continue;
    }
    const box = visualBox(model, otherId);
    if (box) {
      boxes.push(box);
    }
  }
  return boxes;
}

function descendantIds(model: WorkPackageLayoutModel, rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of model.childrenOf.get(id) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        stack.push(childId);
      }
    }
  }
  return result;
}

/**
 * Box used for parent containment (child drag + resize min bounds), matching
 * moveChild's footprint math - no NODE_OVERLAP_PADDING.
 */
function childFitBoxAbsolute(model: WorkPackageLayoutModel, childId: string): VisualBox | null {
  const node = model.nodes.get(childId);
  if (!node) {
    return null;
  }

  if (node.isCompound && node.size) {
    return compositeOuterBox(model, childId);
  }

  const center = absoluteCenter(model, childId);
  const footprint = leafFootprint(node);
  return {
    x1: center.x - footprint.halfW,
    y1: center.y - footprint.halfHTop,
    x2: center.x + footprint.halfW,
    y2: center.y + footprint.halfHBottom,
  };
}

export function childrenFitBoxAbsolute(model: WorkPackageLayoutModel, compositeId: string): VisualBox | null {
  const childIds = model.childrenOf.get(compositeId) ?? [];
  if (childIds.length === 0) {
    return null;
  }

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const childId of childIds) {
    const box = childFitBoxAbsolute(model, childId);
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

/**
 * Tightest parent outer box allowed by the child-containment resize clamp: direct
 * children's fit boxes expanded by compositeEdgeClearance, floored at COMPOUND_MIN_*.
 */
export function minimumCompositeOuterBox(
  model: WorkPackageLayoutModel,
  compositeId: string,
): VisualBox | null {
  const childrenBox = childrenFitBoxAbsolute(model, compositeId);
  const edgeClearance = compositeEdgeClearance(model, compositeId);

  if (!childrenBox) {
    const outer = compositeOuterBox(model, compositeId);
    if (!outer) {
      return null;
    }
    const centerX = (outer.x1 + outer.x2) / 2;
    const centerY = (outer.y1 + outer.y2) / 2;
    return {
      x1: centerX - COMPOUND_MIN_WIDTH / 2,
      y1: centerY - COMPOUND_MIN_HEIGHT / 2,
      x2: centerX + COMPOUND_MIN_WIDTH / 2,
      y2: centerY + COMPOUND_MIN_HEIGHT / 2,
    };
  }

  const bounds = parentOuterBoundsFromChildFit(childrenBox, edgeClearance);
  let { x1, y1, x2, y2 } = bounds;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < COMPOUND_MIN_WIDTH) {
    const pad = (COMPOUND_MIN_WIDTH - width) / 2;
    x1 -= pad;
    x2 += pad;
  }
  if (height < COMPOUND_MIN_HEIGHT) {
    const pad = (COMPOUND_MIN_HEIGHT - height) / 2;
    y1 -= pad;
    y2 += pad;
  }

  return { x1, y1, x2, y2 };
}

/** Parent outer bounds that still contain `childrenBox` with `edgeClearance` on every side. */
export function parentOuterBoundsFromChildFit(
  childrenBox: VisualBox,
  edgeClearance: number,
): VisualBox {
  const clearance = nonNegativeClearance(edgeClearance);
  return {
    x1: childrenBox.x1 - clearance,
    y1: childrenBox.y1 - clearance,
    x2: childrenBox.x2 + clearance,
    y2: childrenBox.y2 + clearance,
  };
}

export function resizeLooseEdgesFromOuter(
  outer: VisualBox,
  childrenBox: VisualBox,
  edgeClearance: number,
): ResizeLooseEdges {
  const bounds = parentOuterBoundsFromChildFit(childrenBox, edgeClearance);
  const epsilon = 1e-6;
  return {
    west: outer.x1 < bounds.x1 - epsilon,
    east: outer.x2 > bounds.x2 + epsilon,
    north: outer.y1 < bounds.y1 - epsilon,
    south: outer.y2 > bounds.y2 + epsilon,
  };
}

export function resizeCompoundBoxFromCorner(
  startBox: VisualBox,
  corner: ResizeCorner,
  dxModel: number,
  dyModel: number,
  constraints: ResizeChildConstraints,
): VisualBox {
  if (Math.abs(dxModel) < 1e-9 && Math.abs(dyModel) < 1e-9) {
    return { ...startBox };
  }

  let { x1, y1, x2, y2 } = startBox;
  const { childrenBox } = constraints;
  const edgeClearance = nonNegativeClearance(constraints.edgeClearance);

  const movesEast = corner === "ne" || corner === "se";
  const movesWest = corner === "nw" || corner === "sw";
  const movesNorth = corner === "nw" || corner === "ne";
  const movesSouth = corner === "sw" || corner === "se";

  const minLeft = childrenBox ? childrenBox.x1 - edgeClearance : null;
  const maxRight = childrenBox ? childrenBox.x2 + edgeClearance : null;
  const minTop = childrenBox ? childrenBox.y1 - edgeClearance : null;
  const maxBottom = childrenBox ? childrenBox.y2 + edgeClearance : null;

  if (movesEast) {
    x2 = startBox.x2 + dxModel;
    x2 = Math.max(x2, maxRight ?? x1 + COMPOUND_MIN_WIDTH);
  }

  if (movesWest) {
    x1 = startBox.x1 + dxModel;
    x1 = Math.min(x1, minLeft ?? x2 - COMPOUND_MIN_WIDTH);
  }

  if (movesSouth) {
    y2 = startBox.y2 + dyModel;
    y2 = Math.max(y2, maxBottom ?? y1 + COMPOUND_MIN_HEIGHT);
  }

  if (movesNorth) {
    y1 = startBox.y1 + dyModel;
    y1 = Math.min(y1, minTop ?? y2 - COMPOUND_MIN_HEIGHT);
  }

  if (!childrenBox) {
    /* v8 ignore start -- corner clamps above already enforce compound minimum size */
    if (x2 - x1 < COMPOUND_MIN_WIDTH) {
      x2 = x1 + COMPOUND_MIN_WIDTH;
    }
    if (y2 - y1 < COMPOUND_MIN_HEIGHT) {
      y2 = y1 + COMPOUND_MIN_HEIGHT;
    }
    /* v8 ignore stop */
  }

  return { x1, y1, x2, y2 };
}

/**
 * Binary-searches the box interpolation from `startBox` to `proposedBox` for the point
 * closest to `proposedBox` that doesn't collide with `obstacles`. Box-resize grows/shrinks
 * independent edges rather than translating a fixed-size shape, so it can't reuse
 * `resolvePosition`'s center-based interpolation directly - but it shares the same
 * `detectCollision` predicate and obstacle list as the center-based clamps below.
 */
function resolveResizeBoxAgainstObstacles(
  startBox: VisualBox,
  proposedBox: VisualBox,
  obstacles: VisualBox[],
): VisualBox {
  if (obstacles.length === 0 || !detectCollision(proposedBox, obstacles)) {
    return proposedBox;
  }

  let low = 0;
  let high = 1;
  let best = { ...startBox };

  for (let iteration = 0; iteration < 40; iteration++) {
    const mid = (low + high) / 2;
    const candidate = {
      x1: startBox.x1 + (proposedBox.x1 - startBox.x1) * mid,
      y1: startBox.y1 + (proposedBox.y1 - startBox.y1) * mid,
      x2: startBox.x2 + (proposedBox.x2 - startBox.x2) * mid,
      y2: startBox.y2 + (proposedBox.y2 - startBox.y2) * mid,
    };

    if (detectCollision(candidate, obstacles)) {
      high = mid;
    } else {
      best = candidate;
      low = mid;
    }
  }

  return best;
}

/**
 * Rewrites a compound's outer box (absolute graph coordinates) while holding every
 * descendant's absolute center constant.
 *
 * This is the single place that encodes the rule "changing a container's extent must not
 * move anything else": descendant centers are stored relative to their own parent, so any
 * change to a compound's center silently drags its whole subtree along unless the offsets
 * are rewritten afterwards. Descendants are re-parented shallowest-first so each one sees
 * an already-corrected parent center. The compound's own center is likewise stored
 * relative to *its* parent, hence the `parentAbsolute` subtraction.
 */
function applyCompositeOuterBox(
  model: WorkPackageLayoutModel,
  compositeId: string,
  outer: VisualBox,
): void {
  const descendants = [...descendantIds(model, compositeId)]
    .filter((id) => id !== compositeId)
    .sort((leftId, rightId) => modelDepth(model, leftId) - modelDepth(model, rightId));
  const savedAbsolute = new Map<string, { x: number; y: number }>();
  for (const descendantId of descendants) {
    savedAbsolute.set(descendantId, absoluteCenter(model, descendantId));
  }

  const parentId = model.parentOf.get(compositeId);
  const parentAbsolute = parentId ? absoluteCenter(model, parentId) : { x: 0, y: 0 };

  const node = model.nodes.get(compositeId)!;
  node.size = { w: outer.x2 - outer.x1, h: outer.y2 - outer.y1 };
  setNodeCenter(model, compositeId, {
    x: (outer.x1 + outer.x2) / 2 - parentAbsolute.x,
    y: (outer.y1 + outer.y2) / 2 - parentAbsolute.y,
  });

  for (const descendantId of descendants) {
    const saved = savedAbsolute.get(descendantId)!;
    const ownParentAbsolute = absoluteCenter(model, model.parentOf.get(descendantId)!);
    setNodeCenter(model, descendantId, {
      x: saved.x - ownParentAbsolute.x,
      y: saved.y - ownParentAbsolute.y,
    });
  }
}

/**
 * Grows `compositeId`'s outer box just far enough to contain all of its direct children
 * with edge clearance, never shrinking it, holding every descendant's absolute center
 * constant. Returns true when the box actually changed.
 *
 * Used by load-time unjam (see layout-unjam.ts) to make room for nodes it has separated;
 * live resize goes through {@link resizeComposite} instead.
 */
/** @internal */
export function growCompositeToFitChildren(
  model: WorkPackageLayoutModel,
  compositeId: string,
): boolean {
  const node = model.nodes.get(compositeId);
  const currentOuter = compositeOuterBox(model, compositeId);
  const minimumOuter = minimumCompositeOuterBox(model, compositeId);
  if (!node?.isCompound || !node.size || !currentOuter || !minimumOuter) {
    return false;
  }

  const merged: VisualBox = {
    x1: Math.min(currentOuter.x1, minimumOuter.x1),
    y1: Math.min(currentOuter.y1, minimumOuter.y1),
    x2: Math.max(currentOuter.x2, minimumOuter.x2),
    y2: Math.max(currentOuter.y2, minimumOuter.y2),
  };
  if (boxesEqual(currentOuter, merged)) {
    return false;
  }

  applyCompositeOuterBox(model, compositeId, merged);
  return true;
}

function boxesEqual(left: VisualBox, right: VisualBox): boolean {
  const epsilon = 1e-6;
  return (
    Math.abs(left.x1 - right.x1) <= epsilon &&
    Math.abs(left.y1 - right.y1) <= epsilon &&
    Math.abs(left.x2 - right.x2) <= epsilon &&
    Math.abs(left.y2 - right.y2) <= epsilon
  );
}

export interface ViewportClampOptions {
  /** Graph-space bounds the compound outer box must stay inside (e.g. visible viewport). */
  viewportBounds?: VisualBox | null;
}

export type MoveCompositeOptions = ViewportClampOptions;

export type ResizeCompositeOptions = ViewportClampOptions;

export function moveComposite(
  model: WorkPackageLayoutModel,
  compositeId: string,
  newCenter: { x: number; y: number },
  options?: MoveCompositeOptions,
): WorkPackageLayoutModel {
  const next = cloneLayoutModel(model);
  const node = next.nodes.get(compositeId);
  if (!node?.isCompound || !node.size) {
    return next;
  }

  const size = node.size;
  const parentId = next.parentOf.get(compositeId);
  const parentAbsolute = parentId ? absoluteCenter(next, parentId) : { x: 0, y: 0 };
  const boxForCenter = (center: Point): VisualBox => {
    const absCenter = { x: parentAbsolute.x + center.x, y: parentAbsolute.y + center.y };
    return {
      x1: absCenter.x - size.w / 2,
      y1: absCenter.y - size.h / 2,
      x2: absCenter.x + size.w / 2,
      y2: absCenter.y + size.h / 2,
    };
  };

  const startCenter = { ...node.center };
  const resolved = resolvePosition({
    from: startCenter,
    to: newCenter,
    bounds: options?.viewportBounds ?? null,
    obstacles: obstacleBoxesFor(next, compositeId),
    boxForCenter,
  });
  setNodeCenter(next, compositeId, resolved);
  return next;
}

export function moveChild(
  model: WorkPackageLayoutModel,
  childId: string,
  newRelativeCenter: { x: number; y: number },
): WorkPackageLayoutModel {
  const next = cloneLayoutModel(model);
  const node = next.nodes.get(childId);
  const parentId = next.parentOf.get(childId);
  if (!node || !parentId) {
    return next;
  }

  const footprint = leafFootprint(node);
  const boxForCenter = (center: Point): VisualBox => ({
    x1: center.x - footprint.halfW,
    y1: center.y - footprint.halfHTop,
    x2: center.x + footprint.halfW,
    y2: center.y + footprint.halfHBottom,
  });

  const parentAbsolute = absoluteCenter(next, parentId);
  const startAbsolute = absoluteCenter(next, childId);
  const proposedAbsolute = {
    x: parentAbsolute.x + newRelativeCenter.x,
    y: parentAbsolute.y + newRelativeCenter.y,
  };

  const resolvedAbsolute = resolvePosition({
    from: startAbsolute,
    to: proposedAbsolute,
    bounds: compositeInteriorBox(next, parentId),
    obstacles: obstacleBoxesFor(next, childId),
    boxForCenter,
  });

  setNodeCenter(next, childId, {
    x: resolvedAbsolute.x - parentAbsolute.x,
    y: resolvedAbsolute.y - parentAbsolute.y,
  });
  return next;
}

/**
 * Drags one corner of `compositeId`'s box by (`dxModel`, `dyModel`), holding every other
 * node - including its own children - exactly where it is.
 *
 * Unlike every other gesture, this rewrites more stored centres than the one node the user
 * grabbed. Moving a corner necessarily moves the box centre by half the drag, and
 * descendant centres are stored relative to their parent, so {@link applyCompositeOuterBox}
 * has to subtract that shift back out of each descendant to leave them on screen where
 * they were. A caller persisting the result per node must therefore save the resized
 * container *and its whole subtree* (see `CompoundGraphScene.flatLayoutForSubtree`);
 * saving the container's entry alone re-hydrates to children displaced by half the drag.
 */
export function resizeComposite(
  model: WorkPackageLayoutModel,
  compositeId: string,
  corner: ResizeCorner,
  dxModel: number,
  dyModel: number,
  constraints?: ResizeChildConstraints,
  options?: ResizeCompositeOptions,
): WorkPackageLayoutModel {
  const next = cloneLayoutModel(model);
  const node = next.nodes.get(compositeId);
  const startOuter = compositeOuterBox(next, compositeId);
  if (!node?.isCompound || !node.size || !startOuter) {
    return next;
  }

  const resolvedConstraints =
    constraints ??
    ({
      childrenBox: childrenFitBoxAbsolute(next, compositeId),
      edgeClearance: compositeEdgeClearance(next, compositeId),
      looseEdges: ALL_LOOSE_EDGES,
    } satisfies ResizeChildConstraints);
  if (resolvedConstraints.edgeClearance !== undefined) {
    node.reservedEdge = nonNegativeClearance(resolvedConstraints.edgeClearance);
  }
  const proposedOuter = resizeCompoundBoxFromCorner(
    startOuter,
    corner,
    dxModel,
    dyModel,
    resolvedConstraints,
  );
  let clampedOuter = resolveResizeBoxAgainstObstacles(
    startOuter,
    proposedOuter,
    obstacleBoxesFor(next, compositeId),
  );

  const viewportBounds = options?.viewportBounds;
  if (viewportBounds) {
    const viewportClamped = clampBoxEdgesToBounds(clampedOuter, viewportBounds);
    const width = viewportClamped.x2 - viewportClamped.x1;
    const height = viewportClamped.y2 - viewportClamped.y1;
    if (width > 0 && height > 0) {
      clampedOuter = viewportClamped;
    }
  }

  applyCompositeOuterBox(next, compositeId, clampedOuter);
  return next;
}

function modelDepth(model: WorkPackageLayoutModel, nodeId: string): number {
  let depth = 0;
  let parentId = model.parentOf.get(nodeId);
  while (parentId) {
    depth += 1;
    parentId = model.parentOf.get(parentId);
  }
  return depth;
}

export function subtreeNodeIds(model: WorkPackageLayoutModel, rootId: string): string[] {
  return [...descendantIds(model, rootId)];
}

export function nodesOverlapInModel(
  model: WorkPackageLayoutModel,
  leftId: string,
  rightId: string,
): boolean {
  const left = visualBox(model, leftId);
  const right = visualBox(model, rightId);
  if (!left || !right) {
    return false;
  }
  return boxesOverlap(left, right);
}
