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
exports.ForgeStudioPanel = void 0;
const vscode = __importStar(require("vscode"));
const webviewHtml_js_1 = require("./webviewHtml.js");
const workspaceBridge_js_1 = require("./workspaceBridge.js");
class ForgeStudioPanel {
    static currentPanel;
    static viewType = 'forge3d.studio';
    panel;
    disposables = [];
    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ForgeStudioPanel.currentPanel) {
            ForgeStudioPanel.currentPanel.panel.reveal(column);
            return ForgeStudioPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(ForgeStudioPanel.viewType, 'Forge3D Studio', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        });
        ForgeStudioPanel.currentPanel = new ForgeStudioPanel(panel);
        return ForgeStudioPanel.currentPanel;
    }
    constructor(panel) {
        this.panel = panel;
        this.panel.webview.html = (0, webviewHtml_js_1.getStudioWebviewHtml)(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg.type !== 'string')
                return;
            await (0, workspaceBridge_js_1.handleWebviewMessage)(msg, { webview: this.panel.webview });
        }, null, this.disposables);
        const watcher = vscode.workspace.createFileSystemWatcher('**/.forge/scene.json');
        const pushSceneUpdate = async () => {
            const root = (0, workspaceBridge_js_1.getPrimaryWorkspaceRoot)();
            if (!root)
                return;
            try {
                const res = await (0, workspaceBridge_js_1.readSceneManifestFromWorkspace)(root);
                await this.panel.webview.postMessage({
                    type: 'forge:sceneData',
                    ok: true,
                    path: res.path,
                    manifest: res.manifest,
                });
            }
            catch {
                // Ignore transient parse errors while user is typing
            }
        };
        watcher.onDidChange(pushSceneUpdate, null, this.disposables);
        watcher.onDidCreate(pushSceneUpdate, null, this.disposables);
        this.disposables.push(watcher);
    }
    dispose() {
        ForgeStudioPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }
}
exports.ForgeStudioPanel = ForgeStudioPanel;
//# sourceMappingURL=studioPanel.js.map