import type { Core, EventObject } from "cytoscape";
import cytoscape from "cytoscape";
import { applyLayoutModelToCy, layoutModelFromCy } from "./cytoscape-sync";
import {
  LEAF_LABEL_COLOR,
  LEAF_LABEL_FONT_FAMILY,
  LEAF_LABEL_FONT_SIZE,
  LEAF_LABEL_MARGIN_Y,
  LEAF_LABEL_OUTLINE_COLOR,
  LEAF_LABEL_OUTLINE_WIDTH,
  LEAF_LABEL_FONT_WEIGHT,
  LEAF_NODE_DIAMETER,
  LEAF_SELECTION_OUTLINE_COLOR,
  LEAF_SELECTION_OUTLINE_WIDTH,
  NODE_OVERLAP_PADDING,
  CLAMP_PARENT_TO_VIEWPORT,
  VIEWPORT_PADDING_PX,
} from "./cytoscape-theme";
import {
  applySubtreePositionsToCy,
  configureDetachedChildDrag,
  enableContainerDragging,
  measureContainerFromCy,
  pinContainerToModel,
  pinLeafToModel,
  renderedContainerBoxFromModel,
  restoreLeafVisibility,
  viewportBoundsInGraphSpace,
} from "./compound-graph-core";
import {
  compoundAbsolutePosition,
  snapshotGraphState,
  syncLeafFootprintsFromCy,
  type GraphSnapshot,
} from "./cytoscape-utils";
import {
  clientPointFromDomEvent,
  clientPointFromOriginalEvent,
  wireDetachedDragListeners,
} from "./drag-listeners";
import {
  absoluteCenter,
  childrenFitBoxAbsolute,
  cloneLayoutModel,
  compositeOuterBox,
  moveComposite,
  moveChild,
  resolvedEdgeClearance,
  resizeComposite,
  resizeLooseEdgesFromOuter,
  type LayoutModelBuildOptions,
  type LayoutNodeInput,
  type MoveCompositeOptions,
  type ResizeChildConstraints,
  type ResizeCorner,
  type WorkPackageLayoutModel,
} from "./layout-model";

/** Screen-space metrics for the DOM child-drag ghost overlay. */
export interface ChildDragVisual {
  renderedX: number;
  renderedY: number;
  zoom: number;
  zoomScale: number;
  label: string;
  color: string;
}

/** Screen-space bounds for the DOM compound-parent overlay (border + label). */
export interface ParentDragVisual {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  selected: boolean;
  /**
   * Current zoom relative to the zoom Cytoscape's initial `fit: true` layout landed on
   * (1 = unchanged since first render), so the DOM title overlay can shrink/grow as the
   * user actually zooms in or out while leaving `.compound-parent-label { font-size: ... }`
   * in App.css as the authoritative base size.
   */
  zoomScale: number;
}

/** Specification for a leaf child owned by a {@link GraphParentVertex}. */
export interface GraphChildVertexSpec {
  id: string;
  label: string;
  color: string;
  x?: number;
  y?: number;
}

/** Leaf node owned exclusively by its compound parent. @internal */
class GraphChildVertex {
  private constructor(
    readonly id: string,
    readonly label: string,
    readonly color: string,
    private readonly preset: { x: number; y: number },
  ) {}

  /** Factory for GraphParentVertex only (same module). */
  static attach(spec: GraphChildVertexSpec): GraphChildVertex {
    return new GraphChildVertex(
      spec.id,
      spec.label,
      spec.color,
      { x: spec.x ?? 0, y: spec.y ?? 0 },
    );
  }

  toElementDefinition(): cytoscape.ElementDefinition {
    return {
      data: {
        id: this.id,
        label: this.label,
        kind: "leaf",
        color: this.color,
        labelFontSize: LEAF_LABEL_FONT_SIZE,
        labelFontFamily: LEAF_LABEL_FONT_FAMILY,
        labelFontWeight: LEAF_LABEL_FONT_WEIGHT,
        labelColor: LEAF_LABEL_COLOR,
        labelOutlineWidth: LEAF_LABEL_OUTLINE_WIDTH,
        labelOutlineColor: LEAF_LABEL_OUTLINE_COLOR,
        labelMarginY: LEAF_LABEL_MARGIN_Y,
        nodeWidth: LEAF_NODE_DIAMETER,
        nodeHeight: LEAF_NODE_DIAMETER,
        selectionOutlineWidth: LEAF_SELECTION_OUTLINE_WIDTH,
        selectionOutlineColor: LEAF_SELECTION_OUTLINE_COLOR,
      },
      position: { ...this.preset },
    };
  }

