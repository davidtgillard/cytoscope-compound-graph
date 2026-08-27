# Changelog

## Unreleased

- A child drag that hits a sibling or the container wall now stops at the last legal position instead of jumping back to where the node was grabbed. Child drag resolves the same way a container drag already does: one frame at a time from the last rest pose, so the node cannot occupy an invalid position.
- Child-drag collision keeps using the label-inclusive footprint measured at pointer-down. The hidden Cytoscape node is pinned to the live model each frame so a later re-measure cannot drop the label and replay the gesture from the grab point.
- Leaf footprints include the CSS line-box of the label (em-box and `text-outline`), not just glyph ink, so a child cannot be dragged onto the parent perimeter and then jump back.
- Compound edge clearance is never negative. Shrinking a parent toward a child stops at the child's line-box plus clearance, so a resize cannot change a child's size by covering it.

## 0.2.0

Package renamed from `@dgillard/nested-cytoscope-vertex` to `@dgillard/cytoscape-compound-graph`.

- Viewport clamping during parent drag and corner resize keeps compounds inside the visible Cytoscape container (`clampParentToViewport`, `viewportPaddingPx` on theme and `GraphParentVertex` / `CompoundGraphScene`; enabled by default)
- Load-time unjam separates compounds and children that arrive stacked or outside their container, growing containers only as far as needed
- `CompoundGraphScene.flatLayoutForSubtree` returns the layout entries a corner resize can change (the container plus its descendants), which is the set a consumer must persist after a resize; saving only the container's entry re-loads with every child displaced by half the corner drag
- Drags and resizes now hold their positional guarantees regardless of unjam, viewport clamping, or nesting depth: a drag moves only the dragged subtree, a container drag is a rigid translation of constant extent, and a resize moves nothing at all (see `layout-invariants.test.ts` and `compound-graph-scene.invariants.test.ts`)

- `CompoundGraphScene` graph-wide coordinator for multiple nested compounds on one canvas
- Exported layout model APIs: `buildLayoutModel`, `flatLayoutFromModel`, `cloneLayoutModel`, `LayoutNodeInput`, `WorkPackageLayoutModel`, `LayoutNode`
- Exported Cytoscape sync helpers: `layoutModelFromCy`, `applyLayoutModelToCy`
- `OVERFLOW_NODE_PREFIX` and `isOverflowNodeId` for synthetic overflow leaves
- `mergeCompoundGraphStylesheet` to layer compound rules onto consumer stylesheets

## 0.1.0

Initial publishable release of `@dgillard/nested-cytoscope-vertex` (renamed to `@dgillard/cytoscape-compound-graph` in 0.2.0).

- `GraphParentVertex` compound graph API with corner resize and detached child drag
- Theming via `CompoundGraphTheme`, `createCompoundGraphStylesheet`, and `leafDomVisualStyle`
- Snapshot helpers for debug/drift detection
