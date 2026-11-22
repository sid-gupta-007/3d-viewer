import * as path from 'path';
import * as vscode from 'vscode';
import type { WebviewToExtensionMessage } from './protocol.js';
import { getStudioWebviewHtml } from './webviewHtml.js';
import { handleWebviewMessage } from './workspaceBridge.js';

class ForgeCustomDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class ForgeCustomEditorProvider
  implements vscode.CustomReadonlyEditorProvider<ForgeCustomDocument>
{
  public static readonly viewType = 'forge3d.sceneEditor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ForgeCustomEditorProvider(context.extensionUri);
    return vscode.window.registerCustomEditorProvider(
      ForgeCustomEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): ForgeCustomDocument {
    return new ForgeCustomDocument(uri);
  }

  resolveCustomEditor(
    document: ForgeCustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, ...workspaceFolders],
    };

    webviewPanel.webview.html = getStudioWebviewHtml(webviewPanel.webview, {
      activeAssetLabel: path.basename(document.uri.fsPath),
    });

    const sub = webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        if (!msg || typeof msg.type !== 'string') return;
        await handleWebviewMessage(msg, {
          webview: webviewPanel.webview,
          activeAssetUri: document.uri,
        });
      }
    );

    webviewPanel.onDidDispose(() => sub.dispose());
  }
}