  /** Read-only view of this child's absolute center in the layout model. */
  absoluteCenter(model: WorkPackageLayoutModel): { x: number; y: number } {
    return absoluteCenter(model, this.id);
  }
}

/**
 * Compound parent that owns its children, layout model, and Cytoscape sync.
 *
 * Typical lifecycle:
 * 1. {@link GraphParentVertex.create} with child specs
 * 2. {@link GraphParentVertex.buildElements} → pass to Cytoscape with {@link createCompoundGraphStylesheet}
 * 3. {@link GraphParentVertex.initializeFromCy} after first render
 * 4. {@link GraphParentVertex.attachChildDragHandlers} / {@link GraphParentVertex.attachParentDragHandlers}
 * 5. On resize: {@link GraphParentVertex.computeResizeChildConstraints} → {@link GraphParentVertex.resizeFromCorner} → {@link GraphParentVertex.syncToCy}
 *
 * Invariant: resizing from a corner does not change child absolute positions in graph space.
 */
export class GraphParentVertex {
  readonly children: readonly GraphChildVertex[];
  private model: WorkPackageLayoutModel | null = null;
  /** Zoom captured right after the initial `fit: true` layout lands; see ParentDragVisual.zoomScale. */
  private referenceZoom = 1;
  private childDragActive = false;
  private childDragSession:
    | {
        childId: string;
        startModel: WorkPackageLayoutModel;
        parentAbsolute: { x: number; y: number };
        startChildAbsolute: { x: number; y: number };
        renderedOffset: { x: number; y: number };
        previousAutoungrabify: boolean;
        previousUserPanningEnabled: boolean;
      }
    | null = null;
  private nodeOverlapPadding = NODE_OVERLAP_PADDING;
  private clampParentToViewport = CLAMP_PARENT_TO_VIEWPORT;
  private viewportPaddingPx = VIEWPORT_PADDING_PX;

  private constructor(
    readonly id: string,
    readonly label: string,
    readonly color: string,
    childSpecs: GraphChildVertexSpec[],
    nodeOverlapPadding: number,
    clampParentToViewport: boolean,
    viewportPaddingPx: number,
  ) {
    this.children = childSpecs.map((spec) => GraphChildVertex.attach(spec));
    this.nodeOverlapPadding = nodeOverlapPadding;
    this.clampParentToViewport = clampParentToViewport;
    this.viewportPaddingPx = viewportPaddingPx;
  }

  /** Creates a compound parent and its owned leaf children. */
  static create(spec: {
    /** Cytoscape element id for the container node. */
    id: string;
    /** Human-readable label shown in the DOM parent overlay. */
    label: string;
    /** Leaf stylesheet fallback color for the container metadata. */
    color: string;
    children: GraphChildVertexSpec[];
    /**
     * Model-unit gap added around each leaf footprint when testing sibling collisions
     * during drag. Defaults to {@link DEFAULT_COMPOUND_GRAPH_THEME.nodeOverlapPadding}.
     */
    nodeOverlapPadding?: number;
    /**
     * When true (default), parent drag keeps the compound outer box inside the visible
     * Cytoscape container. See {@link GraphParentVertex.setClampParentToViewport}.
     */
    clampParentToViewport?: boolean;
    /** Screen-pixel inset from the container edge during viewport clamping. */
    viewportPaddingPx?: number;
  }): GraphParentVertex {
    return new GraphParentVertex(
      spec.id,
      spec.label,
      spec.color,
      spec.children,
      spec.nodeOverlapPadding ?? NODE_OVERLAP_PADDING,
      spec.clampParentToViewport ?? CLAMP_PARENT_TO_VIEWPORT,
      spec.viewportPaddingPx ?? VIEWPORT_PADDING_PX,
    );
  }

