# Кнопка «Обновить кэш» и авто-парсинг: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить кнопку «Обновить кэш» в webview-панель конструктора и автоматически запускать парсинг при открытии без YAML-кэша.

**Architecture:** Новые типы сообщений `refreshCache` (webview→extension) и `refreshResult` (extension→webview) проходят через существующий контракт `messages.ts`. Extension запускает `parseConfiguration` синхронно и отвечает результатом; текущая метамодель в памяти не меняется.

**Tech Stack:** TypeScript, React, VS Code Webview API, vitest

**Test command:** `npm test` (vitest) + `npx tsc -p tsconfig.json --noEmit` (type check)

---

## Структура файлов

**Изменить:**
- `src/shared/messages.ts` — добавить `refreshCache` в WebviewMsg, `refreshResult` в HostMsg
- `src/extension/panel.ts` — вынести `outPath`, добавить обработчик `refreshCache`, добавить авто-парсинг в `loadMetadata`
- `src/webview/App.tsx` — добавить `refreshState`, кнопку и строку статуса

---

## Task 1: Расширить контракт сообщений

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Заменить `src/shared/messages.ts` полностью**

```ts
import type { MetaField, MetaTable, TableKind } from '../core/metadata/types';
import type { QueryModel } from '../core/query/queryModel';

export type RefId = { kind: TableKind; name: string };

export type HostMsg =
  | { type: 'metadataTree'; tables: MetaTable[] }
  | { type: 'refFields'; ref: RefId; fields: MetaField[] }
  | { type: 'generatedText'; text: string }
  | { type: 'refreshResult'; ok: boolean; message: string };

export type WebviewMsg =
  | { type: 'ready' }
  | { type: 'expandRef'; ref: RefId }
  | { type: 'generate'; model: QueryModel }
  | { type: 'insertText'; text: string }
  | { type: 'cancel' }
  | { type: 'refreshCache' };
```

- [ ] **Step 2: Проверить типы**

```bash
npx tsc -p tsconfig.json --noEmit
npm test
```

Ожидается: нет ошибок.

- [ ] **Step 3: Коммит**

```bash
git add src/shared/messages.ts
git commit -m "feat: добавить refreshCache/refreshResult в контракт сообщений"
```

---

## Task 2: Extension — обработчик refreshCache + авто-парсинг

**Files:**
- Modify: `src/extension/panel.ts`

Изменения: (1) добавить импорт `parseConfiguration`, (2) вынести `outPath` из `loadMetadata` в `createPanel`, (3) добавить авто-парсинг, (4) добавить обработчик `refreshCache`.

- [ ] **Step 1: Заменить `src/extension/panel.ts` полностью**

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseCf } from '../core/metadata/cfParser';
import { buildCachePath, writeCache } from '../core/metadata/cacheBuilder';
import { isCacheValid, readCache } from '../core/metadata/cacheLoader';
import { loadMetadataFromYaml } from '../core/metadata/yamlLoader';
import { parseConfiguration } from '../core/metadata/parser/parseConfiguration';
import { generate } from '../core/query/sdblGenerator';
import { insertResult } from './insertResult';
import type { SavedEditorState } from './insertResult';
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

function resolveOutPath(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration('queryConsole');
  const outSetting = config.get<string>('parserOutputPath') || 'tmp/parser_data';
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  return path.isAbsolute(outSetting) ? outSetting : path.join(root, outSetting);
}

