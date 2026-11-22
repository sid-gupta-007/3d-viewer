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
exports.ForgeCustomEditorProvider = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const webviewHtml_js_1 = require("./webviewHtml.js");
const workspaceBridge_js_1 = require("./workspaceBridge.js");
class ForgeCustomDocument {
    uri;
    constructor(uri) {
        this.uri = uri;
    }
    dispose() { }
}
class ForgeCustomEditorProvider {
    extensionUri;
    static viewType = 'forge3d.sceneEditor';
    static register(context) {
        const provider = new ForgeCustomEditorProvider(context.extensionUri);
        return vscode.window.registerCustomEditorProvider(ForgeCustomEditorProvider.viewType, provider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
            supportsMultipleEditorsPerDocument: false,
        });
    }
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }
    openCustomDocument(uri) {
        return new ForgeCustomDocument(uri);
    }
    resolveCustomEditor(document, webviewPanel) {
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri, ...workspaceFolders],
        };
        webviewPanel.webview.html = (0, webviewHtml_js_1.getStudioWebviewHtml)(webviewPanel.webview, {
            activeAssetLabel: path.basename(document.uri.fsPath),
        });
        const sub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg.type !== 'string')
                return;
            await (0, workspaceBridge_js_1.handleWebviewMessage)(msg, {
                webview: webviewPanel.webview,
                activeAssetUri: document.uri,
            });
        });
        webviewPanel.onDidDispose(() => sub.dispose());
    }
}
exports.ForgeCustomEditorProvider = ForgeCustomEditorProvider;
//# sourceMappingURL=customEditor.js.map