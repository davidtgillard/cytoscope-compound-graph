/**
 * Load-time layout unjam for compound work-package graphs.
 *
 * Live drag uses `resolvePosition`, which assumes the gesture starts from a
 * collision-free rest pose (`from`). After clone or missing layout cache, many
 * nodes stack at the same coordinates; drag then clamps back to the overlap and
 * feels frozen. This module runs once when a work-graph loads (not during drag)
 * to separate jammed nodes while respecting cached positions for nodes that can
 * already move.
 */
import {
  boxesOverlap,
  containmentShift,
  resolvePosition,
  type Point,
  type VisualBox,
} from "./collision";
import {
  absoluteCenter,
  canOverlap,
  childFitBoxAbsolute,
  cloneLayoutModel,
  compositeInteriorBox,
  growCompositeToFitChildren,
  moveChild,
  moveComposite,
  visualBox,
  type LayoutNode,
  type WorkPackageLayoutModel,
} from "./layout-model";
import { COMPOUND_MIN_HEIGHT, COMPOUND_MIN_WIDTH } from "./cytoscape-theme";

const EPSILON = 1e-6;
const DEFAULT_PROBE_TAU = 1;
const DEFAULT_PROBE_COUNT = 16;
const DEFAULT_MAX_RINGS = 12;
const DEFAULT_RING_STEP = 50;
const MAX_GROW_ATTEMPTS = 4;

/** @internal */
export interface UnjamLayoutOptions {
  /** When true, lay out every node (empty layout cache). Otherwise only fully impeded nodes move. */
  bootstrap?: boolean;
  probeTau?: number;
  probeCount?: number;
  ringStep?: number;
  maxRings?: number;
}

/** @internal */
export interface UnjamLayoutResult {
  model: WorkPackageLayoutModel;
  changed: boolean;
}

