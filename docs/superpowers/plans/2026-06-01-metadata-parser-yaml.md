# Парсер метаданных → YAML: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Построить standalone-парсер метаданных 1С, который читает XML-выгрузку конфигурации и пишет дерево YAML-файлов (`cf/<Тип>/<Имя>.yaml` + `cf/configuration.yaml`), запускаемый CLI-командой и тонкой VS Code командой.

**Architecture:** Чистое TS-ядро без зависимости от `vscode` в `src/core/metadata/parser/`: общие примитивы (DOM-хелперы, парсер типов, парсер реквизитов) + тонкие модули на каждый тип метаданных, скомпонованные оркестратором `parseConfiguration`. CLI (`src/cli/parseMetadata.ts`) и VS Code команда (`src/extension/parseCommand.ts`) — две тонкие обёртки над одним ядром. Старый путь (`cfParser.ts` → кэш → webview) не трогаем.

**Tech Stack:** TypeScript, `@xmldom/xmldom` (DOM-парсинг XML, уже в проекте), `yaml` (сериализация, добавляем), esbuild (сборка CLI), vitest (точечные юнит-тесты парсера типов).

Спек: `docs/superpowers/specs/2026-06-01-metadata-parser-yaml-design.md`

**Верификация:** основной способ — прогон CLI на реальной выгрузке `src/cf` и просмотр YAML глазами (по решению из спека). Единственное исключение — юнит-тесты на `typeParser` (Task 2): это самая хитрая чистая функция (квалификаторы, ссылки, составные типы), дешёвый и надёжный страховочный сетап на существующей инфраструктуре vitest.

---

## Структура файлов

Создаём:
- `src/core/metadata/parser/dom.ts` — DOM-утилиты (parseXml + хелперы + clean).
- `src/core/metadata/parser/model.ts` — TS-интерфейсы результата.
- `src/core/metadata/parser/typeParser.ts` — `<Type>` → `ParsedType[]`.
- `src/core/metadata/parser/attribute.ts` — реквизиты и табличные части.
- `src/core/metadata/parser/catalog.ts` — Справочник.
- `src/core/metadata/parser/document.ts` — Документ.
- `src/core/metadata/parser/constant.ts` — Константа.
- `src/core/metadata/parser/enum.ts` — Перечисление.
- `src/core/metadata/parser/yamlWriter.ts` — запись YAML.
- `src/core/metadata/parser/parseConfiguration.ts` — оркестратор.
- `src/cli/parseMetadata.ts` — CLI-вход.
- `src/extension/resolveCfPath.ts` — вынос текущей функции из `extension.ts`.
- `src/extension/parseCommand.ts` — VS Code команда-обёртка.
- `test/unit/typeParser.test.ts` — юнит-тесты парсера типов.

Модифицируем:
- `package.json` — зависимость `yaml`, npm-скрипты, contributes (команда + настройка).
- `tsconfig.json` — добавить `src/cli/**/*` в `include`.
- `src/extension/extension.ts` — использовать вынесенный `resolveCfPath`, зарегистрировать команду.

Не трогаем: `cfParser.ts`, `cacheBuilder.ts`, `cacheLoader.ts`, `panel.ts`, `types.ts`, webview.

---

## Task 1: Зависимости, конфиги, модель и DOM-утилиты

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `src/core/metadata/parser/model.ts`
- Create: `src/core/metadata/parser/dom.ts`

- [x] **Step 1: Добавить зависимость `yaml` и npm-скрипты в `package.json`**

