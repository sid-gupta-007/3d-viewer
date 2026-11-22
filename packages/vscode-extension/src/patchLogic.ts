import * as path from 'path';
import type { ForgeSceneManifest, Vec3 } from './protocol.js';

export const FORGE_BEGIN_MARKER = '// @forge:begin';
export const FORGE_END_MARKER = '// @forge:end';
export const DEFAULT_SCENE_RELATIVE_PATH = '.forge/scene.json';

/**
 * Resolves a relative or workspace-scoped path and ensures it cannot escape `workspaceRoot`.
 */
export function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  if (!workspaceRoot) {
    throw new Error('No workspace folder is open.');
  }
  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(normalizedRoot, targetPath);

  const rel = path.relative(normalizedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }
  return resolved;
}

/**
 * Validates that a scene read/write target is `.forge/scene.json` or a `.forge.json` file.
 */
export function assertSceneFilePath(resolvedPath: string): void {
  const normalized = resolvedPath.replace(/\\/g, '/');
  if (normalized.endsWith('/.forge/scene.json') || normalized.endsWith('.forge.json')) {
    return;
  }
  throw new Error(`Scene path must target .forge/scene.json or *.forge.json (got ${resolvedPath})`);
}

/**
 * Validates that a code-patch target is a `.ts` or `.tsx` file.
 */
export function assertTsPatchTarget(resolvedPath: string): void {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== '.ts' && ext !== '.tsx') {
    throw new Error(`Patch target must be a .ts or .tsx file (got ${resolvedPath})`);
  }
}

function fmtVec(v: Vec3): string {
  return `[${v.map((n) => Number(n.toFixed(4))).join(', ')}]`;
}

/**
 * Generates a marker-bounded R3F configuration block from a ForgeSceneManifest.
 */
export function generateForgeBlock(manifest: ForgeSceneManifest): string {
  const nodeOverrides = (manifest.nodes ?? [])
    .filter((n) => n.parentId !== null)
    .map(
      (n) =>
        `  '${n.forgeId}': { name: '${n.name.replace(/'/g, "\\'")}', position: ${fmtVec(
          n.position
        )}, rotation: ${fmtVec(n.rotation)}, scale: ${fmtVec(n.scale)}, visible: ${Boolean(
          n.visible
        )} },`
    )
    .join('\n');

  return `${FORGE_BEGIN_MARKER}
export const FORGE_SCENE_CONFIG = {
  assetPath: '${manifest.assetPath}',
  camera: {
    position: ${fmtVec(manifest.camera.position)} as [number, number, number],
    target: ${fmtVec(manifest.camera.target)} as [number, number, number],
    fov: ${manifest.camera.fov},
  },
  xrEnabled: ${Boolean(manifest.environment?.xrEnabled)},
  nodes: {
${nodeOverrides}
  },
} as const
${FORGE_END_MARKER}`;
}

export interface PatchOutcome {
  nextSource: string;
  mode: 'marker-replace' | 'create' | 'replace';
}

/**
 * Applies a marker-aware patch to an existing `.ts`/`.tsx` source string.
 * - If `// @forge:begin` and `// @forge:end` exist, only the bounded block is replaced.
 * - If the file is empty/new, creates the file with the provided content or generated block.
 * - Otherwise replaces the file with `nextContent` if provided, or appends the generated block.
 */
export function computePatchedTsSource(
  existingSource: string | null,
  nextContent: string | undefined,
  manifest: ForgeSceneManifest | undefined
): PatchOutcome {
  const blockOrContent =
    nextContent ?? (manifest ? generateForgeBlock(manifest) : undefined);

  if (blockOrContent === undefined) {
    throw new Error('Either content or manifest must be provided to patch a .ts/.tsx file.');
  }

  if (existingSource === null) {
    return { nextSource: blockOrContent, mode: 'create' };
  }

  const startIdx = existingSource.indexOf(FORGE_BEGIN_MARKER);
  const endIdx = existingSource.indexOf(FORGE_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const replacementBlock = extractMarkerBlock(blockOrContent) ?? blockOrContent;
    const nextSource =
      existingSource.slice(0, startIdx) +
      replacementBlock +
      existingSource.slice(endIdx + FORGE_END_MARKER.length);
    return { nextSource, mode: 'marker-replace' };
  }

  if (nextContent !== undefined) {
    return { nextSource: nextContent, mode: 'replace' };
  }

  const separator = existingSource.endsWith('\n') ? '\n' : '\n\n';
  return { nextSource: `${existingSource}${separator}${blockOrContent}\n`, mode: 'replace' };
}

function extractMarkerBlock(source: string): string | null {
  const startIdx = source.indexOf(FORGE_BEGIN_MARKER);
  const endIdx = source.indexOf(FORGE_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }
  return source.slice(startIdx, endIdx + FORGE_END_MARKER.length);
}
