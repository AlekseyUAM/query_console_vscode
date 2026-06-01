# 1C Query Constructor MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that opens a webview query constructor for 1C, parses `src/cf` metadata, lets users select tables/fields, and generates a `ВЫБРАТЬ … ИЗ …` SDBL query inserted into the active editor.

**Architecture:** Four isolated layers — pure-TS core (metadata parser, SDBL generator), thin extension host (command, webview panel, editor insert), React webview UI (three-panel layout), shared message contract. Extension host owns all logic; webview is a dumb view. TDD for all pure-TS modules.

**Tech Stack:** TypeScript 5, Node 22, React 18, esbuild (webview bundle), tsc (extension host), Vitest (unit tests), Playwright (webview E2E), @xmldom/xmldom (XML parsing), web-tree-sitter + tree-sitter-sdbl.wasm (test oracle).

---

## File Map

```
package.json                        extension manifest + scripts
tsconfig.json                       extension host TS config
tsconfig.webview.json               webview (React/JSX) TS config
vitest.config.ts                    unit test config
playwright.config.ts                E2E test config
.vscodeignore
scripts/build-wasm.sh               build + vendor tree-sitter-sdbl.wasm

src/
  shared/messages.ts                host↔webview message contract + RefId
  core/
    metadata/
      types.ts                      MetaField, MetaTable, MetadataModel
      cfParser.ts                   src/cf XML → MetadataModel
      cacheBuilder.ts               MetadataModel → JSON + cache path logic
      cacheLoader.ts                read + validate cache
    query/
      queryModel.ts                 SelectedTable, SelectedField, QueryModel
      sdblGenerator.ts              generate(QueryModel) → SDBL string
  extension/
    extension.ts                    activate(): register command
    panel.ts                        WebviewPanel, postMessage bridge, metadata load
    insertResult.ts                 insert text into active editor / clipboard
  webview/
    main.tsx                        React entry point
    App.tsx                         root component + useReducer state
    bridge.ts                       type-safe postMessage to/from host
    state/
      queryStore.ts                 QueryState interface + initialState()
    components/
      TabsBar.tsx                   tab bar (one active tab in MVP)
      DbTreePanel.tsx               database tree (catalogs + documents)
      TablesPanel.tsx               selected tables + > < buttons
      FieldsPanel.tsx               selected fields + > < buttons + Query button

test/
  fixtures/
    cf/
      Catalogs/Тест.xml             minimal catalog fixture (2 attributes)
      Documents/ТестДок.xml         minimal document fixture (1 attribute)
    tree-sitter-sdbl.wasm           vendored (built by scripts/build-wasm.sh)
    tree-sitter.wasm                vendored from web-tree-sitter
  helpers/
    assertValidSdbl.ts              oracle: parse SDBL text, assert no errors
  unit/
    sdblGenerator.test.ts
    cfParser.test.ts
    cache.test.ts
  e2e/
    harness/index.html              standalone webview with mocked postMessage
    webview.spec.ts                 Playwright test
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.webview.json`
- Create: `vitest.config.ts`
- Create: `.vscodeignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "query-console-1c",
  "displayName": "1C: Query Constructor",
  "description": "Visual query constructor for 1C",
  "version": "0.0.1",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": [],
  "main": "./out/extension/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "1c.queryConstructor",
        "title": "1С: Конструктор запроса"
      }
    ],
    "configuration": {
      "title": "Query Console 1C",
      "properties": {
        "queryConsole.metadataPath": {
          "type": "string",
          "default": "",
          "description": "Absolute path to src/cf directory (leave empty to auto-detect)"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "npm run build:extension && npm run build:webview",
    "build:extension": "tsc -p tsconfig.json",
    "build:webview": "esbuild src/webview/main.tsx --bundle --outfile=out/webview/main.js --platform=browser --format=iife --loader:.tsx=tsx --loader:.ts=ts",
    "watch:extension": "tsc -p tsconfig.json --watch",
    "watch:webview": "npm run build:webview -- --watch",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "test": "npm run test:unit"
  },
  "devDependencies": {
    "@playwright/test": "^1.44.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/vscode": "^1.90.0",
    "@xmldom/xmldom": "^0.9.5",
    "esbuild": "^0.21.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "web-tree-sitter": "^0.22.6"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (extension host — CommonJS for VS Code)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/extension/**/*", "src/core/**/*", "src/shared/**/*"],
  "exclude": ["src/webview/**/*", "node_modules"]
}
```

- [ ] **Step 3: Write `tsconfig.webview.json`** (React/JSX webview)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020", "DOM"],
    "jsx": "react",
    "outDir": "out/webview",
    "rootDir": "src/webview",
    "noEmit": true
  },
  "include": ["src/webview/**/*", "src/shared/**/*", "src/core/metadata/types.ts", "src/core/query/queryModel.ts"],
  "exclude": ["src/extension/**/*", "node_modules"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@shared': '/workspaces/query_console_vscode/src/shared',
      '@core': '/workspaces/query_console_vscode/src/core',
    },
  },
});
```

- [ ] **Step 5: Write `.vscodeignore`**

```
.vscode/**
src/**
test/**
scripts/**
tmp/**
docs/**
node_modules/**
out/webview/**/*.map
tsconfig*.json
vitest.config.ts
playwright.config.ts
*.vsix
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`

Expected: `node_modules/` created, `package-lock.json` updated, no errors.

- [ ] **Step 7: Verify TypeScript compiles (empty src)**

Create directory stubs so `tsc` doesn't fail:

```bash
mkdir -p src/extension src/core/metadata src/core/query src/shared src/webview
touch src/extension/extension.ts src/core/metadata/types.ts src/core/query/queryModel.ts src/shared/messages.ts
echo "export {};" > src/extension/extension.ts
echo "export {};" > src/core/metadata/types.ts
echo "export {};" > src/core/query/queryModel.ts
echo "export {};" > src/shared/messages.ts
```

Run: `npm run build:extension`

Expected: Exits 0, `out/extension/extension.js` created.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsconfig.webview.json vitest.config.ts .vscodeignore src/
git commit -m "chore: project scaffolding — package.json, tsconfig, vitest, stubs"
```

---

## Task 2: Shared Type Definitions

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/core/metadata/types.ts`
- Modify: `src/core/query/queryModel.ts`

- [ ] **Step 1: Write `src/core/metadata/types.ts`**

```ts
export type FieldKind = 'standard' | 'attribute';

export type TableKind = 'Справочник' | 'Документ';

export interface MetaType {
  primitive?: 'Строка' | 'Число' | 'Булево' | 'Дата';
  ref?: { kind: TableKind; name: string };
}

export interface MetaField {
  name: string;
  kind: FieldKind;
  types: MetaType[];
}

export interface MetaTable {
  kind: TableKind;
  name: string;
  fullName: string;
  fields: MetaField[];
}

export interface MetadataModel {
  version: 1;
  tables: MetaTable[];
}
```

- [ ] **Step 2: Write `src/core/query/queryModel.ts`**

```ts
export interface SelectedTable {
  id: string;
  fullName: string;
  alias?: string;
}

export interface SelectedField {
  tableId: string;
  path: string;
  alias?: string;
}

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
}
```

- [ ] **Step 3: Write `src/shared/messages.ts`**

```ts
import type { MetaField, MetaTable, TableKind } from '../core/metadata/types';
import type { QueryModel } from '../core/query/queryModel';

