# Phase 4 — Расширение типов метаданных: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить поддержку всех 17 типов метаданных 1С в парсер и загрузчик YAML конструктора запросов.

**Architecture:** Один модуль на тип (`src/core/metadata/parser/<type>.ts`) → строка в `HANDLERS[]` (`parseConfiguration.ts`) → строка в `SUPPORTED_KINDS` (`yamlLoader.ts`). Роль полей регистров хранится в `category: 'dimension' | 'resource'`. Тип данных расширяется в `model.ts` и `types.ts`.

**Tech Stack:** TypeScript, Vitest, YAML (`yaml`), DOM (`@xmldom/xmldom` через `parser/dom.ts`)

**Test command:** `npm test` (запускает `vitest run`). Конкретный файл: `npx vitest run test/unit/newParsers.test.ts`

---

## Структура файлов

**Создать:**
- `src/core/metadata/parser/exchangePlan.ts`
- `src/core/metadata/parser/chartOfCharacteristicTypes.ts`
- `src/core/metadata/parser/chartOfAccounts.ts`
- `src/core/metadata/parser/chartOfCalculationTypes.ts`
- `src/core/metadata/parser/businessProcess.ts`
- `src/core/metadata/parser/task.ts`
- `src/core/metadata/parser/informationRegister.ts`
- `src/core/metadata/parser/accumulationRegister.ts`
- `src/core/metadata/parser/accountingRegister.ts`
- `src/core/metadata/parser/calculationRegister.ts`
- `src/core/metadata/parser/sequence.ts`
- `src/core/metadata/parser/documentJournal.ts`
- `src/core/metadata/parser/filterCriteria.ts`
- `test/unit/newParsers.test.ts`

**Изменить:**
- `src/core/metadata/parser/model.ts` — расширить `kind` + `category`
- `src/core/metadata/types.ts` — расширить `TableKind` + `FieldKind`
- `src/core/metadata/parser/attribute.ts` — добавить Dimension/Resource в `parseChildObjects`
- `src/core/metadata/parser/parseConfiguration.ts` — 13 новых хендлеров
- `src/core/metadata/yamlLoader.ts` — SUPPORTED_KINDS, mapParsedType, parsedObjectToMetaTable
- `test/unit/yamlLoader.test.ts` — новые тесты на новые типы

---

## Task 1: Расширить типы данных (model.ts + types.ts)

**Files:**
- Modify: `src/core/metadata/parser/model.ts`
- Modify: `src/core/metadata/types.ts`

- [ ] **Step 1: Обновить `model.ts`**

Файл: `src/core/metadata/parser/model.ts`

```ts
export type Primitive = 'Строка' | 'Число' | 'Дата' | 'Булево';
export type TypeKind = Primitive | 'timestamp' | 'ref' | 'unknown';

export interface ParsedType {
  kind: TypeKind;
  length?: number;
  allowedLength?: string;
  digits?: number;
  fractionDigits?: number;
  allowedSign?: string;
  dateFractions?: string;
  ref?: string;
  raw?: string;
}

export interface ParsedField {
  name: string;
  category: 'standard' | 'attribute' | 'dimension' | 'resource';
  types: ParsedType[];
}

export interface ParsedTabularSection {
  name: string;
  uuid: string;
  fields: ParsedField[];
}

export interface ParsedObject {
  version: 1;
  kind:
    | 'Справочник' | 'Документ' | 'Константа' | 'Перечисление'
    | 'ПланОбмена' | 'ПланВидовХарактеристик' | 'ПланСчетов' | 'ПланВидовРасчета'
    | 'БизнесПроцесс' | 'Задача'
    | 'РегистрСведений' | 'РегистрНакопления' | 'РегистрБухгалтерии' | 'РегистрРасчета'
    | 'Последовательность' | 'ЖурналДокументов' | 'КритерийОтбора';
  name: string;
  fullName: string;
  uuid: string;
  source?: string;
  properties?: Record<string, unknown>;
  fields?: ParsedField[];
  tabularSections?: ParsedTabularSection[];
  values?: { name: string }[];
  types?: ParsedType[];
}
```

- [ ] **Step 2: Обновить `types.ts`**

Файл: `src/core/metadata/types.ts`

```ts
export type FieldKind = 'standard' | 'attribute' | 'dimension' | 'resource';

export type TableKind =
  | 'Справочник' | 'Документ' | 'ТабличнаяЧасть'
  | 'Константа' | 'Перечисление'
  | 'ПланОбмена' | 'ПланВидовХарактеристик' | 'ПланСчетов' | 'ПланВидовРасчета'
  | 'БизнесПроцесс' | 'Задача'
  | 'РегистрСведений' | 'РегистрНакопления' | 'РегистрБухгалтерии' | 'РегистрРасчета'
  | 'Последовательность' | 'ЖурналДокументов' | 'КритерийОтбора';

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
  tabularSections?: MetaTable[];
}

export interface MetadataModel {
  version: 1;
  tables: MetaTable[];
}
```

- [ ] **Step 3: Проверить, что существующие тесты проходят**

```bash
npm test
```

Ожидается: все тесты проходят без изменений (тип расширен обратно совместимо).

- [ ] **Step 4: Коммит**

```bash
git add src/core/metadata/parser/model.ts src/core/metadata/types.ts
git commit -m "feat: расширить ParsedField.category и TableKind/FieldKind для фазы 4"
```

---

## Task 2: Расширить parseChildObjects (attribute.ts)

**Files:**
- Modify: `src/core/metadata/parser/attribute.ts`
- Create: `test/unit/newParsers.test.ts`

