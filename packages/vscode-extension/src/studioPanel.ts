import * as vscode from 'vscode';
import type { WebviewToExtensionMessage } from './protocol.js';
import { getStudioWebviewHtml } from './webviewHtml.js';
import {
  getPrimaryWorkspaceRoot,
  handleWebviewMessage,
  readSceneManifestFromWorkspace,
} from './workspaceBridge.js';

export class ForgeStudioPanel {
  public static currentPanel: ForgeStudioPanel | undefined;
  private static readonly viewType = 'forge3d.studio';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): ForgeStudioPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ForgeStudioPanel.currentPanel) {
      ForgeStudioPanel.currentPanel.panel.reveal(column);
      return ForgeStudioPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ForgeStudioPanel.viewType,
      'Forge3D Studio',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    ForgeStudioPanel.currentPanel = new ForgeStudioPanel(panel);
    return ForgeStudioPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = getStudioWebviewHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        if (!msg || typeof msg.type !== 'string') return;
        await handleWebviewMessage(msg, { webview: this.panel.webview });
      },
      null,
      this.disposables
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/.forge/scene.json');
    const pushSceneUpdate = async () => {
      const root = getPrimaryWorkspaceRoot();
      if (!root) return;
      try {
        const res = await readSceneManifestFromWorkspace(root);
        await this.panel.webview.postMessage({
          type: 'forge:sceneData',
          ok: true,
          path: res.path,
          manifest: res.manifest,
        });
      } catch {
        // Ignore transient parse errors while user is typing
      }
    };
    watcher.onDidChange(pushSceneUpdate, null, this.disposables);
    watcher.onDidCreate(pushSceneUpdate, null, this.disposables);
    this.disposables.push(watcher);
  }

  public dispose(): void {
    ForgeStudioPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }
}