  /** Returns an owned child by id, if present. */
  getChild(id: string): GraphChildVertex | undefined {
    return this.children.find((child) => child.id === id);
  }

  /** Layout-model inputs describing this parent and its children. @internal */
  get layoutInputs(): LayoutNodeInput[] {
    return [
      { id: this.id, isCompound: true },
      ...this.children.map((child) => ({ id: child.id, parent: this.id })),
    ];
  }

  /** Child element ids owned by this parent. */
  get childIds(): string[] {
    return this.children.map((child) => child.id);
  }

  /** Current in-memory layout model, or null before initialization. @internal */
  getModel(): WorkPackageLayoutModel | null {
    return this.model;
  }

  /**
   * Records how many model units CHILD_EDGE_CLEARANCE_PX currently maps to at the live
   * zoom level (see App.tsx), so the child's left/right/bottom drag clamp stays a
   * constant number of screen pixels from the border no matter how far Cytoscape's
   * `fit: true` layout has zoomed in or out.
   */
  setEdgeClearance(modelUnits: number): void {
    const node = this.model?.nodes.get(this.id);
    if (node) {
      node.reservedEdge = Number.isFinite(modelUnits) ? Math.max(0, modelUnits) : 0;
    }
  }

  /**
   * Sets the model-unit gap added around each leaf footprint when testing sibling
   * collisions during drag. Use {@link CompoundGraphTheme.nodeOverlapPadding} or tune
   * at runtime without editing library constants.
   */
  setNodeOverlapPadding(modelUnits: number): void {
    this.nodeOverlapPadding = modelUnits;
    if (this.model) {
      this.model.nodeOverlapPadding = modelUnits;
    }
  }

  /**
   * Enables or disables clamping compound parent drag to the visible Cytoscape container.
   */
  setClampParentToViewport(enabled: boolean): void {
    this.clampParentToViewport = enabled;
  }

  /**
   * Sets the screen-pixel padding inset used when {@link setClampParentToViewport} is enabled.
   */
  setViewportPaddingPx(pixels: number): void {
    this.viewportPaddingPx = pixels;
  }

  /** Cytoscape element definitions for the container node and its leaf children. */
  buildElements(): cytoscape.ElementDefinition[] {
    return [
      {
        data: {
          id: this.id,
          label: this.label,
          kind: "container",
          color: this.color,
        },
        position: { x: 0, y: 0 },
      },
      ...this.children.map((child) => child.toElementDefinition()),
    ];
  }

  /** Initial Cytoscape setup: measure, then snapshot the authoritative model. */
  initializeFromCy(cy: Core): GraphSnapshot {
    this.measureFromCy(cy);
    this.syncModelFromCy(cy);
    enableContainerDragging(cy, [this.id]);
    configureDetachedChildDrag(cy, this.childIds);
    const zoom = cy.zoom();
    this.referenceZoom = zoom > 0 ? zoom : 1;
    return snapshotGraphState(cy, this.id, this.childIds);
  }

  /** Ensures the layout model exists, syncing from Cytoscape if needed. @internal */
  ensureModelFromCy(cy: Core): WorkPackageLayoutModel {
    if (!this.model || !compositeOuterBox(this.model, this.id)) {
      this.syncModelFromCy(cy);
    }
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    return this.model;
  }

  /** Deep-clones the current layout model for immutable resize gestures. */
  cloneModel(): WorkPackageLayoutModel {
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    return cloneLayoutModel(this.model);
  }

  /** Screen-space box for corner resize handles when the parent is selected. */
  renderedHandleBox(cy: Core): { left: number; top: number; width: number; height: number } | null {
    const parent = cy.getElementById(this.id);
    if (parent.empty() || !parent.selected()) {
      return null;
    }
    return this.renderedParentBoxFromModel(cy);
  }

  /** Point-in-time Cytoscape snapshot of parent size and child absolutes. */
  snapshot(cy: Core): GraphSnapshot {
    return snapshotGraphState(cy, this.id, this.childIds);
  }