export type RefId = { kind: TableKind; name: string };

export type HostMsg =
  | { type: 'metadataTree'; tables: MetaTable[] }
  | { type: 'refFields'; ref: RefId; fields: MetaField[] }
  | { type: 'generatedText'; text: string };

export type WebviewMsg =
  | { type: 'ready' }
  | { type: 'expandRef'; ref: RefId }
  | { type: 'generate'; model: QueryModel };
```

- [ ] **Step 4: Rebuild and verify**

Run: `npm run build:extension`

Expected: Exits 0, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts src/core/metadata/types.ts src/core/query/queryModel.ts
git commit -m "feat: shared types — MetadataModel, QueryModel, host↔webview message contract"
```

---

## Task 3: WASM Build Script + Oracle Helper

**Files:**
- Create: `scripts/build-wasm.sh`
- Create: `test/helpers/assertValidSdbl.ts`
- Create: `test/fixtures/` (wasm files go here after running script)

- [ ] **Step 1: Write `scripts/build-wasm.sh`**

```bash
#!/usr/bin/env bash
# Builds tree-sitter-sdbl.wasm from tmp/tree-sitter-bsl and vendors both
# tree-sitter-sdbl.wasm and tree-sitter.wasm into test/fixtures/.
# Run once (or when grammar changes). Requires: tree-sitter CLI, emscripten.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSL_REPO="$REPO_ROOT/tmp/tree-sitter-bsl"
FIXTURES="$REPO_ROOT/test/fixtures"

echo "Building tree-sitter-sdbl.wasm from $BSL_REPO ..."
cd "$BSL_REPO"
npm install --silent
npm run build:wasm:sdbl

mkdir -p "$FIXTURES"
cp grammars/sdbl/tree-sitter-sdbl.wasm "$FIXTURES/tree-sitter-sdbl.wasm"

# Vendor the web-tree-sitter runtime WASM
WEB_TS_WASM="$REPO_ROOT/node_modules/web-tree-sitter/tree-sitter.wasm"
if [ -f "$WEB_TS_WASM" ]; then
  cp "$WEB_TS_WASM" "$FIXTURES/tree-sitter.wasm"
else
  echo "ERROR: web-tree-sitter not installed. Run npm install first."
  exit 1
fi

echo "Done. Vendored to $FIXTURES/"
```

- [ ] **Step 2: Make script executable and run it**

```bash
chmod +x scripts/build-wasm.sh
bash scripts/build-wasm.sh
```

Expected output:
```
Building tree-sitter-sdbl.wasm from .../tmp/tree-sitter-bsl ...
Done. Vendored to .../test/fixtures/
```

Verify:
```bash
ls test/fixtures/
```
Expected: `tree-sitter-sdbl.wasm  tree-sitter.wasm`

- [ ] **Step 3: Write `test/helpers/assertValidSdbl.ts`**

```ts
import Parser from 'web-tree-sitter';
import * as path from 'path';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

let _parser: Parser | null = null;

async function getParser(): Promise<Parser> {
  if (_parser) return _parser;
  await Parser.init({
    locateFile: (file: string) => path.join(FIXTURES, file),
  });
  const Lang = await Parser.Language.load(
    path.join(FIXTURES, 'tree-sitter-sdbl.wasm')
  );
  _parser = new Parser();
  _parser.setLanguage(Lang);
  return _parser;
}

export async function assertValidSdbl(text: string): Promise<void> {
  const parser = await getParser();
  const tree = parser.parse(text);
  if (tree.rootNode.hasError()) {
    throw new Error(
      `SDBL parse error in:\n${text}\n\nAST:\n${tree.rootNode.toString()}`
    );
  }
}
```

- [ ] **Step 4: Commit (include the vendored WASM)**

```bash
git add scripts/build-wasm.sh test/fixtures/ test/helpers/assertValidSdbl.ts
git commit -m "feat: vendor tree-sitter-sdbl.wasm + assertValidSdbl oracle helper"
```

---

## Task 4: SDBL Generator (TDD)

**Files:**
- Create: `test/unit/sdblGenerator.test.ts`
- Modify: `src/core/query/sdblGenerator.ts`

- [ ] **Step 1: Write the failing tests `test/unit/sdblGenerator.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generate } from '../../src/core/query/sdblGenerator';
import type { QueryModel } from '../../src/core/query/queryModel';

describe('generate', () => {
  it('returns empty string when no tables', () => {
    const model: QueryModel = { tables: [], fields: [] };
    expect(generate(model)).toBe('');
  });

  it('returns empty string when no fields', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [],
    };
    expect(generate(model)).toBe('');
  });

  it('generates a minimal single-table single-field query', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('puts comma after each field except the last', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't1', path: 'Наименование' },
        { tableId: 't1', path: 'ЗагружаетсяИзИнтернета' },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tВалюты.Наименование,\n\tВалюты.ЗагружаетсяИзИнтернета\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('generates multi-table FROM separated by comma', () => {
    const model: QueryModel = {
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Документ.Счет' },
      ],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't2', path: 'Дата' },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tСчет.Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Счет КАК Счет'
    );
  });

  it('resolves alias conflict with numeric suffix', () => {
    const model: QueryModel = {
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Документ.Валюты' },
      ],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't2', path: 'Дата' },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tВалюты1.Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Валюты КАК Валюты1'
    );
  });

  it('uses explicit alias when provided', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты', alias: 'Вал' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВал.Код\nИЗ\n\tСправочник.Валюты КАК Вал'
    );
  });

  it('supports multi-segment field path', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'ОсновнаяВалюта.Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.ОсновнаяВалюта.Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('appends КАК alias when field alias is set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'КодВалюты' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК КодВалюты\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `npm run test:unit -- --reporter=verbose 2>&1 | head -30`

Expected: Tests fail with `Cannot find module` or import error.

- [ ] **Step 3: Implement `src/core/query/sdblGenerator.ts`**

```ts
import type { QueryModel, SelectedTable } from './queryModel';

function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = t.alias ?? t.fullName.split('.')[1] ?? t.fullName;
    let alias = base;
    let counter = 1;
    while (seen.has(alias)) {
      alias = base + counter;
      counter++;
    }
    seen.add(alias);
    result.set(t.id, alias);
  }
  return result;
}

export function generate(model: QueryModel): string {
  if (model.tables.length === 0 || model.fields.length === 0) return '';

  const aliases = resolveAliases(model.tables);

  const fieldLines = model.fields.map((f, i) => {
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const fieldExpr = `${tableAlias}.${f.path}`;
    const withAlias = f.alias ? `${fieldExpr} КАК ${f.alias}` : fieldExpr;
    const comma = i < model.fields.length - 1 ? ',' : '';
    return `\t${withAlias}${comma}`;
  });

  const tableLines = model.tables.map((t, i) => {
    const alias = aliases.get(t.id) ?? t.id;
    const comma = i < model.tables.length - 1 ? ',' : '';
    return `\t${t.fullName} КАК ${alias}${comma}`;
  });

  return ['ВЫБРАТЬ', ...fieldLines, 'ИЗ', ...tableLines].join('\n');
}
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `npm run test:unit -- --reporter=verbose 2>&1`

