import * as crypto from 'crypto';
import * as vscode from 'vscode';

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function getStudioWebviewHtml(
  webview: vscode.Webview,
  options: { activeAssetLabel?: string } = {}
): string {
  const nonce = getNonce();
  const studioDevUrl = vscode.workspace
    .getConfiguration('forge3d')
    .get<string>('studioDevUrl', '')
    .trim();

  let devOrigin = '';
  if (studioDevUrl) {
    try {
      devOrigin = new URL(studioDevUrl).origin;
    } catch {
      devOrigin = '';
    }
  }

  const frameSrc = devOrigin ? `frame-src ${devOrigin};` : '';
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    frameSrc,
  ]
    .filter(Boolean)
    .join('; ');

  const assetBanner = options.activeAssetLabel
    ? `Active asset: <code>${escapeHtml(options.activeAssetLabel)}</code>`
    : 'Studio workspace mode';

  const iframeSection = devOrigin
    ? `<iframe id="forge-studio-frame" src="${escapeHtml(
        studioDevUrl
      )}" allow="cross-origin-isolated" style="width:100%;height:70vh;border:1px solid #2d3340;border-radius:8px;background:#0f1116;"></iframe>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Forge3D Studio</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      color: var(--vscode-foreground, #e4e7ec);
      background: var(--vscode-editor-background, #111317);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #2a2f3a);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    button {
      background: var(--vscode-button-background, #3b82f6);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground, #2563eb);
    }
    pre {
      background: var(--vscode-textCodeBlock-background, #181b22);
      padding: 12px;
      border-radius: 6px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
      max-height: 45vh;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <strong>Forge3D Studio</strong>
      <span style="opacity:0.75;margin-left:10px;font-size:12px;">${assetBanner}</span>
    </div>
    <span id="status" style="font-size:12px;opacity:0.8;">Connecting...</span>
  </header>

  ${iframeSection}

  <div class="actions">
    <button id="btn-read-scene">Read .forge/scene.json</button>
    <button id="btn-write-scene">Write Sample .forge/scene.json</button>
    <button id="btn-patch-tsx">Patch Target .tsx</button>
    <button id="btn-list-files">List Workspace Files</button>
  </div>

  <pre id="log">Waiting for extension host...</pre>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    const frameEl = document.getElementById('forge-studio-frame');
    let lastManifest = null;

    function appendLog(label, data) {
      const line = '[' + new Date().toLocaleTimeString() + '] ' + label + '\\n' + JSON.stringify(data, null, 2);
      logEl.textContent = line;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      // Forward messages from embedded Studio iframe to extension host
      if (frameEl && event.source === frameEl.contentWindow && msg.type.startsWith('forge:')) {
        vscode.postMessage(msg);
        return;
      }

      // Forward extension host messages to embedded Studio iframe
      if (frameEl && frameEl.contentWindow && msg.type.startsWith('forge:')) {
        frameEl.contentWindow.postMessage(msg, '*');
      }

      if (msg.type === 'forge:init') {
        statusEl.textContent = msg.workspaceRoot ? 'Connected' : 'No workspace open';
        lastManifest = msg.sceneManifest;
      } else if (msg.type === 'forge:sceneData' && msg.ok && msg.manifest) {
        lastManifest = msg.manifest;
      }
      appendLog(msg.type, msg);
    });

    document.getElementById('btn-read-scene').addEventListener('click', () => {
      vscode.postMessage({ type: 'forge:readScene', requestId: 'ui-read' });
    });

    document.getElementById('btn-write-scene').addEventListener('click', () => {
      const manifest = lastManifest || {
        version: 1,
        projectName: 'ForgeScene',
        assetPath: './assets/model.glb',
        camera: { position: [4.6, 3.6, 6.8], target: [0, 0.8, 0], fov: 38, near: 0.1, far: 100 },
        environment: { preset: 'studio', background: '#111317', exposure: 1, xrEnabled: false, lights: [] },
        nodes: [],
        keyframes: [],
        loopMode: 'loop'
      };
      vscode.postMessage({ type: 'forge:writeScene', requestId: 'ui-write', manifest });
    });

    document.getElementById('btn-patch-tsx').addEventListener('click', () => {
      if (!lastManifest) {
        appendLog('forge:patchFile (skipped)', { error: 'Read or write .forge/scene.json first.' });
        return;
      }
      vscode.postMessage({ type: 'forge:patchFile', requestId: 'ui-patch', manifest: lastManifest });
    });

    document.getElementById('btn-list-files').addEventListener('click', () => {
      vscode.postMessage({ type: 'forge:listWorkspaceFiles', requestId: 'ui-files' });
    });

    vscode.postMessage({ type: 'forge:ready' });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