В блок `devDependencies` (рядом с `@xmldom/xmldom`, который тоже бандлится esbuild'ом) добавить:

```json
    "yaml": "^2.4.5",
```

В блок `scripts` добавить две строки:

```json
    "build:cli": "esbuild src/cli/parseMetadata.ts --bundle --outfile=out/cli/parseMetadata.js --platform=node --format=cjs",
    "parse": "npm run build:cli && node out/cli/parseMetadata.js",
```

- [x] **Step 2: Добавить `src/cli` в `tsconfig.json`**

Заменить строку `include`:

```json
  "include": ["src/extension/**/*", "src/core/**/*", "src/shared/**/*", "src/cli/**/*"],
```

- [x] **Step 3: Установить зависимость**

Run: `npm install`
Expected: установка завершается без ошибок, `yaml` появляется в `node_modules`.

- [x] **Step 4: Создать `src/core/metadata/parser/model.ts`**

```typescript
export type Primitive = 'Строка' | 'Число' | 'Дата' | 'Булево';
export type TypeKind = Primitive | 'timestamp' | 'ref' | 'unknown';

export interface ParsedType {
  kind: TypeKind;
  // Строка
  length?: number;
  allowedLength?: string;
  // Число
  digits?: number;
  fractionDigits?: number;
  allowedSign?: string;
  // Дата
  dateFractions?: string;
  // ref
  ref?: string;
  // unknown
  raw?: string;
}

export interface ParsedField {
  name: string;
  category: 'standard' | 'attribute';
  types: ParsedType[];
}

export interface ParsedTabularSection {
  name: string;
  uuid: string;
  fields: ParsedField[];
}

export interface ParsedObject {
  version: 1;
  kind: 'Справочник' | 'Документ' | 'Константа' | 'Перечисление';
  name: string;
  fullName: string;
  uuid: string;
  source?: string;                       // проставляет оркестратор
  properties?: Record<string, unknown>;
  fields?: ParsedField[];
  tabularSections?: ParsedTabularSection[];
  values?: { name: string }[];           // Перечисление
  types?: ParsedType[];                  // Константа
}
```

- [x] **Step 5: Создать `src/core/metadata/parser/dom.ts`**

```typescript
import { DOMParser } from '@xmldom/xmldom';

/**
 * Парсит XML 1С в DOM. Срезает UTF-8 BOM (1С выгружает XML с BOM, иначе
 * @xmldom/xmldom падает с ParseError). Возвращает null при ошибке парсинга.
 */
export function parseXml(xml: string): any | null {
  try {
    const parser = new DOMParser({ onError: () => {} } as any);
    const doc = parser.parseFromString(xml.replace(/^﻿/, ''), 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return doc;
  } catch {
    return null;
  }
}

export function firstElementChild(parent: any): any | null {
  const nodes = parent?.childNodes;
  if (!nodes) return null;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) return nodes[i];
  }
  return null;
}

export function childByLocalName(parent: any, localName: string): any | null {
  const nodes = parent?.childNodes;
  if (!nodes) return null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

export function childrenByLocalName(parent: any, localName: string): any[] {
  const result: any[] = [];
  const nodes = parent?.childNodes;
  if (!nodes) return result;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) result.push(n);
  }
  return result;
}

export function nodeText(el: any | null): string {
  return el?.textContent?.trim() ?? '';
}

/** Удаляет ключи со значением undefined (чтобы YAML оставался чистым). */
export function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) delete (o as Record<string, unknown>)[k];
  }
  return o;
}
```

- [x] **Step 6: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/core/metadata/parser/model.ts src/core/metadata/parser/dom.ts
git commit -m "chore: каркас парсера метаданных — зависимости, модель, DOM-утилиты

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Парсер типов `typeParser` (TDD)

**Files:**
- Create: `src/core/metadata/parser/typeParser.ts`
- Test: `test/unit/typeParser.test.ts`

- [x] **Step 1: Написать падающий тест**

`test/unit/typeParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseTypeBlock, mapMdObjectRef } from '../../src/core/metadata/parser/typeParser';

/** Оборачивает внутренний XML в <Type> и возвращает этот элемент. */
function typeEl(inner: string): any {
  const doc = parseXml(`<r xmlns:v8="urn:v8"><Type>${inner}</Type></r>`);
  return firstElementChild(doc!.documentElement);
}

describe('parseTypeBlock', () => {
  it('строка с квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:string</v8:Type>' +
        '<v8:StringQualifiers><v8:Length>50</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Строка', length: 50, allowedLength: 'Variable' }]);
  });

  it('число с квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:decimal</v8:Type>' +
        '<v8:NumberQualifiers><v8:Digits>10</v8:Digits><v8:FractionDigits>2</v8:FractionDigits><v8:AllowedSign>Any</v8:AllowedSign></v8:NumberQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'Число', digits: 10, fractionDigits: 2, allowedSign: 'Any' },
    ]);
  });

  it('дата с DateFractions', () => {
    const el = typeEl(
      '<v8:Type>xs:dateTime</v8:Type>' +
        '<v8:DateQualifiers><v8:DateFractions>Date</v8:DateFractions></v8:DateQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Дата', dateFractions: 'Date' }]);
  });

  it('булево', () => {
    const el = typeEl('<v8:Type>xs:boolean</v8:Type>');
    expect(parseTypeBlock(el)).toEqual([{ kind: 'Булево' }]);
  });

  it('ссылки CatalogRef/DocumentRef/EnumRef', () => {
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:CatalogRef.Валюты</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Справочник.Валюты' },
    ]);
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:DocumentRef.Встреча</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Документ.Встреча' },
    ]);
    expect(parseTypeBlock(typeEl('<v8:Type>cfg:EnumRef.СпособыУстановкиКурсаВалюты</v8:Type>'))).toEqual([
      { kind: 'ref', ref: 'Перечисление.СпособыУстановкиКурсаВалюты' },
    ]);
  });

  it('составной тип: строка + число с раздельными квалификаторами', () => {
    const el = typeEl(
      '<v8:Type>xs:string</v8:Type>' +
        '<v8:Type>xs:decimal</v8:Type>' +
        '<v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers>' +
        '<v8:NumberQualifiers><v8:Digits>5</v8:Digits></v8:NumberQualifiers>'
    );
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'Строка', length: 10 },
      { kind: 'Число', digits: 5 },
    ]);
  });

  it('неизвестный тип сохраняется как unknown+raw', () => {
    const el = typeEl('<v8:Type>cfg:ChartOfAccountsRef.Основной</v8:Type>');
    expect(parseTypeBlock(el)).toEqual([
      { kind: 'unknown', raw: 'cfg:ChartOfAccountsRef.Основной' },
    ]);
  });

  it('mapMdObjectRef: формат Catalog./Document./Enum.', () => {
    expect(mapMdObjectRef('Catalog.Контрагенты')).toEqual({ kind: 'ref', ref: 'Справочник.Контрагенты' });
    expect(mapMdObjectRef('Document.ЗаказПокупателя')).toEqual({ kind: 'ref', ref: 'Документ.ЗаказПокупателя' });
    expect(mapMdObjectRef('Что-тоНепонятное')).toEqual({ kind: 'unknown', raw: 'Что-тоНепонятное' });
  });
});
```

- [x] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run test/unit/typeParser.test.ts`
Expected: FAIL — модуль `typeParser` не найден / `parseTypeBlock is not a function`.

- [x] **Step 3: Реализовать `src/core/metadata/parser/typeParser.ts`**

```typescript
import { childByLocalName, childrenByLocalName, nodeText, clean } from './dom';
import type { ParsedType } from './model';

function numChild(el: any, name: string): number | undefined {
  const t = nodeText(childByLocalName(el, name));
  return t ? Number(t) : undefined;
}

function strChild(el: any, name: string): string | undefined {
  const t = nodeText(childByLocalName(el, name));
  return t || undefined;
}

const REF_PREFIX: Record<string, string> = {
  CatalogRef: 'Справочник',
  DocumentRef: 'Документ',
  EnumRef: 'Перечисление',
};

const MD_PREFIX: Record<string, string> = {
  Catalog: 'Справочник',
  Document: 'Документ',
  Enum: 'Перечисление',
};

interface Qualifiers {
  stringQ: any | null;
  numberQ: any | null;
  dateQ: any | null;
}

function mapTypeString(s: string, q: Qualifiers): ParsedType {
  switch (s) {
    case 'xs:string': {
      const t: ParsedType = { kind: 'Строка' };
      if (q.stringQ) {
        t.length = numChild(q.stringQ, 'Length');
        t.allowedLength = strChild(q.stringQ, 'AllowedLength');
      }
      return clean(t);
    }
    case 'xs:decimal': {
      const t: ParsedType = { kind: 'Число' };
      if (q.numberQ) {
        t.digits = numChild(q.numberQ, 'Digits');
        t.fractionDigits = numChild(q.numberQ, 'FractionDigits');
        t.allowedSign = strChild(q.numberQ, 'AllowedSign');
      }
      return clean(t);
    }
    case 'xs:dateTime': {
      const t: ParsedType = { kind: 'Дата' };
      if (q.dateQ) t.dateFractions = strChild(q.dateQ, 'DateFractions');
      return clean(t);
    }
    case 'xs:boolean':
      return { kind: 'Булево' };
  }
  const m = s.match(/^cfg:(CatalogRef|DocumentRef|EnumRef)\.(.+)$/);
  if (m) return { kind: 'ref', ref: `${REF_PREFIX[m[1]]}.${m[2]}` };
  return { kind: 'unknown', raw: s };
}

/** Разбирает контейнер <Type> в список логических типов 1С с квалификаторами. */
export function parseTypeBlock(typeContainer: any | null): ParsedType[] {
  if (!typeContainer) return [];
  const q: Qualifiers = {
    stringQ: childByLocalName(typeContainer, 'StringQualifiers'),
    numberQ: childByLocalName(typeContainer, 'NumberQualifiers'),
    dateQ: childByLocalName(typeContainer, 'DateQualifiers'),
  };
  return childrenByLocalName(typeContainer, 'Type')
    .map(nodeText)
    .filter(Boolean)
    .map((s) => mapTypeString(s, q));
}

/** Разбирает ссылку в формате MDObjectRef (Catalog.X / Document.X / Enum.X). */
export function mapMdObjectRef(s: string): ParsedType {
  const m = s.match(/^(Catalog|Document|Enum)\.(.+)$/);
  if (m) return { kind: 'ref', ref: `${MD_PREFIX[m[1]]}.${m[2]}` };
  return { kind: 'unknown', raw: s };
}
```

- [x] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npx vitest run test/unit/typeParser.test.ts`
Expected: PASS, все 8 тестов зелёные.

- [x] **Step 5: Commit**

```bash
git add src/core/metadata/parser/typeParser.ts test/unit/typeParser.test.ts
git commit -m "feat: парсер типов 1С (квалификаторы, ссылки, составные типы)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Парсер реквизитов и табличных частей `attribute`

**Files:**
- Create: `src/core/metadata/parser/attribute.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/attribute.ts`**

```typescript
import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseTypeBlock } from './typeParser';
import type { ParsedField, ParsedTabularSection } from './model';

