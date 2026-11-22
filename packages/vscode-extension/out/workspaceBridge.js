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
exports.getPrimaryWorkspaceRoot = getPrimaryWorkspaceRoot;
exports.readSceneManifestFromWorkspace = readSceneManifestFromWorkspace;
exports.writeSceneManifestToWorkspace = writeSceneManifestToWorkspace;
exports.patchTsFileInWorkspace = patchTsFileInWorkspace;
exports.buildInitMessage = buildInitMessage;
exports.handleWebviewMessage = handleWebviewMessage;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const patchLogic_js_1 = require("./patchLogic.js");
function getPrimaryWorkspaceRoot() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : null;
}
async function readSceneManifestFromWorkspace(workspaceRoot, relativePath = patchLogic_js_1.DEFAULT_SCENE_RELATIVE_PATH) {
    const resolved = (0, patchLogic_js_1.resolveWorkspacePath)(workspaceRoot, relativePath);
    (0, patchLogic_js_1.assertSceneFilePath)(resolved);
    const uri = vscode.Uri.file(resolved);
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        return { path: resolved, manifest: JSON.parse(text) };
    }
    catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            return { path: resolved, manifest: null };
        }
        if (err && typeof err === 'object' && 'code' in err && err.code === 'FileNotFound') {
            return { path: resolved, manifest: null };
        }
        throw err;
    }
}
async function writeSceneManifestToWorkspace(workspaceRoot, manifest, relativePath = patchLogic_js_1.DEFAULT_SCENE_RELATIVE_PATH) {
    const resolved = (0, patchLogic_js_1.resolveWorkspacePath)(workspaceRoot, relativePath);
    (0, patchLogic_js_1.assertSceneFilePath)(resolved);
    const dirUri = vscode.Uri.file(path.dirname(resolved));
    await vscode.workspace.fs.createDirectory(dirUri);
    const formatted = `${JSON.stringify(manifest, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(resolved), Buffer.from(formatted, 'utf8'));
    return resolved;
}
async function patchTsFileInWorkspace(workspaceRoot, targetPath, content, manifest) {
    const resolved = (0, patchLogic_js_1.resolveWorkspacePath)(workspaceRoot, targetPath);
    (0, patchLogic_js_1.assertTsPatchTarget)(resolved);
    const fileUri = vscode.Uri.file(resolved);
    let existingSource = null;
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        existingSource = doc.getText();
    }
    catch {
        existingSource = null;
    }
    const { nextSource, mode } = (0, patchLogic_js_1.computePatchedTsSource)(existingSource, content, manifest);
    if (existingSource === null) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolved)));
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(nextSource, 'utf8'));
        return { path: resolved, mode };
    }
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(existingSource.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(fileUri, fullRange, nextSource);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error(`Failed to apply workspace edit to ${targetPath}`);
    }
    await doc.save();
    return { path: resolved, mode };
}
function getMimeTypeForUri(uri) {
    const lower = uri.fsPath.toLowerCase();
    if (lower.endsWith('.glb'))
        return 'model/gltf-binary';
    if (lower.endsWith('.gltf'))
        return 'model/gltf+json';
    return 'application/json';
}
async function buildInitMessage(activeAssetUri) {
    const workspaceRoot = getPrimaryWorkspaceRoot();
    const defaultScenePath = patchLogic_js_1.DEFAULT_SCENE_RELATIVE_PATH;
    let sceneManifest = null;
    if (workspaceRoot) {
        try {
            const read = await readSceneManifestFromWorkspace(workspaceRoot, defaultScenePath);
            sceneManifest = read.manifest;
        }
        catch {
            sceneManifest = null;
        }
    }
    return {
        type: 'forge:init',
        workspaceRoot,
        activeAssetPath: activeAssetUri ? activeAssetUri.fsPath : null,
        activeAssetUri: activeAssetUri ? activeAssetUri.toString() : null,
        scenePath: defaultScenePath,
        sceneManifest,
    };
}
async function handleWebviewMessage(msg, ctx) {
    const post = (payload) => ctx.webview.postMessage(payload);
    const workspaceRoot = getPrimaryWorkspaceRoot();
    switch (msg.type) {
        case 'forge:ready': {
            await post(await buildInitMessage(ctx.activeAssetUri));
            return;
        }
        case 'forge:readScene': {
            const targetPath = msg.path ?? patchLogic_js_1.DEFAULT_SCENE_RELATIVE_PATH;
            try {
                if (!workspaceRoot) {
                    throw new Error('No workspace folder is open.');
                }
                const res = await readSceneManifestFromWorkspace(workspaceRoot, targetPath);
                await post({
                    type: 'forge:sceneData',
                    requestId: msg.requestId,
                    ok: true,
                    path: res.path,
                    manifest: res.manifest,
                });
            }
            catch (err) {
                await post({
                    type: 'forge:sceneData',
                    requestId: msg.requestId,
                    ok: false,
                    path: targetPath,
                    manifest: null,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
        case 'forge:writeScene': {
            const targetPath = msg.path ?? patchLogic_js_1.DEFAULT_SCENE_RELATIVE_PATH;
            try {
                if (!workspaceRoot) {
                    throw new Error('No workspace folder is open.');
                }
                const writtenPath = await writeSceneManifestToWorkspace(workspaceRoot, msg.manifest, targetPath);
                await post({
                    type: 'forge:writeSceneResult',
                    requestId: msg.requestId,
                    ok: true,
                    path: writtenPath,
                });
            }
            catch (err) {
                await post({
                    type: 'forge:writeSceneResult',
                    requestId: msg.requestId,
                    ok: false,
                    path: targetPath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
        case 'forge:patchFile': {
            const configTarget = vscode.workspace
                .getConfiguration('forge3d')
                .get('defaultTargetFile', 'src/ForgeScene.tsx');
            const targetPath = msg.targetPath || configTarget;
            try {
                if (!workspaceRoot) {
                    throw new Error('No workspace folder is open.');
                }
                const res = await patchTsFileInWorkspace(workspaceRoot, targetPath, msg.content, msg.manifest);
                await post({
                    type: 'forge:patchFileResult',
                    requestId: msg.requestId,
                    ok: true,
                    path: res.path,
                    mode: res.mode,
                });
            }
            catch (err) {
                await post({
                    type: 'forge:patchFileResult',
                    requestId: msg.requestId,
                    ok: false,
                    path: targetPath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
        case 'forge:readAsset': {
            const targetUri = msg.uri ? vscode.Uri.parse(msg.uri) : ctx.activeAssetUri;
            if (!targetUri) {
                await post({
                    type: 'forge:assetData',
                    requestId: msg.requestId,
                    ok: false,
                    uri: '',
                    mimeType: 'application/octet-stream',
                    error: 'No active asset URI provided.',
                });
                return;
            }
            try {
                if (workspaceRoot) {
                    (0, patchLogic_js_1.resolveWorkspacePath)(workspaceRoot, targetUri.fsPath);
                }
                const bytes = await vscode.workspace.fs.readFile(targetUri);
                await post({
                    type: 'forge:assetData',
                    requestId: msg.requestId,
                    ok: true,
                    uri: targetUri.toString(),
                    mimeType: getMimeTypeForUri(targetUri),
                    base64: Buffer.from(bytes).toString('base64'),
                });
            }
            catch (err) {
                await post({
                    type: 'forge:assetData',
                    requestId: msg.requestId,
                    ok: false,
                    uri: targetUri.toString(),
                    mimeType: getMimeTypeForUri(targetUri),
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
        case 'forge:listWorkspaceFiles': {
            try {
                const pattern = msg.include ?? '**/*.{ts,tsx,glb,gltf,forge.json}';
                const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);
                const files = uris
                    .map((u) => (workspaceRoot ? path.relative(workspaceRoot, u.fsPath) : u.fsPath))
                    .sort();
                await post({
                    type: 'forge:workspaceFiles',
                    requestId: msg.requestId,
                    ok: true,
                    files,
                });
            }
            catch (err) {
                await post({
                    type: 'forge:workspaceFiles',
                    requestId: msg.requestId,
                    ok: false,
                    files: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return;
        }
    }
}
//# sourceMappingURL=workspaceBridge.js.map