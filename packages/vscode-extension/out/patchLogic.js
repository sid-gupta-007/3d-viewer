"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SCENE_RELATIVE_PATH = exports.FORGE_END_MARKER = exports.FORGE_BEGIN_MARKER = void 0;
exports.resolveWorkspacePath = resolveWorkspacePath;
exports.assertSceneFilePath = assertSceneFilePath;
exports.assertTsPatchTarget = assertTsPatchTarget;
exports.generateForgeBlock = generateForgeBlock;
exports.computePatchedTsSource = computePatchedTsSource;
const path = __importStar(require("path"));
exports.FORGE_BEGIN_MARKER = '// @forge:begin';
exports.FORGE_END_MARKER = '// @forge:end';
exports.DEFAULT_SCENE_RELATIVE_PATH = '.forge/scene.json';
/**
 * Resolves a relative or workspace-scoped path and ensures it cannot escape `workspaceRoot`.
 */
function resolveWorkspacePath(workspaceRoot, targetPath) {
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
function assertSceneFilePath(resolvedPath) {
    const normalized = resolvedPath.replace(/\\/g, '/');
    if (normalized.endsWith('/.forge/scene.json') || normalized.endsWith('.forge.json')) {
        return;
    }
    throw new Error(`Scene path must target .forge/scene.json or *.forge.json (got ${resolvedPath})`);
}
/**
 * Validates that a code-patch target is a `.ts` or `.tsx` file.
 */
function assertTsPatchTarget(resolvedPath) {
    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext !== '.ts' && ext !== '.tsx') {
        throw new Error(`Patch target must be a .ts or .tsx file (got ${resolvedPath})`);
    }
}
function fmtVec(v) {
    return `[${v.map((n) => Number(n.toFixed(4))).join(', ')}]`;
}
/**
 * Generates a marker-bounded R3F configuration block from a ForgeSceneManifest.
 */
function generateForgeBlock(manifest) {
    const nodeOverrides = (manifest.nodes ?? [])
        .filter((n) => n.parentId !== null)
        .map((n) => `  '${n.forgeId}': { name: '${n.name.replace(/'/g, "\\'")}', position: ${fmtVec(n.position)}, rotation: ${fmtVec(n.rotation)}, scale: ${fmtVec(n.scale)}, visible: ${Boolean(n.visible)} },`)
        .join('\n');
    return `${exports.FORGE_BEGIN_MARKER}
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
${exports.FORGE_END_MARKER}`;
}
/**
 * Applies a marker-aware patch to an existing `.ts`/`.tsx` source string.
 * - If `// @forge:begin` and `// @forge:end` exist, only the bounded block is replaced.
 * - If the file is empty/new, creates the file with the provided content or generated block.
 * - Otherwise replaces the file with `nextContent` if provided, or appends the generated block.
 */
function computePatchedTsSource(existingSource, nextContent, manifest) {
    const blockOrContent = nextContent ?? (manifest ? generateForgeBlock(manifest) : undefined);
    if (blockOrContent === undefined) {
        throw new Error('Either content or manifest must be provided to patch a .ts/.tsx file.');
    }
    if (existingSource === null) {
        return { nextSource: blockOrContent, mode: 'create' };
    }
    const startIdx = existingSource.indexOf(exports.FORGE_BEGIN_MARKER);
    const endIdx = existingSource.indexOf(exports.FORGE_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
        const replacementBlock = extractMarkerBlock(blockOrContent) ?? blockOrContent;
        const nextSource = existingSource.slice(0, startIdx) +
            replacementBlock +
            existingSource.slice(endIdx + exports.FORGE_END_MARKER.length);
        return { nextSource, mode: 'marker-replace' };
    }
    if (nextContent !== undefined) {
        return { nextSource: nextContent, mode: 'replace' };
    }
    const separator = existingSource.endsWith('\n') ? '\n' : '\n\n';
    return { nextSource: `${existingSource}${separator}${blockOrContent}\n`, mode: 'replace' };
}
function extractMarkerBlock(source) {
    const startIdx = source.indexOf(exports.FORGE_BEGIN_MARKER);
    const endIdx = source.indexOf(exports.FORGE_END_MARKER);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return null;
    }
    return source.slice(startIdx, endIdx + exports.FORGE_END_MARKER.length);
}
//# sourceMappingURL=patchLogic.js.map