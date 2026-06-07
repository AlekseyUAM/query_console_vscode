# Виртуальные таблицы регистров бухгалтерии — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать конструктору виртуальные таблицы регистров бухгалтерии (`Остатки`, `Обороты`, `ОборотыДтКт`, `ОстаткиИОбороты`, `ДвиженияССубконто`) с развёрткой счетов/субконто/ресурсов, генерацией текста запроса и окном параметров.

**Architecture:** Логика — в core (pure-TS, TDD через vitest), webview — тонкий. Парсер пишет признак корреспонденции и план счетов в `properties`; `yamlLoader` резолвит число субконто и эмитит ВТ; генератор рендерит источник с фиксированной арностью; диалог рендерит параметры из core-дескриптора. Псевдоним ВТ приводится к 1С-точному (имя объекта).

**Tech Stack:** TypeScript, vitest, React (webview). Эталоны — `tmp/meta1c/РегистрБухгалтерии*.txt`; фикстуры — `src/cf/AccountingRegisters/`, `src/cf/ChartsOfAccounts/ПланСчетов1.xml`.

**Спек:** `docs/superpowers/specs/2026-06-07-phase4-accounting-virtual-tables-design.md`

**Команды:** тест одного файла — `npx vitest run test/unit/<file>`; все юнит-тесты — `npm run test:unit`.

---

## Карта файлов

- `src/core/metadata/parser/chartOfAccounts.ts` — **изм.**: читать `MaxExtDimensionCount`/`ExtDimensionTypes`.
- `src/core/metadata/parser/accountingRegister.ts` — **изм.**: `Correspondence`/`ChartOfAccounts`, поля базовой таблицы.
- `src/core/metadata/types.ts` — **изм.**: `VirtualTableInfo.slice` + `correspondence`.
- `src/core/metadata/accountingVirtualTables.ts` — **нов.**: `buildAccountingRegSlices` + хелперы развёртки.
- `src/core/metadata/yamlLoader.ts` — **изм.**: пред-скан планов счетов + вызов `buildAccountingRegSlices`.
- `src/core/query/queryModel.ts` — **изм.**: `VirtualParams` + `defaultTableAlias` (имя объекта).
- `src/core/query/sdblGenerator.ts` — **изм.**: рендер источника РБ (фикс. арность).
- `src/core/query/accountingVirtualParams.ts` — **нов.**: дескриптор полей окна параметров.
- `src/webview/state/queryStore.ts` — **изм.**: проброс `correspondence`.
- `src/webview/App.tsx`, `src/webview/components/TablesPanel.tsx` — **изм.**: период-поля для `ОборотыДтКт`; передача `kind`/`correspondence` в диалог.
- `src/webview/components/VirtualTableParamsDialog.tsx` — **изм.**: параметры РБ из дескриптора.
- Тесты: `test/unit/newParsers.test.ts`, `test/unit/yamlLoader.test.ts`, `test/unit/sdblGenerator.test.ts`, `test/unit/accountingVirtualTables.test.ts` (нов.), `test/unit/accountingVirtualParams.test.ts` (нов.).

---

## Task 1: Парсер плана счетов — субконто

**Files:**
- Modify: `src/core/metadata/parser/chartOfAccounts.ts`
- Test: `test/unit/newParsers.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/unit/newParsers.test.ts` в блок `describe('parseChartOfAccounts'` (если блока нет — создать рядом с импортом `parseChartOfAccounts`; импорт добавить вверху файла):

```ts
import { parseChartOfAccounts } from '../../src/core/metadata/parser/chartOfAccounts';

describe('parseChartOfAccounts subconto', () => {
  it('reads MaxExtDimensionCount and ExtDimensionTypes name into properties', () => {
    const el = readObjectEl('ChartsOfAccounts', 'ПланСчетов1.xml');
    const result = parseChartOfAccounts(el)!;
    expect((result.properties as any).maxExtDimensionCount).toBe(3);
    expect((result.properties as any).extDimensionTypes).toBe('ВидыСубконто');
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/newParsers.test.ts -t "subconto"`
Expected: FAIL (`properties` undefined / значения не совпадают).

- [ ] **Step 3: Реализовать**

В `src/core/metadata/parser/chartOfAccounts.ts` после чтения `descriptionLength` добавить:

```ts
  const maxExtDimensionCount = Number(nodeText(childByLocalName(props, 'MaxExtDimensionCount')) || '0');
  const extRaw = nodeText(childByLocalName(props, 'ExtDimensionTypes')); // 'ChartOfCharacteristicTypes.ВидыСубконто'
  const extDimensionTypes = extRaw.includes('.') ? extRaw.split('.').slice(1).join('.') : extRaw;
```

И в возвращаемом объекте добавить поле `properties`:

```ts
  return {
    version: 1,
    kind: 'ПланСчетов',
    name,
    fullName,
    uuid,
    properties: { maxExtDimensionCount, extDimensionTypes },
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
```

- [ ] **Step 4: Запустить — убедиться, что прошёл**

Run: `npx vitest run test/unit/newParsers.test.ts -t "subconto"`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/chartOfAccounts.ts test/unit/newParsers.test.ts
git commit -m "feat(parser): план счетов читает MaxExtDimensionCount/ExtDimensionTypes"
```

---

## Task 2: Парсер регистра бухгалтерии — корреспонденция и поля базовой таблицы

**Files:**
- Modify: `src/core/metadata/parser/accountingRegister.ts`
- Test: `test/unit/newParsers.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавить в `describe('parseAccountingRegister'`:

```ts
  it('reads Correspondence and ChartOfAccounts name into properties', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const r = parseAccountingRegister(el)!;
    expect((r.properties as any).correspondence).toBe(true);
    expect((r.properties as any).chartOfAccounts).toBe('ПланСчетов1');
  });

  it('base table of a correspondence register has СчетДт/СчетКт, no ВидДвижения', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии1.xml');
    const names = parseAccountingRegister(el)!.fields.map(f => f.name);
    expect(names.slice(0, 6)).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'СчетДт', 'СчетКт']);
    expect(names).not.toContain('ВидДвижения');
    expect(names).not.toContain('Счет');
  });

  it('base table of a non-correspondence register has ВидДвижения + Счет', () => {
    const el = readObjectEl('AccountingRegisters', 'РегистрБухгалтерии2.xml');
    const r = parseAccountingRegister(el)!;
    expect((r.properties as any).correspondence).toBe(false);
    const names = r.fields.map(f => f.name);
    expect(names.slice(0, 6)).toEqual(['Период', 'Регистратор', 'НомерСтроки', 'Активность', 'ВидДвижения', 'Счет']);
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/newParsers.test.ts -t "parseAccountingRegister"`
Expected: FAIL (нет `properties`, поля счёта отсутствуют, порядок иной).

- [ ] **Step 3: Реализовать**

