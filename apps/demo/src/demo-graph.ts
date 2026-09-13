import type { Core } from "cytoscape";
import cytoscape from "cytoscape";
import {
  CompoundGraphScene,
  createCompoundGraphStylesheet,
  DEFAULT_COMPOUND_GRAPH_THEME,
} from "@dgillard/cytoscape-compound-graph";

/** Demo theme overrides — tune spacing and visuals here without editing the library. */
export const DEMO_THEME = {
  ...DEFAULT_COMPOUND_GRAPH_THEME,
  /** Minimum gap between sibling footprints while dragging (model units per side). */
  nodeOverlapPadding: 0,
};

/** CSS probe copy; matches the first parented leaf in {@link DEMO_SCENE}. */
export const DEMO_PROBE_LABEL = "wp-pdf-export";

/** Demo graph: one compound with two children, plus a parentless leaf to the side. */
export const DEMO_SCENE = CompoundGraphScene.fromSpec({
  nodes: [
    {
      id: "wp-invoicing",
      label: "wp-invoicing",
      color: "#64748b",
      kind: "container",
    },
    {
      id: "wp-pdf-export",
      label: DEMO_PROBE_LABEL,
      color: "#94a3b8",
      kind: "leaf",
      parent: "wp-invoicing",
      x: -60,
      y: 0,
    },
    {
      id: "wp-email-export",
      label: "wp-email-export",
      color: "#a8b4c4",
      kind: "leaf",
      parent: "wp-invoicing",
      x: 60,
      y: 0,
    },
    {
      id: "wp-standalone",
      label: "wp-standalone",
      color: "#f59e0b",
      kind: "leaf",
      x: 280,
      y: 0,
    },
  ],
  edges: [],
  nodeOverlapPadding: DEMO_THEME.nodeOverlapPadding,
});

export function createDemoCy(container: HTMLElement): Core {
  return cytoscape({
    container,
    style: createCompoundGraphStylesheet(DEMO_THEME),
    elements: DEMO_SCENE.buildElements(),
    layout: { name: "preset", fit: true, padding: 40 },
    wheelSensitivity: 0.2,
  });
}
