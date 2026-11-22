---
name: forge-3d
description: Inspect and edit Forge 3D scene manifests (.forge/scene.json), set camera poses, node transforms, and animation keyframes, and sync React Three Fiber (R3F) code exports via the forge-3d-mcp server.
---

# Forge 3D Scene Authoring Skill

Use this skill when working in a Forge 3D workspace that stores scene state in `.forge/scene.json` (matching `ForgeSceneManifest` in `src/domain/sceneManifest.ts`) and exports React Three Fiber components using `// @forge:begin` ... `// @forge:end` markers.

## MCP Server

The standalone stdio MCP server lives in `packages/mcp-server/` and runs with Node >= 22.18 (no build step required):

```json
{
  "mcpServers": {
    "forge-3d": {
      "command": "node",
      "args": ["packages/mcp-server/src/index.ts", "--root", "."]
    }
  }
}
```

You can also set `FORGE_PROJECT_ROOT` in the environment or pass `projectRoot` per tool call.

## Available Tools

1. **`get_scene_summary`**
   - Reads `.forge/scene.json` and returns `projectName`, `assetPath`, `loopMode`, `camera`, `environment` (preset, background, exposure, xrEnabled, fog, lights), `nodes`, and `keyframes`.
   - Always call this first to discover valid `forgeId` values before editing nodes or keyframes.

2. **`set_camera_pose`**
   - Updates `camera.position`, `camera.target`, `camera.fov`, `camera.near`, or `camera.far` in `.forge/scene.json`.
   - Initializes a default `.forge/scene.json` if one does not exist yet.

3. **`set_node_transform`**
   - Updates `position`, `rotation` (Euler radians), `scale`, `visible`, `pivot`, or `name` for a node identified by `forgeId`.
   - Pass `createIfMissing: true` only when intentionally adding a new node entry.

4. **`add_animation_keyframe`**
   - Adds or updates a `KeyframeManifest` for `targetId` at `time` (seconds >= 0), with optional `position`, `rotation`, `scale`, and `easing` (`linear`, `easeInOut`, `easeIn`, `easeOut`, `step`).
   - Omitted transform fields default to the target node's current transform. Keyframes are kept sorted by `time`.

5. **`sync_code_export`**
   - Generates a new R3F `.tsx` file at `outputPath` if missing, or patches the existing file between `// @forge:begin` and `// @forge:end` markers so custom user code outside those markers is preserved.

## Recommended Workflow

1. Call `get_scene_summary` to inspect the current camera, nodes (`forgeId`), and keyframes.
2. Apply scene edits with `set_camera_pose`, `set_node_transform`, and `add_animation_keyframe`.
3. Call `sync_code_export` with the target R3F component path (e.g. `src/GeneratedScene.tsx`) to update the generated React Three Fiber code without overwriting custom logic outside the `@forge` markers.
4. Run project tests/typecheck to verify the exported component compiles cleanly.