- [ ] **Step 1: Создать тестовый файл с failing-тестом**

Создать `test/unit/newParsers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseChildObjects } from '../../src/core/metadata/parser/attribute';

const CF_DIR = path.join(__dirname, '..', '..', 'src', 'cf');

function readObjectEl(subdir: string, filename: string): any {
  const xml = fs.readFileSync(path.join(CF_DIR, subdir, filename), 'utf8');
  const doc = parseXml(xml)!;
  return firstElementChild(doc.documentElement);
}

describe('parseChildObjects — dimension/resource', () => {
  it('parses Dimension children with category dimension', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const { dimensions } = parseChildObjects(el);
    expect(dimensions.length).toBeGreaterThan(0);
    expect(dimensions.every(d => d.category === 'dimension')).toBe(true);
    expect(dimensions[0].name).toBeTruthy();
  });

  it('parses Resource children with category resource', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const { resources } = parseChildObjects(el);
    expect(resources.length).toBeGreaterThan(0);
    expect(resources[0].category).toBe('resource');
    expect(resources[0].name).toBe('Ресурс1');
  });

  it('returns empty dimensions and resources for objects without those children', () => {
    const el = readObjectEl('Enums', 'ВариантыВажностиВзаимодействия.xml');
    const result = parseChildObjects(el);
    expect(Array.isArray(result.dimensions)).toBe(true);
    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.dimensions).toHaveLength(0);
    expect(result.resources).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

Ожидается: ошибка `Property 'dimensions' does not exist` или `undefined` — потому что `parseChildObjects` ещё не возвращает `dimensions`/`resources`.

- [ ] **Step 3: Обновить `parseChildObjects` в `attribute.ts`**

```ts
import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseTypeBlock } from './typeParser';
import type { ParsedField, ParsedTabularSection } from './model';

export function parseAttribute(attrEl: any): ParsedField | null {
  const props = childByLocalName(attrEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const types = parseTypeBlock(childByLocalName(props, 'Type'));
  return { name, category: 'attribute', types };
}

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

export function parseChildObjects(objectEl: any): {
  attributes: ParsedField[];
  tabularSections: ParsedTabularSection[];
  dimensions: ParsedField[];
  resources: ParsedField[];
} {
  const attributes: ParsedField[] = [];
  const tabularSections: ParsedTabularSection[] = [];
  const dimensions: ParsedField[] = [];
  const resources: ParsedField[] = [];
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
    for (const d of childrenByLocalName(child, 'Dimension')) {
      const f = parseAttribute(d);
      if (f) dimensions.push({ ...f, category: 'dimension' });
    }
    for (const r of childrenByLocalName(child, 'Resource')) {
      const f = parseAttribute(r);
      if (f) resources.push({ ...f, category: 'resource' });
    }
  }
  return { attributes, tabularSections, dimensions, resources };
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

```bash
npx vitest run test/unit/newParsers.test.ts
npm test
```

Ожидается: все тесты (включая существующие) проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/attribute.ts test/unit/newParsers.test.ts
git commit -m "feat: parseChildObjects возвращает dimensions и resources"
```

---

## Task 3: Парсер ПланОбмена

**Files:**
- Create: `src/core/metadata/parser/exchangePlan.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно: `src/cf/ExchangePlans/ОбновлениеИнформационнойБазы.xml` — CodeLength=9, DescriptionLength=25.

- [ ] **Step 1: Добавить тест в `test/unit/newParsers.test.ts`**

```ts
import { parseExchangePlan } from '../../src/core/metadata/parser/exchangePlan';

describe('parseExchangePlan', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el);
    expect(result?.name).toBe('ОбновлениеИнформационнойБазы');
    expect(result?.fullName).toBe('ПланОбмена.ОбновлениеИнформационнойБазы');
    expect(result?.kind).toBe('ПланОбмена');
  });

  it('includes always-present standard fields', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('ЭтотУзел');
    expect(stdNames).toContain('НомерПринятого');
    expect(stdNames).toContain('НомерОтправленного');
  });

  it('includes Код and Наименование when lengths > 0', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).toContain('Код');
    expect(names).toContain('Наименование');
  });

  it('parses attribute fields', () => {
    const el = readObjectEl('ExchangePlans', 'ОбновлениеИнформационнойБазы.xml');
    const result = parseExchangePlan(el)!;
    const attrNames = result.fields.filter(f => f.category === 'attribute').map(f => f.name);
    expect(attrNames).toContain('Очередь');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

Ожидается: `Cannot find module '../../src/core/metadata/parser/exchangePlan'`

- [ ] **Step 3: Создать `src/core/metadata/parser/exchangePlan.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseExchangePlan(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланОбмена.${name}`;

  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  std('ЭтотУзел', [{ kind: 'Булево' }]);
  std('НомерПринятого', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('НомерОтправленного', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'ПланОбмена',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/exchangePlan.ts test/unit/newParsers.test.ts
git commit -m "feat: парсер ПланОбмена"
```

---

## Task 4: Парсеры ПланВидовХарактеристик + ПланСчетов

**Files:**
- Create: `src/core/metadata/parser/chartOfCharacteristicTypes.ts`
- Create: `src/core/metadata/parser/chartOfAccounts.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно:
- `src/cf/ChartsOfCharacteristicTypes/ДополнительныеРеквизитыИСведения.xml` — Hierarchical=false, CodeLength=0, DescriptionLength=150.
- `src/cf/ChartsOfAccounts/ПланСчетов1.xml` — ПланСчетов1.

- [ ] **Step 1: Добавить тесты**

```ts
import { parseChartOfCharacteristicTypes } from '../../src/core/metadata/parser/chartOfCharacteristicTypes';
import { parseChartOfAccounts } from '../../src/core/metadata/parser/chartOfAccounts';

describe('parseChartOfCharacteristicTypes', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el);
    expect(result?.name).toBe('ДополнительныеРеквизитыИСведения');
    expect(result?.fullName).toBe('ПланВидовХарактеристик.ДополнительныеРеквизитыИСведения');
    expect(result?.kind).toBe('ПланВидовХарактеристик');
  });

  it('includes ТипЗначения standard field', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('ТипЗначения');
    expect(stdNames).toContain('Ссылка');
  });

  it('omits Код when CodeLength=0 and includes Наименование when DescriptionLength>0', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).not.toContain('Код');
    expect(names).toContain('Наименование');
  });

  it('omits ЭтоГруппа/Родитель when not hierarchical', () => {
    const el = readObjectEl('ChartsOfCharacteristicTypes', 'ДополнительныеРеквизитыИСведения.xml');
    const result = parseChartOfCharacteristicTypes(el)!;
    const names = result.fields.map(f => f.name);
    expect(names).not.toContain('ЭтоГруппа');
    expect(names).not.toContain('Родитель');
  });
});