Заменить тело `src/core/metadata/parser/accountingRegister.ts`:

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
  const correspondence = nodeText(childByLocalName(props, 'Correspondence')) === 'true';
  const chartRaw = nodeText(childByLocalName(props, 'ChartOfAccounts')); // 'ChartOfAccounts.ПланСчетов1'
  const chartOfAccounts = chartRaw.includes('.') ? chartRaw.split('.').slice(1).join('.') : chartRaw;
  const accountRef = `ПланСчетов.${chartOfAccounts}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Активность', [{ kind: 'Булево' }]);
  if (correspondence) {
    std('СчетДт', [{ kind: 'ref', ref: accountRef }]);
    std('СчетКт', [{ kind: 'ref', ref: accountRef }]);
  } else {
    std('ВидДвижения', [{ kind: 'unknown' }]);
    std('Счет', [{ kind: 'ref', ref: accountRef }]);
  }

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
    properties: { correspondence, chartOfAccounts },
    fields,
  };
}
```

- [ ] **Step 4: Запустить — убедиться, что прошёл**

Run: `npx vitest run test/unit/newParsers.test.ts -t "parseAccountingRegister"`
Expected: PASS (включая существующие тесты `toContain` на стандартные поля).

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/parser/accountingRegister.ts test/unit/newParsers.test.ts
git commit -m "feat(parser): регистр бухгалтерии читает Correspondence/ChartOfAccounts и поля счёта"
```

---

## Task 3: Тип `VirtualTableInfo` — новые виды ВТ + корреспонденция

**Files:**
- Modify: `src/core/metadata/types.ts`

- [ ] **Step 1: Реализовать (расширение типа, без отдельного теста — проверяется компиляцией Task 4)**

В `src/core/metadata/types.ts` заменить интерфейс `VirtualTableInfo`:

```ts
export interface VirtualTableInfo {
  slice: 'СрезПервых' | 'СрезПоследних' | 'Обороты' | 'Остатки' | 'ОстаткиИОбороты'
       | 'ОборотыДтКт' | 'ДвиженияССубконто';
  baseFullName: string;
  correspondence?: boolean; // регистр бухгалтерии: состав/арность Обороты, наличие ОборотыДтКт
}
```

- [ ] **Step 2: Проверить компиляцию**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: без новых ошибок типов.

- [ ] **Step 3: Коммит**

```bash
git add src/core/metadata/types.ts
git commit -m "feat(types): VirtualTableInfo поддерживает ОборотыДтКт/ДвиженияССубконто и correspondence"
```

---

## Task 4: Построение виртуальных таблиц РБ — `accountingVirtualTables.ts`

**Files:**
- Create: `src/core/metadata/accountingVirtualTables.ts`
- Test: `test/unit/accountingVirtualTables.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `test/unit/accountingVirtualTables.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAccountingRegSlices } from '../../src/core/metadata/accountingVirtualTables';
import type { MetaTable } from '../../src/core/metadata/types';
import type { ParsedObject } from '../../src/core/metadata/parser/model';

const charts = new Map([['ПланСчетов1', { maxExtDimensionCount: 3, extDimensionTypes: 'ВидыСубконто' }]]);

// corr-регистр: база как у РБ1
const corrObj = {
  version: 1, kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии1',
  fullName: 'РегистрБухгалтерии.РегистрБухгалтерии1', uuid: 'r1',
  properties: { correspondence: true, chartOfAccounts: 'ПланСчетов1' },
} as unknown as ParsedObject;
const corrBase: MetaTable = {
  kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии1', fullName: 'РегистрБухгалтерии.РегистрБухгалтерии1',
  fields: [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'Организация', kind: 'dimension', types: [{ primitive: 'Строка' }] },
    { name: 'Сумма', kind: 'resource', types: [{ primitive: 'Число' }] },
    { name: 'Реквизит1', kind: 'attribute', types: [{ primitive: 'Строка' }] },
  ],
};

// non-corr регистр: база как у РБ2
const nonObj = {
  version: 1, kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии2',
  fullName: 'РегистрБухгалтерии.РегистрБухгалтерии2', uuid: 'r2',
  properties: { correspondence: false, chartOfAccounts: 'ПланСчетов1' },
} as unknown as ParsedObject;
const nonBase: MetaTable = {
  kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии2', fullName: 'РегистрБухгалтерии.РегистрБухгалтерии2',
  fields: [
    { name: 'Измерение1', kind: 'dimension', types: [{ primitive: 'Строка' }] },
    { name: 'Ресурс1', kind: 'resource', types: [{ primitive: 'Число' }] },
  ],
};

const byName = (ts: MetaTable[], suffix: string) => ts.find(t => t.fullName.endsWith(suffix))!;
const names = (t: MetaTable) => t.fields.map(f => f.name);

describe('buildAccountingRegSlices (correspondence)', () => {
  const vts = buildAccountingRegSlices(corrObj, corrBase, charts);

  it('emits 5 VTs incl. ОборотыДтКт', () => {
    expect(vts.map(t => t.fullName.split('.')[2])).toEqual(
      ['Остатки', 'Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
    expect(vts[0].virtual).toEqual({ slice: 'Остатки', baseFullName: 'РегистрБухгалтерии.РегистрБухгалтерии1', correspondence: true });
  });

  it('Остатки: Счет, Субконто1..3, dims, развёрнутый ресурс', () => {
    expect(names(byName(vts, '.Остатки'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаОстаток', 'СуммаОстатокДт', 'СуммаОстатокКт', 'СуммаРазвернутыйОстатокДт', 'СуммаРазвернутыйОстатокКт',
    ]);
  });

  it('Обороты corr: dims между Субконто и КорСчет', () => {
    expect(names(byName(vts, '.Обороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'КорСчет', 'КорСубконто1', 'КорСубконто2', 'КорСубконто3',
      'СуммаОборот', 'СуммаОборотДт', 'СуммаОборотКт',
    ]);
  });

  it('ОборотыДтКт: Дт-блок, Кт-блок, dims, RОборот', () => {
    expect(names(byName(vts, '.ОборотыДтКт'))).toEqual([
      'СчетДт', 'СубконтоДт1', 'СубконтоДт2', 'СубконтоДт3',
      'СчетКт', 'СубконтоКт1', 'СубконтоКт2', 'СубконтоКт3',
      'Организация', 'СуммаОборот',
    ]);
  });

  it('ОстаткиИОбороты: Счет, Субконто, dims, развёртка Начальный/Оборот/Конечный', () => {
    expect(names(byName(vts, '.ОстаткиИОбороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаНачальныйОстаток', 'СуммаНачальныйОстатокДт', 'СуммаНачальныйОстатокКт',
      'СуммаНачальныйРазвернутыйОстатокДт', 'СуммаНачальныйРазвернутыйОстатокКт',
      'СуммаОборот', 'СуммаОборотДт', 'СуммаОборотКт',
      'СуммаКонечныйОстаток', 'СуммаКонечныйОстатокДт', 'СуммаКонечныйОстатокКт',
      'СуммаКонечныйРазвернутыйОстатокДт', 'СуммаКонечныйРазвернутыйОстатокКт',
    ]);
  });

  it('ДвиженияССубконто corr: Дт/Кт + ВидСубконто, dims, ресурс, реквизиты, без ВидДвижения', () => {
    expect(names(byName(vts, '.ДвиженияССубконто'))).toEqual([
      'Период', 'Регистратор', 'НомерСтроки', 'Активность',
      'СчетДт', 'СубконтоДт1', 'ВидСубконтоДт1', 'СубконтоДт2', 'ВидСубконтоДт2', 'СубконтоДт3', 'ВидСубконтоДт3',
      'СчетКт', 'СубконтоКт1', 'ВидСубконтоКт1', 'СубконтоКт2', 'ВидСубконтоКт2', 'СубконтоКт3', 'ВидСубконтоКт3',
      'Организация', 'Сумма', 'Реквизит1',
    ]);
  });
});

describe('buildAccountingRegSlices (non-correspondence)', () => {
  const vts = buildAccountingRegSlices(nonObj, nonBase, charts);

  it('emits 4 VTs without ОборотыДтКт', () => {
    expect(vts.map(t => t.fullName.split('.')[2])).toEqual(
      ['Остатки', 'Обороты', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
  });

  it('Обороты non-corr: Счет, Субконто, dims, RОборот/Дт/Кт (без КорСчет)', () => {
    expect(names(byName(vts, '.Обороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Измерение1',
      'Ресурс1Оборот', 'Ресурс1ОборотДт', 'Ресурс1ОборотКт',
    ]);
  });

  it('ДвиженияССубконто non-corr: Счет + ВидСубконто, dims, ресурс, ВидДвижения в конце', () => {
    expect(names(byName(vts, '.ДвиженияССубконто'))).toEqual([
      'Период', 'Регистратор', 'НомерСтроки', 'Активность',
      'Счет', 'Субконто1', 'ВидСубконто1', 'Субконто2', 'ВидСубконто2', 'Субконто3', 'ВидСубконто3',
      'Измерение1', 'Ресурс1', 'ВидДвижения',
    ]);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/accountingVirtualTables.test.ts`
