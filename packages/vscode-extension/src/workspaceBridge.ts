import * as path from 'path';
import * as vscode from 'vscode';
import {
  assertSceneFilePath,
  assertTsPatchTarget,
  computePatchedTsSource,
  DEFAULT_SCENE_RELATIVE_PATH,
  resolveWorkspacePath,
} from './patchLogic.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './protocol.js';

export interface BridgeContext {
  webview: vscode.Webview;
  activeAssetUri?: vscode.Uri;
}

export function getPrimaryWorkspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : null;
}

export async function readSceneManifestFromWorkspace(
  workspaceRoot: string,
  relativePath = DEFAULT_SCENE_RELATIVE_PATH
): Promise<{ path: string; manifest: unknown | null }> {
  const resolved = resolveWorkspacePath(workspaceRoot, relativePath);
  assertSceneFilePath(resolved);
  const uri = vscode.Uri.file(resolved);

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    return { path: resolved, manifest: JSON.parse(text) };
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return { path: resolved, manifest: null };
    }
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'FileNotFound') {
      return { path: resolved, manifest: null };
    }
    throw err;
  }
}

export async function writeSceneManifestToWorkspace(
  workspaceRoot: string,
  manifest: unknown,
  relativePath = DEFAULT_SCENE_RELATIVE_PATH
): Promise<string> {
  const resolved = resolveWorkspacePath(workspaceRoot, relativePath);
  assertSceneFilePath(resolved);

  const dirUri = vscode.Uri.file(path.dirname(resolved));
  await vscode.workspace.fs.createDirectory(dirUri);

  const formatted = `${JSON.stringify(manifest, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(vscode.Uri.file(resolved), Buffer.from(formatted, 'utf8'));
  return resolved;
}

export async function patchTsFileInWorkspace(
  workspaceRoot: string,
  targetPath: string,
  content: string | undefined,
  manifest: Parameters<typeof computePatchedTsSource>[2]
): Promise<{ path: string; mode: 'marker-replace' | 'create' | 'replace' }> {
  const resolved = resolveWorkspacePath(workspaceRoot, targetPath);
  assertTsPatchTarget(resolved);

  const fileUri = vscode.Uri.file(resolved);
  let existingSource: string | null = null;
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    existingSource = doc.getText();
  } catch {
    existingSource = null;
  }

  const { nextSource, mode } = computePatchedTsSource(existingSource, content, manifest);

  if (existingSource === null) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolved)));
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(nextSource, 'utf8'));
    return { path: resolved, mode };
  }

  const doc = await vscode.workspace.openTextDocument(fileUri);
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(existingSource.length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(fileUri, fullRange, nextSource);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`Failed to apply workspace edit to ${targetPath}`);
  }
  await doc.save();
  return { path: resolved, mode };
}

function getMimeTypeForUri(uri: vscode.Uri): string {
  const lower = uri.fsPath.toLowerCase();
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  if (lower.endsWith('.gltf')) return 'model/gltf+json';
  return 'application/json';
}

export async function buildInitMessage(activeAssetUri?: vscode.Uri): Promise<ExtensionToWebviewMessage> {
  const workspaceRoot = getPrimaryWorkspaceRoot();
  const defaultScenePath = DEFAULT_SCENE_RELATIVE_PATH;
  let sceneManifest: unknown | null = null;

  if (workspaceRoot) {
    try {
      const read = await readSceneManifestFromWorkspace(workspaceRoot, defaultScenePath);
      sceneManifest = read.manifest;
    } catch {
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

export async function handleWebviewMessage(
  msg: WebviewToExtensionMessage,
  ctx: BridgeContext
): Promise<void> {
  const post = (payload: ExtensionToWebviewMessage) => ctx.webview.postMessage(payload);
  const workspaceRoot = getPrimaryWorkspaceRoot();

  switch (msg.type) {
    case 'forge:ready': {
      await post(await buildInitMessage(ctx.activeAssetUri));
      return;
    }

    case 'forge:readScene': {
      const targetPath = msg.path ?? DEFAULT_SCENE_RELATIVE_PATH;
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
      } catch (err) {
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
      const targetPath = msg.path ?? DEFAULT_SCENE_RELATIVE_PATH;
      try {
        if (!workspaceRoot) {
          throw new Error('No workspace folder is open.');
        }
        const writtenPath = await writeSceneManifestToWorkspace(
          workspaceRoot,
          msg.manifest,
          targetPath
        );
        await post({
          type: 'forge:writeSceneResult',
          requestId: msg.requestId,
          ok: true,
          path: writtenPath,
        });
      } catch (err) {
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
        .get<string>('defaultTargetFile', 'src/ForgeScene.tsx');
      const targetPath = msg.targetPath || configTarget;

      try {
        if (!workspaceRoot) {
          throw new Error('No workspace folder is open.');
        }
        const res = await patchTsFileInWorkspace(
          workspaceRoot,
          targetPath,
          msg.content,
          msg.manifest
        );
        await post({
          type: 'forge:patchFileResult',
          requestId: msg.requestId,
          ok: true,
          path: res.path,
          mode: res.mode,
        });
      } catch (err) {
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
          resolveWorkspacePath(workspaceRoot, targetUri.fsPath);
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
      } catch (err) {
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
      } catch (err) {
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