Expected: `8 tests passed`.

- [ ] **Step 5: Add assertValidSdbl oracle test (async, requires WASM)**

Add to `test/unit/sdblGenerator.test.ts` at the bottom:

```ts
import { assertValidSdbl } from '../helpers/assertValidSdbl';

describe('assertValidSdbl oracle', () => {
  it('validates generated SDBL is syntactically correct', async () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't1', path: 'Наименование' },
      ],
    };
    const text = generate(model);
    await assertValidSdbl(text);
  });
});
```

- [ ] **Step 6: Run all unit tests (includes WASM oracle)**

Run: `npm run test:unit -- --reporter=verbose 2>&1`

Expected: `9 tests passed` (the oracle test runs last and loads WASM once).

If the oracle test fails with a WASM error, verify `test/fixtures/tree-sitter-sdbl.wasm` exists and re-run `bash scripts/build-wasm.sh`.

- [ ] **Step 7: Commit**

```bash
git add src/core/query/sdblGenerator.ts test/unit/sdblGenerator.test.ts
git commit -m "feat(tdd): SDBL generator — generate(QueryModel) → ВЫБРАТЬ…ИЗ…"
```

---

## Task 5: CF Parser Fixtures

**Files:**
- Create: `test/fixtures/cf/Catalogs/Тест.xml`
- Create: `test/fixtures/cf/Documents/ТестДок.xml`

- [ ] **Step 1: Create fixture directory structure**

```bash
mkdir -p test/fixtures/cf/Catalogs test/fixtures/cf/Documents
```

- [ ] **Step 2: Write `test/fixtures/cf/Catalogs/Тест.xml`**

Minimal catalog with standard structure matching real `src/cf` format: two attributes (one primitive, one ref).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"
  xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"
  xmlns:v8="http://v8.1c.ru/8.1/data/core"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Catalog uuid="aaa-111">
    <Properties>
      <Name>Тест</Name>
    </Properties>
    <ChildObjects>
      <Attribute uuid="bbb-222">
        <Properties>
          <Name>Активен</Name>
          <Type>
            <v8:Type>xs:boolean</v8:Type>
          </Type>
        </Properties>
      </Attribute>
      <Attribute uuid="ccc-333">
        <Properties>
          <Name>Валюта</Name>
          <Type>
            <v8:Type>cfg:CatalogRef.Валюты</v8:Type>
          </Type>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>
```

- [ ] **Step 3: Write `test/fixtures/cf/Documents/ТестДок.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"
  xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Document uuid="ddd-444">
    <Properties>
      <Name>ТестДок</Name>
    </Properties>
    <ChildObjects>
      <Attribute uuid="eee-555">
        <Properties>
          <Name>Сумма</Name>
          <Type>
            <v8:Type>xs:decimal</v8:Type>
          </Type>
        </Properties>
      </Attribute>
      <Attribute uuid="fff-666">
        <Properties>
          <Name>Контрагент</Name>
          <Type>
            <v8:Type>cfg:DocumentRef.ТестДок</v8:Type>
          </Type>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Document>
</MetaDataObject>
```

- [ ] **Step 4: Commit fixtures**

```bash
git add test/fixtures/cf/
git commit -m "test: add minimal cf fixture XMLs for parser tests"
```

---

## Task 6: CF Parser (TDD)

**Files:**
- Create: `test/unit/cfParser.test.ts`
- Create: `src/core/metadata/cfParser.ts`

- [ ] **Step 1: Write the failing tests `test/unit/cfParser.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseCf, parseCatalogXml, parseDocumentXml } from '../../src/core/metadata/cfParser';

const FIXTURES_CF = path.join(__dirname, '..', 'fixtures', 'cf');

describe('parseCatalogXml', () => {
  it('extracts name and fullName', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml);
    expect(table?.name).toBe('Тест');
    expect(table?.fullName).toBe('Справочник.Тест');
    expect(table?.kind).toBe('Справочник');
  });

  it('includes standard Catalog fields first', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const stdNames = table.fields.filter(f => f.kind === 'standard').map(f => f.name);
    expect(stdNames).toEqual(['Ссылка', 'Код', 'Наименование', 'ПометкаУдаления', 'Предопределённый']);
  });

  it('parses xs:boolean attribute type', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const активен = table.fields.find(f => f.name === 'Активен');
    expect(активен?.kind).toBe('attribute');
    expect(активен?.types).toEqual([{ primitive: 'Булево' }]);
  });

  it('parses cfg:CatalogRef type as ref', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Catalogs', 'Тест.xml'), 'utf8'
    );
    const table = parseCatalogXml(xml)!;
    const валюта = table.fields.find(f => f.name === 'Валюта');
    expect(валюта?.types).toEqual([{ ref: { kind: 'Справочник', name: 'Валюты' } }]);
  });

  it('returns null for malformed XML', () => {
    expect(parseCatalogXml('<broken xml<<')).toBeNull();
  });
});

describe('parseDocumentXml', () => {
  it('extracts Document with correct kind and standard fields', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Documents', 'ТестДок.xml'), 'utf8'
    );
    const table = parseDocumentXml(xml);
    expect(table?.name).toBe('ТестДок');
    expect(table?.kind).toBe('Документ');
    const stdNames = table!.fields.filter(f => f.kind === 'standard').map(f => f.name);
    expect(stdNames).toEqual(['Ссылка', 'Номер', 'Дата', 'Проведён', 'ПометкаУдаления']);
  });

  it('parses xs:decimal as Число', () => {
    const xml = require('fs').readFileSync(
      path.join(FIXTURES_CF, 'Documents', 'ТестДок.xml'), 'utf8'
    );
    const table = parseDocumentXml(xml)!;
    const сумма = table.fields.find(f => f.name === 'Сумма');
    expect(сумма?.types).toEqual([{ primitive: 'Число' }]);
  });
});

