# @dgillard/cytoscape-compound-graph

TypeScript library for compound graph layout in Cytoscape. Use {@link GraphParentVertex} for a single compound parent, or {@link CompoundGraphScene} for multiple nested compounds on one canvas. Both keep an authoritative layout model and sync to Cytoscape while preserving child absolute positions during resize.

## Install

```bash
npm install @dgillard/cytoscape-compound-graph cytoscape
```

## Quick start (single compound)

```ts
import cytoscape from "cytoscape";
import {
  GraphParentVertex,
  createCompoundGraphStylesheet,
} from "@dgillard/cytoscape-compound-graph";

const parent = GraphParentVertex.create({
  id: "wp-invoicing",
  label: "wp-invoicing",
  color: "#64748b",
  children: [
    { id: "wp-pdf-export", label: "wp-pdf-export", color: "#94a3b8", x: -60, y: 0 },
  ],
});

const cy = cytoscape({
  container: document.getElementById("graph")!,
  style: createCompoundGraphStylesheet(),
  elements: parent.buildElements(),
  layout: { name: "preset", fit: true, padding: 40 },
});

cy.ready(() => {
  parent.initializeFromCy(cy);
  parent.attachChildDragHandlers(cy, { onMove: () => {} });
  parent.attachParentDragHandlers(cy, { onChange: () => {} });
});
```

## Multi-compound scene

```ts
import cytoscape from "cytoscape";
import {
  CompoundGraphScene,
  createCompoundGraphStylesheet,
} from "@dgillard/cytoscape-compound-graph";

const scene = CompoundGraphScene.fromSpec({
  nodes: [
    { id: "a", label: "A", color: "#64748b", kind: "container", compoundWidth: 200, compoundHeight: 160 },
    { id: "a1", label: "a1", color: "#94a3b8", kind: "leaf", parent: "a", x: 0, y: 0 },
    { id: "b", label: "B", color: "#64748b", kind: "container", x: 280, y: 0, compoundWidth: 200, compoundHeight: 160 },
    { id: "b1", label: "b1", color: "#a8b4c4", kind: "leaf", parent: "b", x: 0, y: 0 },
    { id: "standalone", label: "standalone", color: "#f59e0b", kind: "leaf", x: 520, y: 0 },
  ],
  edges: [],
});

const cy = cytoscape({
  container: document.getElementById("graph")!,
  style: createCompoundGraphStylesheet(),
  elements: scene.buildElements(),
  layout: { name: "preset", fit: true, padding: 40 },
});

cy.ready(() => {
  scene.initializeFromCy(cy);
  scene.attachChildDragHandlers(cy, {});
  scene.attachParentDragHandlers(cy, {});
});
```

## Demo app

Manual test harness (not published):

```bash
npm install
npm run dev
```

Open http://localhost:5174

## Development

```bash
npm install          # install all workspaces
npm run build        # build library + demo
npm test             # run library tests
npm run test:coverage
npm run docs         # generate API docs → docs/api/
npm run attw         # build + TypeScript declaration check
```

## Release (manual)

1. Bump `version` in `packages/cytoscape-compound-graph/package.json`
2. Update `packages/cytoscape-compound-graph/CHANGELOG.md`
3. From repo root:

```bash
npm run build
npm run test:coverage
npm run docs
npm run attw
cd packages/cytoscape-compound-graph
npm publish --access public
npm deprecate @dgillard/nested-cytoscope-vertex "Renamed to @dgillard/cytoscape-compound-graph"
```

## API documentation

Generated TypeDoc output lives in [`docs/api/`](docs/api/) after `npm run docs`.

## Monorepo layout

| Path | Role |
|------|------|
| `packages/cytoscape-compound-graph/` | Publishable library |
| `apps/demo/` | Vite + React manual test harness |

## Relation to bellman-gui

This repo extracts and validates compound resize behaviour from bellman-gui. When a fix works here, port the same change back to the main app.
