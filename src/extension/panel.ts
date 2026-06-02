import * as vscode from 'vscode';
import * as path from 'path';
import { parseCf } from '../core/metadata/cfParser';
import { buildCachePath, writeCache } from '../core/metadata/cacheBuilder';
import { isCacheValid, readCache } from '../core/metadata/cacheLoader';
import { generate } from '../core/query/sdblGenerator';
import { insertResult } from './insertResult';
import type { HostMsg, WebviewMsg } from '../shared/messages';
import type { MetadataModel } from '../core/metadata/types';
import type { QueryModel } from '../core/query/queryModel';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getHtml(webview: vscode.Webview, scriptUri: vscode.Uri, n: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline';">
  <title>1С: Конструктор запроса</title>
</head>
<body style="margin:0;padding:0;height:100vh;">
  <div id="root" style="height:100%;"></div>
  <script nonce="${n}" src="${webview.asWebviewUri(scriptUri)}"></script>
</body>
</html>`;
}

async function loadMetadata(
  context: vscode.ExtensionContext,
  cfPath: string,
  channel: vscode.OutputChannel
): Promise<MetadataModel> {
  if (!cfPath) return { version: 1, tables: [] };
  const cachePath = buildCachePath(context.globalStorageUri.fsPath, cfPath);
  if (isCacheValid(cachePath, cfPath)) {
    const cached = readCache(cachePath);
    if (cached && cached.tables.length > 0) {
      channel.appendLine(`[1C Query] From cache: ${cached.tables.length} tables`);
      return cached;
    }
  }
  channel.appendLine(`[1C Query] Parsing metadata from: ${cfPath}`);
  const fs2 = require('fs') as typeof import('fs');
  const path2 = require('path') as typeof import('path');
  for (const sub of ['Catalogs', 'Documents']) {
    const dir = path2.join(cfPath, sub);
    if (fs2.existsSync(dir)) {
      const files = (fs2.readdirSync(dir) as string[]).filter(f => f.endsWith('.xml'));
      channel.appendLine(`[1C Query] ${sub}/: ${files.length} XML files`);
      if (files.length > 0) {
        const firstPath = path2.join(dir, files[0]);
        const firstXml: string = fs2.readFileSync(firstPath, 'utf8');
        channel.appendLine(`[1C Query] First file: ${files[0]}`);
        channel.appendLine(`[1C Query] First 300 chars: ${firstXml.slice(0, 300).replace(/\n/g, '↵')}`);
      }
    } else {
      channel.appendLine(`[1C Query] ${sub}/: directory not found`);
    }
  }
  const model = parseCf(cfPath);
  channel.appendLine(`[1C Query] Parsed ${model.tables.length} tables`);
  writeCache(cachePath, model);
  return model;
}

export function createPanel(
  context: vscode.ExtensionContext,
  cfPath: string,
  channel: vscode.OutputChannel
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    '1c.queryConstructor',
    '1С: Конструктор запроса',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
      retainContextWhenHidden: true,
    }
  );

  const scriptUri = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'main.js');
  const n = nonce();
  panel.webview.html = getHtml(panel.webview, scriptUri, n);

  let metadataModel: MetadataModel = { version: 1, tables: [] };
  const metadataReady = loadMetadata(context, cfPath, channel).then(m => { metadataModel = m; });

  panel.webview.onDidReceiveMessage(async (msg: WebviewMsg) => {
    if (msg.type === 'ready') {
      await metadataReady;
      const reply: HostMsg = { type: 'metadataTree', tables: metadataModel.tables };
      panel.webview.postMessage(reply);
      if (metadataModel.tables.length === 0 && !cfPath) {
        vscode.window.showWarningMessage('Не найдена выгрузка конфигурации. Укажите путь в настройке queryConsole.metadataPath');
      }
    } else if (msg.type === 'expandRef') {
      await metadataReady;
      const ref = msg.ref;
      const table = metadataModel.tables.find(t => t.kind === ref.kind && t.name === ref.name);
      const reply: HostMsg = { type: 'refFields', ref, fields: table?.fields ?? [] };
      panel.webview.postMessage(reply);
    } else if (msg.type === 'generate') {
      const text = generate(msg.model as QueryModel);
      if (!text) {
        vscode.window.showInformationMessage('Выберите хотя бы одну таблицу и одно поле');
        return;
      }
      const reply: HostMsg = { type: 'generatedText', text };
      panel.webview.postMessage(reply);
    } else if (msg.type === 'insertText') {
      await insertResult(msg.text);
    }
  });

  return panel;
}