describe('parseCf', () => {
  it('scans Catalogs/ and Documents/ subdirectories', () => {
    const model = parseCf(FIXTURES_CF);
    expect(model.version).toBe(1);
    const names = model.tables.map(t => t.name);
    expect(names).toContain('Тест');
    expect(names).toContain('ТестДок');
  });

  it('returns empty tables when cfPath does not exist', () => {
    const model = parseCf('/nonexistent/path/cf');
    expect(model.version).toBe(1);
    expect(model.tables).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `npm run test:unit -- test/unit/cfParser.test.ts 2>&1 | head -20`

Expected: Fails with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/metadata/cfParser.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import type { MetaField, MetaTable, MetadataModel, MetaType, TableKind } from './types';

type DOMDocument = ReturnType<DOMParser['parseFromString']>;
type Element = ReturnType<DOMDocument['documentElement']['childNodes']['item']> & {
  childNodes: any; localName: string; textContent: string | null;
};

function firstElementChild(parent: { childNodes: any }): any | null {
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) return nodes[i];
  }
  return null;
}

function childByLocalName(parent: any, localName: string): any | null {
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

function childrenByLocalName(parent: any, localName: string): any[] {
  const result: any[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) result.push(n);
  }
  return result;
}

function nodeText(el: any | null): string {
  return el?.textContent?.trim() ?? '';
}

function parseTypeString(s: string): MetaType {
  if (s === 'xs:boolean') return { primitive: 'Булево' };
  if (s === 'xs:string') return { primitive: 'Строка' };
  if (s === 'xs:decimal') return { primitive: 'Число' };
  if (s === 'xs:dateTime') return { primitive: 'Дата' };
  const catMatch = s.match(/^cfg:CatalogRef\.(.+)$/);
  if (catMatch) return { ref: { kind: 'Справочник', name: catMatch[1] } };
  const docMatch = s.match(/^cfg:DocumentRef\.(.+)$/);
  if (docMatch) return { ref: { kind: 'Документ', name: docMatch[1] } };
  return {};
}

function parseAttribute(attrEl: any): MetaField | null {
  const props = childByLocalName(attrEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const typeContainer = childByLocalName(props, 'Type');
  if (!typeContainer) return { name, kind: 'attribute', types: [] };
  // Inner <v8:Type> elements have localName 'Type' inside the outer <Type> container
  const typeEls = childrenByLocalName(typeContainer, 'Type');
  const types: MetaType[] = typeEls
    .map((el: any) => nodeText(el))
    .filter(Boolean)
    .map(parseTypeString);
  return { name, kind: 'attribute', types };
}

const CATALOG_STANDARD_FIELDS: MetaField[] = [
  { name: 'Ссылка', kind: 'standard', types: [] },
  { name: 'Код', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'Наименование', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'ПометкаУдаления', kind: 'standard', types: [{ primitive: 'Булево' }] },
  { name: 'Предопределённый', kind: 'standard', types: [{ primitive: 'Булево' }] },
];

const DOCUMENT_STANDARD_FIELDS: MetaField[] = [
  { name: 'Ссылка', kind: 'standard', types: [] },
  { name: 'Номер', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'Дата', kind: 'standard', types: [{ primitive: 'Дата' }] },
  { name: 'Проведён', kind: 'standard', types: [{ primitive: 'Булево' }] },
  { name: 'ПометкаУдаления', kind: 'standard', types: [{ primitive: 'Булево' }] },
];

function parseObjectXml(xml: string, kind: TableKind): MetaTable | null {
  let doc: any;
  try {
    const parser = new DOMParser({
      errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} },
    });
    doc = parser.parseFromString(xml, 'text/xml');
    // Detect parse errors: @xmldom/xmldom may insert <parsererror> on invalid XML
    if (doc.getElementsByTagName('parsererror').length) return null;
  } catch {
    return null;
  }

  const root = doc.documentElement;
  if (!root) return null;
  const objectEl = firstElementChild(root);
  if (!objectEl) return null;

  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;

  const childObjects = childByLocalName(objectEl, 'ChildObjects');
  const attributes: MetaField[] = [];
  if (childObjects) {
    for (const attrEl of childrenByLocalName(childObjects, 'Attribute')) {
      const field = parseAttribute(attrEl);
      if (field) attributes.push(field);
    }
  }

  const standardFields =
    kind === 'Справочник' ? CATALOG_STANDARD_FIELDS : DOCUMENT_STANDARD_FIELDS;

  return {
    kind,
    name,
    fullName: `${kind}.${name}`,
    fields: [...standardFields.map(f => ({ ...f, types: [...f.types] })), ...attributes],
  };
}

export function parseCatalogXml(xml: string): MetaTable | null {
  return parseObjectXml(xml, 'Справочник');
}

export function parseDocumentXml(xml: string): MetaTable | null {
  return parseObjectXml(xml, 'Документ');
}

function scanDirectory(dir: string, kind: TableKind): MetaTable[] {
  const tables: MetaTable[] = [];
  if (!fs.existsSync(dir)) return tables;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.xml')) continue;
    const xmlPath = path.join(dir, entry);
    try {
      const xml = fs.readFileSync(xmlPath, 'utf8');
      const table =
        kind === 'Справочник' ? parseCatalogXml(xml) : parseDocumentXml(xml);
      if (table) tables.push(table);
    } catch {
      // skip unreadable files
    }
  }
  return tables;
}

export function parseCf(cfPath: string): MetadataModel {
  if (!fs.existsSync(cfPath)) {
    return { version: 1, tables: [] };
  }
  const catalogs = scanDirectory(path.join(cfPath, 'Catalogs'), 'Справочник');
  const documents = scanDirectory(path.join(cfPath, 'Documents'), 'Документ');
  return { version: 1, tables: [...catalogs, ...documents] };
}
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `npm run test:unit -- test/unit/cfParser.test.ts --reporter=verbose 2>&1`

Expected: All `cfParser` tests pass. If `parsererror` detection fails for malformed XML, check `@xmldom/xmldom` error handling config.

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata/cfParser.ts test/unit/cfParser.test.ts
git commit -m "feat(tdd): CF parser — parseCf(cfPath) → MetadataModel from src/cf XML"
```

---

## Task 7: Metadata Cache (TDD)

**Files:**
- Create: `test/unit/cache.test.ts`
- Create: `src/core/metadata/cacheBuilder.ts`
- Create: `src/core/metadata/cacheLoader.ts`

- [ ] **Step 1: Write `test/unit/cache.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildCachePath, writeCache } from '../../src/core/metadata/cacheBuilder';
import { isCacheValid, readCache } from '../../src/core/metadata/cacheLoader';
import type { MetadataModel } from '../../src/core/metadata/types';

const MODEL: MetadataModel = {
  version: 1,
  tables: [
    {
      kind: 'Справочник',
      name: 'Тест',
      fullName: 'Справочник.Тест',
      fields: [],
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildCachePath', () => {
  it('returns a path inside storageUri with .json extension', () => {
    const p = buildCachePath(tmpDir, '/some/path/src/cf');
    expect(p).toMatch(/\.json$/);
    expect(p.startsWith(tmpDir)).toBe(true);
  });

  it('produces different paths for different cfPaths', () => {
    const p1 = buildCachePath(tmpDir, '/project-a/src/cf');
    const p2 = buildCachePath(tmpDir, '/project-b/src/cf');
    expect(p1).not.toBe(p2);
  });
});

describe('writeCache + readCache round-trip', () => {
  it('persists and restores the model exactly', () => {
    const cachePath = buildCachePath(tmpDir, '/test/src/cf');
    writeCache(cachePath, MODEL);
    const restored = readCache(cachePath);
    expect(restored).toEqual(MODEL);
  });

  it('readCache returns null for missing file', () => {
    expect(readCache('/no/such/file.json')).toBeNull();
  });

  it('readCache returns null when version mismatches', () => {
    const cachePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(cachePath, JSON.stringify({ version: 99, tables: [] }));
    expect(readCache(cachePath)).toBeNull();
  });
});

describe('isCacheValid', () => {
  it('returns false when cache file does not exist', () => {
    const cfPath = tmpDir;
    expect(isCacheValid('/no/cache.json', cfPath)).toBe(false);
  });

  it('returns true when cache is newer than all cf files', () => {
    // Write a cf file, then write the cache (newer)
    const cfDir = path.join(tmpDir, 'cf');
    fs.mkdirSync(cfDir);
    const xmlFile = path.join(cfDir, 'test.xml');
    fs.writeFileSync(xmlFile, '<x/>');

    const cachePath = buildCachePath(tmpDir, cfDir);
    writeCache(cachePath, MODEL);

    // Touch cache mtime to be newer (1 second in future via utime)
    const futureMs = Date.now() + 2000;
    fs.utimesSync(cachePath, futureMs / 1000, futureMs / 1000);

    expect(isCacheValid(cachePath, cfDir)).toBe(true);
  });

  it('returns false when cf has a file newer than cache', () => {
    const cfDir = path.join(tmpDir, 'cf');
    fs.mkdirSync(cfDir);
    const cachePath = buildCachePath(tmpDir, cfDir);
    writeCache(cachePath, MODEL);

    // Write an xml file AFTER the cache
    const xmlFile = path.join(cfDir, 'new.xml');
    fs.writeFileSync(xmlFile, '<x/>');
    const futureMs = Date.now() + 2000;
    fs.utimesSync(xmlFile, futureMs / 1000, futureMs / 1000);

    expect(isCacheValid(cachePath, cfDir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit -- test/unit/cache.test.ts 2>&1 | head -15`

Expected: Fails with `Cannot find module`.

- [ ] **Step 3: Implement `src/core/metadata/cacheBuilder.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MetadataModel } from './types';

export function buildCachePath(storageUri: string, cfPath: string): string {
  const hash = crypto.createHash('sha1').update(cfPath).digest('hex');
  return path.join(storageUri, `metadata-${hash}.json`);
}

export function writeCache(cachePath: string, model: MetadataModel): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(model));
}
```

- [ ] **Step 4: Implement `src/core/metadata/cacheLoader.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { MetadataModel } from './types';

export function readCache(cachePath: string): MetadataModel | null {
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (data.version === 1) return data as MetadataModel;
  } catch {
    // missing file or invalid JSON
  }
  return null;
}

function newestMtime(dirPath: string): number {
  let max = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        max = Math.max(max, newestMtime(full));
      } else {
        max = Math.max(max, fs.statSync(full).mtimeMs);
      }
    }
  } catch {
    // inaccessible directory — treat as 0
  }
  return max;
}