/** <Attribute> → реквизит. */
export function parseAttribute(attrEl: any): ParsedField | null {
  const props = childByLocalName(attrEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const types = parseTypeBlock(childByLocalName(props, 'Type'));
  return { name, category: 'attribute', types };
}

/** <TabularSection> → табличная часть (НомерСтроки + реквизиты). */
export function parseTabularSection(tsEl: any): ParsedTabularSection | null {
  const props = childByLocalName(tsEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = tsEl.getAttribute('uuid') || '';
  const lineNumberLength = Number(nodeText(childByLocalName(props, 'LineNumberLength')) || '5');
  const fields: ParsedField[] = [
    {
      name: 'НомерСтроки',
      category: 'standard',
      types: [{ kind: 'Число', digits: lineNumberLength, fractionDigits: 0 }],
    },
  ];
  const child = childByLocalName(tsEl, 'ChildObjects');
  if (child) {
    for (const a of childrenByLocalName(child, 'Attribute')) {
      const f = parseAttribute(a);
      if (f) fields.push(f);
    }
  }
  return { name, uuid, fields };
}

/** Разбирает <ChildObjects> объекта на реквизиты и табличные части. */
export function parseChildObjects(objectEl: any): {
  attributes: ParsedField[];
  tabularSections: ParsedTabularSection[];
} {
  const attributes: ParsedField[] = [];
  const tabularSections: ParsedTabularSection[] = [];
  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const a of childrenByLocalName(child, 'Attribute')) {
      const f = parseAttribute(a);
      if (f) attributes.push(f);
    }
    for (const t of childrenByLocalName(child, 'TabularSection')) {
      const ts = parseTabularSection(t);
      if (ts) tabularSections.push(ts);
    }
  }
  return { attributes, tabularSections };
}
```

- [x] **Step 2: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 3: Commit**

```bash
git add src/core/metadata/parser/attribute.ts
git commit -m "feat: парсер реквизитов и табличных частей

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Парсер Справочника `catalog`

