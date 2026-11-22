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

## Phase 2 — Per-part authoring and visual effects

### Authoring workflow for articulated assets

The target is any multi-part GLB/glTF, not one category of model. A drone can check rotation, an elevator or machine can check nested moving parts, and a product/architectural asset can check selection and group transforms. The first selection pass now has an explicit marquee-select mode: left-to-right selects fully enclosed meshes, right-to-left selects intersecting meshes, Shift adds, and hierarchy modifiers toggle nodes. Group transforms and separate per-node keyframes are supported. A box-select gesture does not start camera orbit. The dense articulated test asset verified visible selection, additive multi-selection, group movement, and topology display in a live WebGPU browser session; broader asset and nested-transform coverage remains open.

Rotor rotation depends on the mesh node's pivot. If the GLB has a rotor joint/group with its origin at the shaft, animate that parent node. If the asset has a misplaced origin, use a dedicated pivot-edit operation that preserves the visible pose and serializes the pivot with the project; do not fake this by translating the blade geometry or by assuming all GLBs have the same hierarchy.

### Modular boundaries

- `domain/scene`: stable node IDs, transforms, visibility, and project serialization; no React or Three.js objects.
- `features/selection`: click/marquee selection, modifier-add/toggle behavior, and selected IDs.
- `features/animation`: time sampling, transform tracks, playback state, and keyframe commands.
- `features/effects`: effect definitions and parameters, beginning with dissolve; each effect has preview, save/load, and export adapters.
- `renderer/three`: applies scene data/effects to Three.js and owns GPU resources and disposal.
- `export/three`: generates runtime code from the same versioned scene and animation data used by the editor.
- `ui`: panels and controls that call feature APIs rather than mutating Three.js objects directly.

Keep authored effect values serializable and renderer-independent. Put TSL/WebGPU-specific shader code behind the renderer adapter; don't put shader state in React or the timeline. This lets effects be previewed in the editor and regenerated for the exported runtime without coupling the project format to one rendering backend.

### Phase 2 implementation status

The Phase 2 feature pass is implemented:

- Mesh click picking resolves the frontmost visible mesh and ignores hidden ancestors. Marquee selection has containment and crossing modes, modifier-add behavior, multi-selection, and group transform controls.
- Meshes can be inspected for vertex/triangle/material counts and toggled into wireframe. Local pivot editing supports last-hit placement and numeric adjustment while preserving the current visible pose; pivot values are included in project data.
- Per-mesh effects include reversible, playhead-driven dissolve and burn surface effects plus deterministic GPU-vertex-animated point particles. Timing and effect settings are serializable. The editor preview and generated Three.js runtime have adapters for the same effect data.
- Automated checks cover visible picking, marquee selection, additive selection, pivot pose preservation/reset, effect timing, and effect-schema bounds. The production build and generated-runtime syntax check pass.

Phase 2 implementation and its defined acceptance workflow are complete on the test fixture, but this is not a production-readiness certification. A live WebGPU browser session verified visible mesh selection, marquee selection, multi-selection and group movement; wireframe and geometry counts; project archive reopen with transforms, pivot, keyframes and effects; and dissolve/burn/particle preview. The generated Three.js runtime was also served independently and verified for rotor animation and visible effects without browser console errors. These checks use a generated dense articulated GLTF fixture and a generated project archive, not a matrix of external customer assets, GPUs, and browsers. The actual UI download-to-disk flow and external-resource folder imports were not exercised because the task is restricted to editing this repo. The particles are GPU vertex-shader animated points with a bounded configurable count; they are not a compute-based fluid, collision, or destruction system.

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
- Complete visibility authoring and accurate material inspection before adding material editing. Pivot editing is now implemented; verify it across nested real assets.
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

The implementation includes the P0 fixes identified in the audit, the selection/transform/diagnostics UX pass, and the Phase 2 feature set above. `npm test`, `npm run typecheck`, `npm run build`, and generated runtime syntax validation pass on the current `phase-2` branch. A generated dense articulated GLTF fixture and saved-project archive were used for live browser checks of Phase 2 preview and interactions, and the generated runtime was independently served and inspected. The Phase 2 feature milestone is complete on that defined fixture workflow. External-asset/browser/device coverage, the UI download-to-disk path, and P1–P4 release criteria remain open; do not describe Forge as production-ready until those acceptance checks pass.