export function isCacheValid(cachePath: string, cfPath: string): boolean {
  if (!fs.existsSync(cachePath)) return false;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1) return false;
    const cacheMtime = fs.statSync(cachePath).mtimeMs;
    const cfMtime = newestMtime(cfPath);
    return cfMtime <= cacheMtime;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run all unit tests — verify they all pass**

Run: `npm run test:unit -- --reporter=verbose 2>&1`

Expected: All tests pass (sdblGenerator + cfParser + cache).

- [ ] **Step 6: Commit**

```bash
git add src/core/metadata/cacheBuilder.ts src/core/metadata/cacheLoader.ts test/unit/cache.test.ts
git commit -m "feat(tdd): metadata cache — write/read JSON with mtime-based invalidation"
```

---

## Task 8: Extension Host Layer

**Files:**
- Create: `src/extension/insertResult.ts`
- Create: `src/extension/panel.ts`
- Modify: `src/extension/extension.ts`

- [ ] **Step 1: Write `src/extension/insertResult.ts`**

```ts
import * as vscode from 'vscode';

export async function insertResult(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await editor.edit(b => b.replace(editor.selection, text));
  } else {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Текст запроса скопирован в буфер обмена');
  }
}
```

- [ ] **Step 2: Write `src/extension/panel.ts`**

```ts
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
    if (cached) return cached;
  }
  channel.appendLine(`[1C Query] Parsing metadata from: ${cfPath}`);
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
  loadMetadata(context, cfPath, channel).then(m => { metadataModel = m; });

  panel.webview.onDidReceiveMessage(async (msg: WebviewMsg) => {
    if (msg.type === 'ready') {
      const reply: HostMsg = { type: 'metadataTree', tables: metadataModel.tables };
      panel.webview.postMessage(reply);
      if (metadataModel.tables.length === 0 && !cfPath) {
        vscode.window.showWarningMessage('Не найдена выгрузка конфигурации. Укажите путь в настройке queryConsole.metadataPath');
      }
    } else if (msg.type === 'expandRef') {
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
      await insertResult(text);
    }
  });

  return panel;
}
```