describe('parseChartOfAccounts', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el);
    expect(result?.name).toBe('ПланСчетов1');
    expect(result?.fullName).toBe('ПланСчетов.ПланСчетов1');
    expect(result?.kind).toBe('ПланСчетов');
  });

  it('includes ВидСчета and ПризнакАктивности standard fields', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('ВидСчета');
    expect(stdNames).toContain('ПризнакАктивности');
    expect(stdNames).toContain('Ссылка');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/chartOfCharacteristicTypes.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseChartOfCharacteristicTypes(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланВидовХарактеристик.${name}`;

  const hierarchical = nodeText(childByLocalName(props, 'Hierarchical')) === 'true';
  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  if (hierarchical) {
    std('ЭтоГруппа', [{ kind: 'Булево' }]);
    std('Родитель', [{ kind: 'ref', ref: fullName }]);
  }
  std('ТипЗначения', [{ kind: 'unknown' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'ПланВидовХарактеристик',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 4: Создать `src/core/metadata/parser/chartOfAccounts.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseChartOfAccounts(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланСчетов.${name}`;

  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  std('ЭтоГруппа', [{ kind: 'Булево' }]);
  std('Родитель', [{ kind: 'ref', ref: fullName }]);
  std('ВидСчета', [{ kind: 'unknown' }]);
  std('ПризнакАктивности', [{ kind: 'Булево' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'ПланСчетов',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 5: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 6: Коммит**

```bash
git add src/core/metadata/parser/chartOfCharacteristicTypes.ts \
        src/core/metadata/parser/chartOfAccounts.ts \
        test/unit/newParsers.test.ts
git commit -m "feat: парсеры ПланВидовХарактеристик и ПланСчетов"
```

---

## Task 5: Парсеры ПланВидовРасчета + БизнесПроцесс + Задача

**Files:**
- Create: `src/core/metadata/parser/chartOfCalculationTypes.ts`
- Create: `src/core/metadata/parser/businessProcess.ts`
- Create: `src/core/metadata/parser/task.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно:
- `src/cf/ChartsOfCalculationTypes/ПланВидовРасчета1.xml` — ПланВидовРасчета1, есть Реквизит1 и ТабличнаяЧасть1.
- `src/cf/BusinessProcesses/Задание.xml` — Задание, NumberLength=11.
- `src/cf/Tasks/ЗадачаИсполнителя.xml` — ЗадачаИсполнителя, NumberLength=14, DescriptionLength=150.

- [ ] **Step 1: Добавить тесты**

```ts
import { parseChartOfCalculationTypes } from '../../src/core/metadata/parser/chartOfCalculationTypes';
import { parseBusinessProcess } from '../../src/core/metadata/parser/businessProcess';
import { parseTask } from '../../src/core/metadata/parser/task';

describe('parseChartOfCalculationTypes', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el);
    expect(result?.name).toBe('ПланВидовРасчета1');
    expect(result?.fullName).toBe('ПланВидовРасчета.ПланВидовРасчета1');
    expect(result?.kind).toBe('ПланВидовРасчета');
  });

  it('includes Ссылка standard field and attribute fields', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el)!;
    expect(result.fields.map(f => f.name)).toContain('Ссылка');
    expect(result.fields.filter(f => f.category === 'attribute').map(f => f.name)).toContain('Реквизит1');
  });

  it('parses tabular sections', () => {
    const el = readObjectEl('ChartsOfCalculationTypes', 'ПланВидовРасчета1.xml');
    const result = parseChartOfCalculationTypes(el)!;
    expect(result.tabularSections).toBeDefined();
    expect(result.tabularSections!.length).toBeGreaterThan(0);
    expect(result.tabularSections![0].name).toBe('ТабличнаяЧасть1');
  });
});

describe('parseBusinessProcess', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el);
    expect(result?.name).toBe('Задание');
    expect(result?.fullName).toBe('БизнесПроцесс.Задание');
    expect(result?.kind).toBe('БизнесПроцесс');
  });

  it('includes always-present standard fields', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Дата');
    expect(stdNames).toContain('Старт');
    expect(stdNames).toContain('Завершен');
    expect(stdNames).toContain('ГоловнаяЗадача');
  });

  it('includes Номер when NumberLength > 0', () => {
    const el = readObjectEl('BusinessProcesses', 'Задание.xml');
    const result = parseBusinessProcess(el)!;
    expect(result.fields.map(f => f.name)).toContain('Номер');
  });
});

describe('parseTask', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('Tasks', 'ЗадачаИсполнителя.xml');
    const result = parseTask(el);
    expect(result?.name).toBe('ЗадачаИсполнителя');
    expect(result?.fullName).toBe('Задача.ЗадачаИсполнителя');
    expect(result?.kind).toBe('Задача');
  });

  it('includes standard fields including Выполнена, ТочкаМаршрута, БизнесПроцесс', () => {
    const el = readObjectEl('Tasks', 'ЗадачаИсполнителя.xml');
    const result = parseTask(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Выполнена');
    expect(stdNames).toContain('ТочкаМаршрута');
    expect(stdNames).toContain('БизнесПроцесс');
    expect(stdNames).toContain('Номер');
    expect(stdNames).toContain('Наименование');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/chartOfCalculationTypes.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseChartOfCalculationTypes(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланВидовРасчета.${name}`;

  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'ПланВидовРасчета',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 4: Создать `src/core/metadata/parser/businessProcess.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseBusinessProcess(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `БизнесПроцесс.${name}`;

  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  if (numberLength > 0) {
    std('Номер', [{ kind: 'Строка', length: numberLength }]);
  }
  std('Старт', [{ kind: 'Булево' }]);
  std('Завершен', [{ kind: 'Булево' }]);
  std('ГоловнаяЗадача', [{ kind: 'unknown' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'БизнесПроцесс',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 5: Создать `src/core/metadata/parser/task.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseTask(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Задача.${name}`;

  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  if (numberLength > 0) {
    std('Номер', [{ kind: 'Строка', length: numberLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  std('Выполнена', [{ kind: 'Булево' }]);
  std('ТочкаМаршрута', [{ kind: 'unknown' }]);
  std('БизнесПроцесс', [{ kind: 'unknown' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'Задача',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
```

- [ ] **Step 6: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 7: Коммит**

```bash
git add src/core/metadata/parser/chartOfCalculationTypes.ts \
        src/core/metadata/parser/businessProcess.ts \
        src/core/metadata/parser/task.ts \
        test/unit/newParsers.test.ts
git commit -m "feat: парсеры ПланВидовРасчета, БизнесПроцесс, Задача"
```

---

## Task 6: Парсер РегистрСведений (с условными полями)

**Files:**
- Create: `src/core/metadata/parser/informationRegister.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно:
- `АдминистративнаяИерархия.xml` — Nonperiodical + Independent → нет Период, нет Регистратор.
- `АрхивСообщенийОбменов.xml` — Second + Independent → есть Период, нет Регистратор.
- Синтетический XML для WriteMode=RecorderSubordinate → есть Регистратор.

- [ ] **Step 1: Добавить тесты**

```ts
import { parseInformationRegister } from '../../src/core/metadata/parser/informationRegister';

const SYNTHETIC_INFOREG_PERIODICAL_RECORDER = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <InformationRegister uuid="test-ir-1">
    <Properties>
      <Name>ТестРегистр</Name>
      <InformationRegisterPeriodicity>Year</InformationRegisterPeriodicity>
      <WriteMode>RecorderSubordinate</WriteMode>
    </Properties>
    <ChildObjects>
      <Dimension uuid="dim-1">
        <Properties>
          <Name>Измерение1</Name>
          <Type><v8:Type xmlns:v8="http://v8.1c.ru/8.1/data/core">xs:string</v8:Type></Type>
        </Properties>
      </Dimension>
      <Resource uuid="res-1">
        <Properties>
          <Name>Ресурс1</Name>
          <Type><v8:Type xmlns:v8="http://v8.1c.ru/8.1/data/core">xs:decimal</v8:Type></Type>
        </Properties>
      </Resource>
    </ChildObjects>
  </InformationRegister>
</MetaDataObject>`;

describe('parseInformationRegister', () => {
  it('parses name, fullName, kind from real XML', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el);
    expect(result?.name).toBe('АдминистративнаяИерархия');
    expect(result?.fullName).toBe('РегистрСведений.АдминистративнаяИерархия');
    expect(result?.kind).toBe('РегистрСведений');
  });

  it('omits Период when Nonperiodical', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).not.toContain('Период');
  });

  it('omits Регистратор when Independent', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).not.toContain('Регистратор');
  });

  it('includes Период when periodicity is not Nonperiodical', () => {
    const el = readObjectEl('InformationRegisters', 'АрхивСообщенийОбменов.xml');
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).toContain('Период');
  });

  it('includes Регистратор when WriteMode is not Independent', () => {
    const doc = parseXml(SYNTHETIC_INFOREG_PERIODICAL_RECORDER)!;
    const el = firstElementChild(doc.documentElement);
    const result = parseInformationRegister(el)!;
    expect(result.fields.map(f => f.name)).toContain('Регистратор');
  });

  it('includes dimension fields from ChildObjects', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    const dims = result.fields.filter(f => f.category === 'dimension');
    expect(dims.length).toBeGreaterThan(0);
  });

  it('synthetic register has dimension and resource fields', () => {
    const doc = parseXml(SYNTHETIC_INFOREG_PERIODICAL_RECORDER)!;
    const el = firstElementChild(doc.documentElement);
    const result = parseInformationRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    const res = result.fields.find(f => f.name === 'Ресурс1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/informationRegister.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseInformationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрСведений.${name}`;

  const periodicity = nodeText(childByLocalName(props, 'InformationRegisterPeriodicity'));
  const writeMode = nodeText(childByLocalName(props, 'WriteMode'));

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Активность', [{ kind: 'Булево' }]);
  if (periodicity && periodicity !== 'Nonperiodical') {
    std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  }
  if (writeMode && writeMode !== 'Independent') {
    std('Регистратор', [{ kind: 'unknown' }]);
  }

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрСведений',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/informationRegister.ts test/unit/newParsers.test.ts
git commit -m "feat: парсер РегистрСведений"
```

---

## Task 7: Парсер РегистрНакопления

**Files:**
- Create: `src/core/metadata/parser/accumulationRegister.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно: `src/cf/AccumulationRegisters/РегистрНакопленияОбор.xml` — Ресурс1 (resource), Измерение1 (dimension).

- [ ] **Step 1: Добавить тест**

```ts
import { parseAccumulationRegister } from '../../src/core/metadata/parser/accumulationRegister';

describe('parseAccumulationRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el);
    expect(result?.name).toBe('РегистрНакопленияОбор');
    expect(result?.fullName).toBe('РегистрНакопления.РегистрНакопленияОбор');
    expect(result?.kind).toBe('РегистрНакопления');
  });

  it('always includes НомерСтроки, Период, Регистратор, ВидДвижения', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
    expect(stdNames).toContain('ВидДвижения');
  });

  it('includes dimension and resource fields', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    const res = result.fields.find(f => f.name === 'Ресурс1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
  });

  it('has no tabularSections', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.tabularSections).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/accumulationRegister.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseAccumulationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрНакопления.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('ВидДвижения', [{ kind: 'unknown' }]);

  const { dimensions, resources } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);

  return {
    version: 1,
    kind: 'РегистрНакопления',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/accumulationRegister.ts test/unit/newParsers.test.ts
git commit -m "feat: парсер РегистрНакопления"
```

---

## Task 8: Парсеры РегистрБухгалтерии + РегистрРасчета

**Files:**
- Create: `src/core/metadata/parser/accountingRegister.ts`
- Create: `src/core/metadata/parser/calculationRegister.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно:
- `src/cf/AccountingRegisters/РегистрБухгалтерии1.xml` — Организация (dim), Сумма (resource), Реквизит1 (attr).
- `src/cf/CalculationRegisters/РегистрРасчета1.xml` — РегистрРасчета1.

- [ ] **Step 1: Добавить тесты**

```ts
import { parseAccountingRegister } from '../../src/core/metadata/parser/accountingRegister';
import { parseCalculationRegister } from '../../src/core/metadata/parser/calculationRegister';

describe('parseAccountingRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el);
    expect(result?.name).toBe('РегистрБухгалтерии1');
    expect(result?.fullName).toBe('РегистрБухгалтерии.РегистрБухгалтерии1');
    expect(result?.kind).toBe('РегистрБухгалтерии');
  });

  it('includes НомерСтроки, Период, Регистратор, Активность standard fields', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
    expect(stdNames).toContain('Активность');
  });

  it('includes dimension, resource, and attribute fields', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const result = parseAccountingRegister(el)!;
    const dim = result.fields.find(f => f.name === 'Организация');
    const res = result.fields.find(f => f.name === 'Сумма');
    const attr = result.fields.find(f => f.name === 'Реквизит1');
    expect(dim?.category).toBe('dimension');
    expect(res?.category).toBe('resource');
    expect(attr?.category).toBe('attribute');
  });
});

