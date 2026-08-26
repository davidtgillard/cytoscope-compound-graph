import type { Core, EventObject } from "cytoscape";
import cytoscape from "cytoscape";
import { applyLayoutModelToCy, layoutModelFromCy } from "./cytoscape-sync";
import {
  CHILD_EDGE_CLEARANCE_PX,
  COMPOUND_PADDING,
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
  renderedContainerBoxFromModel,
  restoreLeafVisibility,
  viewportBoundsInGraphSpace,
} from "./compound-graph-core";
import type { ChildDragVisual, ParentDragVisual } from "./compound-graph";
import {
  compoundAbsolutePosition,
  childrenFitBoxAbsoluteFromCy,
  syncLeafFootprintsFromCy,
} from "./cytoscape-utils";
import {
  clientPointFromDomEvent,
  clientPointFromOriginalEvent,
  wireDetachedDragListeners,
} from "./drag-listeners";
import {
  absoluteCenter,
  cloneLayoutModel,
  compositeOuterBox,
  flatLayoutFromModel,
  isOverflowNodeId,
  moveComposite,
  moveChild,
  resizeComposite,
  resizeLooseEdgesFromOuter,
  type LayoutModelBuildOptions,
  type LayoutNodeInput,
  type MoveCompositeOptions,
  type ResizeChildConstraints,
  type ResizeCorner,
  type WorkPackageLayoutModel,
} from "./layout-model";
import { unjamLayoutModel, type UnjamLayoutOptions } from "./layout-unjam";

const SCENE_NODE_RESERVED_KEYS = new Set([
  "id",
  "label",
  "color",
  "kind",
  "parent",
  "isOverflow",
  "x",
  "y",
  "compoundWidth",
  "compoundHeight",
  "nodeType",
  "classes",
]);

export interface SceneNodeSpec {
  id: string;
  label: string;
  color: string;
  kind: "container" | "leaf";
  parent?: string;
  isOverflow?: boolean;
  x?: number;
  y?: number;
  compoundWidth?: number;
  compoundHeight?: number;
  nodeType?: string;
  classes?: string;
  [key: string]: unknown;
}

export interface SceneEdgeSpec {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface CompoundGraphSceneSpec {
  nodes: SceneNodeSpec[];
  edges: SceneEdgeSpec[];
  nodeOverlapPadding?: number;
  clampParentToViewport?: boolean;
  viewportPaddingPx?: number;
}

/**
 * Graph-wide compound coordinator for multiple nested containers on one Cytoscape canvas.
 */
export class CompoundGraphScene {
  private readonly nodeSpecs: Map<string, SceneNodeSpec>;
  private readonly edges: SceneEdgeSpec[];
  private model: WorkPackageLayoutModel | null = null;
  private referenceZoom = 1;
  private childDragActive = false;
  private childDragSession:
    | {
        childId: string;
        startModel: WorkPackageLayoutModel;
        parentId: string;
        parentAbsolute: { x: number; y: number };
        startChildAbsolute: { x: number; y: number };
        renderedOffset: { x: number; y: number };
        previousAutoungrabify: boolean;
        previousUserPanningEnabled: boolean;
      }
    | null = null;
  private nodeOverlapPadding: number;
  private clampParentToViewport: boolean;
  private viewportPaddingPx: number;

  private constructor(
    nodeSpecs: Map<string, SceneNodeSpec>,
    edges: SceneEdgeSpec[],
    nodeOverlapPadding: number,
    clampParentToViewport: boolean,
    viewportPaddingPx: number,
  ) {
    this.nodeSpecs = nodeSpecs;
    this.edges = edges;
    this.nodeOverlapPadding = nodeOverlapPadding;
    this.clampParentToViewport = clampParentToViewport;
    this.viewportPaddingPx = viewportPaddingPx;
  }

