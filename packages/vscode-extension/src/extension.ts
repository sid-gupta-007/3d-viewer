import * as vscode from 'vscode';
import { ForgeCustomEditorProvider } from './customEditor.js';
import { ForgeStudioPanel } from './studioPanel.js';

export function activate(context: vscode.ExtensionContext): void {
  const openStudioCmd = vscode.commands.registerCommand('forge3d.openStudio', () => {
    ForgeStudioPanel.createOrShow(context.extensionUri);
  });

  const customEditorRegistration = ForgeCustomEditorProvider.register(context);

  context.subscriptions.push(openStudioCmd, customEditorRegistration);
}

export function deactivate(): void {
  ForgeStudioPanel.currentPanel?.dispose();
}
