# Forge production plan

## Release target

Ship a dependable desktop-class web editor for the path from a GLB/glTF asset to editable transform animation and a portable Three.js runtime. Forge is not a mesh modeler or a game engine. Production readiness means the supported workflow is predictable, saved work reopens faithfully, and generated output runs independently of the editor.

## Current audit

- The editor state and live Three.js scene can diverge during development hot reload. The renderer could keep an imported model while React restarted with an empty hierarchy. The import overlay then obscured the live model.
- The hierarchy previously rendered only root objects and their immediate children. Deep glTF hierarchies were omitted.
- Imported assets need reliable ground placement and camera framing. Transform gizmos still use authored object pivots, which can legitimately be far from visible geometry.
- The inspector previously showed hardcoded material values. Those controls have been removed until they can edit real materials.
- Several visible buttons had no behavior. The active milestone should expose only working controls.
- Project archives had basic validation, but object references, graph cycles, duplicate IDs, and asset paths were not checked fully.
- The generated export had not been run as a separate application. Its entry URL also assumed a site-root deployment.
- The current project is an in-memory session until the user downloads a `.forge.zip`; automatic recovery, undo/redo, and formal browser coverage are not present.
- Mesh-level inspection was missing: selection feedback was too subtle, per-node transformability was hard to use, and developers could not see triangle/vertex counts or a wireframe view.

## Product value for developers

Forge should shorten the gap between receiving a finished GLB and integrating it into a Three.js application. It should complement Blender, which remains the right place to model and author complex rigs. The developer-facing value is fast hierarchy inspection, reliable per-node transforms and animation, visual debugging (bounds, topology and later material/texture health), and a portable project/runtime export that developers can review and adapt. Avoid claiming a market gap until the end-to-end output has been compared with existing tools and validated with Three.js developers.

The most useful expansion sequence is: (1) dependable mesh selection and transforms, (2) mesh diagnostics and isolation, (3) authored visibility/transform animation, (4) export and integration checks, then (5) advanced effects, skeletal controls, and colliders based on developer feedback.

## Phase 1 — GLB to animated Three.js output

The first product phase is intentionally narrow: import GLB/glTF, animate position/rotation/scale on selected nodes, scrub and preview the timeline, then produce Three.js output a developer can run or adapt. The editor now has direct generated entry-code export that embeds project/animation data, plus the editable ZIP project export. The remaining phase-one gate is to run a representative exported project independently, compare its hierarchy/transforms/playback against Forge, and fix any mismatch before calling the pipeline complete.

## Execution plan

### P0 — Correctness and data integrity

- Keep the visible hierarchy synchronized with the live scene, including a retained scene after hot reload.
- Support arbitrary hierarchy depth, stable selection, explicit clear/replace behavior, and empty projects.
- Frame and ground imported assets; preserve each imported object's baseline transform for reset.
- Validate node graphs, references, animation targets, asset paths, archive limits, and supported project versions before changing the current scene.
- Keep all visible controls truthful and disable actions that require a selection.

**Acceptance:** import a nested model, select any level, edit/reset transforms, clear/open an empty project, and confirm the canvas, hierarchy, inspector, and object count always agree.

### P1 — Complete authoring workflow

- Define transform keyframe interpolation, endpoint behavior, loop behavior, and rotation semantics.
- Support selecting, moving, deleting, and navigating keyframes; make playhead scrubbing work by mouse and keyboard.
- Add undo/redo for scene edits and model replacement.
- Add explicit pivot handling, visibility authoring, and accurate material inspection before adding material editing.
- Expand mesh diagnostics with bounds, wireframe, isolation, normals, draw-call/material grouping, and a model-health report for missing or unsupported asset data.
- Persist recoverable local sessions in IndexedDB and report save state.

**Acceptance:** author an animation, close/reopen the app, and recover the same asset, transforms, visibility, and timeline state; undo and redo every supported edit.

### P2 — Portable project and runtime export

- Verify project archives across import/save/reopen cycles, including external glTF resources and malformed archives.
- Generate deterministic runtime source with pinned dependencies and relative URLs.
- Run the exported application independently on a root path and a subpath; compare the rendered transforms and animation to the editor.
- Document renderer fallback behavior and browser requirements.

**Acceptance:** a clean checkout can install and run the exported project without access to the editor, and the output matches the saved project.

### P3 — GPU and scale readiness

- Measure import time, frame time, GPU memory, and draw calls on representative small and large assets.
- Add WebGPU device-loss handling, initialization diagnostics, and a tested fallback path.
- Profile before optimizing; then prototype TSL materials or compute for measured parallel workloads such as particles or deformation.
- Keep serialization, scene orchestration, and editor state on the CPU. Introduce WASM only for a measured CPU bottleneck with a maintained library.

**Acceptance:** publish supported browser/device ranges and performance budgets; verify fallback and device-loss recovery on target hardware.

### P4 — Release operations and usability

- Add browser-level coverage for the supported workflows, accessibility and keyboard navigation, error boundaries, and crash-safe project writes.
- Remove or implement remaining placeholder actions; add onboarding, recovery guidance, and user-facing documentation.
- Pin the toolchain, maintain dependency/security updates, and test release builds on Windows and at least one non-Windows platform.

**Acceptance:** release checklist passes on the supported browser matrix with no data-loss issues in the core workflow.

## Current execution status

The current pass addresses the P0 issues identified in the audit: scene/hierarchy resynchronization, hierarchy depth, imported framing, baseline transform reset, stricter archive validation, relative export entry URL, and removal of misleading controls. The current UX pass adds visible selected-row feedback, selected-object bounds, per-node viewport picking in transform modes, mesh/vertex/triangle/material/bounds statistics, a wireframe toggle, and direct generated Three.js entry-code export with embedded project/animation data. `npm run build` passes. Independent runtime playback verification and a live pointer interaction check with representative assets are still needed. P1–P4 remain planned work; do not describe the product as production-ready until their acceptance criteria are met.