async function loadMetadata(
  cfPath: string,
  outPath: string,
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): Promise<MetadataModel> {
  const cfYamlDir = path.join(outPath, 'cf');
  const configYaml = path.join(cfYamlDir, 'configuration.yaml');

  // Auto-parse: if no YAML cache exists and cfPath is set, try parsing first
  if (!fs.existsSync(configYaml) && cfPath) {
    channel.appendLine(`[1C Query] YAML не найден, попытка авто-парсинга: ${cfPath}`);
    try {
      parseConfiguration(cfPath, outPath);
      channel.appendLine(`[1C Query] Авто-парсинг завершён`);
    } catch (e) {
      channel.appendLine(`[1C Query] Авто-парсинг не удался: ${e}`);
    }
  }

  if (fs.existsSync(configYaml)) {
    channel.appendLine(`[1C Query] Loading metadata from YAML: ${cfYamlDir}`);
    const model = loadMetadataFromYaml(cfYamlDir);
    channel.appendLine(`[1C Query] YAML: loaded ${model.tables.length} tables`);
    return model;
  }

  // Fallback: XML parsing + cache
  if (!cfPath) return { version: 1, tables: [] };
  const cachePath = buildCachePath(context.globalStorageUri.fsPath, cfPath);
  if (isCacheValid(cachePath, cfPath)) {
    const cached = readCache(cachePath);
    if (cached && cached.tables.length > 0) {
      channel.appendLine(`[1C Query] From cache: ${cached.tables.length} tables`);
      return cached;
    }
  }
  channel.appendLine(`[1C Query] Parsing metadata from XML: ${cfPath}`);
  for (const sub of ['Catalogs', 'Documents']) {
    const dir = path.join(cfPath, sub);
    if (fs.existsSync(dir)) {
      const files = (fs.readdirSync(dir) as string[]).filter(f => f.endsWith('.xml'));
      channel.appendLine(`[1C Query] ${sub}/: ${files.length} XML files`);
      if (files.length > 0) {
        const firstPath = path.join(dir, files[0]);
        const firstXml: string = fs.readFileSync(firstPath, 'utf8');
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
  channel: vscode.OutputChannel,
  savedEditor?: SavedEditorState
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

  const outPath = resolveOutPath(context);
  let metadataModel: MetadataModel = { version: 1, tables: [] };
  const metadataReady = loadMetadata(cfPath, outPath, context, channel).then(m => { metadataModel = m; });

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
      await insertResult(msg.text, savedEditor);
      panel.dispose();
    } else if (msg.type === 'cancel') {
      panel.dispose();
    } else if (msg.type === 'refreshCache') {
      if (!cfPath) {
        const reply: HostMsg = { type: 'refreshResult', ok: false, message: 'Не найден путь к выгрузке конфигурации' };
        panel.webview.postMessage(reply);
        return;
      }
      try {
        parseConfiguration(cfPath, outPath);
        const reply: HostMsg = { type: 'refreshResult', ok: true, message: 'Кэш обновлён. Перезапустите конструктор для применения изменений.' };
        panel.webview.postMessage(reply);
      } catch (e) {
        const reply: HostMsg = { type: 'refreshResult', ok: false, message: `Ошибка парсинга: ${e}` };
        panel.webview.postMessage(reply);
      }
    }
  });

  return panel;
}
```

- [ ] **Step 2: Проверить типы и тесты**

```bash
npx tsc -p tsconfig.json --noEmit
npm test
```

Ожидается: нет ошибок.

- [ ] **Step 3: Коммит**

```bash
git add src/extension/panel.ts
git commit -m "feat: обработчик refreshCache и авто-парсинг при открытии без YAML"
```

---

## Task 3: Webview — кнопка «Обновить кэш»

**Files:**
- Modify: `src/webview/App.tsx`

- [ ] **Step 1: Заменить `src/webview/App.tsx` полностью**

```tsx
import * as React from 'react';
import { useReducer, useEffect, useState } from 'react';
import { TabsBar } from './components/TabsBar';
import { DbTreePanel } from './components/DbTreePanel';
import { TablesPanel } from './components/TablesPanel';
import { FieldsPanel } from './components/FieldsPanel';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer } from './state/queryStore';
import { generate } from '../core/query/sdblGenerator';