- [ ] **Step 3: Write `src/extension/extension.ts`**

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createPanel } from './panel';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('1C Query Constructor');

  const cmd = vscode.commands.registerCommand('1c.queryConstructor', () => {
    const cfPath = resolveCfPath();
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
```

- [ ] **Step 4: Build extension and verify zero type errors**

Run: `npm run build:extension 2>&1`

Expected: Exits 0, `out/extension/` contains JS files with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension/
git commit -m "feat: extension host — command registration, webview panel, metadata load, insertResult"
```

---

## Task 9: Webview React UI

**Files:**
- Create: `src/webview/bridge.ts`
- Create: `src/webview/state/queryStore.ts`
- Create: `src/webview/components/TabsBar.tsx`
- Create: `src/webview/components/DbTreePanel.tsx`
- Create: `src/webview/components/TablesPanel.tsx`
- Create: `src/webview/components/FieldsPanel.tsx`
- Create: `src/webview/App.tsx`
- Create: `src/webview/main.tsx`

- [ ] **Step 1: Write `src/webview/bridge.ts`**

```ts
import type { HostMsg, WebviewMsg } from '../shared/messages';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const _vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

export function postToHost(msg: WebviewMsg): void {
  _vscode?.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostMsg) => void): () => void {
  const listener = (event: MessageEvent) => handler(event.data as HostMsg);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
```

- [ ] **Step 2: Write `src/webview/state/queryStore.ts`**

```ts
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField } from '../../core/query/queryModel';
import type { RefId } from '../../shared/messages';
import type { MetaField } from '../../core/metadata/types';

export interface QueryState {
  tables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  expandedRefs: Map<string, MetaField[]>;
  generatedText: string;
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedTableId: string | null;
  focusedSelectedFieldIdx: number | null;
}

export type QueryAction =
  | { type: 'SET_METADATA'; tables: MetaTable[] }
  | { type: 'SET_GENERATED_TEXT'; text: string }
  | { type: 'SET_REF_FIELDS'; ref: RefId; fields: MetaField[] }
  | { type: 'FOCUS_DB_TABLE'; fullName: string }
  | { type: 'FOCUS_DB_FIELD'; tableFullName: string; fieldPath: string }
  | { type: 'ADD_TABLE'; table: MetaTable }
  | { type: 'REMOVE_TABLE'; tableId: string }
  | { type: 'ADD_FIELD'; tableId: string; fieldPath: string }
  | { type: 'REMOVE_FIELD'; fieldIdx: number }
  | { type: 'FOCUS_SELECTED_TABLE'; id: string }
  | { type: 'FOCUS_SELECTED_FIELD'; idx: number };

export function initialState(): QueryState {
  return {
    tables: [],
    selectedTables: [],
    selectedFields: [],
    expandedRefs: new Map(),
    generatedText: '',
    focusedDbTableFullName: null,
    focusedDbFieldPath: null,
    focusedSelectedTableId: null,
    focusedSelectedFieldIdx: null,
  };
}

let _tableCounter = 0;

export function reducer(state: QueryState, action: QueryAction): QueryState {
  switch (action.type) {
    case 'SET_METADATA':
      return { ...state, tables: action.tables };

    case 'SET_GENERATED_TEXT':
      return { ...state, generatedText: action.text };

    case 'SET_REF_FIELDS': {
      const key = `${action.ref.kind}.${action.ref.name}`;
      const updated = new Map(state.expandedRefs);
      updated.set(key, action.fields);
      return { ...state, expandedRefs: updated };
    }

    case 'FOCUS_DB_TABLE':
      return { ...state, focusedDbTableFullName: action.fullName, focusedDbFieldPath: null };

    case 'FOCUS_DB_FIELD':
      return { ...state, focusedDbTableFullName: action.tableFullName, focusedDbFieldPath: action.fieldPath };

    case 'ADD_TABLE': {
      const alreadyIn = state.selectedTables.some(t => t.fullName === action.table.fullName);
      if (alreadyIn) return state;
      const id = `t${++_tableCounter}`;
      return {
        ...state,
        selectedTables: [...state.selectedTables, { id, fullName: action.table.fullName }],
        focusedSelectedTableId: id,
      };
    }

    case 'REMOVE_TABLE': {
      const filtered = state.selectedTables.filter(t => t.id !== action.tableId);
      const fields = state.selectedFields.filter(f => f.tableId !== action.tableId);
      return { ...state, selectedTables: filtered, selectedFields: fields, focusedSelectedTableId: null };
    }

    case 'ADD_FIELD': {
      const alreadyIn = state.selectedFields.some(
        f => f.tableId === action.tableId && f.path === action.fieldPath
      );
      if (alreadyIn) return state;
      const newField = { tableId: action.tableId, path: action.fieldPath };
      return { ...state, selectedFields: [...state.selectedFields, newField] };
    }

    case 'REMOVE_FIELD': {
      const fields = state.selectedFields.filter((_, i) => i !== action.fieldIdx);
      return { ...state, selectedFields: fields, focusedSelectedFieldIdx: null };
    }

    case 'FOCUS_SELECTED_TABLE':
      return { ...state, focusedSelectedTableId: action.id };

    case 'FOCUS_SELECTED_FIELD':
      return { ...state, focusedSelectedFieldIdx: action.idx };

    default:
      return state;
  }
}
```

- [ ] **Step 3: Write `src/webview/components/TabsBar.tsx`**

```tsx
import * as React from 'react';

const TABS = ['Таблицы и поля'];

export function TabsBar(): React.ReactElement {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border, #444)', background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)' }}>
      {TABS.map(tab => (
        <div
          key={tab}
          style={{
            padding: '6px 16px',
            cursor: 'default',
            borderBottom: '2px solid var(--vscode-focusBorder, #007fd4)',
            color: 'var(--vscode-tab-activeForeground, #fff)',
            fontSize: 13,
          }}
        >
          {tab}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `src/webview/components/DbTreePanel.tsx`**

```tsx
import * as React from 'react';
import type { MetaTable, MetaField, TableKind } from '../../core/metadata/types';
import type { RefId } from '../../shared/messages';

interface Props {
  tables: MetaTable[];
  expandedRefs: Map<string, MetaField[]>;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusTable: (fullName: string) => void;
  onFocusField: (tableFullName: string, fieldPath: string) => void;
  onExpandRef: (ref: RefId) => void;
}

const GROUP_KINDS: TableKind[] = ['Справочник', 'Документ'];
const GROUP_LABELS: Record<TableKind, string> = {
  'Справочник': 'Справочники',
  'Документ': 'Документы',
};

function FieldNode({ tableFullName, fieldPath, field, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusField, onExpandRef, depth }: {
  tableFullName: string;
  fieldPath: string;
  field: MetaField;
  expandedRefs: Map<string, MetaField[]>;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusField: (t: string, p: string) => void;
  onExpandRef: (ref: RefId) => void;
  depth: number;
}): React.ReactElement {
  const ref = field.types.find(t => t.ref)?.ref ?? null;
  const refKey = ref ? `${ref.kind}.${ref.name}` : null;
  const expanded = refKey ? expandedRefs.has(refKey) : false;
  const isFocused = focusedTableFullName === tableFullName && focusedFieldPath === fieldPath;

  return (
    <>
      <div
        data-field-path={fieldPath}
        onClick={() => onFocusField(tableFullName, fieldPath)}
        style={{
          paddingLeft: 8 + depth * 16,
          paddingTop: 2,
          paddingBottom: 2,
          cursor: 'default',
          background: isFocused ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
          color: isFocused ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          userSelect: 'none',
        }}
      >
        {ref && (
          <span
            onClick={e => { e.stopPropagation(); if (!expanded) onExpandRef(ref); }}
            style={{ cursor: 'pointer', fontSize: 10, width: 12 }}
          >
            {expanded ? '▼' : '▶'}
          </span>
        )}
        {!ref && <span style={{ width: 12 }} />}
        <span>{field.name}</span>
      </div>
      {expanded && refKey && expandedRefs.get(refKey)?.map(subField => (
        <FieldNode
          key={`${fieldPath}.${subField.name}`}
          tableFullName={tableFullName}
          fieldPath={`${fieldPath}.${subField.name}`}
          field={subField}
          expandedRefs={expandedRefs}
          focusedTableFullName={focusedTableFullName}
          focusedFieldPath={focusedFieldPath}
          onFocusField={onFocusField}
          onExpandRef={onExpandRef}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export function DbTreePanel({ tables, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusTable, onFocusField, onExpandRef }: Props): React.ReactElement {
  const [expandedGroups, setExpandedGroups] = React.useState<Set<TableKind>>(new Set(['Справочник', 'Документ']));
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());

  function toggleGroup(kind: TableKind) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  }

  function toggleTable(fullName: string) {
    setExpandedTables(prev => {
      const next = new Set(prev);
      next.has(fullName) ? next.delete(fullName) : next.add(fullName);
      return next;
    });
  }

  return (
    <div style={{ overflowY: 'auto', height: '100%', fontSize: 13 }}>
      {GROUP_KINDS.map(kind => {
        const group = tables.filter(t => t.kind === kind);
        const isExpanded = expandedGroups.has(kind);
        return (
          <div key={kind}>
            <div
              onClick={() => toggleGroup(kind)}
              style={{ padding: '3px 8px', fontWeight: 'bold', cursor: 'default', display: 'flex', gap: 4, userSelect: 'none' }}
            >
              <span>{isExpanded ? '▼' : '▶'}</span>
              <span>{GROUP_LABELS[kind]}</span>
            </div>
            {isExpanded && group.map(table => {
              const isTableExpanded = expandedTables.has(table.fullName);
              const isFocused = focusedTableFullName === table.fullName && !focusedFieldPath;
              return (
                <div key={table.fullName}>
                  <div
                    data-table-fullname={table.fullName}
                    onClick={() => { toggleTable(table.fullName); onFocusTable(table.fullName); }}
                    style={{
                      paddingLeft: 24,
                      paddingTop: 2,
                      paddingBottom: 2,
                      cursor: 'default',
                      background: isFocused ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                      color: isFocused ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
                      display: 'flex',
                      gap: 4,
                      userSelect: 'none',
                    }}
                  >
                    <span>{isTableExpanded ? '▼' : '▶'}</span>
                    <span>{table.name}</span>
                  </div>
                  {isTableExpanded && table.fields.map(field => (
                    <FieldNode
                      key={`${table.fullName}:${field.name}`}
                      tableFullName={table.fullName}
                      fieldPath={field.name}
                      field={field}
                      expandedRefs={expandedRefs}
                      focusedTableFullName={focusedTableFullName}
                      focusedFieldPath={focusedFieldPath}
                      onFocusField={onFocusField}
                      onExpandRef={onExpandRef}
                      depth={2}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Write `src/webview/components/TablesPanel.tsx`**

```tsx
import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
  focusedDbTableFullName: string | null;
  focusedSelectedTableId: string | null;
  onAddTable: (table: MetaTable) => void;
  onRemoveTable: (tableId: string) => void;
  onFocusTable: (id: string) => void;
}

const BTN: React.CSSProperties = {
  padding: '2px 8px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

export function TablesPanel({ metaTables, selectedTables, focusedDbTableFullName, focusedSelectedTableId, onAddTable, onRemoveTable, onFocusTable }: Props): React.ReactElement {
  const focusedMeta = metaTables.find(t => t.fullName === focusedDbTableFullName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Таблицы</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Добавить таблицу"
          disabled={!focusedMeta}
          onClick={() => focusedMeta && onAddTable(focusedMeta)}
        >
          &gt;
        </button>
        <button
          style={BTN}
          title="Убрать таблицу"
          disabled={!focusedSelectedTableId}
          onClick={() => focusedSelectedTableId && onRemoveTable(focusedSelectedTableId)}
        >
          &lt;
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', fontSize: 13 }}>
        {selectedTables.map(t => (
          <div
            key={t.id}
            data-table-id={t.id}
            onClick={() => onFocusTable(t.id)}
            style={{
              padding: '2px 6px',
              cursor: 'default',
              background: focusedSelectedTableId === t.id ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
              color: focusedSelectedTableId === t.id ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
              userSelect: 'none',
            }}
          >
            {t.fullName}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write `src/webview/components/FieldsPanel.tsx`**

```tsx
import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedFieldIdx: number | null;
  onAddField: (tableId: string, fieldPath: string) => void;
  onRemoveField: (fieldIdx: number) => void;
  onFocusField: (idx: number) => void;
  onGenerate: () => void;
}

const BTN: React.CSSProperties = {
  padding: '2px 8px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

export function FieldsPanel({ metaTables, selectedTables, selectedFields, focusedDbTableFullName, focusedDbFieldPath, focusedSelectedFieldIdx, onAddField, onRemoveField, onFocusField, onGenerate }: Props): React.ReactElement {
  function handleAddField() {
    if (!focusedDbTableFullName || !focusedDbFieldPath) return;
    // Find or auto-add table
    let tableInQuery = selectedTables.find(t => t.fullName === focusedDbTableFullName);
    if (!tableInQuery) {
      // Can't add field without table — noop (user should add table first)
      return;
    }
    onAddField(tableInQuery.id, focusedDbFieldPath);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Поля</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Добавить поле"
          disabled={!focusedDbFieldPath || !selectedTables.some(t => t.fullName === focusedDbTableFullName)}
          onClick={handleAddField}
        >
          &gt;
        </button>
        <button
          style={BTN}
          title="Убрать поле"
          disabled={focusedSelectedFieldIdx === null}
          onClick={() => focusedSelectedFieldIdx !== null && onRemoveField(focusedSelectedFieldIdx)}
        >
          &lt;
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', fontSize: 13 }}>
        {selectedFields.map((f, i) => {
          const table = selectedTables.find(t => t.id === f.tableId);
          const label = table ? `${table.fullName.split('.')[1]}.${f.path}` : f.path;
          return (
            <div
              key={`${f.tableId}:${f.path}`}
              data-field-idx={i}
              onClick={() => onFocusField(i)}
              style={{
                padding: '2px 6px',
                cursor: 'default',
                background: focusedSelectedFieldIdx === i ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                color: focusedSelectedFieldIdx === i ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
                userSelect: 'none',
              }}
            >
              {label}
            </div>
          );
        })}
      </div>
      <button
        data-testid="btn-generate"
        style={{ ...BTN, padding: '6px 12px', alignSelf: 'flex-end', marginTop: 4 }}
        onClick={onGenerate}
      >
        Запрос
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Write `src/webview/App.tsx`**

```tsx
import * as React from 'react';
import { useReducer, useEffect } from 'react';
import { TabsBar } from './components/TabsBar';
import { DbTreePanel } from './components/DbTreePanel';
import { TablesPanel } from './components/TablesPanel';
import { FieldsPanel } from './components/FieldsPanel';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer } from './state/queryStore';
import type { QueryModel } from '../core/query/queryModel';

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    const unsub = onHostMessage(msg => {
      if (msg.type === 'metadataTree') {
        dispatch({ type: 'SET_METADATA', tables: msg.tables });
      } else if (msg.type === 'refFields') {
        dispatch({ type: 'SET_REF_FIELDS', ref: msg.ref, fields: msg.fields });
      } else if (msg.type === 'generatedText') {
        dispatch({ type: 'SET_GENERATED_TEXT', text: msg.text });
      }
    });
    postToHost({ type: 'ready' });
    return unsub;
  }, []);

  function handleGenerate() {
    const model: QueryModel = {
      tables: state.selectedTables,
      fields: state.selectedFields,
    };
    postToHost({ type: 'generate', model });
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
          />
        </div>
        <div style={panelStyle}>
          <TablesPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            focusedDbTableFullName={state.focusedDbTableFullName}
            focusedSelectedTableId={state.focusedSelectedTableId}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onRemoveTable={tableId => dispatch({ type: 'REMOVE_TABLE', tableId })}
            onFocusTable={id => dispatch({ type: 'FOCUS_SELECTED_TABLE', id })}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            selectedFields={state.selectedFields}
            focusedDbTableFullName={state.focusedDbTableFullName}
            focusedDbFieldPath={state.focusedDbFieldPath}
            focusedSelectedFieldIdx={state.focusedSelectedFieldIdx}
            onAddField={(tableId, fieldPath) => dispatch({ type: 'ADD_FIELD', tableId, fieldPath })}
            onRemoveField={idx => dispatch({ type: 'REMOVE_FIELD', fieldIdx: idx })}
            onFocusField={idx => dispatch({ type: 'FOCUS_SELECTED_FIELD', idx })}
            onGenerate={handleGenerate}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Write `src/webview/main.tsx`**

```tsx
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(React.createElement(App));
}
```

- [ ] **Step 9: Build the webview bundle**

Run: `npm run build:webview 2>&1`

Expected: Exits 0, `out/webview/main.js` created (should be several hundred KB with React bundled). No TypeScript/JSX errors.

- [ ] **Step 10: Commit**

```bash
git add src/webview/
git commit -m "feat: React webview UI — DbTreePanel, TablesPanel, FieldsPanel, App, bridge"
```

---

## Task 10: Playwright E2E Test

**Files:**
- Create: `playwright.config.ts`
- Create: `test/e2e/harness/index.html`
- Create: `test/e2e/webview.spec.ts`

- [ ] **Step 1: Install Playwright browsers**

Run: `npx playwright install chromium 2>&1 | tail -5`

Expected: Chromium downloaded, no errors.

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 15000,
  use: {
    headless: true,
  },
  webServer: {
    command: `npx serve test/e2e/harness -p 5555 --no-port-switching`,
    port: 5555,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
```

- [ ] **Step 3: Write `test/e2e/harness/index.html`**

This page loads the built webview bundle and injects mock metadata so the UI works in isolation without VS Code.

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Webview Harness</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; height: 100vh; }
  </style>
</head>
<body>
  <div id="root" style="height:100vh;"></div>
  <script>
    // Capture all outgoing messages from the webview
    window.__webviewMessages = [];

    // Mock acquireVsCodeApi — must be defined BEFORE the bundle loads
    window.acquireVsCodeApi = function() {
      return {
        postMessage: function(msg) {
          window.__webviewMessages.push(msg);
          // Simulate host responses
          if (msg.type === 'ready') {
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: {
                  type: 'metadataTree',
                  tables: [
                    {
                      kind: 'Справочник',
                      name: 'Валюты',
                      fullName: 'Справочник.Валюты',
                      fields: [
                        { name: 'Ссылка', kind: 'standard', types: [] },
                        { name: 'Код', kind: 'standard', types: [{ primitive: 'Строка' }] },
                        { name: 'Наименование', kind: 'standard', types: [{ primitive: 'Строка' }] },
                        { name: 'ЗагружаетсяИзИнтернета', kind: 'attribute', types: [{ primitive: 'Булево' }] }
                      ]
                    }
                  ]
                }
              }));
            }, 50);
          } else if (msg.type === 'generate') {
            // Simulate SDBL generation in harness (simplified)
            var tables = msg.model.tables;
            var fields = msg.model.fields;
            if (!tables.length || !fields.length) return;
            var alias = tables[0].fullName.split('.')[1];
            var fieldLines = fields.map(function(f, i) {
              return '\t' + alias + '.' + f.path + (i < fields.length - 1 ? ',' : '');
            });
            var text = 'ВЫБРАТЬ\n' + fieldLines.join('\n') + '\nИЗ\n\t' + tables[0].fullName + ' КАК ' + alias;
            window.__generatedText = text;
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'generatedText', text: text }
              }));
            }, 10);
          }
        }
      };
    };
  </script>
  <script src="../../../out/webview/main.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `test/e2e/webview.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5555';

test.describe('Query Constructor Webview', () => {
  test('shows Справочники group in DB tree', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('text=Справочники')).toBeVisible();
  });

  test('expands Справочники group to show Валюты', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('text=Справочники').click();
    await expect(page.locator('[data-table-fullname="Справочник.Валюты"]')).toBeVisible();
  });

  test('expands Валюты to show fields', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await expect(page.locator('[data-field-path="Код"]')).toBeVisible();
    await expect(page.locator('[data-field-path="Наименование"]')).toBeVisible();
  });

  test('adds table to Tables panel via > button', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    // Click > in Tables panel
    await page.locator('button[title="Добавить таблицу"]').click();
    await expect(page.locator('[data-table-id]')).toBeVisible();
    await expect(page.locator('text=Справочник.Валюты')).toBeVisible();
  });

  test('adds field to Fields panel via > button after table selected', async ({ page }) => {
    await page.goto(BASE);
    // Expand and add table first
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('button[title="Добавить таблицу"]').click();

    // Now expand fields and click a field
    await page.locator('[data-field-path="Код"]').click();
    await page.locator('button[title="Добавить поле"]').click();

    await expect(page.locator('[data-field-idx="0"]')).toBeVisible();
    await expect(page.locator('text=Валюты.Код')).toBeVisible();
  });

  test('clicking Запрос generates query text', async ({ page }) => {
    await page.goto(BASE);
    // Add table
    await page.locator('[data-table-fullname="Справочник.Валюты"]').click();
    await page.locator('button[title="Добавить таблицу"]').click();
    // Add field
    await page.locator('[data-field-path="Код"]').click();
    await page.locator('button[title="Добавить поле"]').click();

    await page.locator('[data-testid="btn-generate"]').click();

    // Verify the generate message was sent
    const messages = await page.evaluate(() => (window as any).__webviewMessages);
    const genMsg = messages.find((m: any) => m.type === 'generate');
    expect(genMsg).toBeTruthy();
    expect(genMsg.model.tables[0].fullName).toBe('Справочник.Валюты');
    expect(genMsg.model.fields[0].path).toBe('Код');
  });
});
```

- [ ] **Step 5: Install `serve` for the static server**

Run: `npm install --save-dev serve 2>&1 | tail -3`

Expected: `serve` added to devDependencies.

- [ ] **Step 6: Build webview (needed before E2E)**

Run: `npm run build:webview 2>&1`

Expected: `out/webview/main.js` up-to-date.

- [ ] **Step 7: Run E2E tests**

Run: `npm run test:e2e 2>&1`

Expected: All 5 tests pass. If the static server fails to start, check that port 5555 is free.

If `[data-table-fullname]` selectors can't find elements, verify `DbTreePanel.tsx` has `data-table-fullname={table.fullName}` on the table row div. If `[data-field-path]` misses, verify `FieldNode` has `data-field-path={fieldPath}`.

- [ ] **Step 8: Run all tests**

Run: `npm test 2>&1`

Expected: All unit tests pass (generator + parser + cache).

Run: `npm run test:e2e 2>&1`

Expected: All E2E tests pass.

- [ ] **Step 9: Final build**

Run: `npm run build 2>&1`

Expected: Exits 0. `out/extension/` and `out/webview/main.js` are up-to-date.

- [ ] **Step 10: Commit**

```bash
git add playwright.config.ts test/e2e/ package.json package-lock.json
git commit -m "test(e2e): Playwright webview harness — tree, table/field add, generate flow"
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Covered in task |
|---|---|
| Command `1С: Конструктор запроса` | Task 8 (extension.ts) |
| Webview panel opens | Task 8 (panel.ts) |
| DB tree: Справочники + Документы | Task 9 (DbTreePanel) |
| Раскрытие ссылочных полей на 1 уровень | Task 9 (DbTreePanel FieldNode + expandRef) |
| Tables panel with > < | Task 9 (TablesPanel) |
| Fields panel with > < | Task 9 (FieldsPanel) |
| Button "Запрос" → generates ВЫБРАТЬ … ИЗ … | Task 4 (sdblGenerator) + Task 8 (panel.ts) |
| Insert into active editor | Task 8 (insertResult.ts) |
| Multiple tables in FROM | Task 4 (sdblGenerator multi-table test) |
| src/cf not found → empty + banner | Task 8 (panel.ts ready handler) |
| Broken XML → skip object | Task 6 (cfParser parseObjectXml try/catch) |
| Unknown type → empty types | Task 6 (parseTypeString returns `{}`) |
| Empty selection → '' + info msg | Task 4 (returns '') + Task 8 (showInformationMessage) |
| No active editor → clipboard | Task 8 (insertResult.ts) |
| Cache path = hash(cfPath) in globalStorageUri | Task 7 (cacheBuilder) |
| queryConsole.metadataPath setting | Task 1 (package.json contributes.configuration) |
| Cache invalidation: mtime + version | Task 7 (cacheLoader) |
| WASM oracle in unit tests | Task 3 + Task 4 |
| Unit tests: sdblGenerator | Task 4 |
| Unit tests: cfParser | Task 6 |
| Unit tests: cache | Task 7 |
| E2E: Playwright webview | Task 10 |

**All requirements covered. No gaps found.**