  static fromSpec(spec: CompoundGraphSceneSpec): CompoundGraphScene {
    const nodeSpecs = new Map<string, SceneNodeSpec>();
    for (const node of spec.nodes) {
      if (nodeSpecs.has(node.id)) {
        throw new Error(`duplicate scene node id: ${node.id}`);
      }
      nodeSpecs.set(node.id, node);
    }
    return new CompoundGraphScene(
      nodeSpecs,
      spec.edges,
      spec.nodeOverlapPadding ?? NODE_OVERLAP_PADDING,
      spec.clampParentToViewport ?? CLAMP_PARENT_TO_VIEWPORT,
      spec.viewportPaddingPx ?? VIEWPORT_PADDING_PX,
    );
  }

  getModel(): WorkPackageLayoutModel | null {
    return this.model;
  }

  setClampParentToViewport(enabled: boolean): void {
    this.clampParentToViewport = enabled;
  }

  setViewportPaddingPx(pixels: number): void {
    this.viewportPaddingPx = pixels;
  }

  private get layoutInputs(): LayoutNodeInput[] {
    return [...this.nodeSpecs.values()].map((node) => ({
      id: node.id,
      parent: node.parent,
      isCompound: node.kind === "container",
      isOverflow: node.isOverflow ?? isOverflowNodeId(node.id),
    }));
  }

  private containerIds(): string[] {
    return [...this.nodeSpecs.values()]
      .filter((node) => node.kind === "container")
      .map((node) => node.id);
  }

  private draggableLeafIds(): string[] {
    return [...this.nodeSpecs.values()]
      .filter(
        (node) =>
          node.kind === "leaf" && !node.isOverflow && !isOverflowNodeId(node.id),
      )
      .map((node) => node.id);
  }

  private directChildIds(containerId: string): string[] {
    return [...this.nodeSpecs.values()]
      .filter((node) => node.parent === containerId)
      .map((node) => node.id);
  }

