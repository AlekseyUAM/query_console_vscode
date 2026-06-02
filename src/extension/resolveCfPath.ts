import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function resolveCfPath(): string {
  const config = vscode.workspace.getConfiguration('queryConsole');
  const custom = config.get<string>('metadataPath');
  if (custom && fs.existsSync(custom)) return custom;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, 'src', 'cf');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}
