# Forge 3D

Forge is a developer-first scene and animation workspace for Three.js applications. It starts with the path from a GLB asset to editable scene behavior and portable project data.

## Product scope

The first product milestone is one dependable workflow:

1. Import a GLB or glTF model, including companion textures and buffers for file based glTF.
2. Inspect and select objects in its hierarchy.
3. Edit transforms and author transform keyframes.
4. Preview, scrub, save, and reopen the work.
5. Export runnable, readable Three.js output and verify it outside the editor.

This is a focused authoring and integration tool. It complements Blender and existing Three.js/R3F applications; it is not a modeling suite or a general game engine. Object visibility tracks, visual effects, rig editing, and collider authoring are separate capabilities and should arrive only after the asset-to-runtime workflow is reliable.

## Rendering direction

The editor uses `WebGPURenderer` from `three/webgpu`. Three.js selects its WebGPU backend when available and can fall back to WebGL 2. Materials are node materials so future TSL effects can target both renderer backends. The editor should expose the active backend and report GPU initialization errors clearly.

WebGPU is the preferred path for node materials, GPU-driven rendering, and future compute workloads. Workloads should move to GPU compute when they are parallel and data-heavy; project serialization, timeline authoring, and scene orchestration remain ordinary TypeScript. Use existing WASM libraries for CPU-side algorithms when profiling shows a need. This project does not need a custom WASM runtime to use WebGPU.

“WebGPU-first” does not mean every feature must run on the GPU. The editor must keep asset compatibility, deterministic authoring, and a clear fallback path. Treat browser/device support and Three.js WebGPU API changes as compatibility constraints, and pin/document the supported Three.js version.

## Data boundaries

- `src/SceneViewport.tsx` owns the live Three.js scene, GPU renderer, controls, and imported object instances.
- Project data is plain, versioned JSON. It must not serialize Three.js objects or rely on transient `Object3D.uuid` values.
- Object IDs are authoring IDs stored in `userData.forgeId`; import and reload must preserve or reconstruct IDs in a documented way.
- Generated runtime code must be deterministic, readable, and tested in a separate example app before it is described as production export.

## Development

```sh
npm ci
npm run dev
```

Create a production bundle with `npm run build`. WebGPU is available only in supported browsers and secure contexts (localhost is considered secure by browsers). A WebGL 2 backend is expected when WebGPU cannot initialize.

## Current implementation status

The editor includes a WebGPU viewport, GLB/glTF import, recursive object hierarchy, click and marquee multi-selection, group transforms, per-object transform keyframes, timeline scrubbing and whole-scene playback, local pivot editing, mesh statistics and wireframe, and dissolve, burn, and point-particle effects. Effect data and pivots are saved in the editable ZIP project and applied by the generated Three.js runtime. The generated `.forge.js` entry embeds the saved scene and animation data; its referenced `assets/` paths must exist beside it in the consuming app. Imported files are limited to 100 MB each and 150 MB total. Companion glTF files can be selected together or imported from their containing folder.

This is an early product build, not a production release. Automated unit checks and the production build pass, but independent runtime playback and visual GPU parity for selection, pivots, and effects still need verification on representative GLB assets. Undo/redo, local recovery, full keyframe editing, device-loss recovery, and browser-level workflow coverage remain outstanding. See [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md) for the audit and release acceptance criteria.