  private passthroughData(node: SceneNodeSpec): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!SCENE_NODE_RESERVED_KEYS.has(key) && value !== undefined) {
        data[key] = value;
      }
    }
    if (node.nodeType !== undefined) {
      data.type = node.nodeType;
    }
    return data;
  }

  buildElements(): cytoscape.ElementDefinition[] {
    const nodes: cytoscape.ElementDefinition[] = [];
    for (const node of this.nodeSpecs.values()) {
      if (node.kind === "container") {
        const data: Record<string, unknown> = {
          id: node.id,
          label: node.label,
          kind: "container",
          color: node.color,
          ...this.passthroughData(node),
        };
        if (node.compoundWidth !== undefined) {
          data.compoundWidth = node.compoundWidth;
        }
        if (node.compoundHeight !== undefined) {
          data.compoundHeight = node.compoundHeight;
        }
        if (node.classes) {
          data.classes = node.classes;
        }
        nodes.push({
          data: data as cytoscape.NodeDefinition["data"],
          position: { x: node.x ?? 0, y: node.y ?? 0 },
        });
        continue;
      }

      const data: Record<string, unknown> = {
        id: node.id,
        label: node.label,
        kind: "leaf",
        color: node.color,
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
        ...this.passthroughData(node),
      };
      if (node.isOverflow || isOverflowNodeId(node.id)) {
        data.isOverflow = true;
      }
      if (node.classes) {
        data.classes = node.classes;
      }
      nodes.push({
        data: data as cytoscape.NodeDefinition["data"],
        position: { x: node.x ?? 0, y: node.y ?? 0 },
      });
    }

    const edgeElements: cytoscape.ElementDefinition[] = this.edges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
      },
    }));

    return [...nodes, ...edgeElements];
  }

  initializeFromCy(cy: Core): void {
    cy.batch(() => {
      for (const node of this.nodeSpecs.values()) {
        const cyNode = cy.getElementById(node.id);
        if (cyNode.empty()) {
          continue;
        }
        if (node.x !== undefined || node.y !== undefined) {
          cyNode.position({
            x: node.x ?? cyNode.position().x,
            y: node.y ?? cyNode.position().y,
          });
        }
        if (node.kind === "container") {
          if (node.compoundWidth !== undefined) {
            cyNode.data("compoundWidth", node.compoundWidth);
          }
          if (node.compoundHeight !== undefined) {
            cyNode.data("compoundHeight", node.compoundHeight);
          }
        }
      }
    });

    for (const containerId of this.containerIds()) {
      const parent = cy.getElementById(containerId);
      if (!parent.empty() && parent.data("compoundWidth") === undefined) {
        measureContainerFromCy(cy, containerId, this.directChildIds(containerId));
      }
    }
    this.syncModelFromCy(cy);
    enableContainerDragging(cy, this.containerIds());
    configureDetachedChildDrag(cy, this.draggableLeafIds());
    const zoom = cy.zoom();
    this.referenceZoom = zoom > 0 ? zoom : 1;
  }

  ensureModelFromCy(cy: Core): WorkPackageLayoutModel {
    const needsSync =
      !this.model ||
      this.containerIds().some((id) => !compositeOuterBox(this.model!, id));
    if (needsSync) {
      this.syncModelFromCy(cy);
    }
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    return this.model;
  }

  cloneModel(): WorkPackageLayoutModel {
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    return cloneLayoutModel(this.model);
  }

  flatLayout(): Record<string, { x: number; y: number; w?: number; h?: number }> {
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    return flatLayoutFromModel(this.model);
  }

  setEdgeClearance(modelUnits: number): void {
    if (!this.model) {
      return;
    }
    for (const containerId of this.containerIds()) {
      const node = this.model.nodes.get(containerId);
      if (node) {
        node.reservedEdge = modelUnits;
      }
    }
  }

  setNodeOverlapPadding(modelUnits: number): void {
    this.nodeOverlapPadding = modelUnits;
    if (this.model) {
      this.model.nodeOverlapPadding = modelUnits;
    }
  }

  refreshFootprintsFromCy(cy: Core): void {
    const model = this.model;
    if (!model) {
      return;
    }
    for (const containerId of this.containerIds()) {
      syncLeafFootprintsFromCy(cy, model, containerId);
    }
  }

  renderedHandleBox(
    cy: Core,
    containerId: string,
  ): { left: number; top: number; width: number; height: number } | null {
    const parent = cy.getElementById(containerId);
    if (parent.empty() || !parent.selected() || !this.model) {
      return null;
    }
    return renderedContainerBoxFromModel(cy, this.model, containerId);
  }

  parentDragVisuals(cy: Core): Map<string, ParentDragVisual> {
    const visuals = new Map<string, ParentDragVisual>();
    if (!this.model) {
      return visuals;
    }
    for (const containerId of this.containerIds()) {
      const parent = cy.getElementById(containerId);
      if (parent.empty() || !parent.selected()) {
        continue;
      }
      const box = renderedContainerBoxFromModel(cy, this.model, containerId);
      const spec = this.nodeSpecs.get(containerId);
      if (!box || !spec) {
        continue;
      }
      visuals.set(containerId, {
        ...box,
        label: spec.label,
        selected: true,
        zoomScale: cy.zoom() / this.referenceZoom,
      });
    }
    return visuals;
  }

  childDragVisual(cy: Core): ChildDragVisual | null {
    const session = this.childDragSession;
    if (!this.childDragActive || !this.model || !session) {
      return null;
    }
    const spec = this.nodeSpecs.get(session.childId);
    if (!spec) {
      return null;
    }
    const childAbsolute = absoluteCenter(this.model, session.childId);
    return {
      renderedX: childAbsolute.x * cy.zoom() + cy.pan().x + session.renderedOffset.x,
      renderedY: childAbsolute.y * cy.zoom() + cy.pan().y + session.renderedOffset.y,
      zoom: cy.zoom(),
      zoomScale: cy.zoom() / this.referenceZoom,
      label: spec.label,
      color: spec.color,
    };
  }

  computeResizeChildConstraints(cy: Core, containerId: string): ResizeChildConstraints {
    const model = this.ensureModelFromCy(cy);
    syncLeafFootprintsFromCy(cy, model, containerId);
    const zoom = cy.zoom();
    const edgeClearance = zoom > 0 ? CHILD_EDGE_CLEARANCE_PX / zoom : COMPOUND_PADDING.left;
    const parentNode = model.nodes.get(containerId);
    if (parentNode) {
      parentNode.reservedEdge = edgeClearance;
    }
    const childrenBox = childrenFitBoxAbsoluteFromCy(cy, model, containerId);
    const outer = compositeOuterBox(model, containerId);
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

  resizeFromCorner(
    containerId: string,
    corner: ResizeCorner,
    dxModel: number,
    dyModel: number,
    startModel: WorkPackageLayoutModel,
    constraints: ResizeChildConstraints,
    cy?: Core,
  ): void {
    this.model = resizeComposite(
      startModel,
      containerId,
      corner,
      dxModel,
      dyModel,
      constraints,
      this.viewportClampOptions(cy),
    );
  }

  /**
   * Separates jammed nodes after `initializeFromCy` when layout cache is missing
   * or degenerate. Persists only when the caller saves `flatLayout()` after a
   * changed result.
   */
  unjamLoadedLayout(cy: Core, options?: UnjamLayoutOptions): { changed: boolean } {
    if (!this.model) {
      throw new Error("layout model not initialized");
    }
    const result = unjamLayoutModel(this.model, options);
    this.model = result.model;
    if (result.changed) {
      this.syncToCy(cy);
    }
    return { changed: result.changed };
  }

  /**
   * Applies the current Cytoscape container position through drag clamp math.
   * Used by bellman-gui's composite drag test hook when synthetic events do not
   * reliably invoke {@link attachParentDragHandlers}.
   */
  applyContainerDragFromCy(cy: Core, containerId: string): void {
    this.syncParentDragFromCy(cy, containerId);
  }

  syncToCy(cy: Core): void {
    if (!this.model) {
      return;
    }
    applyLayoutModelToCy(cy, this.model);
    for (const containerId of this.containerIds()) {
      pinContainerToModel(cy, this.model, containerId);
    }
    restoreLeafVisibility(cy, this.draggableLeafIds());
    enableContainerDragging(cy, this.containerIds());
    configureDetachedChildDrag(cy, this.draggableLeafIds());
  }

  isChildDragInProgress(): boolean {
    return this.childDragActive;
  }

  attachChildDragHandlers(
    cy: Core,
    callbacks: {
      onStart?: (childId: string) => void;
      onMove?: () => void;
      onEnd?: () => void;
    },
  ): () => void {
    const draggableLeafIds = new Set(this.draggableLeafIds());
    let dragCleanup: (() => void) | null = null;

    const stopChildDrag = () => {
      this.finishChildDrag(cy);
      dragCleanup?.();
      dragCleanup = null;
      callbacks.onEnd?.();
    };

    const onChildDragStart = (event: EventObject) => {
      const childId = event.target.id();
      const nodeSpec = this.nodeSpecs.get(childId);
      if (
        !draggableLeafIds.has(childId) ||
        this.childDragActive ||
        nodeSpec?.isOverflow ||
        isOverflowNodeId(childId)
      ) {
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
      callbacks.onStart?.(childId);

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

    return () => {
      dragCleanup?.();
      dragCleanup = null;
      cy.removeListener("tapstart", "node[kind = 'leaf']", onChildDragStart);
    };
  }

  attachParentDragHandlers(
    cy: Core,
    callbacks: { onGrab?: (containerId: string) => void; onChange?: () => void },
  ): () => void {
    const movedDuringGesture = new Map<string, boolean>();

    const onGrab = (event: EventObject) => {
      const containerId = event.target.id();
      if (
        this.childDragActive ||
        !this.nodeSpecs.get(containerId) ||
        this.nodeSpecs.get(containerId)?.kind !== "container"
      ) {
        return;
      }
      movedDuringGesture.set(containerId, false);
      callbacks.onGrab?.(containerId);
    };

    const onDrag = (event: EventObject) => {
      const containerId = event.target.id();
      if (this.childDragActive || this.nodeSpecs.get(containerId)?.kind !== "container") {
        return;
      }
      movedDuringGesture.set(containerId, true);
      this.syncParentDragFromCy(cy, containerId);
      callbacks.onChange?.();
    };

    const onFree = (event: EventObject) => {
      const containerId = event.target.id();
      if (this.childDragActive || this.nodeSpecs.get(containerId)?.kind !== "container") {
        return;
      }
      if (movedDuringGesture.get(containerId)) {
        this.syncParentDragFromCy(cy, containerId);
        callbacks.onChange?.();
      }
      movedDuringGesture.delete(containerId);
    };

    cy.on("grab", "node[kind = 'container']", onGrab);
    cy.on("drag", "node[kind = 'container']", onDrag);
    cy.on("free", "node[kind = 'container']", onFree);

    return () => {
      cy.removeListener("grab", "node[kind = 'container']", onGrab);
      cy.removeListener("drag", "node[kind = 'container']", onDrag);
      cy.removeListener("free", "node[kind = 'container']", onFree);
    };
  }

  private syncModelFromCy(cy: Core): WorkPackageLayoutModel {
    this.model = layoutModelFromCy(cy, this.layoutInputs, this.layoutModelOptions());
    return this.model;
  }

  private layoutModelOptions(): LayoutModelBuildOptions {
    return { nodeOverlapPadding: this.nodeOverlapPadding };
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

    const nextModel = moveChild(session.startModel, childId, {
      x: session.startChildAbsolute.x + delta.x - session.parentAbsolute.x,
      y: session.startChildAbsolute.y + delta.y - session.parentAbsolute.y,
    });
    this.model = nextModel;
    if (this.model) {
      pinContainerToModel(cy, this.model, session.parentId);
    }
  }

  private beginChildDrag(cy: Core, childId: string): void {
    if (this.childDragActive) {
      return;
    }

    const model = this.ensureModelFromCy(cy);
    const parentId = model.parentOf.get(childId);
    if (!parentId) {
      return;
    }
    syncLeafFootprintsFromCy(cy, model, parentId);

    const cyChild = cy.getElementById(childId);
    if (cyChild.empty()) {
      return;
    }

    const childAbsolute = compoundAbsolutePosition(cyChild);
    const renderedCenter = cyChild.renderedPosition();
    const pan = cy.pan();
    const zoom = cy.zoom();

    this.childDragActive = true;
    this.childDragSession = {
      childId,
      parentId,
      startModel: cloneLayoutModel(model),
      parentAbsolute: absoluteCenter(model, parentId),
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
    pinContainerToModel(cy, model, parentId);
  }

  private finishChildDrag(cy: Core): void {
    const model = this.model;
    const session = this.childDragSession;
    if (session) {
      cy.autoungrabify(session.previousAutoungrabify);
      cy.userPanningEnabled(session.previousUserPanningEnabled);
    }
    if (!model) {
      restoreLeafVisibility(cy, this.draggableLeafIds());
      enableContainerDragging(cy, this.containerIds());
      configureDetachedChildDrag(cy, this.draggableLeafIds());
      this.childDragActive = false;
      this.childDragSession = null;
      return;
    }

    applyLayoutModelToCy(cy, model);
    for (const containerId of this.containerIds()) {
      pinContainerToModel(cy, model, containerId);
    }
    restoreLeafVisibility(cy, this.draggableLeafIds());
    enableContainerDragging(cy, this.containerIds());
    configureDetachedChildDrag(cy, this.draggableLeafIds());
    this.childDragActive = false;
    this.childDragSession = null;
  }

  private syncParentDragFromCy(cy: Core, containerId: string): void {
    if (!this.model) {
      this.syncModelFromCy(cy);
    }
    if (!this.model) {
      return;
    }
    const cyParent = cy.getElementById(containerId);
    if (cyParent.empty()) {
      return;
    }

    const cyAbsolute = cyParent.position();
    const parentId = this.model.parentOf.get(containerId);
    const parentAbsolute = parentId ? absoluteCenter(this.model, parentId) : { x: 0, y: 0 };
    const proposedRelative = {
      x: cyAbsolute.x - parentAbsolute.x,
      y: cyAbsolute.y - parentAbsolute.y,
    };

    this.model = moveComposite(
      this.model,
      containerId,
      proposedRelative,
      this.viewportClampOptions(cy),
    );
    if (this.model) {
      pinContainerToModel(cy, this.model, containerId);
      applySubtreePositionsToCy(cy, this.model, containerId);
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
}
