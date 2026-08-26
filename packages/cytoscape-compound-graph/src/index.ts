/**
 * Compound graph layout for Cytoscape.
 *
 * Use {@link GraphParentVertex} for a single compound parent, or {@link CompoundGraphScene}
 * for multiple nested compounds on one canvas.
 *
 * @example Single compound
 * ```ts
 * import cytoscape from "cytoscape";
 * import {
 *   GraphParentVertex,
 *   createCompoundGraphStylesheet,
 * } from "@dgillard/cytoscape-compound-graph";
 *
 * const parent = GraphParentVertex.create({
 *   id: "wp-invoicing",
 *   label: "wp-invoicing",
 *   color: "#64748b",
 *   children: [{ id: "child-a", label: "child-a", color: "#94a3b8" }],
 * });
 *
 * const cy = cytoscape({
 *   container: document.getElementById("graph")!,
 *   style: createCompoundGraphStylesheet(),
 *   elements: parent.buildElements(),
 *   layout: { name: "preset", fit: true, padding: 40 },
 * });
 *
 * cy.ready(() => parent.initializeFromCy(cy));
 * ```
 *
 * @example Multi-compound scene
 * ```ts
 * import {
 *   CompoundGraphScene,
 *   createCompoundGraphStylesheet,
 * } from "@dgillard/cytoscape-compound-graph";
 *
 * const scene = CompoundGraphScene.fromSpec({
 *   nodes: [
 *     { id: "a", label: "A", color: "#64748b", kind: "container" },
 *     { id: "a1", label: "a1", color: "#94a3b8", kind: "leaf", parent: "a" },
 *     { id: "b", label: "B", color: "#64748b", kind: "container", x: 300, y: 0 },
 *     { id: "b1", label: "b1", color: "#94a3b8", kind: "leaf", parent: "b" },
 *   ],
 *   edges: [],
 * });
 * ```
 *
 * @packageDocumentation
 */

export {
  GraphParentVertex,
  type GraphChildVertexSpec,
  type ChildDragVisual,
  type ParentDragVisual,
} from "./compound-graph";

export {
  CompoundGraphScene,
  type SceneNodeSpec,
  type SceneEdgeSpec,
  type CompoundGraphSceneSpec,
} from "./compound-graph-scene";

export { type GraphSnapshot } from "./cytoscape-utils";

export {
  buildLayoutModel,
  flatLayoutFromModel,
  cloneLayoutModel,
  nodesOverlapInModel,
  OVERFLOW_NODE_PREFIX,
  isOverflowNodeId,
  type LayoutNodeInput,
  type LayoutNode,
  type WorkPackageLayoutModel,
  type ResizeCorner,
  type ResizeChildConstraints,
  type ResizeLooseEdges,
  type LayoutModelBuildOptions,
} from "./layout-model";

export { layoutModelFromCy, applyLayoutModelToCy } from "./cytoscape-sync";

export {
  isFullyImpeded,
  isLocallyFree,
  isValidRest,
  unjamLayoutModel,
  type UnjamLayoutOptions,
  type UnjamLayoutResult,
} from "./layout-unjam";

export {
  type CompoundGraphTheme,
  type LeafDomVisualStyle,
  DEFAULT_COMPOUND_GRAPH_THEME,
  CLAMP_PARENT_TO_VIEWPORT,
  VIEWPORT_PADDING_PX,
  createCompoundGraphStylesheet,
  mergeCompoundGraphStylesheet,
  leafDomVisualStyle,
} from "./cytoscape-theme";