describe('parseCalculationRegister', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('CalculationRegisters', 'РегистрРасчета1.xml');
    const result = parseCalculationRegister(el);
    expect(result?.name).toBe('РегистрРасчета1');
    expect(result?.fullName).toBe('РегистрРасчета.РегистрРасчета1');
    expect(result?.kind).toBe('РегистрРасчета');
  });

  it('includes НомерСтроки, Период, Регистратор, ВидРасчета standard fields', () => {
    const el = readObjectEl('CalculationRegisters', 'РегистрРасчета1.xml');
    const result = parseCalculationRegister(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
    expect(stdNames).toContain('ВидРасчета');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/accountingRegister.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseAccountingRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрБухгалтерии.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('Активность', [{ kind: 'Булево' }]);

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрБухгалтерии',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 4: Создать `src/core/metadata/parser/calculationRegister.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseCalculationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрРасчета.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('ВидРасчета', [{ kind: 'unknown' }]);

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрРасчета',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 5: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 6: Коммит**

```bash
git add src/core/metadata/parser/accountingRegister.ts \
        src/core/metadata/parser/calculationRegister.ts \
        test/unit/newParsers.test.ts
git commit -m "feat: парсеры РегистрБухгалтерии и РегистрРасчета"
```

---

## Task 9: Парсеры Последовательность + ЖурналДокументов + КритерийОтбора

**Files:**
- Create: `src/core/metadata/parser/sequence.ts`
- Create: `src/core/metadata/parser/documentJournal.ts`
- Create: `src/core/metadata/parser/filterCriteria.ts`
- Modify: `test/unit/newParsers.test.ts`

Справочно:
- `src/cf/Sequences/ПоследовательностьТест.xml` — Измерение1.
- `src/cf/DocumentJournals/Взаимодействия.xml` — Columns: Автор, Входящий, Ответственный, Тема, Участники, СтатусИсходящегоПисьма.
- `src/cf/FilterCriteria/СвязанныеДокументы.xml` — СвязанныеДокументы.

- [ ] **Step 1: Добавить тесты**

```ts
import { parseSequence } from '../../src/core/metadata/parser/sequence';
import { parseDocumentJournal } from '../../src/core/metadata/parser/documentJournal';
import { parseFilterCriteria } from '../../src/core/metadata/parser/filterCriteria';

describe('parseSequence', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el);
    expect(result?.name).toBe('ПоследовательностьТест');
    expect(result?.fullName).toBe('Последовательность.ПоследовательностьТест');
    expect(result?.kind).toBe('Последовательность');
  });

  it('includes НомерСтроки, Период, Регистратор standard fields', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('НомерСтроки');
    expect(stdNames).toContain('Период');
    expect(stdNames).toContain('Регистратор');
  });

  it('includes dimension fields from ChildObjects', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    const dim = result.fields.find(f => f.name === 'Измерение1');
    expect(dim?.category).toBe('dimension');
  });

  it('has no tabularSections', () => {
    const el = readObjectEl('Sequences', 'ПоследовательностьТест.xml');
    const result = parseSequence(el)!;
    expect(result.tabularSections).toBeUndefined();
  });
});

describe('parseDocumentJournal', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el);
    expect(result?.name).toBe('Взаимодействия');
    expect(result?.fullName).toBe('ЖурналДокументов.Взаимодействия');
    expect(result?.kind).toBe('ЖурналДокументов');
  });

  it('includes standard fields Ссылка, Дата, Номер, ТипДокумента', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el)!;
    const stdNames = result.fields.filter(f => f.category === 'standard').map(f => f.name);
    expect(stdNames).toContain('Ссылка');
    expect(stdNames).toContain('Дата');
    expect(stdNames).toContain('Номер');
    expect(stdNames).toContain('ТипДокумента');
  });

  it('includes Column fields as attribute', () => {
    const el = readObjectEl('DocumentJournals', 'Взаимодействия.xml');
    const result = parseDocumentJournal(el)!;
    const colNames = result.fields.filter(f => f.category === 'attribute').map(f => f.name);
    expect(colNames).toContain('Автор');
    expect(colNames).toContain('Ответственный');
  });
});

describe('parseFilterCriteria', () => {
  it('parses name, fullName, kind', () => {
    const el = readObjectEl('FilterCriteria', 'СвязанныеДокументы.xml');
    const result = parseFilterCriteria(el);
    expect(result?.name).toBe('СвязанныеДокументы');
    expect(result?.fullName).toBe('КритерийОтбора.СвязанныеДокументы');
    expect(result?.kind).toBe('КритерийОтбора');
  });

  it('includes only Ссылка field', () => {
    const el = readObjectEl('FilterCriteria', 'СвязанныеДокументы.xml');
    const result = parseFilterCriteria(el)!;
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('Ссылка');
    expect(result.fields[0].category).toBe('standard');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что тесты падают**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 3: Создать `src/core/metadata/parser/sequence.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseSequence(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Последовательность.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);

  const { dimensions } = parseChildObjects(objectEl);
  fields.push(...dimensions);

  return {
    version: 1,
    kind: 'Последовательность',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 4: Создать `src/core/metadata/parser/documentJournal.ts`**

```ts
import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseAttribute } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseDocumentJournal(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ЖурналДокументов.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Номер', [{ kind: 'Строка', length: 11 }]);
  std('ТипДокумента', [{ kind: 'unknown' }]);

  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const c of childrenByLocalName(child, 'Column')) {
      const f = parseAttribute(c);
      if (f) fields.push(f);
    }
  }

  return {
    version: 1,
    kind: 'ЖурналДокументов',
    name,
    fullName,
    uuid,
    fields,
  };
}
```

- [ ] **Step 5: Создать `src/core/metadata/parser/filterCriteria.ts`**

```ts
import { childByLocalName, nodeText } from './dom';
import type { ParsedObject } from './model';

export function parseFilterCriteria(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `КритерийОтбора.${name}`;

  return {
    version: 1,
    kind: 'КритерийОтбора',
    name,
    fullName,
    uuid,
    fields: [
      { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: fullName }] },
    ],
  };
}
```

- [ ] **Step 6: Запустить тесты**

```bash
npx vitest run test/unit/newParsers.test.ts
```

- [ ] **Step 7: Коммит**

```bash
git add src/core/metadata/parser/sequence.ts \
        src/core/metadata/parser/documentJournal.ts \
        src/core/metadata/parser/filterCriteria.ts \
        test/unit/newParsers.test.ts
git commit -m "feat: парсеры Последовательность, ЖурналДокументов, КритерийОтбора"
```

---

## Task 10: Подключить все парсеры в parseConfiguration.ts

**Files:**
- Modify: `src/core/metadata/parser/parseConfiguration.ts`

- [ ] **Step 1: Обновить `parseConfiguration.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { parseXml, firstElementChild, childByLocalName, nodeText, clean } from './dom';
import { writeYaml } from './yamlWriter';
import { parseCatalog } from './catalog';
import { parseDocument } from './document';
import { parseConstant } from './constant';
import { parseEnum } from './enum';
import { parseExchangePlan } from './exchangePlan';
import { parseChartOfCharacteristicTypes } from './chartOfCharacteristicTypes';
import { parseChartOfAccounts } from './chartOfAccounts';
import { parseChartOfCalculationTypes } from './chartOfCalculationTypes';
import { parseBusinessProcess } from './businessProcess';
import { parseTask } from './task';
import { parseInformationRegister } from './informationRegister';
import { parseAccumulationRegister } from './accumulationRegister';
import { parseAccountingRegister } from './accountingRegister';
import { parseCalculationRegister } from './calculationRegister';
import { parseSequence } from './sequence';
import { parseDocumentJournal } from './documentJournal';
import { parseFilterCriteria } from './filterCriteria';
import type { ParsedObject } from './model';

interface TypeHandler {
  subdir: string;
  parse: (el: any) => ParsedObject | null;
}

const HANDLERS: TypeHandler[] = [
  { subdir: 'Catalogs',                   parse: parseCatalog },
  { subdir: 'Documents',                  parse: parseDocument },
  { subdir: 'Constants',                  parse: parseConstant },
  { subdir: 'Enums',                      parse: parseEnum },
  { subdir: 'ExchangePlans',              parse: parseExchangePlan },
  { subdir: 'ChartsOfCharacteristicTypes', parse: parseChartOfCharacteristicTypes },
  { subdir: 'ChartsOfAccounts',           parse: parseChartOfAccounts },
  { subdir: 'ChartsOfCalculationTypes',   parse: parseChartOfCalculationTypes },
  { subdir: 'BusinessProcesses',          parse: parseBusinessProcess },
  { subdir: 'Tasks',                      parse: parseTask },
  { subdir: 'InformationRegisters',       parse: parseInformationRegister },
  { subdir: 'AccumulationRegisters',      parse: parseAccumulationRegister },
  { subdir: 'AccountingRegisters',        parse: parseAccountingRegister },
  { subdir: 'CalculationRegisters',       parse: parseCalculationRegister },
  { subdir: 'Sequences',                  parse: parseSequence },
  { subdir: 'DocumentJournals',           parse: parseDocumentJournal },
  { subdir: 'FilterCriteria',             parse: parseFilterCriteria },
];
```

Остальную часть функции `parseConfiguration` не трогать.

- [ ] **Step 2: Запустить все тесты**

```bash
npm test
```

Ожидается: все проходят.

- [ ] **Step 3: Опционально — smoke test парсера на реальных данных**

```bash
npm run parse
```

Ожидается: YAML-файлы для всех 17 типов появляются в `out/cf/`.

- [ ] **Step 4: Коммит**

```bash
git add src/core/metadata/parser/parseConfiguration.ts
git commit -m "feat: регистрация всех 17 хендлеров в parseConfiguration"
```

---

## Task 11: Обновить yamlLoader.ts

**Files:**
- Modify: `src/core/metadata/yamlLoader.ts`
- Modify: `test/unit/yamlLoader.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/yamlLoader.test.ts`**

Добавить в конец файла (после существующих тестов):

```ts
  it('loads a РегистрСведений with dimension fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы', file: 'InformationRegisters/Курсы.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Курсы.yaml', {
      version: 1,
      kind: 'РегистрСведений',
      name: 'Курсы',
      fullName: 'РегистрСведений.Курсы',
      uuid: 'ir-1',
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число', digits: 9, fractionDigits: 0 }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата', dateFractions: 'DateTime' }] },
        { name: 'Валюта', category: 'dimension', types: [{ kind: 'ref', ref: 'Справочник.Валюты' }] },
        { name: 'Курс', category: 'resource', types: [{ kind: 'Число', digits: 15, fractionDigits: 4 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('РегистрСведений');
    expect(table.name).toBe('Курсы');

    const валюта = table.fields.find(f => f.name === 'Валюта')!;
    expect(валюта.kind).toBe('dimension');

    const курс = table.fields.find(f => f.name === 'Курс')!;
    expect(курс.kind).toBe('resource');
    expect(курс.types).toEqual([{ primitive: 'Число' }]);
  });

  it('loads a Константа with Значение field', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Константа', name: 'НомерВерсии', fullName: 'Константа.НомерВерсии', file: 'Constants/НомерВерсии.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Constants/НомерВерсии.yaml', {
      version: 1,
      kind: 'Константа',
      name: 'НомерВерсии',
      fullName: 'Константа.НомерВерсии',
      uuid: 'const-1',
      types: [{ kind: 'Строка', length: 20 }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Константа');
    expect(table.fields).toHaveLength(1);
    expect(table.fields[0].name).toBe('Значение');
    expect(table.fields[0].kind).toBe('standard');
    expect(table.fields[0].types).toEqual([{ primitive: 'Строка' }]);
  });

  it('loads a Перечисление with Ссылка and Порядок fields', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'Перечисление', name: 'Статусы', fullName: 'Перечисление.Статусы', file: 'Enums/Статусы.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'Enums/Статусы.yaml', {
      version: 1,
      kind: 'Перечисление',
      name: 'Статусы',
      fullName: 'Перечисление.Статусы',
      uuid: 'enum-1',
      fields: [
        { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'Перечисление.Статусы' }] },
        { name: 'Порядок', category: 'standard', types: [{ kind: 'Число' }] },
      ],
      values: [{ name: 'Новый' }, { name: 'ВРаботе' }],
    });

    const result = loadMetadataFromYaml(tmpDir);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0];
    expect(table.kind).toBe('Перечисление');
    expect(table.fields.map(f => f.name)).toContain('Ссылка');
    expect(table.fields.map(f => f.name)).toContain('Порядок');
  });

  it('maps dimension/resource category to MetaField.kind correctly', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1,
      objects: [
        { type: 'РегистрНакопления', name: 'Продажи', fullName: 'РегистрНакопления.Продажи', file: 'AccumulationRegisters/Продажи.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Продажи.yaml', {
      version: 1,
      kind: 'РегистрНакопления',
      name: 'Продажи',
      fullName: 'РегистрНакопления.Продажи',
      uuid: 'ar-1',
      fields: [
        { name: 'Номенклатура', category: 'dimension', types: [{ kind: 'ref', ref: 'Справочник.Номенклатура' }] },
        { name: 'Количество', category: 'resource', types: [{ kind: 'Число', digits: 15, fractionDigits: 3 }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const table = result.tables[0];
    expect(table.fields.find(f => f.name === 'Номенклатура')?.kind).toBe('dimension');
    expect(table.fields.find(f => f.name === 'Количество')?.kind).toBe('resource');
  });
```

Закрыть блок `describe('loadMetadataFromYaml', ...)` после последнего нового теста.

- [ ] **Step 2: Запустить, убедиться что новые тесты падают**

```bash
npx vitest run test/unit/yamlLoader.test.ts
```

Ожидается: тесты на Константу, Перечисление, РегистрСведений и РегистрНакопления падают (SUPPORTED_KINDS их не включает).

- [ ] **Step 3: Обновить `yamlLoader.ts`**

Заменить файл полностью:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind } from './types';
import type { ParsedObject, ParsedField, ParsedType } from './parser/model';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  'Справочник', 'Документ', 'Константа', 'Перечисление',
  'ПланОбмена', 'ПланВидовХарактеристик', 'ПланСчетов', 'ПланВидовРасчета',
  'БизнесПроцесс', 'Задача',
  'РегистрСведений', 'РегистрНакопления', 'РегистрБухгалтерии', 'РегистрРасчета',
  'Последовательность', 'ЖурналДокументов', 'КритерийОтбора',
]);

function mapParsedType(pt: ParsedType): MetaType {
  const k = pt.kind;
  if (k === 'Строка' || k === 'Число' || k === 'Булево' || k === 'Дата') {
    return { primitive: k };
  }
  if (k === 'ref' && pt.ref) {
    const match = pt.ref.match(
      /^(Справочник|Документ|Константа|Перечисление|ПланОбмена|ПланВидовХарактеристик|ПланСчетов|ПланВидовРасчета|БизнесПроцесс|Задача|РегистрСведений|РегистрНакопления|РегистрБухгалтерии|РегистрРасчета|Последовательность|ЖурналДокументов|КритерийОтбора)\.(.+)$/
    );
    if (match) {
      return { ref: { kind: match[1] as TableKind, name: match[2] } };
    }
  }
  return {};
}

function mapParsedField(pf: ParsedField): MetaField {
  return {
    name: pf.name,
    kind: pf.category,
    types: (pf.types ?? []).map(mapParsedType),
  };
}

function parsedObjectToMetaTable(obj: ParsedObject): MetaTable {
  if (obj.kind === 'Константа') {
    return {
      kind: 'Константа',
      name: obj.name,
      fullName: obj.fullName,
      fields: [{
        name: 'Значение',
        kind: 'standard',
        types: (obj.types ?? []).map(mapParsedType),
      }],
    };
  }

  const tabularSections: MetaTable[] = (obj.tabularSections ?? []).map(ts => ({
    kind: 'ТабличнаяЧасть' as TableKind,
    name: ts.name,
    fullName: `${obj.fullName}.${ts.name}`,
    fields: [
      { name: 'Ссылка', kind: 'standard' as const, types: [{ ref: { kind: obj.kind as TableKind, name: obj.name } }] },
      ...(ts.fields ?? []).map(mapParsedField),
    ],
  }));

  return {
    kind: obj.kind as TableKind,
    name: obj.name,
    fullName: obj.fullName,
    fields: (obj.fields ?? []).map(mapParsedField),
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}

interface IndexEntry {
  type: string;
  name: string;
  fullName: string;
  file: string;
}

interface ConfigurationIndex {
  version: number;
  name?: string;
  objects?: IndexEntry[];
}

export function loadMetadataFromYaml(cfYamlDir: string): MetadataModel {
  const empty: MetadataModel = { version: 1, tables: [] };

  const configPath = path.join(cfYamlDir, 'configuration.yaml');
  if (!fs.existsSync(configPath)) {
    return empty;
  }

  let index: ConfigurationIndex;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    index = parse(raw) as ConfigurationIndex;
  } catch {
    return empty;
  }

  if (!index?.objects?.length) {
    return empty;
  }

  const tables: MetaTable[] = [];

  for (const entry of index.objects) {
    if (!SUPPORTED_KINDS.has(entry.type)) {
      continue;
    }

    const filePath = path.join(cfYamlDir, entry.file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    let obj: ParsedObject;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      obj = parse(raw) as ParsedObject;
      if (!obj || !obj.name || !obj.kind) continue;
    } catch {
      continue;
    }

    const metaTable = parsedObjectToMetaTable(obj);
    tables.push(metaTable);

    for (const ts of metaTable.tabularSections ?? []) {
      tables.push(ts);
    }
  }

  return { version: 1, tables };
}
```

- [ ] **Step 4: Запустить все тесты**

```bash
npm test
```

Ожидается: все тесты проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/yamlLoader.ts test/unit/yamlLoader.test.ts
git commit -m "feat: yamlLoader поддерживает все 17 типов метаданных"
```

---

## Финальная проверка

- [ ] **Запустить весь тест-сьют**

```bash
npm test
```

Ожидается: все тесты проходят, нет регрессий.

- [ ] **Smoke-test парсера**

```bash
npm run parse
```

Ожидается: в `out/cf/` появляются папки для всех 17 типов с YAML-файлами.
