# Project Context

## Product

Forge is a developer-oriented visual authoring tool for creating and integrating interactive 3D behavior into existing Three.js web projects. Its primary user is a web developer working with Three.js or React Three Fiber who wants to manipulate and animate objects without hand-writing every scene operation.

## Product hypothesis

The hypothesis is that developers value a fast asset-to-code workflow: bring in an existing GLB, author scene behavior visually, and keep the resulting data or generated code under their control. This is a hypothesis, not a proven market advantage. Validate it with developer interviews and direct comparisons against Spline, Three.js Editor, Blender, and PlayCanvas.

## First complete workflow

- Import GLB/glTF.
- Select, inspect, hide, and organize scene objects.
- Author position, rotation, and scale tracks with a predictable timeline.
- Save and reopen portable project data.
- Export maintainable Three.js code and validate it in an independent app.

## WebGPU direction

Use Three.js `WebGPURenderer` as the editor renderer. Prefer WebGPU where available and retain Three.js's WebGL 2 backend fallback. Use TSL and node materials for custom materials and effects intended to work across both backends. Build toward serious GPU workloads in stages: measure the real frame and memory costs, prototype a TSL material or compute pass, then compare quality and performance across WebGPU and the fallback backend. Good candidates include large particle effects, procedural burn/dissolve fields, and GPU deformation. Do not move serialization, editor UI, or ordinary scene orchestration into WASM or GPU compute without evidence that it helps.

Keep the renderer behind a small adapter boundary. Track WebGPU device loss, initialization failures, browser support, renderer version, and fallback status. Keep user-authored project data renderer-independent.

## Architecture rules

- TypeScript, React, Vite, and Three.js.
- Keep serializable authoring state separate from the live Three.js scene.
- Use stable authoring IDs; do not persist transient Three.js UUIDs.
- Version, validate, and migrate project files.
- Define imported file limits and report parse, network, and GPU errors in the UI.
- Dispose geometries, materials, textures, workers, listeners, and GPU resources on replacement and exit.
- Treat generated output as a product surface: deterministic output, clear runtime dependencies, and an external fixture app are required.
- Pin dependency versions and document supported Three.js/browser versions.

## Non-goals for the first release

- Replacing Blender for asset creation.
- A proprietary rendering engine or general game engine.
- Broad model format support before GLB/glTF is reliable.
- Full rigging, simulation, destructive effects, or general physics authoring before the core workflow is validated.

## Current status

The editor currently has a WebGPU renderer, GLB/glTF import with companion files, recursive and marquee hierarchy selection, group transforms, mesh statistics/wireframe, pivot editing, transform keyframes, and dissolve/burn/point-particle effects with project serialization and generated-runtime adapters. Automated selection, pivot, and effect-schema checks, TypeScript checking, production bundling, and generated-runtime parsing pass. The generated app and WebGPU effects have not yet been visually verified in a live browser against representative assets. Automatic local recovery, undo/redo, stronger animation semantics, device-loss handling, and browser-level coverage remain required before production release. See `PRODUCTION_ROADMAP.md` for the full pipeline audit and acceptance criteria.