Expected: FAIL (модуль не существует).

- [ ] **Step 3: Реализовать**

Создать `src/core/metadata/accountingVirtualTables.ts`:

```ts
import type { MetaField, MetaTable, VirtualTableInfo } from './types';
import type { ParsedObject } from './parser/model';

export interface AccChartInfo {
  maxExtDimensionCount: number;
  extDimensionTypes: string; // имя ПВХ, напр. 'ВидыСубконто'
}

const RESOURCE_SUFFIXES: Record<string, string[]> = {
  Остатки: ['Остаток', 'ОстатокДт', 'ОстатокКт', 'РазвернутыйОстатокДт', 'РазвернутыйОстатокКт'],
  Обороты: ['Оборот', 'ОборотДт', 'ОборотКт'],
  ОборотыДтКт: ['Оборот'],
  ОстаткиИОбороты: [
    'НачальныйОстаток', 'НачальныйОстатокДт', 'НачальныйОстатокКт',
    'НачальныйРазвернутыйОстатокДт', 'НачальныйРазвернутыйОстатокКт',
    'Оборот', 'ОборотДт', 'ОборотКт',
    'КонечныйОстаток', 'КонечныйОстатокДт', 'КонечныйОстатокКт',
    'КонечныйРазвернутыйОстатокДт', 'КонечныйРазвернутыйОстатокКт',
  ],
};

export function buildAccountingRegSlices(
  obj: ParsedObject,
  base: MetaTable,
  charts: Map<string, AccChartInfo>,
): MetaTable[] {
  if (obj.kind !== 'РегистрБухгалтерии') return [];
  const props = obj.properties as { correspondence?: boolean; chartOfAccounts?: string } | undefined;
  const corr = props?.correspondence === true;
  const chartName = props?.chartOfAccounts ?? '';
  const chart = charts.get(chartName);
  const n = chart?.maxExtDimensionCount ?? 0;
  const vidName = chart?.extDimensionTypes ?? '';

  const dims = base.fields.filter(f => f.kind === 'dimension').map(d => ({ ...d }));
  const resources = base.fields.filter(f => f.kind === 'resource');
  const attrs = base.fields.filter(f => f.kind === 'attribute').map(a => ({ ...a }));

  const acct = (name: string): MetaField =>
    ({ name, kind: 'standard', types: [{ ref: { kind: 'ПланСчетов', name: chartName } }] });
  const sub = (prefix: string, i: number): MetaField =>
    ({ name: `${prefix}${i}`, kind: 'standard', types: [{}] });
  const vidSub = (prefix: string, i: number): MetaField =>
    ({ name: `Вид${prefix}${i}`, kind: 'standard', types: [{ ref: { kind: 'ПланВидовХарактеристик', name: vidName } }] });
  const subs = (prefix: string): MetaField[] =>
    Array.from({ length: n }, (_, k) => sub(prefix, k + 1));
  const subsWithVid = (prefix: string): MetaField[] =>
    Array.from({ length: n }, (_, k) => [sub(prefix, k + 1), vidSub(prefix, k + 1)]).flat();
  const expand = (slice: string): MetaField[] =>
    resources.flatMap(r => RESOURCE_SUFFIXES[slice].map((s): MetaField =>
      ({ name: `${r.name}${s}`, kind: 'resource', types: r.types })));

  const makeVT = (slice: VirtualTableInfo['slice'], fields: MetaField[]): MetaTable => ({
    kind: 'РегистрБухгалтерии',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    fields,
    virtual: { slice, baseFullName: obj.fullName, correspondence: corr },
  });

  const dvStd: MetaField[] = [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'Регистратор', kind: 'standard', types: [{}] },
    { name: 'НомерСтроки', kind: 'standard', types: [{ primitive: 'Число' }] },
    { name: 'Активность', kind: 'standard', types: [{ primitive: 'Булево' }] },
  ];
  const vidDvizh: MetaField = { name: 'ВидДвижения', kind: 'standard', types: [{}] };

  const result: MetaTable[] = [];

  result.push(makeVT('Остатки', [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('Остатки')]));

  result.push(makeVT('Обороты', corr
    ? [acct('Счет'), ...subs('Субконто'), ...dims, acct('КорСчет'), ...subs('КорСубконто'), ...expand('Обороты')]
    : [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('Обороты')]));

  if (corr) {
    result.push(makeVT('ОборотыДтКт',
      [acct('СчетДт'), ...subs('СубконтоДт'), acct('СчетКт'), ...subs('СубконтоКт'), ...dims, ...expand('ОборотыДтКт')]));
  }

  result.push(makeVT('ОстаткиИОбороты', [acct('Счет'), ...subs('Субконто'), ...dims, ...expand('ОстаткиИОбороты')]));

  const dvAccount = corr
    ? [acct('СчетДт'), ...subsWithVid('СубконтоДт'), acct('СчетКт'), ...subsWithVid('СубконтоКт')]
    : [acct('Счет'), ...subsWithVid('Субконто')];
  const dvFields = [...dvStd, ...dvAccount, ...dims, ...resources.map(r => ({ ...r })), ...attrs];
  if (!corr) dvFields.push(vidDvizh);
  result.push(makeVT('ДвиженияССубконто', dvFields));

  return result;
}
```

- [ ] **Step 4: Запустить — убедиться, что прошёл**