  /**
   * Snapshot that reflects the authoritative layout model mid-gesture (e.g. detached child drag)
   * instead of reading hidden Cytoscape node positions.
   */
  liveSnapshot(cy: Core): GraphSnapshot {
    if (!this.childDragActive || !this.model) {
      return this.snapshot(cy);
    }

    const session = this.childDragSession;
    const parent = this.model.nodes.get(this.id);
    const child = session ? this.model.nodes.get(session.childId) : undefined;
    const box = compositeOuterBox(this.model, this.id);
    if (!session || !parent?.size || !child || !box) {
      return this.snapshot(cy);
    }

    const children: GraphSnapshot["children"] = {};
    for (const childId of this.childIds) {
      const childNode = this.model.nodes.get(childId);
      if (childNode) {
        children[childId] = {
          absolute: absoluteCenter(this.model, childId),
          relative: { ...childNode.center },
        };
      }
    }

    return {
      parent: {
        center: absoluteCenter(this.model, this.id),
        relative: { ...parent.center },
        w: parent.size.w,
        h: parent.size.h,
        box,
      },
      children,
    };
  }

  /** Screen-space ghost overlay state while a child drag is active. */
  childDragVisual(cy: Core): ChildDragVisual | null {
    const session = this.childDragSession;
    if (!this.childDragActive || !this.model || !session) {
      return null;
    }
    const childVertex = this.getChild(session.childId);
    if (!childVertex) {
      return null;
    }
    const childAbsolute = absoluteCenter(this.model, session.childId);
    return {
      renderedX: childAbsolute.x * cy.zoom() + cy.pan().x + session.renderedOffset.x,
      renderedY: childAbsolute.y * cy.zoom() + cy.pan().y + session.renderedOffset.y,
      zoom: cy.zoom(),
      zoomScale: cy.zoom() / this.referenceZoom,
      label: childVertex.label,
      color: childVertex.color,
    };
  }

  /** Screen-space compound border/label overlay driven by the layout model. */
  parentDragVisual(cy: Core): ParentDragVisual | null {
    const parent = cy.getElementById(this.id);
    if (parent.empty()) {
      return null;
    }
    const box = this.renderedParentBoxFromModel(cy);
    if (!box) {
      return null;
    }
    return {
      ...box,
      label: this.label,
      selected: parent.selected(),
      zoomScale: cy.zoom() / this.referenceZoom,
    };
  }

