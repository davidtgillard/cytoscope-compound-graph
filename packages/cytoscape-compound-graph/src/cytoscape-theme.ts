import type { Core, NodeSingular, StylesheetStyle } from "cytoscape";

/**
 * Visual and layout tuning for a nested compound graph backed by Cytoscape.
 * Pass partial overrides to {@link createCompoundGraphStylesheet} and
 * {@link leafDomVisualStyle} so Cytoscape rendering and DOM drag ghosts stay aligned.
 */
export interface CompoundGraphTheme {
  /** Interior padding between compound border and child footprints (model units). */
  compoundPadding: { top: number; right: number; bottom: number; left: number };
  leafLabel: {
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    color: string;
    outlineWidth: number;
    outlineColor: string;
    marginY: number;
  };
  leafNode: { diameter: number };
  leafSelection: { outlineWidth: number; outlineColor: string };
  /**
   * How close a child's measured footprint (shape plus the CSS line-box of its label)
   * may get to the parent's outer border while being dragged, in screen pixels. Converted
   * to model units via {@link GraphParentVertex.setEdgeClearance}. Must be >= 0: a negative
   * value lets the child sit on the perimeter, after which a later clamp jumps it back.
   */
  childEdgeClearancePx: number;
  /**
   * Extra model-unit inset added around each leaf's measured footprint when testing
   * sibling collisions during drag ({@link GraphParentVertex.setNodeOverlapPadding}).
   */
  nodeOverlapPadding: number;
  /**
   * When true, compound parent drag is clamped so the outer box stays inside the
   * Cytoscape container's visible pixel bounds ({@link GraphParentVertex.setClampParentToViewport}).
   */
  clampParentToViewport: boolean;
  /** Screen-pixel inset from the container edge used by viewport clamping during parent drag. */
  viewportPaddingPx: number;
  compoundMinSize: { width: number; height: number };
  edgeStyle: {
    width: number;
    lineColor: string;
    targetArrowColor: string;
  };
}

/** Default theme matching the reference demo appearance. */
export const DEFAULT_COMPOUND_GRAPH_THEME: CompoundGraphTheme = {
  compoundPadding: { top: 8, right: 8, bottom: 8, left: 8 },
  leafLabel: {
    fontSize: 11,
    fontFamily: '"Helvetica Neue", Helvetica, sans-serif',
    fontWeight: 400,
    color: "#e2e8f0",
    outlineWidth: 2,
    outlineColor: "#0f172a",
    marginY: 6,
  },
  leafNode: { diameter: 36 },
  leafSelection: { outlineWidth: 3, outlineColor: "#38bdf8" },
  childEdgeClearancePx: 2,
  nodeOverlapPadding: 8,
  clampParentToViewport: true,
  viewportPaddingPx: 8,
  compoundMinSize: { width: 80, height: 80 },
  edgeStyle: {
    width: 2,
    lineColor: "#64748b",
    targetArrowColor: "#64748b",
  },
};

/** CSS-friendly leaf styling for DOM drag ghosts and probe elements. */
export interface LeafDomVisualStyle {
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  color: string;
  labelOutlineWidth: number;
  labelOutlineColor: string;
  labelMarginY: number;
  nodeWidth: number;
  nodeHeight: number;
  selectionOutlineWidth: number;
  selectionOutlineColor: string;
}

function resolveTheme(partial?: Partial<CompoundGraphTheme>): CompoundGraphTheme {
  if (!partial) {
    return DEFAULT_COMPOUND_GRAPH_THEME;
  }
  return {
    ...DEFAULT_COMPOUND_GRAPH_THEME,
    ...partial,
    compoundPadding: {
      ...DEFAULT_COMPOUND_GRAPH_THEME.compoundPadding,
      ...partial.compoundPadding,
    },
    leafLabel: { ...DEFAULT_COMPOUND_GRAPH_THEME.leafLabel, ...partial.leafLabel },
    leafNode: { ...DEFAULT_COMPOUND_GRAPH_THEME.leafNode, ...partial.leafNode },
    leafSelection: {
      ...DEFAULT_COMPOUND_GRAPH_THEME.leafSelection,
      ...partial.leafSelection,
    },
    compoundMinSize: {
      ...DEFAULT_COMPOUND_GRAPH_THEME.compoundMinSize,
      ...partial.compoundMinSize,
    },
    edgeStyle: { ...DEFAULT_COMPOUND_GRAPH_THEME.edgeStyle, ...partial.edgeStyle },
  };
}

/**
 * Leaf node DOM styling derived from the theme, for overlays that must match Cytoscape's
 * `text-valign: bottom` + label outline rendering.
 */
export function leafDomVisualStyle(partial?: Partial<CompoundGraphTheme>): LeafDomVisualStyle {
  const theme = resolveTheme(partial);
  const { leafLabel, leafNode, leafSelection } = theme;
  return {
    fontSize: leafLabel.fontSize,
    fontFamily: leafLabel.fontFamily,
    fontWeight: String(leafLabel.fontWeight),
    color: leafLabel.color,
    labelOutlineWidth: leafLabel.outlineWidth,
    labelOutlineColor: leafLabel.outlineColor,
    labelMarginY: leafLabel.marginY,
    nodeWidth: leafNode.diameter,
    nodeHeight: leafNode.diameter,
    selectionOutlineWidth: leafSelection.outlineWidth,
    selectionOutlineColor: leafSelection.outlineColor,
  };
}