const BTN: React.CSSProperties = {
  padding: '4px 12px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

type RefreshState = 'idle' | 'loading' | { ok: boolean; message: string };

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [queryModalText, setQueryModalText] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');

  useEffect(() => {
    const unsub = onHostMessage(msg => {
      if (msg.type === 'metadataTree') {
        dispatch({ type: 'SET_METADATA', tables: msg.tables });
      } else if (msg.type === 'refFields') {
        dispatch({ type: 'SET_REF_FIELDS', ref: msg.ref, fields: msg.fields });
      } else if (msg.type === 'refreshResult') {
        setRefreshState({ ok: msg.ok, message: msg.message });
      }
    });
    postToHost({ type: 'ready' });
    return unsub;
  }, []);

  function handleInsert(text: string) {
    postToHost({ type: 'insertText', text });
  }

  function handleCancel() {
    postToHost({ type: 'cancel' });
  }

  function handleShowQuery() {
    const text = generate({
      tables: state.selectedTables,
      fields: state.selectedFields,
      tabSectionFields: state.tabSectionFields,
    });
    setQueryModalText(text || '-- нет полей для генерации запроса');
  }

  function handleRefreshCache() {
    setRefreshState('loading');
    postToHost({ type: 'refreshCache' });
  }

  const panelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid var(--vscode-panel-border, #444)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--vscode-foreground, #ccc)', background: 'var(--vscode-editor-background, #1e1e1e)', fontFamily: 'var(--vscode-font-family, sans-serif)', overflow: 'hidden' }}>
      <TabsBar />
      {/* Cache toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
        <button
          style={{ ...BTN, opacity: refreshState === 'loading' ? 0.6 : 1 }}
          onClick={handleRefreshCache}
          disabled={refreshState === 'loading'}
        >
          {refreshState === 'loading' ? 'Обновление...' : 'Обновить кэш'}
        </button>
        {typeof refreshState === 'object' && (
          <span style={{ fontSize: 12, color: refreshState.ok ? 'var(--vscode-terminal-ansiGreen, #4caf50)' : 'var(--vscode-errorForeground, #f44747)' }}>
            {refreshState.message}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
        <div style={panelStyle}>
          <DbTreePanel
            tables={state.tables}
            expandedRefs={state.expandedRefs}
            focusedTableFullName={state.focusedDbTableFullName}
            focusedFieldPath={state.focusedDbFieldPath}
            onFocusTable={fullName => dispatch({ type: 'FOCUS_DB_TABLE', fullName })}
            onFocusField={(tableFullName, fieldPath) => dispatch({ type: 'FOCUS_DB_FIELD', tableFullName, fieldPath })}
            onExpandRef={ref => postToHost({ type: 'expandRef', ref })}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onAddField={(_tableFullName, _fieldPath) => { /* drag to FieldsPanel instead */ }}
          />
        </div>
        <div style={panelStyle}>
          <TablesPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            focusedSelectedTableId={state.focusedSelectedTableId}
            expandedRefs={state.expandedRefs}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onRemoveTable={tableId => dispatch({ type: 'REMOVE_TABLE', tableId })}
            onFocusTable={id => dispatch({ type: 'FOCUS_SELECTED_TABLE', id })}
            onExpandRef={ref => postToHost({ type: 'expandRef', ref })}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            selectedFields={state.selectedFields}
            tabSectionFields={state.tabSectionFields}
            focusedSelectedFieldIdx={state.focusedSelectedFieldIdx}
            onDropField={(tableFullName, fieldPath) => dispatch({ type: 'ADD_FIELD_WITH_TABLE', tableFullName, fieldPath })}
            onDropTabSection={(parentTableFullName, tsName, tsFullName, tsFields) =>
              dispatch({ type: 'ADD_TAB_SECTION_WITH_TABLE', parentTableFullName, tsName, tsFullName, tsFields })
            }
            onRemoveField={idx => dispatch({ type: 'REMOVE_FIELD', fieldIdx: idx })}
            onRemoveTabSection={(tableId, tsName) => dispatch({ type: 'REMOVE_TAB_SECTION', tableId, tsName })}
            onRemoveTabSectionSubField={(tableId, tsName, fieldName) =>
              dispatch({ type: 'REMOVE_TAB_SECTION_SUB_FIELD', tableId, tsName, fieldName })
            }
            onFocusField={idx => dispatch({ type: 'FOCUS_SELECTED_FIELD', idx })}
            onInsert={handleInsert}
            onCancel={handleCancel}
          />
        </div>
      </div>
      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', borderTop: '1px solid var(--vscode-panel-border, #444)' }}>
        <button style={BTN} onClick={handleShowQuery}>Запрос</button>
      </div>

      {/* Query preview modal */}
      {queryModalText !== null && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setQueryModalText(null)}
        >
          <div
            style={{
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-panel-border, #555)',
              borderRadius: 4,
              padding: 16,
              minWidth: 400,
              maxWidth: '70vw',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 'bold', fontSize: 13 }}>Текст запроса</span>
              <button
                onClick={() => setQueryModalText(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--vscode-foreground, #ccc)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
            <pre style={{
              margin: 0,
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              overflowY: 'auto',
              maxHeight: 'calc(70vh - 60px)',
              color: 'var(--vscode-foreground, #ccc)',
            }}>
              {queryModalText}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы и тесты**

```bash
npx tsc -p tsconfig.json --noEmit
npm test
```

Ожидается: нет ошибок, 112 тестов проходят.

- [ ] **Step 3: Собрать webview и проверить визуально**

```bash
npm run build:webview
```

Ожидается: `out/webview/main.js` пересобран без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add src/webview/App.tsx
git commit -m "feat: кнопка Обновить кэш в панели конструктора"
```