interface SiblingGroup {
  parentId: string | null;
  childIds: string[];
  depth: number;
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

function setNodeCenter(
  model: WorkPackageLayoutModel,
  nodeId: string,
  center: Point,
): void {
  const node = model.nodes.get(nodeId);
  /* v8 ignore start -- defensive: callers only invoke this for existing nodes */
  if (!node) {
    return;
  }
  /* v8 ignore stop */
  node.center = { x: center.x, y: center.y };
}

function leafFootprint(node: LayoutNode): {
  halfW: number;
  halfHTop: number;
  halfHBottom: number;
} {
  return (
    node.footprint ?? {
      halfW: 18,
      halfHTop: 26,
      halfHBottom: 26,
    }
  );
}

function centersEqual(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function boxInsideBounds(box: VisualBox, bounds: VisualBox): boolean {
  const { dx, dy } = containmentShift(box, bounds);
  return Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON;
}

/** Same obstacle list as live drag — see obstacleBoxesFor in layout-model.ts. */
function obstacleBoxesFor(
  model: WorkPackageLayoutModel,
  subjectId: string,
): VisualBox[] {
  const boxes: VisualBox[] = [];
  for (const [otherId] of model.nodes) {
    if (otherId === subjectId || canOverlap(model, subjectId, otherId)) {
      continue;
    }
    const box = visualBox(model, otherId);
    /* v8 ignore start -- visualBox is null only when the node is missing */
    if (!box) {
      continue;
    }
    /* v8 ignore stop */
    boxes.push(box);
  }
  return boxes;
}

/** True when `nodeId`'s visual box clears every node it is not allowed to overlap. */
function clearsObstacles(model: WorkPackageLayoutModel, nodeId: string): boolean {
  const box = visualBox(model, nodeId);
  /* v8 ignore start -- visualBox is null only when the node is missing */
  if (!box) {
    return false;
  }
  /* v8 ignore stop */
  return !obstacleBoxesFor(model, nodeId).some((obstacle) => boxesOverlap(box, obstacle));
}

/**
 * Valid rest for load-time unjam: padded visual box clears non-ancestor obstacles and
 * the fit box lies inside the parent interior. Live drag uses the slightly looser
 * {@link isLegalNodeRest} commit gate (bare footprint vs padded obstacles).
 */
export function isValidRest(model: WorkPackageLayoutModel, nodeId: string): boolean {
  const node = model.nodes.get(nodeId);
  if (!node || node.isOverflow) {
    return true;
  }

  if (!clearsObstacles(model, nodeId)) {
    return false;
  }

  const parentId = model.parentOf.get(nodeId);
  if (!parentId) {
    return true;
  }

  const interior = compositeInteriorBox(model, parentId);
  const fitBox = childFitBoxAbsolute(model, nodeId);
  if (!interior || !fitBox) {
    return false;
  }
  return boxInsideBounds(fitBox, interior);
}

function moveRootNode(
  model: WorkPackageLayoutModel,
  nodeId: string,
  newCenter: Point,
): WorkPackageLayoutModel {
  const next = cloneLayoutModel(model);
  const node = next.nodes.get(nodeId);
  /* v8 ignore start -- parented nodes use moveChild instead */
  if (!node || next.parentOf.has(nodeId)) {
    return next;
  }
  /* v8 ignore stop */

  const footprint = leafFootprint(node);
  const boxForCenter = (center: Point): VisualBox => ({
    x1: center.x - footprint.halfW,
    y1: center.y - footprint.halfHTop,
    x2: center.x + footprint.halfW,
    y2: center.y + footprint.halfHBottom,
  });

  const startCenter = absoluteCenter(next, nodeId);
  const resolved = resolvePosition({
    from: startCenter,
    to: newCenter,
    bounds: null,
    obstacles: obstacleBoxesFor(next, nodeId),
    boxForCenter,
  });
  setNodeCenter(next, nodeId, resolved);
  return next;
}

/** Probe move using the same resolution path as live drag (no viewport clamp). */
function resolvedCenterAfterProbe(
  model: WorkPackageLayoutModel,
  nodeId: string,
  targetRelative: Point,
): Point {
  const node = model.nodes.get(nodeId);
  /* v8 ignore start -- defensive: only called for existing node ids */
  if (!node) {
    return targetRelative;
  }
  /* v8 ignore stop */

  if (node.isCompound && node.size) {
    return moveComposite(model, nodeId, targetRelative).nodes.get(nodeId)!.center;
  }

  const parentId = model.parentOf.get(nodeId);
  if (parentId) {
    return moveChild(model, nodeId, targetRelative).nodes.get(nodeId)!.center;
  }

  return moveRootNode(model, nodeId, targetRelative).nodes.get(nodeId)!.center;
}

/**
 * Locally free: valid rest plus at least one nearby probe step that actually moves
 * the node (drag would not clamp immediately back to the overlap).
 */
export function isLocallyFree(
  model: WorkPackageLayoutModel,
  nodeId: string,
  options?: Pick<UnjamLayoutOptions, "probeTau" | "probeCount">,
): boolean {
  if (!isValidRest(model, nodeId)) {
    return false;
  }

  const node = model.nodes.get(nodeId);
  if (!node || node.isOverflow) {
    return true;
  }

  const tau = options?.probeTau ?? DEFAULT_PROBE_TAU;
  const probeCount = options?.probeCount ?? DEFAULT_PROBE_COUNT;
  const startCenter = { ...node.center };
  const minMove = tau / 2;

  for (let index = 0; index < probeCount; index++) {
    const angle = (index / probeCount) * Math.PI * 2;
    const target = {
      x: startCenter.x + Math.cos(angle) * tau,
      y: startCenter.y + Math.sin(angle) * tau,
    };
    const resolved = resolvedCenterAfterProbe(model, nodeId, target);
    if (Math.hypot(resolved.x - startCenter.x, resolved.y - startCenter.y) >= minMove) {
      return true;
    }
  }

  return false;
}

/** Fully impeded when rest is invalid or no nearby drag step succeeds. */
export function isFullyImpeded(
  model: WorkPackageLayoutModel,
  nodeId: string,
  options?: Pick<UnjamLayoutOptions, "probeTau" | "probeCount">,
): boolean {
  const node = model.nodes.get(nodeId);
  if (!node || node.isOverflow) {
    return false;
  }
  return !isValidRest(model, nodeId) || !isLocallyFree(model, nodeId, options);
}

function defaultRingStep(model: WorkPackageLayoutModel, nodeId: string): number {
  const box = visualBox(model, nodeId);
  /* v8 ignore start -- defaultRingStep is only used for existing nodes */
  if (!box) {
    return DEFAULT_RING_STEP;
  }
  /* v8 ignore stop */
  // `visualBox` already includes nodeOverlapPadding on every side, so `span` is the
  // axis-aligned distance that separates two identical stacked footprints.
  const span = Math.max(box.x2 - box.x1, box.y2 - box.y1);
  return span + EPSILON;
}

function unjamGrowSlack(options: UnjamLayoutOptions): number {
  return options.probeTau ?? DEFAULT_PROBE_TAU;
}

function growParentForUnjam(
  model: WorkPackageLayoutModel,
  parentId: string,
  options: UnjamLayoutOptions,
): boolean {
  return growCompositeToFitChildren(model, parentId, { slack: unjamGrowSlack(options) });
}

function compositeBelowMinimum(model: WorkPackageLayoutModel, compositeId: string): boolean {
  const size = model.nodes.get(compositeId)?.size;
  /* v8 ignore start -- unsized parents fail child validity instead of this check */
  if (!size) {
    return false;
  }
  /* v8 ignore stop */
  return size.w + EPSILON < COMPOUND_MIN_WIDTH || size.h + EPSILON < COMPOUND_MIN_HEIGHT;
}

function collectSiblingGroups(model: WorkPackageLayoutModel): SiblingGroup[] {
  const groups: SiblingGroup[] = [];

  const rootIds = model.rootIds.filter((id) => !model.nodes.get(id)?.isOverflow);
  if (rootIds.length > 0) {
    groups.push({ parentId: null, childIds: rootIds, depth: 0 });
  }

  for (const [parentId, childIds] of model.childrenOf) {
    const visibleChildren = childIds.filter((id) => !model.nodes.get(id)?.isOverflow);
    if (visibleChildren.length === 0) {
      continue;
    }
    groups.push({
      parentId,
      childIds: visibleChildren,
      depth: modelDepth(model, parentId) + 1,
    });
  }

  groups.sort((left, right) => right.depth - left.depth);
  return groups;
}

/**
 * Moves `nodeId` so that its absolute centre lands on `absolute`.
 *
 * Placement works entirely in absolute coordinates even though the model stores
 * parent-relative centres, because growing a container shifts its centre and therefore
 * re-bases every relative offset underneath it (see growCompositeToFitChildren). A search
 * anchored in relative coordinates would silently slide its own candidates sideways the
 * moment it grew the container it was searching inside.
 */
function parkAt(model: WorkPackageLayoutModel, nodeId: string, absolute: Point): void {
  const parentId = model.parentOf.get(nodeId);
  const parentAbsolute = parentId ? absoluteCenter(model, parentId) : { x: 0, y: 0 };
  setNodeCenter(model, nodeId, {
    x: absolute.x - parentAbsolute.x,
    y: absolute.y - parentAbsolute.y,
  });
}

/**
 * Sweeps candidate absolute positions on rings around `startAbsolute`, leaving `nodeId`
 * parked on whichever candidate it visited last.
 *
 * `placed` is the nearest valid rest (inside the parent, obstacle-free). Local freedom is
 * not required here: a flush fit is still a rest, and the caller grows a 1px slack rather
 * than walking further rings.
 *
 * `roomNeeded` is the first candidate that cleared every obstacle but did not fit inside
 * the container's interior - the deliberate place to grow the container towards when no
 * ring yields a valid rest, rather than growing towards wherever probing happened to end.
 */
function sweepRings(
  model: WorkPackageLayoutModel,
  nodeId: string,
  startAbsolute: Point,
  options: UnjamLayoutOptions,
): { placed: Point | null; roomNeeded: Point | null } {
  const ringStep = options.ringStep ?? defaultRingStep(model, nodeId);
  const maxRings = options.maxRings ?? DEFAULT_MAX_RINGS;
  let roomNeeded: Point | null = null;

  for (let ring = 0; ring <= maxRings; ring++) {
    const samples = ring === 0 ? 1 : Math.max(8, ring * 6);
    for (let index = 0; index < samples; index++) {
      const angle = ring === 0 ? 0 : (index / samples) * Math.PI * 2;
      const candidate = {
        x: startAbsolute.x + Math.cos(angle) * ringStep * ring,
        y: startAbsolute.y + Math.sin(angle) * ringStep * ring,
      };
      parkAt(model, nodeId, candidate);
      if (isValidRest(model, nodeId)) {
        return { placed: candidate, roomNeeded: null };
      }
      if (!roomNeeded && clearsObstacles(model, nodeId)) {
        roomNeeded = candidate;
      }
    }
  }

  return { placed: null, roomNeeded };
}

function keepPlacedRest(
  model: WorkPackageLayoutModel,
  nodeId: string,
  placed: Point,
  parentId: string | undefined,
  options: UnjamLayoutOptions,
  grew: boolean,
): { placed: Point; grew: boolean } {
  parkAt(model, nodeId, placed);
  if (parentId && !isLocallyFree(model, nodeId, options) && growParentForUnjam(model, parentId, options)) {
    return { placed, grew: true };
  }
  return { placed, grew };
}

function tryRingSearchPlacement(
  model: WorkPackageLayoutModel,
  nodeId: string,
  startAbsolute: Point,
  options: UnjamLayoutOptions,
): { placed: Point | null; grew: boolean } {
  const parentId = model.parentOf.get(nodeId);
  let grew = false;
  let lastRoomNeeded: Point | null = null;

  for (let growAttempt = 0; growAttempt < MAX_GROW_ATTEMPTS; growAttempt++) {
    const sweep = sweepRings(model, nodeId, startAbsolute, options);
    if (sweep.placed) {
      return keepPlacedRest(model, nodeId, sweep.placed, parentId, options, grew);
    }
    if (!parentId || !sweep.roomNeeded) {
      break;
    }
    lastRoomNeeded = sweep.roomNeeded;
    parkAt(model, nodeId, sweep.roomNeeded);
    if (!growParentForUnjam(model, parentId, options)) {
      break;
    }
    grew = true;
  }

  // An obstacle-free candidate away from the start is a better park than the diagonal
  // fallback, even if further grow attempts did not admit a ring rest. The start itself
  // is not a placement: it is the jammed pose, and the caller still needs the last-resort
  // offset (e.g. a parent with no size, so grow cannot create an interior).
  if (lastRoomNeeded && !centersEqual(lastRoomNeeded, startAbsolute)) {
    parkAt(model, nodeId, lastRoomNeeded);
    if (parentId && growParentForUnjam(model, parentId, options)) {
      grew = true;
    }
    return { placed: lastRoomNeeded, grew };
  }

  // Probing must not leave the node parked on a rejected candidate; the caller's fallback
  // placement is measured from `startAbsolute`.
  parkAt(model, nodeId, startAbsolute);
  return { placed: null, grew };
}

function tryPlaceNode(
  model: WorkPackageLayoutModel,
  nodeId: string,
  sortedIndex: number,
  options: UnjamLayoutOptions,
): boolean {
  const node = model.nodes.get(nodeId);
  /* v8 ignore start -- overflow nodes are filtered out before placement */
  if (!node || node.isOverflow) {
    return false;
  }
  /* v8 ignore stop */

  if (!options.bootstrap && !isFullyImpeded(model, nodeId, options)) {
    return false;
  }

  const startAbsolute = absoluteCenter(model, nodeId);
  const { placed, grew } = tryRingSearchPlacement(model, nodeId, startAbsolute, options);
  if (placed) {
    return grew || !centersEqual(startAbsolute, placed);
  }

  // Last resort: deterministic offset so deeply nested stacks still separate. Only used
  // when no obstacle-free candidate existed at all.
  const ringStep = options.ringStep ?? defaultRingStep(model, nodeId);
  const fallback = {
    x: startAbsolute.x + ringStep * (sortedIndex + 1),
    y: startAbsolute.y + ringStep * 0.5 * (sortedIndex + 1),
  };
  parkAt(model, nodeId, fallback);
  const parentId = model.parentOf.get(nodeId);
  const grewForFallback = parentId ? growParentForUnjam(model, parentId, options) : false;
  return grew || grewForFallback || !centersEqual(startAbsolute, fallback);
}

/**
 * Separates jammed nodes on load. Deepest sibling groups first; free cached
 * positions stay fixed unless bootstrap mode lays out an empty scope.
 */
export function unjamLayoutModel(
  model: WorkPackageLayoutModel,
  options: UnjamLayoutOptions = {},
): UnjamLayoutResult {
  const next = cloneLayoutModel(model);
  let changed = false;

  for (const group of collectSiblingGroups(next)) {
    const sortedIds = [...group.childIds].sort();
    let groupChanged = false;
    for (let index = 0; index < sortedIds.length; index++) {
      if (tryPlaceNode(next, sortedIds[index]!, index, options)) {
        changed = true;
        groupChanged = true;
      }
    }

    if (!group.parentId) {
      continue;
    }
    const needsRoom =
      groupChanged ||
      group.childIds.some((id) => !isValidRest(next, id)) ||
      compositeBelowMinimum(next, group.parentId);
    if (needsRoom && growParentForUnjam(next, group.parentId, options)) {
      changed = true;
    }
  }

  return { model: next, changed };
}