  /** Refreshes measured leaf footprints from live Cytoscape label metrics. */
  refreshFootprintsFromCy(cy: Core): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const skipIds = this.childDragSession
      ? new Set([this.childDragSession.childId])
      : undefined;
    syncLeafFootprintsFromCy(cy, model, this.id, skipIds);
  }

  /** Computes frozen child-fit constraints for a resize gesture about to begin. */
  computeResizeChildConstraints(cy: Core): ResizeChildConstraints {
    const model = this.ensureModelFromCy(cy);
    syncLeafFootprintsFromCy(cy, model, this.id);
    const zoom = cy.zoom();
    const edgeClearance = resolvedEdgeClearance(model, this.id, zoom);
    const parentNode = model.nodes.get(this.id);
    if (parentNode) {
      parentNode.reservedEdge = edgeClearance;
    }
    const childrenBox = childrenFitBoxAbsolute(model, this.id);
    const outer = compositeOuterBox(model, this.id);
    if (!childrenBox || !outer) {
      return {
        childrenBox,
        edgeClearance,
        looseEdges: { west: false, east: false, north: false, south: false },
      };
    }
    return {
      childrenBox,
      edgeClearance,
      looseEdges: resizeLooseEdgesFromOuter(outer, childrenBox, edgeClearance),
    };
  }

  /** Applies a corner resize delta to a cloned start model and stores the result. */
  resizeFromCorner(
    corner: ResizeCorner,
    dxModel: number,
    dyModel: number,
    startModel: WorkPackageLayoutModel,
    constraints: ResizeChildConstraints,
    cy?: Core,
  ): void {
    this.model = resizeComposite(
      startModel,
      this.id,
      corner,
      dxModel,
      dyModel,
      constraints,
      this.viewportClampOptions(cy),
    );
  }

  /** Writes the layout model back to Cytoscape and reconfigures drag behaviour. */
  syncToCy(cy: Core): void {
    if (!this.model) {
      return;
    }
    applyLayoutModelToCy(cy, this.model);
    if (this.model) {
      pinContainerToModel(cy, this.model, this.id);
    }
    restoreLeafVisibility(cy, this.childIds);
    enableContainerDragging(cy, [this.id]);
    configureDetachedChildDrag(cy, this.childIds);
  }

  /** True while a detached child drag session is in progress. */
  isChildDragInProgress(): boolean {
    return this.childDragActive;
  }

  /** Registers detached pointer/touch handlers for owned leaf nodes. */
  attachChildDragHandlers(
    cy: Core,
    callbacks: {
      onStart?: (childId: string, snap: GraphSnapshot) => void;
      onMove?: () => void;
      onEnd?: () => void;
    },
  ): void {
    const childIdSet = new Set(this.childIds);
    let dragCleanup: (() => void) | null = null;

    const stopChildDrag = () => {
      this.finishChildDrag(cy);
      dragCleanup?.();
      dragCleanup = null;
      callbacks.onEnd?.();
    };

    const onChildDragStart = (event: EventObject) => {
      const childId = event.target.id();
      if (!childIdSet.has(childId) || this.childDragActive) {
        return;
      }

      const clientPoint = clientPointFromOriginalEvent(event.originalEvent as Event | undefined);
      if (!clientPoint) {
        return;
      }

      const originalEvent = event.originalEvent as Event | undefined;
      originalEvent?.preventDefault?.();
      originalEvent?.stopPropagation?.();

      dragCleanup?.();
      dragCleanup = null;

      this.beginChildDrag(cy, childId);
      callbacks.onStart?.(childId, this.liveSnapshot(cy));

      const startClientPoint = clientPoint;

      const onWindowMove = (domEvent: MouseEvent | PointerEvent | TouchEvent) => {
        const nextClientPoint = clientPointFromDomEvent(domEvent);
        if (!nextClientPoint) {
          return;
        }
        domEvent.preventDefault();
        this.syncChildDragByDelta(cy, childId, {
          x: (nextClientPoint.clientX - startClientPoint.clientX) / cy.zoom(),
          y: (nextClientPoint.clientY - startClientPoint.clientY) / cy.zoom(),
        });
        callbacks.onMove?.();
      };

      const onWindowUp = (domEvent: MouseEvent | PointerEvent | TouchEvent) => {
        domEvent.preventDefault();
        stopChildDrag();
      };

      dragCleanup = wireDetachedDragListeners(originalEvent, onWindowMove, onWindowUp);
    };

    cy.on("tapstart", "node[kind = 'leaf']", onChildDragStart);
  }

  /** Registers Cytoscape grab/drag/free handlers for the container node. */
  attachParentDragHandlers(
    cy: Core,
    callbacks: { onGrab?: (snap: GraphSnapshot) => void; onChange?: () => void },
  ): void {
    let parentMovedDuringGesture = false;

    const onGrab = (event: EventObject) => {
      if (event.target.id() !== this.id || this.childDragActive) {
        return;
      }
      parentMovedDuringGesture = false;
      callbacks.onGrab?.(this.snapshot(cy));
    };

    const onDrag = (event: EventObject) => {
      if (event.target.id() !== this.id || this.childDragActive) {
        return;
      }
      parentMovedDuringGesture = true;
      this.syncParentDragFromCy(cy);
      callbacks.onChange?.();
    };

    const onFree = (event: EventObject) => {
      if (event.target.id() !== this.id || this.childDragActive) {
        return;
      }
      if (parentMovedDuringGesture) {
        this.syncParentDragFromCy(cy);
        callbacks.onChange?.();
      }
      parentMovedDuringGesture = false;
    };

    cy.on("grab", `node#${this.id}`, onGrab);
    cy.on("drag", `node#${this.id}`, onDrag);
    cy.on("free", `node#${this.id}`, onFree);
  }

  private syncChildDragByDelta(
    cy: Core,
    childId: string,
    delta: { x: number; y: number },
  ): void {
    const session = this.childDragSession;
    if (!session || !this.childDragActive || session.childId !== childId) {
      return;
    }

    // Advance from the last legal rest, not from where the pointer went down. Replaying
    // every frame against `startModel` makes an illegal target throw the child all the
    // way back to the grab point; using the live model stops it against the obstacle
    // instead, the same way a container drag already resolves (see syncParentDragFromCy).
    const nextModel = moveChild(this.model ?? session.startModel, childId, {
      x: session.startChildAbsolute.x + delta.x - session.parentAbsolute.x,
      y: session.startChildAbsolute.y + delta.y - session.parentAbsolute.y,
    });
    this.model = nextModel;
    if (this.model) {
      pinContainerToModel(cy, this.model, this.id);
      pinLeafToModel(cy, this.model, childId);
    }
  }

  private beginChildDrag(cy: Core, childId: string): void {
    if (this.childDragActive) {
      return;
    }

    const model = this.ensureModelFromCy(cy);
    syncLeafFootprintsFromCy(cy, model, this.id);
    const cyChild = cy.getElementById(childId);
    if (cyChild.empty()) {
      return;
    }

    const childAbsolute = compoundAbsolutePosition(cyChild);
    const renderedCenter = cyChild.renderedPosition();
    const pan = cy.pan();
    const zoom = cy.zoom();
    const parent = cy.getElementById(this.id);
    if (parent.empty()) {
      return;
    }
    this.childDragActive = true;
    this.childDragSession = {
      childId,
      startModel: cloneLayoutModel(model),
      parentAbsolute: absoluteCenter(model, this.id),
      startChildAbsolute: childAbsolute,
      renderedOffset: {
        x: renderedCenter.x - (childAbsolute.x * zoom + pan.x),
        y: renderedCenter.y - (childAbsolute.y * zoom + pan.y),
      },
      previousAutoungrabify: cy.autoungrabify(),
      previousUserPanningEnabled: cy.userPanningEnabled(),
    };

    cy.autoungrabify(true);
    cy.userPanningEnabled(false);
    cyChild.style("opacity", 0);
    cyChild.style("events", "no");
    if (this.model) {
      pinContainerToModel(cy, this.model, this.id);
    }
  }

  private finishChildDrag(cy: Core): void {
    const model = this.model;
    const session = this.childDragSession;
    if (session) {
      cy.autoungrabify(session.previousAutoungrabify);
      cy.userPanningEnabled(session.previousUserPanningEnabled);
    }
    if (!model) {
      restoreLeafVisibility(cy, this.childIds);
      enableContainerDragging(cy, [this.id]);
      configureDetachedChildDrag(cy, this.childIds);
      this.childDragActive = false;
      this.childDragSession = null;
      return;
    }

    applyLayoutModelToCy(cy, model);
    pinContainerToModel(cy, model, this.id);
    restoreLeafVisibility(cy, this.childIds);
    enableContainerDragging(cy, [this.id]);
    configureDetachedChildDrag(cy, this.childIds);
    this.childDragActive = false;
    this.childDragSession = null;
  }

  private syncParentDragFromCy(cy: Core): void {
    if (!this.model) {
      this.syncModelFromCy(cy);
    }
    if (!this.model) {
      return;
    }
    const cyParent = cy.getElementById(this.id);
    if (cyParent.empty()) {
      return;
    }
    this.model = moveComposite(
      this.model,
      this.id,
      cyParent.position(),
      this.viewportClampOptions(cy),
    );
    if (this.model) {
      pinContainerToModel(cy, this.model, this.id);
      applySubtreePositionsToCy(cy, this.model, this.id);
    }
  }

  private viewportClampOptions(cy?: Core): MoveCompositeOptions | undefined {
    if (!this.clampParentToViewport || !cy) {
      return undefined;
    }
    return {
      viewportBounds: viewportBoundsInGraphSpace(cy, this.viewportPaddingPx),
    };
  }

  private measureFromCy(cy: Core): void {
    measureContainerFromCy(cy, this.id, this.childIds);
  }

  private renderedParentBoxFromModel(
    cy: Core,
  ): { left: number; top: number; width: number; height: number } | null {
    if (!this.model) {
      return null;
    }
    return renderedContainerBoxFromModel(cy, this.model, this.id);
  }

  private syncModelFromCy(cy: Core): WorkPackageLayoutModel {
    this.model = layoutModelFromCy(cy, this.layoutInputs, this.layoutModelOptions());
    return this.model;
  }

  private layoutModelOptions(): LayoutModelBuildOptions {
    return { nodeOverlapPadding: this.nodeOverlapPadding };
  }
}