Run: `npx vitest run test/unit/accountingVirtualTables.test.ts`
Expected: PASS (все 8 кейсов).

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/accountingVirtualTables.ts test/unit/accountingVirtualTables.test.ts
git commit -m "feat(metadata): buildAccountingRegSlices — состав ВТ регистра бухгалтерии"
```

---

## Task 5: `yamlLoader` — пред-скан планов счетов и эмиссия ВТ

**Files:**
- Modify: `src/core/metadata/yamlLoader.ts`
- Test: `test/unit/yamlLoader.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/unit/yamlLoader.test.ts` (внутри основного `describe`, рядом с тестами регистров накопления):

```ts
  it('emits 5 accounting VTs (corr) resolving subconto count from chart of accounts', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'ПланСчетов', name: 'ПланСчетов1', fullName: 'ПланСчетов.ПланСчетов1', file: 'ChartsOfAccounts/ПланСчетов1.yaml' },
        { type: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1', file: 'AccountingRegisters/РБ1.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'ChartsOfAccounts/ПланСчетов1.yaml', {
      version: 1, kind: 'ПланСчетов', name: 'ПланСчетов1', fullName: 'ПланСчетов.ПланСчетов1',
      properties: { maxExtDimensionCount: 3, extDimensionTypes: 'ВидыСубконто' },
      fields: [{ name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] }],
    });
    writeCfYaml(tmpDir, 'AccountingRegisters/РБ1.yaml', {
      version: 1, kind: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1',
      properties: { correspondence: true, chartOfAccounts: 'ПланСчетов1' },
      fields: [
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'СчетДт', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] },
        { name: 'СчетКт', category: 'standard', types: [{ kind: 'ref', ref: 'ПланСчетов.ПланСчетов1' }] },
        { name: 'Организация', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Сумма', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const vtNames = result.tables.filter(t => t.virtual).map(t => t.fullName.split('.')[2]);
    expect(vtNames).toEqual(['Остатки', 'Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
    const ostatki = result.tables.find(t => t.fullName === 'РегистрБухгалтерии.РБ1.Остатки')!;
    expect(ostatki.fields.map(f => f.name)).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаОстаток', 'СуммаОстатокДт', 'СуммаОстатокКт', 'СуммаРазвернутыйОстатокДт', 'СуммаРазвернутыйОстатокКт',
    ]);
    expect(ostatki.virtual?.correspondence).toBe(true);
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/yamlLoader.test.ts -t "accounting VTs"`
Expected: FAIL (ВТ РБ не эмитятся).

- [ ] **Step 3: Реализовать**

В `src/core/metadata/yamlLoader.ts` добавить импорт вверху:

```ts
import { buildAccountingRegSlices, type AccChartInfo } from './accountingVirtualTables';
```

В функции `loadMetadataFromYaml`, после проверки `if (!index?.objects?.length) return empty;` и перед `const tables: MetaTable[] = [];`, добавить пред-скан планов счетов:

```ts
  const charts = new Map<string, AccChartInfo>();
  for (const entry of index.objects) {
    if (entry.type !== 'ПланСчетов') continue;
    const fp = path.join(cfYamlDir, entry.file);
    if (!fs.existsSync(fp)) continue;
    try {
      const o = parse(fs.readFileSync(fp, 'utf8')) as ParsedObject;
      const p = o?.properties as { maxExtDimensionCount?: number; extDimensionTypes?: string } | undefined;
      charts.set(o.name, {
        maxExtDimensionCount: p?.maxExtDimensionCount ?? 0,
        extDimensionTypes: p?.extDimensionTypes ?? '',
      });
    } catch { /* пропустить нечитаемый план счетов */ }
  }
```

В основном цикле, после блока `for (const slice of buildAccumRegSlices(obj, metaTable)) { tables.push(slice); }`, добавить:

```ts
    for (const slice of buildAccountingRegSlices(obj, metaTable, charts)) {
      tables.push(slice);
    }
```

- [ ] **Step 4: Запустить — убедиться, что прошёл (и регрессий нет)**

Run: `npx vitest run test/unit/yamlLoader.test.ts`
Expected: PASS (новый тест + все прежние).

- [ ] **Step 5: Коммит**

```bash
git add src/core/metadata/yamlLoader.ts test/unit/yamlLoader.test.ts
git commit -m "feat(metadata): yamlLoader эмитит ВТ регистров бухгалтерии (пред-скан планов счетов)"
```

---

## Task 6: `queryModel` — `VirtualParams` и псевдоним = имя объекта

**Files:**
- Modify: `src/core/query/queryModel.ts`
- Test: `test/unit/sdblGenerator.test.ts` (новый кейс на псевдоним)

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/unit/sdblGenerator.test.ts` (в основной `describe`):

```ts
  it('uses object name (not concat) as virtual table alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Остатки', virtual: { period: '&П' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Остаток' }],
    };
    expect(generate(model)).toContain('КАК РегистрНакопленияОст');
    expect(generate(model)).not.toContain('РегистрНакопленияОстОстатки КАК');
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/sdblGenerator.test.ts -t "object name"`
Expected: FAIL (текущий псевдоним — склейка).

- [ ] **Step 3: Реализовать**

В `src/core/query/queryModel.ts` расширить `VirtualParams`:

```ts
export interface VirtualParams {
  period?: string;
  startPeriod?: string;
  endPeriod?: string;
  periodicity?: string;
  fillMethod?: string;
  condition?: string;
  // регистр бухгалтерии:
  accountCondition?: string;     // УсловиеСчета
  corrAccountCondition?: string; // УсловиеКорСчета (Обороты corr)
  accountDtCondition?: string;   // УсловиеСчетаДт (ОборотыДтКт)
  accountKtCondition?: string;   // УсловиеСчетаКт (ОборотыДтКт)
  order?: string;                // Порядок (ДвиженияССубконто)
  top?: string;                  // Первые (ДвиженияССубконто)
  correspondence?: boolean;      // проброшен из метаданных при добавлении ВТ
}
```

Заменить `defaultTableAlias` (убрать склейку для ВТ):

```ts
export function defaultTableAlias(t: SelectedTable): string {
  if (t.alias) return t.alias;
  const parts = t.fullName.split('.');
  return parts[1] ?? t.fullName;
}
```

Обновить JSDoc-комментарий над функцией: псевдоним по умолчанию — имя объекта (2-й сегмент), и для обычных, и для виртуальных таблиц; склейка с видом ВТ убрана (1С использует имя объекта).

- [ ] **Step 4: Запустить — убедиться, что новый тест прошёл**

Run: `npx vitest run test/unit/sdblGenerator.test.ts -t "object name"`
Expected: PASS. (Старые accum/срез-тесты теперь падают — чинятся в Task 7.)

- [ ] **Step 5: Коммит**

```bash
git add src/core/query/queryModel.ts test/unit/sdblGenerator.test.ts
git commit -m "feat(query): VirtualParams для РБ; псевдоним ВТ = имя объекта (1С)"
```

---

## Task 7: Обновить эталоны псевдонима в существующих тестах генератора

**Files:**
- Modify: `test/unit/sdblGenerator.test.ts`

- [ ] **Step 1: Обновить ожидаемые строки (псевдоним = имя объекта)**

В `test/unit/sdblGenerator.test.ts` заменить во всех затронутых кейсах (это эталоны 4.2/4.3, ранее проверявшие склейку):

- `КурсыСрезПоследних` → `Курсы` (replace_all: затрагивает префиксы полей и `КАК`-псевдоним в 4 кейсах срезов РС).
- `РегистрНакопленияОстОбороты` → `РегистрНакопленияОст` (replace_all).
- `РегистрНакопленияОстОстаткиИОбороты` → `РегистрНакопленияОст` (выполнить ДО предыдущей замены либо строкой целиком, чтобы не получить двойную замену; проще — заменить три точных эталонных строки целиком, см. ниже).

Конкретно заменить строковые литералы:

```
'ВЫБРАТЬ\n\tКурсыСрезПоследних.Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК КурсыСрезПоследних'
→ 'ВЫБРАТЬ\n\tКурсы.Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК Курсы'

'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК КурсыСрезПоследних'
→ 'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК Курсы'

'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период) КАК КурсыСрезПоследних'
→ 'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период) КАК Курсы'

'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК КурсыСрезПоследних'
→ 'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК Курсы'

'РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон, Авто, Измерение1 = &Пар) КАК РегистрНакопленияОстОбороты'
→ '...Обороты(&Нач, &Кон, Авто, Измерение1 = &Пар) КАК РегистрНакопленияОст'

'РегистрНакопления.РегистрНакопленияОст.Остатки(&Период, Измерение1 = &Пар) КАК РегистрНакопленияОстОстатки'
→ '...Остатки(&Период, Измерение1 = &Пар) КАК РегистрНакопленияОст'

'РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты(&НачалоПериода, &КонецП, Авто, ДвиженияИГраницыПериода, Измерение1 = &Пар) КАК РегистрНакопленияОстОстаткиИОбороты'
→ '...ОстаткиИОбороты(...) КАК РегистрНакопленияОст'

'РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон) КАК РегистрНакопленияОстОбороты'
→ '...Обороты(&Нач, &Кон) КАК РегистрНакопленияОст'

'РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, , Месяц) КАК РегистрНакопленияОстОбороты'
→ '...Обороты(&Нач, , Месяц) КАК РегистрНакопленияОст'
```

(Применить как точные строковые замены; полный SQL-текст последних — без сокращений `...`, оставить позиционные параметры как были, поменять только хвостовой псевдоним.)

- [ ] **Step 2: Запустить — весь файл зелёный**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: PASS (все кейсы, кроме новых РБ — они в Task 8).

- [ ] **Step 3: Коммит**

```bash
git add test/unit/sdblGenerator.test.ts
git commit -m "test(query): эталоны псевдонима ВТ 4.2/4.3 → имя объекта (1С)"
```

---

## Task 8: Генератор — источник РБ с фиксированной арностью

**Files:**
- Modify: `src/core/query/sdblGenerator.ts`
- Test: `test/unit/sdblGenerator.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Добавить в `test/unit/sdblGenerator.test.ts` блок:

```ts
  describe('accounting register virtual table source', () => {
    const mk = (slice: string, virtual: any) => ({
      tables: [{ id: 't1', fullName: `РегистрБухгалтерии.РБ1.${slice}`, virtual }],
      fields: [{ tableId: 't1', path: 'Счет' }],
    } as QueryModel);

    it('Остатки без параметров — без скобок', () => {
      expect(generate(mk('Остатки', {}))).toContain('РегистрБухгалтерии.РБ1.Остатки КАК РБ1');
    });

    it('Остатки с периодом и условием счёта (арность 4)', () => {
      const text = generate(mk('Остатки', { period: '&П', accountCondition: 'Счет = &С' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Остатки(&П, Счет = &С, , ) КАК РБ1');
    });

    it('Обороты corr: периодичность в поз.3, фикс. арность 8, хвост сохранён', () => {
      const text = generate(mk('Обороты', { periodicity: 'Период', correspondence: true }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Обороты(, , Период, , , , , ) КАК РБ1');
    });

    it('Обороты non-corr: арность 6', () => {
      const text = generate(mk('Обороты', { periodicity: 'Авто', correspondence: false }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Обороты(, , Авто, , , ) КАК РБ1');
    });

    it('ОборотыДтКт: арность 8', () => {
      const text = generate(mk('ОборотыДтКт', { periodicity: 'Период' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ОборотыДтКт(, , Период, , , , , ) КАК РБ1');
    });

    it('ОстаткиИОбороты: арность 7, метод дополнения в поз.4', () => {
      const text = generate(mk('ОстаткиИОбороты', { periodicity: 'Период', fillMethod: 'ДвиженияИГраницыПериода' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ОстаткиИОбороты(, , Период, ДвиженияИГраницыПериода, , , ) КАК РБ1');
    });

    it('ДвиженияССубконто без параметров — без скобок', () => {
      expect(generate(mk('ДвиженияССубконто', {}))).toContain('РегистрБухгалтерии.РБ1.ДвиженияССубконто КАК РБ1');
    });

    it('ДвиженияССубконто с параметром Первые (арность 5)', () => {
      const text = generate(mk('ДвиженияССубконто', { top: '3' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ДвиженияССубконто(, , , , 3) КАК РБ1');
    });
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/sdblGenerator.test.ts -t "accounting register"`
Expected: FAIL (РБ-источник пока через общую ветку с отбрасыванием хвоста).

- [ ] **Step 3: Реализовать**

В `src/core/query/sdblGenerator.ts` заменить функцию `renderSource`:

```ts
function accountingPositions(slice: string, v: SelectedTable['virtual'] & {}): string[] {
  const s = (x?: string) => x ?? '';
  switch (slice) {
    case 'Остатки':
      return [s(v.period), s(v.accountCondition), '', s(v.condition)];
    case 'Обороты':
      return v.correspondence
        ? [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountCondition), '', s(v.condition), s(v.corrAccountCondition), '']
        : [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountCondition), '', s(v.condition)];
    case 'ОборотыДтКт':
      return [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountDtCondition), '', s(v.accountKtCondition), '', s(v.condition)];
    case 'ОстаткиИОбороты':
      return [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.fillMethod), s(v.accountCondition), '', s(v.condition)];
    case 'ДвиженияССубконто':
      return [s(v.startPeriod), s(v.endPeriod), s(v.condition), s(v.order), s(v.top)];
    default:
      return [];
  }
}

function renderSource(t: SelectedTable): string {
  if (!t.virtual) return t.fullName;
  const v = t.virtual;
  const parts = t.fullName.split('.');
  const kind = parts[0];
  const slice = parts[2];

  // Регистр бухгалтерии: фиксированная арность, хвостовые пустые позиции сохраняются,
  // скобки — только если задан хоть один параметр.
  if (kind === 'РегистрБухгалтерии') {
    const positions = accountingPositions(slice, v);
    if (!positions.some(p => p !== '')) return t.fullName;
    return `${t.fullName}(${positions.join(', ')})`;
  }

  // Регистры сведений/накопления: хвостовые пустые позиции отбрасываются.
  let positions: string[];
  if (slice === 'Обороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.condition ?? ''];
  } else if (slice === 'ОстаткиИОбороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.fillMethod ?? '', v.condition ?? ''];
  } else {
    positions = [v.period ?? '', v.condition ?? ''];
  }
  let last = positions.length - 1;
  while (last >= 0 && positions[last] === '') last--;
  if (last < 0) return t.fullName;
  return `${t.fullName}(${positions.slice(0, last + 1).join(', ')})`;
}
```

- [ ] **Step 4: Запустить — весь файл зелёный**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: PASS (новые РБ-кейсы + прежние РС/РН).

- [ ] **Step 5: Коммит**

```bash
git add src/core/query/sdblGenerator.ts test/unit/sdblGenerator.test.ts
git commit -m "feat(query): рендер источника ВТ регистра бухгалтерии (фикс. арность)"
```

---

## Task 9: Дескриптор параметров окна — `accountingVirtualParams.ts`

**Files:**
- Create: `src/core/query/accountingVirtualParams.ts`
- Test: `test/unit/accountingVirtualParams.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `test/unit/accountingVirtualParams.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { accountingParamFields } from '../../src/core/query/accountingVirtualParams';

const keys = (slice: string, corr: boolean) => accountingParamFields(slice, corr).map(f => f.key);

describe('accountingParamFields', () => {
  it('Остатки', () => {
    expect(keys('Остатки', true)).toEqual(['period', 'accountCondition', 'condition']);
  });
  it('Обороты corr includes corrAccountCondition', () => {
    expect(keys('Обороты', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountCondition', 'condition', 'corrAccountCondition']);
  });
  it('Обороты non-corr omits corrAccountCondition', () => {
    expect(keys('Обороты', false)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountCondition', 'condition']);
  });
  it('ОборотыДтКт', () => {
    expect(keys('ОборотыДтКт', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountDtCondition', 'accountKtCondition', 'condition']);
  });
  it('ОстаткиИОбороты has fillMethod', () => {
    expect(keys('ОстаткиИОбороты', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'fillMethod', 'accountCondition', 'condition']);
    expect(accountingParamFields('ОстаткиИОбороты', true).find(f => f.key === 'fillMethod')!.control).toBe('fillMethod');
  });
  it('ДвиженияССубконто', () => {
    expect(keys('ДвиженияССубконто', false)).toEqual(['startPeriod', 'endPeriod', 'condition', 'order', 'top']);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/accountingVirtualParams.test.ts`
Expected: FAIL (модуль не существует).

- [ ] **Step 3: Реализовать**

Создать `src/core/query/accountingVirtualParams.ts`:

```ts
export type VtParamKey =
  | 'period' | 'startPeriod' | 'endPeriod' | 'periodicity' | 'fillMethod'
  | 'accountCondition' | 'corrAccountCondition' | 'accountDtCondition' | 'accountKtCondition'
  | 'condition' | 'order' | 'top';

export interface VtParamField {
  key: VtParamKey;
  label: string;
  control: 'text' | 'periodicity' | 'fillMethod';
}

const t = (key: VtParamKey, label: string): VtParamField => ({ key, label, control: 'text' });
const periodicity: VtParamField = { key: 'periodicity', label: 'Периодичность', control: 'periodicity' };
const fillMethod: VtParamField = { key: 'fillMethod', label: 'Метод дополнения', control: 'fillMethod' };

export function accountingParamFields(slice: string, correspondence: boolean): VtParamField[] {
  switch (slice) {
    case 'Остатки':
      return [t('period', 'Период'), t('accountCondition', 'Условие счёта'), t('condition', 'Условие')];
    case 'Обороты':
      return [
        t('startPeriod', 'Начало периода'), t('endPeriod', 'Конец периода'), periodicity,
        t('accountCondition', 'Условие счёта'), t('condition', 'Условие'),
        ...(correspondence ? [t('corrAccountCondition', 'Условие кор. счёта')] : []),
      ];
    case 'ОборотыДтКт':
      return [
        t('startPeriod', 'Начало периода'), t('endPeriod', 'Конец периода'), periodicity,
        t('accountDtCondition', 'Условие счёта Дт'), t('accountKtCondition', 'Условие счёта Кт'),
        t('condition', 'Условие'),
      ];
    case 'ОстаткиИОбороты':
      return [
        t('startPeriod', 'Начало периода'), t('endPeriod', 'Конец периода'), periodicity, fillMethod,
        t('accountCondition', 'Условие счёта'), t('condition', 'Условие'),
      ];
    case 'ДвиженияССубконто':
      return [
        t('startPeriod', 'Начало периода'), t('endPeriod', 'Конец периода'),
        t('condition', 'Условие'), t('order', 'Порядок'), t('top', 'Первые'),
      ];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Запустить — убедиться, что прошёл**

Run: `npx vitest run test/unit/accountingVirtualParams.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/query/accountingVirtualParams.ts test/unit/accountingVirtualParams.test.ts
git commit -m "feat(query): дескриптор параметров окна ВТ регистра бухгалтерии"
```

---

## Task 10: `queryStore` — проброс `correspondence`

**Files:**
- Modify: `src/webview/state/queryStore.ts`
- Test: `test/unit/queryStore.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавить в `test/unit/queryStore.test.ts` (использовать существующий хелпер/паттерн файла; если редьюсер импортируется как `reducer`/`queryReducer` — взять имя из файла):

```ts
  it('ADD_TABLE copies correspondence into selected virtual; SET_VIRTUAL_PARAMS preserves it', () => {
    const meta: any = { kind: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1.Обороты',
      fields: [], virtual: { slice: 'Обороты', baseFullName: 'РегистрБухгалтерии.РБ1', correspondence: true } };
    let st = reducer(initialState, { type: 'ADD_TABLE', table: meta });
    const id = st.selectedTables[0].id;
    expect(st.selectedTables[0].virtual).toEqual({ correspondence: true });
    st = reducer(st, { type: 'SET_VIRTUAL_PARAMS', tableId: id, params: { periodicity: 'Авто' } });
    expect(st.selectedTables[0].virtual).toEqual({ periodicity: 'Авто', correspondence: true });
  });
```

(Имена `reducer`/`initialState` — привести к фактическим экспортам `queryStore.ts`.)

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run test/unit/queryStore.test.ts -t "correspondence"`
Expected: FAIL (`virtual` пустой; SET перетирает).

- [ ] **Step 3: Реализовать**

В `src/webview/state/queryStore.ts`, в кейсе `ADD_TABLE`, заменить строку установки `virtual`:

```ts
      if (action.table.virtual) {
        newTable.virtual = action.table.virtual.correspondence !== undefined
          ? { correspondence: action.table.virtual.correspondence }
          : {};
      }
```

В кейсе `SET_VIRTUAL_PARAMS` сохранить `correspondence` из текущего состояния:

```ts
    case 'SET_VIRTUAL_PARAMS': {
      return {
        ...state,
        selectedTables: state.selectedTables.map(t =>
          t.id === action.tableId
            ? { ...t, virtual: { ...action.params, ...(t.virtual?.correspondence !== undefined ? { correspondence: t.virtual.correspondence } : {}) } }
            : t
        ),
      };
    }
```

- [ ] **Step 4: Запустить — убедиться, что прошёл**

Run: `npx vitest run test/unit/queryStore.test.ts`
Expected: PASS (новый кейс + прежние).

- [ ] **Step 5: Коммит**

```bash
git add src/webview/state/queryStore.ts test/unit/queryStore.test.ts
git commit -m "feat(webview): проброс correspondence в выбранную ВТ регистра бухгалтерии"
```

---

## Task 11: Webview — период-поля для `ОборотыДтКт` и передача `kind`/`correspondence` в диалог

**Files:**
- Modify: `src/webview/App.tsx`
- Modify: `src/webview/components/TablesPanel.tsx`

- [ ] **Step 1: Период-поля для трёх видов ВТ**

В `src/webview/App.tsx`, в `fieldsForTable`, заменить условие `periodFields`:

```ts
    const periodFields: MetaField[] =
      meta.virtual && ['Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты'].includes(meta.virtual.slice)
        ? accumPeriodFields(sel.virtual?.periodicity)
        : [];
```

В `src/webview/components/TablesPanel.tsx` (около строки 207) — аналогично:

```ts
                    meta.virtual && ['Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты'].includes(meta.virtual.slice)
                      ? [...accumPeriodFields(t.virtual?.periodicity), ...meta.fields]
```

- [ ] **Step 2: Передать `kind` и `correspondence` в диалог**

В `src/webview/App.tsx`, где определяется `vtSlice`, добавить рядом:

```ts
  const vtKind = vtMeta?.kind ?? 'РегистрСведений';
  const vtCorr = vtMeta?.virtual?.correspondence ?? false;
```

В JSX-рендере `<VirtualTableParamsDialog ... />` добавить пропсы:

```tsx
          slice={vtSlice}
          kind={vtKind}
          correspondence={vtCorr}
```

- [ ] **Step 3: Проверить компиляцию TS (пропсы появятся в Task 12; временно допускается ошибка типов до Task 12 — поэтому объединить проверку)**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: ошибка «лишние пропсы `kind`/`correspondence`» — устранится в Task 12. Это ожидаемо; не коммитить отдельно — см. Step 4.

- [ ] **Step 4: Зафиксировать вместе с Task 12**

Коммит этой задачи выполняется после Task 12 (диалог принимает новые пропсы), чтобы дерево компилировалось. Перейти к Task 12.

---

## Task 12: `VirtualTableParamsDialog` — параметры регистра бухгалтерии

**Files:**
- Modify: `src/webview/components/VirtualTableParamsDialog.tsx`

- [ ] **Step 1: Реализовать ветку для регистра бухгалтерии**

Заменить содержимое `src/webview/components/VirtualTableParamsDialog.tsx`:

```tsx
import * as React from 'react';
import type { VirtualParams } from '../../core/query/queryModel';
import type { VirtualTableInfo, TableKind } from '../../core/metadata/types';
import { PERIODICITY_VALUES, FILL_METHOD_VALUES } from '../../core/query/accumVirtualFields';
import { accountingParamFields, type VtParamKey } from '../../core/query/accountingVirtualParams';

interface Props {
  slice: VirtualTableInfo['slice'];
  kind?: TableKind;
  correspondence?: boolean;
  initial: VirtualParams;
  onOpenConditionBuilder: (current: string, apply: (text: string) => void) => void;
  onOk: (params: VirtualParams) => void;
  onCancel: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 150,
};
const PANEL: React.CSSProperties = {
  background: 'var(--vscode-editor-background, #1e1e1e)',
  border: '1px solid var(--vscode-panel-border, #555)',
  borderRadius: 4, padding: 16, minWidth: 460,
  display: 'flex', flexDirection: 'column', gap: 10,
};
const BTN: React.CSSProperties = {
  padding: '4px 12px', cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none', borderRadius: 2, fontSize: 12,
};
const INPUT: React.CSSProperties = {
  flex: 1, fontSize: 12, padding: '2px 4px',
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
};

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ width: 140, fontSize: 12 }}>{label}</label>
      {children}
    </div>
  );
}

// Виды ВТ регистра бухгалтерии — рендер из core-дескриптора.
const ACC_SLICES = new Set(['Остатки', 'Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты', 'ДвиженияССубконто']);

function AccountingForm({ slice, correspondence, initial, onOpenConditionBuilder, onOk, onCancel }: Props): React.ReactElement {
  const fieldsDesc = accountingParamFields(slice, correspondence === true);
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of fieldsDesc) v[f.key] = (initial as any)[f.key] ?? '';
    return v;
  });
  const set = (k: VtParamKey, val: string) => setValues(prev => ({ ...prev, [k]: val }));

  function handleOk() {
    const params: VirtualParams = {};
    for (const f of fieldsDesc) {
      const val = values[f.key];
      if (val) (params as any)[f.key] = val;
    }
    onOk(params);
  }

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Параметры виртуальной таблицы</div>
        {fieldsDesc.map(f => (
          <Row key={f.key} label={f.label}>
            {f.control === 'periodicity' ? (
              <select data-testid={`vt-${f.key}`} style={INPUT} value={values[f.key]} onChange={e => set(f.key, e.target.value)}>
                <option value="">(не выбрано)</option>
                {PERIODICITY_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : f.control === 'fillMethod' ? (
              <select data-testid={`vt-${f.key}`} style={INPUT} value={values[f.key]} onChange={e => set(f.key, e.target.value)}>
                <option value="">(не выбрано)</option>
                {FILL_METHOD_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : f.key === 'condition' ? (
              <>
                <input data-testid={`vt-${f.key}`} style={INPUT} value={values[f.key]} onChange={e => set(f.key, e.target.value)} />
                <button style={{ ...BTN, padding: '2px 8px' }} title="Произвольное выражение"
                  onClick={() => onOpenConditionBuilder(values[f.key], text => set('condition', text))}>…</button>
              </>
            ) : (
              <input data-testid={`vt-${f.key}`} style={INPUT} value={values[f.key]} onChange={e => set(f.key, e.target.value)} />
            )}
          </Row>
        ))}
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button data-testid="vt-ok" style={BTN} onClick={handleOk}>ОК</button>
          <button data-testid="vt-cancel" style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }} onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

export function VirtualTableParamsDialog(props: Props): React.ReactElement {
  if (props.kind === 'РегистрБухгалтерии' && ACC_SLICES.has(props.slice)) {
    return <AccountingForm {...props} />;
  }
  return <LegacyForm {...props} />;
}

function LegacyForm({ slice, initial, onOpenConditionBuilder, onOk, onCancel }: Props): React.ReactElement {
  const [period, setPeriod] = React.useState(initial.period ?? '');
  const [startPeriod, setStartPeriod] = React.useState(initial.startPeriod ?? '');
  const [endPeriod, setEndPeriod] = React.useState(initial.endPeriod ?? '');
  const [periodicity, setPeriodicity] = React.useState(initial.periodicity ?? '');
  const [fillMethod, setFillMethod] = React.useState(initial.fillMethod ?? '');
  const [condition, setCondition] = React.useState(initial.condition ?? '');

  const isOIO = slice === 'ОстаткиИОбороты';
  const isRange = slice === 'Обороты' || isOIO;

  function handleOk() {
    const params: VirtualParams = {};
    if (!isRange && period) params.period = period;
    if (isRange) {
      if (startPeriod) params.startPeriod = startPeriod;
      if (endPeriod) params.endPeriod = endPeriod;
      if (periodicity) params.periodicity = periodicity;
    }
    if (isOIO && fillMethod) params.fillMethod = fillMethod;
    if (condition) params.condition = condition;
    onOk(params);
  }

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Параметры виртуальной таблицы</div>
        {!isRange && (
          <Row label="Период">
            <input data-testid="vt-period" style={INPUT} value={period} onChange={e => setPeriod(e.target.value)} />
          </Row>
        )}
        {isRange && (
          <>
            <Row label="Начало периода">
              <input data-testid="vt-start" style={INPUT} value={startPeriod} onChange={e => setStartPeriod(e.target.value)} />
            </Row>
            <Row label="Конец периода">
              <input data-testid="vt-end" style={INPUT} value={endPeriod} onChange={e => setEndPeriod(e.target.value)} />
            </Row>
            <Row label="Периодичность">
              <select data-testid="vt-periodicity" style={INPUT} value={periodicity} onChange={e => setPeriodicity(e.target.value)}>
                <option value="">(не выбрано)</option>
                {PERIODICITY_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </Row>
          </>
        )}
        {isOIO && (
          <Row label="Метод дополнения">
            <select data-testid="vt-fillmethod" style={INPUT} value={fillMethod} onChange={e => setFillMethod(e.target.value)}>
              <option value="">(не выбрано)</option>
              {FILL_METHOD_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
        )}
        <Row label="Условие">
          <input data-testid="vt-condition" style={INPUT} value={condition} onChange={e => setCondition(e.target.value)} />
          <button style={{ ...BTN, padding: '2px 8px' }} title="Произвольное выражение"
            onClick={() => onOpenConditionBuilder(condition, setCondition)}>…</button>
        </Row>
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button data-testid="vt-ok" style={BTN} onClick={handleOk}>ОК</button>
          <button data-testid="vt-cancel" style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }} onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить сборку webview**

Run: `npx tsc -p tsconfig.webview.json --noEmit && npm run build:webview`
Expected: без ошибок типов; сборка успешна.

- [ ] **Step 3: Проверить весь юнит-набор**

Run: `npm run test:unit`
Expected: все тесты зелёные.

- [ ] **Step 4: Ручная проверка (webview-тестов в проекте нет)**

Запустить расширение (F5 / `npm run build`), открыть конструктор на конфигурации `src/cf`:
- В дереве у `РегистрБухгалтерии.РегистрБухгалтерии1` есть строки `Остатки`, `Обороты`, `ОборотыДтКт`, `ОстаткиИОбороты`, `ДвиженияССубконто`; у `РегистрБухгалтерии2` — те же без `ОборотыДтКт`.
- Перетащить `Остатки` в Таблицы, добавить поля — генерируется
  `РегистрБухгалтерии.РегистрБухгалтерии1.Остатки КАК РегистрБухгалтерии1` с полями `Счет`, `Субконто1..3`, …
- Окно «Параметры виртуальной таблицы» для `Обороты` показывает `Начало/Конец периода`,
  `Периодичность`, `Условие счёта`, `Условие`, `Условие кор. счёта`; выбор `Периодичность=Период`
  даёт источник `Обороты(, , Период, , , , , )`.
- Сверить итоговые тексты с `tmp/meta1c/РегистрБухгалтерии*.txt` (отличие допускается только
  по составу выбранных полей, не по структуре источника).

- [ ] **Step 5: Коммит (Task 11 + Task 12 вместе)**

```bash
git add src/webview/App.tsx src/webview/components/TablesPanel.tsx src/webview/components/VirtualTableParamsDialog.tsx
git commit -m "feat(webview): окно параметров и период-поля для ВТ регистра бухгалтерии"
```

---

## Task 13: ROADMAP — отметить фазу 4.4

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Добавить подраздел 4.4**

В `docs/ROADMAP.md`, после блока «#### 4.3. Виртуальные таблицы регистров накопления», добавить:

```markdown
#### 4.4. Виртуальные таблицы регистров бухгалтерии

Продолжение 4.3 на регистры бухгалтерии: `Остатки`, `Обороты`, `ОстаткиИОбороты`,
`ДвиженияССубконто` + `ОборотыДтКт` для корреспондентских регистров. Развёртка
счетов/субконто/ресурсов по виду ВТ, фиксированная арность источника, псевдоним ВТ
приведён к 1С-точному (имя объекта). За рамками: разворот небалансовых измерений в Дт/Кт,
параметры-субконто в окне.

- Спек: [`specs/2026-06-07-phase4-accounting-virtual-tables-design.md`](superpowers/specs/2026-06-07-phase4-accounting-virtual-tables-design.md)
- План: [`plans/2026-06-07-phase4-accounting-virtual-tables.md`](superpowers/plans/2026-06-07-phase4-accounting-virtual-tables.md)
```

- [ ] **Step 2: Финальный прогон всех тестов**

Run: `npm run test:unit`
Expected: всё зелёное.

- [ ] **Step 3: Коммит**

```bash
git add docs/ROADMAP.md
git commit -m "docs: ROADMAP — фаза 4.4 (ВТ регистров бухгалтерии)"
```

---

## Self-Review (выполнено автором плана)

**Покрытие спека:** §4.1 базовая таблица → Task 2; §4.2 развёртка ресурсов → Task 4; §4.3
счёт/субконто → Task 4; §4.4 порядок полей → Task 4 (8 кейсов); §5.1/5.2 парсеры → Task 1,2;
§5.3 типы → Task 3; §5.4 yamlLoader+пред-скан → Task 5; §6 период-поля → Task 11
(переиспользование `accumPeriodFields`); §7 `VirtualParams`/alias → Task 6; §8 генератор →
Task 8; §9 окно параметров → Task 9 (дескриптор) + Task 12 (рендер); §10 дерево/поля →
Task 11; §11 проброс correspondence → Task 10; §12 тесты — распределены по задачам; обновление
alias-эталонов 4.2/4.3 → Task 7.

**Плейсхолдеры:** нет (весь код приведён; «...» в Task 7 относится к неизменяемой части
позиционных параметров — точные строки берутся из текущего файла теста).

**Согласованность типов:** `VtParamKey`/`VtParamField` (Task 9) используются в Task 12;
`AccChartInfo` (Task 4) импортируется в Task 5; ключи `VirtualParams` (Task 6) совпадают с
позициями генератора (Task 8) и дескриптором (Task 9); `correspondence` проброс (Task 10)
читается генератором (Task 8) через `virtual.correspondence`.