/**
 * Cytoscape scratch flag: leaf `nodeWidth` / label metrics are already model units for the
 * frozen fit zoom. Until this is set, leaf styles divide screen-pixel data by the live zoom
 * so a `fit` cannot shrink children to the uncompensated 36px model diameter.
 */
const LEAF_METRICS_MODEL_SPACE_SCRATCH = "_ccgLeafMetricsModelSpace";
const LEAF_ZOOM_STYLE_HOOK_SCRATCH = "_ccgLeafZoomStyleHook";

function ensureLiveZoomLeafStyle(cy: Core): void {
  if (cy.scratch(LEAF_ZOOM_STYLE_HOOK_SCRATCH)) {
    return;
  }
  cy.scratch(LEAF_ZOOM_STYLE_HOOK_SCRATCH, true);
  cy.on("zoom", () => {
    /* v8 ignore start -- the instance can be torn down while a zoom event is queued */
    if (cy.destroyed()) {
      return;
    }
    /* v8 ignore stop */
    if (cy.scratch(LEAF_METRICS_MODEL_SPACE_SCRATCH)) {
      return;
    }
    refreshLeafStyle(cy);
  });
}

function refreshLeafStyle(cy: Core): void {
  const styleApi = typeof cy.style === "function" ? cy.style() : undefined;
  if (styleApi && typeof (styleApi as { update?: () => void }).update === "function") {
    (styleApi as { update: () => void }).update();
  }
}

/**
 * Screen-pixel leaf metric → model units. Before initialize/unjam freezes the fit zoom,
 * this tracks the live zoom so children keep their themed on-screen diameter.
 */
function leafScreenMetric(ele: NodeSingular, dataKey: string, screenDefault: number): number {
  const raw = Number(ele.data(dataKey));
  const screen = Number.isFinite(raw) && raw > 0 ? raw : screenDefault;
  const cy = ele.cy();
  ensureLiveZoomLeafStyle(cy);
  if (cy.scratch(LEAF_METRICS_MODEL_SPACE_SCRATCH)) {
    return screen;
  }
  const zoom = cy.zoom();
  return zoom > 0 ? screen / zoom : screen;
}

function modelUnitsForScreenDefault(
  current: unknown,
  zoom: number,
  screenDefault: number,
): number | null {
  const value = Number(current);
  if (!Number.isFinite(value) || !(zoom > 0)) {
    return null;
  }
  const expected = screenDefault / zoom;
  if (Math.abs(value - expected) <= 1e-3) {
    return null;
  }
  if (Math.abs(value - screenDefault) <= 1e-3) {
    return expected;
  }
  return null;
}

/**
 * Writes zoom-compensated leaf diameters and label metrics into Cytoscape data so packing
 * and painting use the same size. Idempotent: already-compensated values (or custom sizes
 * that are not the theme defaults) are left alone. Freezes live-zoom stylesheet mapping.
 *
 * Call before measuring footprints or unjamming. `initializeFromCy` and
 * `CompoundGraphScene.unjamLoadedLayout` do this automatically.
 */
export function applyReferenceZoomToLeafMetrics(cy: Core, referenceZoom: number): boolean {
  const zoom = Number.isFinite(referenceZoom) && referenceZoom > 0 ? referenceZoom : 1;
  const screen: Record<string, number> = {
    nodeWidth: DEFAULT_COMPOUND_GRAPH_THEME.leafNode.diameter,
    nodeHeight: DEFAULT_COMPOUND_GRAPH_THEME.leafNode.diameter,
    labelFontSize: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize,
    labelOutlineWidth: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.outlineWidth,
    labelMarginY: DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.marginY,
    selectionOutlineWidth: DEFAULT_COMPOUND_GRAPH_THEME.leafSelection.outlineWidth,
  };
  let changed = false;
  cy.batch(() => {
    cy.nodes("[kind = 'leaf']").forEach((node) => {
      for (const dataKey of Object.keys(screen)) {
        const next = modelUnitsForScreenDefault(node.data(dataKey), zoom, screen[dataKey]!);
        if (next === null) {
          continue;
        }
        node.data(dataKey, next);
        changed = true;
      }
    });
  });
  cy.scratch(LEAF_METRICS_MODEL_SPACE_SCRATCH, true);
  refreshLeafStyle(cy);
  return changed;
}

/**
 * Builds the Cytoscape stylesheet for container + leaf nodes. The container node is a
 * plain, explicitly-sized rectangle (not a native compound parent); its border renders
 * labels are drawn via DOM overlays driven by {@link GraphParentVertex.parentDragVisual}.
 * Draw the compound border in that same DOM layer behind the Cytoscape viewport so leaf
 * nodes on the canvas are never covered.
 */
