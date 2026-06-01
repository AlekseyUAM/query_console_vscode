import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createPanel } from './panel';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('1C Query Constructor');

  const cmd = vscode.commands.registerCommand('1c.queryConstructor', () => {
    const config = vscode.workspace.getConfiguration('queryConsole');
    const setting = config.get<string>('metadataPath') ?? '';
    outputChannel.appendLine(`[1C Query] metadataPath setting: "${setting}"`);
    outputChannel.appendLine(`[1C Query] setting exists on disk: ${setting ? fs.existsSync(setting) : 'n/a'}`);
    const cfPath = resolveCfPath();
    outputChannel.appendLine(`[1C Query] resolved cfPath: "${cfPath}"`);
    outputChannel.show(true);
    createPanel(context, cfPath, outputChannel);
  });

  context.subscriptions.push(cmd, outputChannel);
}

function resolveCfPath(): string {
  const config = vscode.workspace.getConfiguration('queryConsole');
  const custom = config.get<string>('metadataPath');
  if (custom && fs.existsSync(custom)) return custom;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, 'src', 'cf');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

export function deactivate(): void {}
