import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createPanel } from './panel';
import { resolveCfPath } from './resolveCfPath';
import { registerParseCommand } from './parseCommand';

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

  context.subscriptions.push(cmd, registerParseCommand(outputChannel), outputChannel);
}

export function deactivate(): void {}