export function createCompoundGraphStylesheet(
  partial?: Partial<CompoundGraphTheme>,
): StylesheetStyle[] {
  const theme = resolveTheme(partial);
  const { leafLabel, compoundMinSize, edgeStyle } = theme;
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        color: leafLabel.color,
        "z-index-compare": "manual",
      },
    },
    {
      selector: "node[kind = 'leaf']",
      style: ({
        "font-size": (ele: NodeSingular) =>
          leafScreenMetric(ele, "labelFontSize", theme.leafLabel.fontSize),
        "font-family": "data(labelFontFamily)",
        "font-weight": "data(labelFontWeight)",
        color: "data(labelColor)",
        "text-outline-color": "data(labelOutlineColor)",
        "text-outline-width": (ele: NodeSingular) =>
          leafScreenMetric(ele, "labelOutlineWidth", theme.leafLabel.outlineWidth),
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": (ele: NodeSingular) =>
          leafScreenMetric(ele, "labelMarginY", theme.leafLabel.marginY),
        "text-wrap": "wrap",
        "text-max-width": "120px",
        "background-color": "data(color)",
        width: (ele: NodeSingular) => leafScreenMetric(ele, "nodeWidth", theme.leafNode.diameter),
        height: (ele: NodeSingular) => leafScreenMetric(ele, "nodeHeight", theme.leafNode.diameter),
        shape: "ellipse",
        "z-index": 10,
      } as unknown) as StylesheetStyle["style"],
    },
    {
      selector: "node[kind = 'container']",
      style: {
        shape: "round-rectangle",
        opacity: 0,
        "background-opacity": 0,
        "border-width": 0,
        "border-opacity": 0,
        "text-opacity": 0,
        width: compoundMinSize.width,
        height: compoundMinSize.height,
        "z-index": 0,
      },
    },
    {
      selector: "node[kind = 'container'][compoundWidth]",
      style: {
        width: "data(compoundWidth)",
        height: "data(compoundHeight)",
      } as StylesheetStyle["style"],
    },
    {
      selector: "node[kind = 'leaf']:selected",
      style: ({
        "border-width": 0,
        "underlay-color": "data(selectionOutlineColor)",
        "underlay-opacity": 1,
        "underlay-padding": "data(selectionOutlineWidth)",
        "underlay-shape": "ellipse",
      } as unknown) as StylesheetStyle["style"],
    },
    {
      selector: "edge",
      style: {
        width: edgeStyle.width,
        "line-color": edgeStyle.lineColor,
        "target-arrow-color": edgeStyle.targetArrowColor,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
      },
    },
  ];
}

export function mergeCompoundGraphStylesheet(
  base: StylesheetStyle[],
  partialTheme?: Partial<CompoundGraphTheme>,
): StylesheetStyle[] {
  return [...base, ...createCompoundGraphStylesheet(partialTheme)];
}

/** @internal */
export const COMPOUND_PADDING = DEFAULT_COMPOUND_GRAPH_THEME.compoundPadding;

/** @internal */
export const COMPOUND_MIN_WIDTH = DEFAULT_COMPOUND_GRAPH_THEME.compoundMinSize.width;

/** @internal */
export const COMPOUND_MIN_HEIGHT = DEFAULT_COMPOUND_GRAPH_THEME.compoundMinSize.height;

/** @internal */
export const CHILD_EDGE_CLEARANCE_PX = DEFAULT_COMPOUND_GRAPH_THEME.childEdgeClearancePx;

/** @internal */
export const NODE_OVERLAP_PADDING = DEFAULT_COMPOUND_GRAPH_THEME.nodeOverlapPadding;

/** @internal */
export const CLAMP_PARENT_TO_VIEWPORT = DEFAULT_COMPOUND_GRAPH_THEME.clampParentToViewport;

/** @internal */
export const VIEWPORT_PADDING_PX = DEFAULT_COMPOUND_GRAPH_THEME.viewportPaddingPx;

/** @internal */
export const LEAF_LABEL_FONT_SIZE = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontSize;

/** @internal */
export const LEAF_LABEL_FONT_FAMILY = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontFamily;

/** @internal */
export const LEAF_LABEL_FONT_WEIGHT = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.fontWeight;

/** @internal */
export const LEAF_LABEL_COLOR = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.color;

/** @internal */
export const LEAF_LABEL_OUTLINE_WIDTH = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.outlineWidth;

/** @internal */
export const LEAF_LABEL_OUTLINE_COLOR = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.outlineColor;

/** @internal */
export const LEAF_SELECTION_OUTLINE_WIDTH = DEFAULT_COMPOUND_GRAPH_THEME.leafSelection.outlineWidth;

/** @internal */
export const LEAF_SELECTION_OUTLINE_COLOR = DEFAULT_COMPOUND_GRAPH_THEME.leafSelection.outlineColor;

/** @internal */
export const LEAF_NODE_DIAMETER = DEFAULT_COMPOUND_GRAPH_THEME.leafNode.diameter;

/** @internal */
export const LEAF_LABEL_MARGIN_Y = DEFAULT_COMPOUND_GRAPH_THEME.leafLabel.marginY;