**Files:**
- Create: `src/core/metadata/parser/catalog.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/catalog.ts`**

```typescript
import { childByLocalName, childrenByLocalName, nodeText, clean } from './dom';
import { mapMdObjectRef } from './typeParser';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseCatalog(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Справочник.${name}`;

  const hierarchical = nodeText(childByLocalName(props, 'Hierarchical')) === 'true';
  const hierarchyType = nodeText(childByLocalName(props, 'HierarchyType'));
  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const codeType = nodeText(childByLocalName(props, 'CodeType')) || 'String';
  const codeAllowedLength = nodeText(childByLocalName(props, 'CodeAllowedLength')) || undefined;
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');
  const ownersEl = childByLocalName(props, 'Owners');
  const owners = ownersEl
    ? childrenByLocalName(ownersEl, 'Item').map(nodeText).filter(Boolean)
    : [];

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределённый', [{ kind: 'Булево' }]);
  std('ИмяПредопределённыхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    const codeStr: ParsedType = { kind: 'Строка', length: codeLength, allowedLength: codeAllowedLength };
    const code: ParsedType =
      codeType === 'Number' ? { kind: 'Число', digits: codeLength } : clean(codeStr);
    std('Код', [code]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  if (hierarchical) {
    std('Родитель', [{ kind: 'ref', ref: fullName }]);
    if (hierarchyType === 'HierarchyFoldersAndItems') {
      std('ЭтоГруппа', [{ kind: 'Булево' }]);
    }
  }
  if (owners.length) {
    std('Владелец', owners.map(mapMdObjectRef));
  }

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'Справочник',
    name,
    fullName,
    uuid,
    properties: { hierarchical, codeLength, codeType, descriptionLength },
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [x] **Step 2: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 3: Commit**

```bash
git add src/core/metadata/parser/catalog.ts
git commit -m "feat: парсер Справочника (стандартные поля + реквизиты + ТЧ)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Запись YAML, оркестратор (Справочники), CLI — первый end-to-end прогон

**Files:**
- Create: `src/core/metadata/parser/yamlWriter.ts`
- Create: `src/core/metadata/parser/parseConfiguration.ts`
- Create: `src/cli/parseMetadata.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/yamlWriter.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';

/** Пишет данные в YAML-файл (создаёт каталоги; длинные строки не переносятся). */
export function writeYaml(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringify(data, { lineWidth: 0 }));
}
```

- [x] **Step 2: Создать `src/core/metadata/parser/parseConfiguration.ts` (пока только Справочники)**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { parseXml, firstElementChild, childByLocalName, nodeText, clean } from './dom';
import { writeYaml } from './yamlWriter';
import { parseCatalog } from './catalog';
import type { ParsedObject } from './model';

interface TypeHandler {
  subdir: string;
  parse: (el: any) => ParsedObject | null;
}

const HANDLERS: TypeHandler[] = [
  { subdir: 'Catalogs', parse: parseCatalog },
];

export interface ParseSummary {
  counts: Record<string, number>;
  skipped: number;
  outCfDir: string;
}

interface IndexEntry {
  type: string;
  name: string;
  fullName: string;
  file: string;
}

export function parseConfiguration(cfPath: string, outPath: string): ParseSummary {
  const outCfDir = path.join(outPath, 'cf');
  fs.rmSync(outCfDir, { recursive: true, force: true });
  fs.mkdirSync(outCfDir, { recursive: true });

  const counts: Record<string, number> = {};
  let skipped = 0;
  const objects: IndexEntry[] = [];

  for (const h of HANDLERS) {
    const dir = path.join(cfPath, h.subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.xml')) continue;
      let obj: ParsedObject | null = null;
      try {
        const xml = fs.readFileSync(path.join(dir, file), 'utf8');
        const doc = parseXml(xml);
        const objectEl = doc ? firstElementChild(doc.documentElement) : null;
        obj = objectEl ? h.parse(objectEl) : null;
      } catch {
        obj = null;
      }
      if (!obj) {
        skipped++;
        continue;
      }
      obj.source = `${h.subdir}/${file}`;
      writeYaml(path.join(outCfDir, h.subdir, `${obj.name}.yaml`), obj);
      counts[obj.kind] = (counts[obj.kind] || 0) + 1;
      objects.push({
        type: obj.kind,
        name: obj.name,
        fullName: obj.fullName,
        file: `${h.subdir}/${obj.name}.yaml`,
      });
    }
  }

  writeConfigurationIndex(cfPath, outCfDir, objects);
  return { counts, skipped, outCfDir };
}

function writeConfigurationIndex(cfPath: string, outCfDir: string, objects: IndexEntry[]): void {
  let name = '';
  let synonym: string | undefined;
  const confXml = path.join(cfPath, 'Configuration.xml');
  if (fs.existsSync(confXml)) {
    const doc = parseXml(fs.readFileSync(confXml, 'utf8'));
    const el = doc ? firstElementChild(doc.documentElement) : null;
    const props = el ? childByLocalName(el, 'Properties') : null;
    if (props) {
      name = nodeText(childByLocalName(props, 'Name'));
      const syn = childByLocalName(props, 'Synonym');
      const item = syn ? childByLocalName(syn, 'item') : null;
      synonym = item ? nodeText(childByLocalName(item, 'content')) || undefined : undefined;
    }
  }
  writeYaml(path.join(outCfDir, 'configuration.yaml'), clean({ version: 1, name, synonym, objects }));
}
```

- [x] **Step 3: Создать `src/cli/parseMetadata.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { parseConfiguration } from '../core/metadata/parser/parseConfiguration';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function main(): void {
  const cf = path.resolve(getArg('cf') ?? 'src/cf');
  const out = path.resolve(getArg('out') ?? 'tmp/parser_data');

  if (!fs.existsSync(cf)) {
    console.error(`Каталог cf не найден: ${cf}`);
    process.exit(1);
  }

  const s = parseConfiguration(cf, out);
  const c = s.counts;
  console.log(
    `Справочники: ${c['Справочник'] || 0}  Документы: ${c['Документ'] || 0}  ` +
      `Константы: ${c['Константа'] || 0}  Перечисления: ${c['Перечисление'] || 0}`
  );
  console.log(`Пропущено (ошибки парсинга): ${s.skipped}`);
  console.log(`→ ${s.outCfDir}`);

  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.error('Распарсено 0 объектов');
    process.exit(1);
  }
}

main();
```

- [x] **Step 4: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 5: Прогнать CLI на реальной выгрузке**

Run: `npm run parse`
Expected: сводка вида `Справочники: <N>  Документы: 0  Константы: 0  Перечисления: 0`, `Пропущено ...`, `→ .../tmp/parser_data/cf`. Exit code 0, N > 0.

- [x] **Step 6: Проверить вывод глазами**

Run: `cat tmp/parser_data/cf/Catalogs/Валюты.yaml`
Expected: видно `kind: Справочник`, `fullName: Справочник.Валюты`, `source: Catalogs/Валюты.xml`, блок `properties` (codeLength: 3, codeType: String, descriptionLength: 10, hierarchical: false), стандартные поля (Ссылка, ВерсияДанных, ПометкаУдаления, Предопределённый, ИмяПредопределённыхДанных, Код со `length: 3` и `allowedLength: Variable`, Наименование со `length: 10`), реквизиты (например, Наценка с `digits: 10`, `fractionDigits: 2`; ОсновнаяВалюта с `ref: Справочник.Валюты`; СпособУстановкиКурса с `ref: Перечисление.СпособыУстановкиКурсаВалюты`) и табличная часть `Представления` с полем `НомерСтроки` и реквизитами.

Run: `cat tmp/parser_data/cf/configuration.yaml`
Expected: `name: БиблиотекаСтандартныхПодсистем`, список `objects` со справочниками (поля type/name/fullName/file).

- [x] **Step 7: Commit**

```bash
git add src/core/metadata/parser/yamlWriter.ts src/core/metadata/parser/parseConfiguration.ts src/cli/parseMetadata.ts
git commit -m "feat: оркестратор + CLI, запись YAML (Справочники end-to-end)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Парсер Документа `document`

**Files:**
- Create: `src/core/metadata/parser/document.ts`
- Modify: `src/core/metadata/parser/parseConfiguration.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/document.ts`**

```typescript
import { childByLocalName, nodeText, clean } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseDocument(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Документ.${name}`;

  const numberType = nodeText(childByLocalName(props, 'NumberType')) || 'String';
  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');
  const numberAllowedLength = nodeText(childByLocalName(props, 'NumberAllowedLength')) || undefined;
  const posting = nodeText(childByLocalName(props, 'Posting')) || undefined;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  if (numberLength > 0) {
    const numStr: ParsedType = { kind: 'Строка', length: numberLength, allowedLength: numberAllowedLength };
    const num: ParsedType =
      numberType === 'Number' ? { kind: 'Число', digits: numberLength } : clean(numStr);
    std('Номер', [num]);
  }
  if (posting === 'Allow') {
    std('Проведён', [{ kind: 'Булево' }]);
  }

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'Документ',
    name,
    fullName,
    uuid,
    properties: clean({ numberLength, numberType, posting }),
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [x] **Step 2: Зарегистрировать Документ в оркестраторе**

В `src/core/metadata/parser/parseConfiguration.ts` добавить импорт после строки `import { parseCatalog } from './catalog';`:

```typescript
import { parseDocument } from './document';
```

И добавить строку в массив `HANDLERS`:

```typescript
const HANDLERS: TypeHandler[] = [
  { subdir: 'Catalogs', parse: parseCatalog },
  { subdir: 'Documents', parse: parseDocument },
];
```

- [x] **Step 3: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 4: Прогнать и проверить глазами**

Run: `npm run parse`
Expected: в сводке `Документы` теперь > 0.

Run: `cat tmp/parser_data/cf/Documents/АктОбУничтоженииПерсональныхДанных.yaml`
Expected: `kind: Документ`, стандартные поля (Ссылка, ВерсияДанных, ПометкаУдаления, Дата с `dateFractions: DateTime`, Номер со `length: 11` и `allowedLength: Variable`, Проведён — т.к. `Posting=Allow`), реквизиты и (при наличии) табличные части.

- [x] **Step 5: Commit**

```bash
git add src/core/metadata/parser/document.ts src/core/metadata/parser/parseConfiguration.ts
git commit -m "feat: парсер Документа

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Парсер Константы `constant`

**Files:**
- Create: `src/core/metadata/parser/constant.ts`
- Modify: `src/core/metadata/parser/parseConfiguration.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/constant.ts`**

```typescript
import { childByLocalName, nodeText } from './dom';
import { parseTypeBlock } from './typeParser';
import type { ParsedObject } from './model';

export function parseConstant(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const types = parseTypeBlock(childByLocalName(props, 'Type'));

  return {
    version: 1,
    kind: 'Константа',
    name,
    fullName: `Константа.${name}`,
    uuid,
    types,
  };
}
```

- [x] **Step 2: Зарегистрировать Константу в оркестраторе**

В `src/core/metadata/parser/parseConfiguration.ts` добавить импорт:

```typescript
import { parseConstant } from './constant';
```

И строку в `HANDLERS`:

```typescript
  { subdir: 'Constants', parse: parseConstant },
```

(Массив `HANDLERS` теперь: Catalogs, Documents, Constants.)

- [x] **Step 3: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 4: Прогнать и проверить глазами**

Run: `npm run parse`
Expected: в сводке `Константы` > 0.

Run: `cat tmp/parser_data/cf/Constants/АвтоматическиНастраиватьРазрешенияВПрофиляхБезопасности.yaml`
Expected: `kind: Константа`, `fullName: Константа.АвтоматическиНастраиватьРазрешенияВПрофиляхБезопасности`, `source: Constants/...xml`, `types` с одним элементом `kind: Булево`. Полей и табличных частей нет.

- [x] **Step 5: Commit**

```bash
git add src/core/metadata/parser/constant.ts src/core/metadata/parser/parseConfiguration.ts
git commit -m "feat: парсер Константы

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Парсер Перечисления `enum`

**Files:**
- Create: `src/core/metadata/parser/enum.ts`
- Modify: `src/core/metadata/parser/parseConfiguration.ts`

- [x] **Step 1: Создать `src/core/metadata/parser/enum.ts`**

```typescript
import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import type { ParsedObject, ParsedField } from './model';

export function parseEnum(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Перечисление.${name}`;

  const fields: ParsedField[] = [
    { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: fullName }] },
    { name: 'Порядок', category: 'standard', types: [{ kind: 'Число' }] },
  ];

  const childObjects = childByLocalName(objectEl, 'ChildObjects');
  const values = childObjects
    ? childrenByLocalName(childObjects, 'EnumValue')
        .map((v) => {
          const p = childByLocalName(v, 'Properties');
          return { name: p ? nodeText(childByLocalName(p, 'Name')) : '' };
        })
        .filter((x) => x.name)
    : [];

  return {
    version: 1,
    kind: 'Перечисление',
    name,
    fullName,
    uuid,
    fields,
    values,
  };
}
```

- [x] **Step 2: Зарегистрировать Перечисление в оркестраторе**

В `src/core/metadata/parser/parseConfiguration.ts` добавить импорт:

```typescript
import { parseEnum } from './enum';
```

И строку в `HANDLERS`:

```typescript
  { subdir: 'Enums', parse: parseEnum },
```

(Массив `HANDLERS` теперь: Catalogs, Documents, Constants, Enums.)

- [x] **Step 3: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

- [x] **Step 4: Прогнать и проверить глазами**

Run: `npm run parse`
Expected: в сводке все четыре счётчика > 0.

Run: `cat tmp/parser_data/cf/Enums/ВажностьПроблемыУчета.yaml`
Expected: `kind: Перечисление`, поля Ссылка (`ref: Перечисление.ВажностьПроблемыУчета`) и Порядок (Число), блок `values` с членами (Ошибка, Предупреждение, ВажнаяИнформация, Информация, ПолезныйСовет).

- [x] **Step 5: Commit**

```bash
git add src/core/metadata/parser/enum.ts src/core/metadata/parser/parseConfiguration.ts
git commit -m "feat: парсер Перечисления

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: VS Code команда-обёртка и настройка

**Files:**
- Create: `src/extension/resolveCfPath.ts`
- Create: `src/extension/parseCommand.ts`
- Modify: `src/extension/extension.ts`
- Modify: `package.json`

- [x] **Step 1: Вынести `resolveCfPath` в отдельный модуль**

Создать `src/extension/resolveCfPath.ts`:

```typescript
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
```

- [x] **Step 2: Создать `src/extension/parseCommand.ts`**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { resolveCfPath } from './resolveCfPath';
import { parseConfiguration } from '../core/metadata/parser/parseConfiguration';

export function registerParseCommand(channel: vscode.OutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('1c.parseMetadata', () => {
    const cfPath = resolveCfPath();
    if (!cfPath) {
      vscode.window.showWarningMessage(
        'Не найдена выгрузка конфигурации (cf). Укажите путь в настройке queryConsole.metadataPath'
      );
      return;
    }
    const config = vscode.workspace.getConfiguration('queryConsole');
    const outSetting = config.get<string>('parserOutputPath') || 'tmp/parser_data';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const outPath = path.isAbsolute(outSetting) ? outSetting : path.join(root, outSetting);

    channel.appendLine(`[1C Query] Парсинг метаданных: ${cfPath} → ${outPath}`);
    channel.show(true);
    try {
      const s = parseConfiguration(cfPath, outPath);
      const c = s.counts;
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      channel.appendLine(
        `[1C Query] Справочники: ${c['Справочник'] || 0} Документы: ${c['Документ'] || 0} ` +
          `Константы: ${c['Константа'] || 0} Перечисления: ${c['Перечисление'] || 0}; пропущено: ${s.skipped}`
      );
      vscode.window.showInformationMessage(`Распарсено объектов: ${total}. → ${s.outCfDir}`);
    } catch (e) {
      channel.appendLine(`[1C Query] Ошибка парсинга: ${e}`);
      vscode.window.showErrorMessage(`Ошибка парсинга метаданных: ${e}`);
    }
  });
}
```

- [x] **Step 3: Подключить команду в `extension.ts`**

В `src/extension/extension.ts` заменить локальную `resolveCfPath` на импорт и зарегистрировать команду.

Добавить импорты вверху (после `import { createPanel } from './panel';`):

```typescript
import { resolveCfPath } from './resolveCfPath';
import { registerParseCommand } from './parseCommand';
```

Удалить локальное определение функции (строки с `function resolveCfPath(): string { ... }` целиком).

Заменить строку регистрации подписок:

```typescript
  context.subscriptions.push(cmd, outputChannel);
```

на:

```typescript
  context.subscriptions.push(cmd, registerParseCommand(outputChannel), outputChannel);
```

- [x] **Step 4: Добавить команду и настройку в `package.json`**

В `contributes.commands` добавить второй элемент массива:

```json
      {
        "command": "1c.parseMetadata",
        "title": "1С: Распарсить метаданные в YAML"
      }
```

В `contributes.configuration.properties` добавить настройку рядом с `queryConsole.metadataPath`:

```json
        "queryConsole.parserOutputPath": {
          "type": "string",
          "default": "tmp/parser_data",
          "description": "Каталог для результата парсинга метаданных (YAML). Относительный путь резолвится от корня workspace."
        }
```

- [x] **Step 5: Проверить компиляцию и сборку расширения**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: нет вывода, exit code 0.

Run: `npm run build:extension`
Expected: esbuild собирает `out/extension/extension.js` без ошибок.

- [x] **Step 6: Проверить, что юнит-тесты по-прежнему зелёные**

Run: `npx vitest run`
Expected: все тесты проходят (включая `test/unit/typeParser.test.ts` и существующий `test/unit/cfParser.test.ts`).

- [x] **Step 7: Commit**

```bash
git add src/extension/resolveCfPath.ts src/extension/parseCommand.ts src/extension/extension.ts package.json
git commit -m "feat: VS Code команда 1c.parseMetadata + настройка parserOutputPath

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Финальная проверка

- [x] **Полный прогон CLI**

Run: `npm run parse`
Expected: все четыре счётчика > 0, разумное число пропущенных (0 или небольшое), дерево `tmp/parser_data/cf/` содержит `configuration.yaml` и подкаталоги `Catalogs/`, `Documents/`, `Constants/`, `Enums/` с YAML-файлами.

- [x] **Проверка пропущенных (если skipped > 0)**

Если число пропущенных заметное — открыть несколько `.xml`, на которых парсер вернул null, понять причину (новый вид типа → попадёт в `unknown`, это норма; либо реально иная структура). Зафиксировать наблюдение для следующих задач, код в этом плане не расширять.
