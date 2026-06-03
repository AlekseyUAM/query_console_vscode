# Phase 4.3 — Виртуальные таблицы регистров накопления: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать конструктору запросов виртуальные таблицы регистров накопления (`Обороты`, `Остатки`, `ОстаткиИОбороты`), окно «Параметры виртуальной таблицы» с выпадающими списками `Периодичность`/`МетодДополнения`, зависимость состава полей от периодичности и генерацию соответствующего текста запроса.

**Architecture:** Прямое обратносовместимое расширение машинерии фазы 4.2. Логика — в `core` (pure-TS, тесты в Node через vitest); webview — тонкий UI. Виртуальные таблицы рождаются в `yamlLoader` по виду регистра из парсера; период-зависимые поля считает чистый core-хелпер `accumPeriodFields`; параметры ВТ хранятся в расширенном `VirtualParams`; генератор диспетчеризует вызов источника по виду ВТ (3-й сегмент `fullName`). Контракт сообщений `src/shared/messages.ts` и reducer `queryStore` не меняются.

**Tech Stack:** TypeScript, Vitest (`node`-окружение), React (webview, бандл esbuild), YAML.

**Дизайн:** [`specs/2026-06-03-phase4-accum-virtual-tables-design.md`](../specs/2026-06-03-phase4-accum-virtual-tables-design.md)

**Test commands:**
- Unit: `npm run test:unit` (весь набор) или `npx vitest run test/unit/<file>.test.ts`
- Typecheck (для .tsx-задач): `npx tsc -p tsconfig.json --noEmit`
- Bundle webview: `npm run build:webview`

---

## Структура файлов

**Создать:**
- `src/core/query/accumVirtualFields.ts` — `accumPeriodFields` + константы `PERIODICITY_VALUES`/`FILL_METHOD_VALUES`
- `test/unit/accumVirtualFields.test.ts`

**Изменить:**
- `src/core/metadata/parser/accumulationRegister.ts` — читать `RegisterType` в `properties`
- `src/core/metadata/types.ts` — расширить `VirtualTableInfo.slice`
- `src/core/metadata/yamlLoader.ts` — `buildAccumRegSlices` + эмиссия
- `src/core/query/queryModel.ts` — расширить `VirtualParams`
- `src/core/query/sdblGenerator.ts` — диспетчеризация источника по виду ВТ
- `src/webview/components/VirtualTableParamsDialog.tsx` — параметричность по виду ВТ + выпадающие списки
- `src/webview/components/TablesPanel.tsx` — период-поля у раскрытой ВТ-накопления
- `src/webview/App.tsx` — проп `slice` диалогу; слияние период-полей в `fieldsForTable`
- `test/unit/newParsers.test.ts`, `test/unit/yamlLoader.test.ts`, `test/unit/sdblGenerator.test.ts` — новые тесты

**Без изменений (намеренно):** `src/webview/state/queryStore.ts` — экшен `SET_VIRTUAL_PARAMS` уже пишет произвольный `VirtualParams`, `ADD_TABLE` уже проставляет `virtual: {}` у таблиц с маркером `virtual`. `src/shared/messages.ts` — данные уже загружены, диалоги — состояние webview.

---

## Task 1: Парсер сохраняет вид регистра накопления (registerType)

**Files:**
- Modify: `src/core/metadata/parser/accumulationRegister.ts`
- Test: `test/unit/newParsers.test.ts`

Фикстуры уже есть: `src/cf/AccumulationRegisters/РегистрНакопленияОст.xml` (`RegisterType` = `Balance`) и `РегистрНакопленияОбор.xml` (`Turnovers`); `parseAccumulationRegister` и `readObjectEl` в тесте уже импортированы.

- [ ] **Step 1: Добавить тест в `test/unit/newParsers.test.ts`**

В конец файла добавить:

```ts
describe('parseAccumulationRegister — registerType property', () => {
  it('stores Balance for a balance (Остатки) register', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОст.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.properties?.registerType).toBe('Balance');
  });

  it('stores Turnovers for a turnover (Обороты) register', () => {
    const el = readObjectEl('AccumulationRegisters', 'РегистрНакопленияОбор.xml');
    const result = parseAccumulationRegister(el)!;
    expect(result.properties?.registerType).toBe('Turnovers');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run test/unit/newParsers.test.ts`
Expected: FAIL — `result.properties` is `undefined`.

- [ ] **Step 3: Изменить `accumulationRegister.ts`**

Файл целиком (добавлена строка чтения `registerType` и поле `properties` в `return`):

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
  const registerType = nodeText(childByLocalName(props, 'RegisterType')) || 'Balance';

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
    properties: { registerType }, // 'Balance' (Остатки) | 'Turnovers' (Обороты)
    fields,
  };
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/newParsers.test.ts`
Expected: PASS (все тесты файла).

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata/parser/accumulationRegister.ts test/unit/newParsers.test.ts
git commit -m "feat: парсер РегистрНакопления сохраняет вид регистра в properties"
```

---

## Task 2: Расширить `VirtualTableInfo.slice`

**Files:**
- Modify: `src/core/metadata/types.ts`

- [ ] **Step 1: Расширить объединение `slice`**

В `src/core/metadata/types.ts` заменить интерфейс `VirtualTableInfo`:

```ts
export interface VirtualTableInfo {
  slice: 'СрезПервых' | 'СрезПоследних' | 'Обороты' | 'Остатки' | 'ОстаткиИОбороты';
  baseFullName: string;
}
```

- [ ] **Step 2: Проверить, что существующие тесты проходят**

Run: `npm run test:unit`
Expected: PASS — расширение объединения обратносовместимо.

- [ ] **Step 3: Commit**

```bash
git add src/core/metadata/types.ts
git commit -m "feat: VirtualTableInfo.slice — виды ВТ регистров накопления"
```

---

## Task 3: Чистый хелпер период-зависимых полей (`accumVirtualFields`)

**Files:**
- Create: `src/core/query/accumVirtualFields.ts`
- Create: `test/unit/accumVirtualFields.test.ts`

- [ ] **Step 1: Написать тест `test/unit/accumVirtualFields.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { accumPeriodFields, PERIODICITY_VALUES, FILL_METHOD_VALUES } from '../../src/core/query/accumVirtualFields';

const names = (p: string | undefined) => accumPeriodFields(p).map(f => f.name);

describe('accumPeriodFields', () => {
  it('returns no period fields for empty/Период', () => {
    expect(names(undefined)).toEqual([]);
    expect(names('')).toEqual([]);
    expect(names('Период')).toEqual([]);
  });

  it('Запись → Период, Регистратор, НомерСтроки', () => {
    expect(names('Запись')).toEqual(['Период', 'Регистратор', 'НомерСтроки']);
  });

  it('Регистратор → Период, Регистратор', () => {
    expect(names('Регистратор')).toEqual(['Период', 'Регистратор']);
  });

  it('time-unit periodicity → Период only', () => {
    expect(names('Месяц')).toEqual(['Период']);
    expect(names('Секунда')).toEqual(['Период']);
    expect(names('Полугодие')).toEqual(['Период']);
  });

  it('Авто → ПериодСекунда…ПериодГод, Регистратор, НомерСтроки', () => {
    expect(names('Авто')).toEqual([
      'ПериодСекунда', 'ПериодМинута', 'ПериодЧас', 'ПериодДень', 'ПериодНеделя',
      'ПериодДекада', 'ПериодМесяц', 'ПериодКвартал', 'ПериодПолугодие', 'ПериодГод',
      'Регистратор', 'НомерСтроки',
    ]);
  });

  it('marks period fields as standard-kind МetaField with Дата/Число types', () => {
    const f = accumPeriodFields('Месяц')[0];
    expect(f.kind).toBe('standard');
    expect(f.types).toEqual([{ primitive: 'Дата' }]);
  });

  it('exposes value lists for dialog dropdowns', () => {
    expect(PERIODICITY_VALUES[0]).toBe('Период');
    expect(PERIODICITY_VALUES).toContain('Авто');
    expect(PERIODICITY_VALUES).toHaveLength(14);
    expect(FILL_METHOD_VALUES).toEqual(['Движения', 'ДвиженияИГраницыПериода']);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run test/unit/accumVirtualFields.test.ts`
Expected: FAIL — `Cannot find module '.../accumVirtualFields'`.

- [ ] **Step 3: Создать `src/core/query/accumVirtualFields.ts`**

```ts
import type { MetaField } from '../metadata/types';

/** Значения параметра `Периодичность` ВТ Обороты/ОстаткиИОбороты (порядок — как в конструкторе 1С). */
export const PERIODICITY_VALUES = [
  'Период', 'Запись', 'Регистратор',
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год',
  'Декада', 'Полугодие', 'Авто',
] as const;

/** Значения параметра `МетодДополнения` ВТ ОстаткиИОбороты. */
export const FILL_METHOD_VALUES = ['Движения', 'ДвиженияИГраницыПериода'] as const;

const date = (name: string): MetaField => ({ name, kind: 'standard', types: [{ primitive: 'Дата' }] });
const num = (name: string): MetaField => ({ name, kind: 'standard', types: [{ primitive: 'Число' }] });
const recorder = (): MetaField => ({ name: 'Регистратор', kind: 'standard', types: [{}] });

const TIME_UNITS: ReadonlySet<string> = new Set([
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год', 'Декада', 'Полугодие',
]);

/**
 * Период-зависимые поля виртуальных таблиц Обороты/ОстаткиИОбороты по выбранной
 * периодичности. Прибавляются к измерениям/развёрнутым ресурсам на слое webview.
 * Для пустого значения и `Период` дополнительных полей нет.
 */
export function accumPeriodFields(periodicity: string | undefined): MetaField[] {
  if (!periodicity) return [];
  if (periodicity === 'Запись') return [date('Период'), recorder(), num('НомерСтроки')];
  if (periodicity === 'Регистратор') return [date('Период'), recorder()];
  if (TIME_UNITS.has(periodicity)) return [date('Период')];
  if (periodicity === 'Авто') {
    return [
      date('ПериодСекунда'), date('ПериодМинута'), date('ПериодЧас'), date('ПериодДень'),
      date('ПериодНеделя'), date('ПериодДекада'), date('ПериодМесяц'), date('ПериодКвартал'),
      date('ПериодПолугодие'), date('ПериодГод'), recorder(), num('НомерСтроки'),
    ];
  }
  return []; // 'Период' и неизвестные значения
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run test/unit/accumVirtualFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/query/accumVirtualFields.ts test/unit/accumVirtualFields.test.ts
git commit -m "feat: accumPeriodFields — период-зависимые поля ВТ регистров накопления"
```

---

## Task 4: `yamlLoader` эмитит виртуальные таблицы регистров накопления

**Files:**
- Modify: `src/core/metadata/yamlLoader.ts`
- Test: `test/unit/yamlLoader.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/yamlLoader.test.ts`**

В конец `describe('loadMetadataFromYaml', ...)` (перед закрывающей `});` на строке ~546) добавить:

```ts
  it('emits Остатки, Обороты, ОстаткиИОбороты for a balance accumulation register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрНакопления', name: 'РегистрНакопленияОст', fullName: 'РегистрНакопления.РегистрНакопленияОст', file: 'AccumulationRegisters/Ост.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Ост.yaml', {
      version: 1, kind: 'РегистрНакопления', name: 'РегистрНакопленияОст', fullName: 'РегистрНакопления.РегистрНакопленияОст',
      properties: { registerType: 'Balance' },
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Регистратор', category: 'standard', types: [{ kind: 'unknown' }] },
        { name: 'Измерение1', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Ресурс1', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result: MetadataModel = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.Остатки');
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты');
    expect(names).toContain('РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты');

    const ostatki = result.tables.find(t => t.fullName.endsWith('.Остатки'))!;
    expect(ostatki.virtual).toEqual({ slice: 'Остатки', baseFullName: 'РегистрНакопления.РегистрНакопленияОст' });
    expect(ostatki.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Остаток']);

    const oboroty = result.tables.find(t => t.fullName.endsWith('.Обороты'))!;
    expect(oboroty.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Оборот', 'Ресурс1Приход', 'Ресурс1Расход']);

    const oio = result.tables.find(t => t.fullName.endsWith('.ОстаткиИОбороты'))!;
    expect(oio.fields.map(f => f.name)).toEqual([
      'Измерение1', 'Ресурс1НачальныйОстаток', 'Ресурс1КонечныйОстаток', 'Ресурс1Оборот', 'Ресурс1Приход', 'Ресурс1Расход',
    ]);
  });

  it('emits only Обороты (with Оборот resource) for a turnover accumulation register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрНакопления', name: 'РегистрНакопленияОбор', fullName: 'РегистрНакопления.РегистрНакопленияОбор', file: 'AccumulationRegisters/Обор.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'AccumulationRegisters/Обор.yaml', {
      version: 1, kind: 'РегистрНакопления', name: 'РегистрНакопленияОбор', fullName: 'РегистрНакопления.РегистрНакопленияОбор',
      properties: { registerType: 'Turnovers' },
      fields: [
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Измерение1', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Ресурс1', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const vtNames = result.tables.filter(t => t.virtual).map(t => t.fullName);
    expect(vtNames).toEqual(['РегистрНакопления.РегистрНакопленияОбор.Обороты']);
    const oboroty = result.tables.find(t => t.virtual)!;
    expect(oboroty.fields.map(f => f.name)).toEqual(['Измерение1', 'Ресурс1Оборот']);
  });
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run test/unit/yamlLoader.test.ts`
Expected: FAIL — виртуальные таблицы регистров накопления не эмитятся.

- [ ] **Step 3: Добавить `buildAccumRegSlices` и эмиссию в `yamlLoader.ts`**

После функции `buildInfoRegSlices` (после строки 113, перед `interface IndexEntry`) добавить:

```ts
// Развёртка ресурса <R> по виду виртуальной таблицы (по эталону конструктора 1С):
//  Остатки           → <R>Остаток
//  Обороты (Остатки) → <R>Оборот, <R>Приход, <R>Расход
//  Обороты (Обороты) → <R>Оборот
//  ОстаткиИОбороты   → <R>НачальныйОстаток, <R>КонечныйОстаток, <R>Оборот, <R>Приход, <R>Расход
function expandResources(resources: MetaField[], suffixes: string[]): MetaField[] {
  return resources.flatMap(r =>
    suffixes.map((s): MetaField => ({ name: `${r.name}${s}`, kind: 'resource', types: r.types }))
  );
}

function buildAccumRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрНакопления') return [];
  const registerType = (obj.properties as { registerType?: string } | undefined)?.registerType ?? 'Balance';
  const isBalance = registerType !== 'Turnovers';

  const dims = base.fields.filter(f => f.kind === 'dimension');
  const resources = base.fields.filter(f => f.kind === 'resource');

  const makeVT = (slice: VirtualTableInfo['slice'], resourceFields: MetaField[]): MetaTable => ({
    kind: 'РегистрНакопления',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    // Период-независимая часть: измерения + развёрнутые ресурсы. Период-поля
    // (зависят от выбранной периодичности) добавляются на слое webview.
    fields: [...dims.map(d => ({ ...d })), ...resourceFields],
    virtual: { slice, baseFullName: obj.fullName },
  });

  const oborotSuffixes = isBalance ? ['Оборот', 'Приход', 'Расход'] : ['Оборот'];

  const result: MetaTable[] = [];
  if (isBalance) {
    result.push(makeVT('Остатки', expandResources(resources, ['Остаток'])));
  }
  result.push(makeVT('Обороты', expandResources(resources, oborotSuffixes)));
  if (isBalance) {
    result.push(makeVT('ОстаткиИОбороты',
      expandResources(resources, ['НачальныйОстаток', 'КонечныйОстаток', 'Оборот', 'Приход', 'Расход'])));
  }
  return result;
}
```

Затем в `loadMetadataFromYaml`, в цикле, сразу после блока эмиссии срезов регистров сведений (строки 176–178), добавить:

```ts
    for (const slice of buildAccumRegSlices(obj, metaTable)) {
      tables.push(slice);
    }
```

`VirtualTableInfo` уже импортируется в `yamlLoader.ts` строкой 4 (используется `buildInfoRegSlices`); дополнительных импортов не нужно.

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/yamlLoader.test.ts`
Expected: PASS (включая существующий тест `maps dimension/resource category`, читающий `tables[0]`).

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata/yamlLoader.ts test/unit/yamlLoader.test.ts
git commit -m "feat: yamlLoader эмитит виртуальные таблицы регистров накопления"
```

---

## Task 5: Расширить `VirtualParams`

**Files:**
- Modify: `src/core/query/queryModel.ts`

- [ ] **Step 1: Добавить параметры виртуальных таблиц накопления**

В `src/core/query/queryModel.ts` заменить интерфейс `VirtualParams` (строки 1–4):

```ts
export interface VirtualParams {
  period?: string;       // срез РС, Остатки РН
  startPeriod?: string;  // НачалоПериода (Обороты, ОстаткиИОбороты)
  endPeriod?: string;    // КонецПериода
  periodicity?: string;  // Период|Запись|Регистратор|Секунда|…|Авто
  fillMethod?: string;   // Движения|ДвиженияИГраницыПериода (ОстаткиИОбороты)
  condition?: string;
}
```

Остальной файл (включая `defaultTableAlias`, склеивающий 2-й и 3-й сегменты для 3-сегментного `fullName`) не трогаем — он уже даёт `РегистрНакопленияОстОбороты` для накопительных ВТ.

- [ ] **Step 2: Проверить, что существующие тесты проходят**

Run: `npm run test:unit`
Expected: PASS — новые поля опциональны, обратносовместимо.

- [ ] **Step 3: Commit**

```bash
git add src/core/query/queryModel.ts
git commit -m "feat: VirtualParams — параметры ВТ регистров накопления"
```

---

## Task 6: Генератор — диспетчеризация источника по виду ВТ

**Files:**
- Modify: `src/core/query/sdblGenerator.ts`
- Test: `test/unit/sdblGenerator.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/sdblGenerator.test.ts`**

В конец `describe('generate', ...)` добавить:

```ts
  it('renders accumulation Обороты with positional params (start, end, periodicity, condition)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон', periodicity: 'Авто', condition: 'Измерение1 = &Пар' } }],
      fields: [
        { tableId: 't1', path: 'Измерение1', alias: 'Измерение1' },
        { tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' },
      ],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон, Авто, Измерение1 = &Пар) КАК РегистрНакопленияОстОбороты'
    );
  });

  it('renders accumulation Остатки with period and condition', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Остатки', virtual: { period: '&Период', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Остаток', alias: 'Ресурс1Остаток' }],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.Остатки(&Период, Измерение1 = &Пар) КАК РегистрНакопленияОстОстатки'
    );
  });

  it('renders accumulation ОстаткиИОбороты with all five positional params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты', virtual: { startPeriod: '&НачалоПериода', endPeriod: '&КонецП', periodicity: 'Авто', fillMethod: 'ДвиженияИГраницыПериода', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты(&НачалоПериода, &КонецП, Авто, ДвиженияИГраницыПериода, Измерение1 = &Пар) КАК РегистрНакопленияОстОстаткиИОбороты'
    );
  });

  it('drops trailing empty positions for Обороты (only start/end period set)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон) КАК РегистрНакопленияОстОбороты');
  });

  it('keeps empty middle position for Обороты (start + periodicity, no end)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', periodicity: 'Месяц' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, , Месяц) КАК РегистрНакопленияОстОбороты');
  });
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: FAIL — `renderSource` пока знает только `period`/`condition`.

- [ ] **Step 3: Переписать `renderSource` в `src/core/query/sdblGenerator.ts`**

Заменить функцию `renderSource` (строки 21–28) на:

```ts
function renderSource(t: SelectedTable): string {
  if (!t.virtual) return t.fullName;
  const v = t.virtual;
  const slice = t.fullName.split('.')[2];

  // Позиционные параметры зависят от вида виртуальной таблицы.
  let positions: string[];
  if (slice === 'Обороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.condition ?? ''];
  } else if (slice === 'ОстаткиИОбороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.fillMethod ?? '', v.condition ?? ''];
  } else {
    // СрезПервых / СрезПоследних / Остатки
    positions = [v.period ?? '', v.condition ?? ''];
  }

  // Хвостовые пустые позиции отбрасываются; пустые позиции в середине сохраняются
  // (ведущая/средняя запятая). Все позиции пусты → вызов без скобок.
  let last = positions.length - 1;
  while (last >= 0 && positions[last] === '') last--;
  if (last < 0) return t.fullName;
  return `${t.fullName}(${positions.slice(0, last + 1).join(', ')})`;
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: PASS (включая существующие тесты срезов РС — `(, Условие)`, `(Период)`, без скобок).

- [ ] **Step 5: Commit**

```bash
git add src/core/query/sdblGenerator.ts test/unit/sdblGenerator.test.ts
git commit -m "feat: генератор диспетчеризует источник по виду виртуальной таблицы"
```

---

## Task 7: Окно «Параметры виртуальной таблицы» — параметричность по виду ВТ

**Files:**
- Modify: `src/webview/components/VirtualTableParamsDialog.tsx`

Компонент чистый (UI), без vitest-теста — проверяется typecheck и бандлом (паттерн проекта). Новый обязательный проп `slice` будет передан из `App.tsx` в Task 9.

- [ ] **Step 1: Переписать `src/webview/components/VirtualTableParamsDialog.tsx`**

```tsx
import * as React from 'react';
import type { VirtualParams } from '../../core/query/queryModel';
import type { VirtualTableInfo } from '../../core/metadata/types';
import { PERIODICITY_VALUES, FILL_METHOD_VALUES } from '../../core/query/accumVirtualFields';

interface Props {
  slice: VirtualTableInfo['slice'];
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
      <label style={{ width: 130, fontSize: 12 }}>{label}</label>
      {children}
    </div>
  );
}

export function VirtualTableParamsDialog({ slice, initial, onOpenConditionBuilder, onOk, onCancel }: Props): React.ReactElement {
  const [period, setPeriod] = React.useState(initial.period ?? '');
  const [startPeriod, setStartPeriod] = React.useState(initial.startPeriod ?? '');
  const [endPeriod, setEndPeriod] = React.useState(initial.endPeriod ?? '');
  const [periodicity, setPeriodicity] = React.useState(initial.periodicity ?? '');
  const [fillMethod, setFillMethod] = React.useState(initial.fillMethod ?? '');
  const [condition, setCondition] = React.useState(initial.condition ?? '');

  const isOIO = slice === 'ОстаткиИОбороты';
  const isRange = slice === 'Обороты' || isOIO; // НачалоПериода/КонецПериода/Периодичность

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
          <button
            style={{ ...BTN, padding: '2px 8px' }}
            title="Произвольное выражение"
            onClick={() => onOpenConditionBuilder(condition, setCondition)}
          >
            …
          </button>
        </Row>

        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button data-testid="vt-ok" style={BTN} onClick={handleOk}>ОК</button>
          <button
            data-testid="vt-cancel"
            style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }}
            onClick={onCancel}
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: FAIL временно — `App.tsx` ещё не передаёт обязательный проп `slice` (исправим в Task 9). Допустимо: переходим дальше, финальный typecheck — в Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/VirtualTableParamsDialog.tsx
git commit -m "feat: окно Параметры виртуальной таблицы параметрично по виду ВТ"
```

---

## Task 8: Период-поля у раскрытой ВТ-накопления в панели «Таблицы»

**Files:**
- Modify: `src/webview/components/TablesPanel.tsx`

Раскрытая в панели «Таблицы» виртуальная таблица Обороты/ОстаткиИОбороты должна показывать период-поля по выбранной периодичности, чтобы их можно было перетащить в «Поля».

- [ ] **Step 1: Импортировать хелпер**

В начало `src/webview/components/TablesPanel.tsx`, после строки 3 (`import type { SelectedTable } ...`), добавить:

```ts
import { accumPeriodFields } from '../../core/query/accumVirtualFields';
```

- [ ] **Step 2: Прибавить период-поля к полям раскрытой ВТ**

В теле `map` по `selectedTables` (внутри блока `{isExpanded && meta && (...)}`) заменить отрисовку полей. Сейчас (строки 205–214):

```tsx
                  {meta.fields.map(field => (
                    <FieldRow
                      key={field.name}
                      tableFullName={t.fullName}
                      field={field}
                      depth={1}
                      expandedRefs={expandedRefs}
                      onExpandRef={onExpandRef}
                    />
                  ))}
```

на:

```tsx
                  {(
                    meta.virtual && (meta.virtual.slice === 'Обороты' || meta.virtual.slice === 'ОстаткиИОбороты')
                      ? [...accumPeriodFields(t.virtual?.periodicity), ...meta.fields]
                      : meta.fields
                  ).map(field => (
                    <FieldRow
                      key={field.name}
                      tableFullName={t.fullName}
                      field={field}
                      depth={1}
                      expandedRefs={expandedRefs}
                      onExpandRef={onExpandRef}
                    />
                  ))}
```

`t.virtual` — это `SelectedTable.virtual` (`VirtualParams`, несёт `periodicity`); `meta.virtual` — это `VirtualTableInfo` (несёт `slice`). Период-поля (`Период`/`Регистратор`/`НомерСтроки`/`ПериодX`) не пересекаются с `meta.fields` (измерения + ресурсы), дублей в ключах нет.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: FAIL временно — `App.tsx` ещё не передаёт `slice` в диалог (Task 9). Ошибок именно в `TablesPanel.tsx` быть не должно.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/TablesPanel.tsx
git commit -m "feat: период-поля у раскрытой ВТ регистра накопления в панели Таблицы"
```

---

## Task 9: Проводка `slice` и период-полей в `App.tsx`

**Files:**
- Modify: `src/webview/App.tsx`

- [ ] **Step 1: Импортировать хелпер период-полей**

В `src/webview/App.tsx` после строки 11 (`import type { MetaField, MetaTable } ...`) добавить:

```ts
import { accumPeriodFields } from '../core/query/accumVirtualFields';
```

- [ ] **Step 2: Слить период-поля в `fieldsForTable`**

Заменить функцию `fieldsForTable` (строки 77–84) на:

```ts
  // qualified=true → 'Alias.Поле' (для произвольного поля в SELECT);
  // qualified=false → 'Поле' (для условия внутри скобок виртуальной таблицы).
  function fieldsForTable(tableId: string, qualified: boolean): string[] {
    const sel = state.selectedTables.find(t => t.id === tableId);
    if (!sel) return [];
    const meta: MetaTable | undefined = state.tables.find(m => m.fullName === sel.fullName);
    if (!meta) return [];
    const alias = defaultTableAlias(sel);
    const periodFields: MetaField[] =
      meta.virtual && (meta.virtual.slice === 'Обороты' || meta.virtual.slice === 'ОстаткиИОбороты')
        ? accumPeriodFields(sel.virtual?.periodicity)
        : [];
    return [...periodFields, ...meta.fields].map((f: MetaField) => qualified ? `${alias}.${f.name}` : f.name);
  }
```

- [ ] **Step 3: Вычислить вид ВТ выбранной строки и передать его диалогу**

После блока `const vtSel = ...` (строки 88–90) добавить:

```ts
  const vtMeta = vtSel ? state.tables.find(m => m.fullName === vtSel.fullName) : undefined;
  const vtSlice = vtMeta?.virtual?.slice ?? 'СрезПоследних';
```

В JSX-вызове `<VirtualTableParamsDialog ... />` (строки 187–203) добавить проп `slice={vtSlice}` первым:

```tsx
        <VirtualTableParamsDialog
          slice={vtSlice}
          initial={vtSel.virtual ?? {}}
          onOpenConditionBuilder={(current, apply) => {
            setExprBuilder({
              fields: fieldsForTable(vtDialogTableId, false),
              initial: current,
              onOk: text => { apply(text); setExprBuilder(null); },
            });
          }}
          onOk={(params: VirtualParams) => {
            dispatch({ type: 'SET_VIRTUAL_PARAMS', tableId: vtDialogTableId, params });
            setVtDialogTableId(null);
          }}
          onCancel={() => setVtDialogTableId(null)}
        />
```

- [ ] **Step 4: Финальный typecheck и сборка**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (проп `slice` из Task 7 теперь передан; `TablesPanel` из Task 8 типизирован).

Run: `npm run build:webview`
Expected: бандл собирается без ошибок.

- [ ] **Step 5: Прогнать весь unit-набор**

Run: `npm run test:unit`
Expected: PASS (все тесты).

- [ ] **Step 6: Commit**

```bash
git add src/webview/App.tsx
git commit -m "feat: проводка вида ВТ и период-полей регистров накопления в App"
```

---

## Task 10: Ручная проверка (smoke) и финальная фиксация

**Files:** —

- [ ] **Step 1: Собрать и запустить расширение**

Run: `npm run build`
Затем запустить из VS Code (F5) — открыть конструктор на `.bsl`-файле. При необходимости нажать «Обновить кэш», чтобы метаданные содержали регистры накопления `РегистрНакопленияОст`/`РегистрНакопленияОбор`.

- [ ] **Step 2: Проверить сценарии по эталонам спека (§8.2)**

1. В дереве «База данных» под «Регистры накопления»:
   - у `РегистрНакопленияОст` (вид Остатки) видны строки `.Остатки`, `.Обороты`, `.ОстаткиИОбороты`;
   - у `РегистрНакопленияОбор` (вид Обороты) видна только `.Обороты`.
2. Перетащить `РегистрНакопленияОст.Обороты` в «Таблицы»; кнопка «⚙ Параметры виртуальной таблицы» активна. В окне: поля `Начало периода`, `Конец периода`, выпадающий список `Периодичность`, `Условие`. Задать `&Нач`, `&Кон`, `Авто`, через «…» — `Измерение1 = &Пар`.
3. Раскрыть `Обороты` в «Таблицы» — при `Периодичность = Авто` среди полей видны `ПериодСекунда…ПериодГод`, `Регистратор`, `НомерСтроки`, плюс `Измерение1`, `Ресурс1Оборот`, `Ресурс1Приход`, `Ресурс1Расход`. Перетащить нужные в «Поля».
4. Аналогично проверить `Остатки` (поля `Период` + `Условие`; ресурс `Ресурс1Остаток`) и `ОстаткиИОбороты` (дополнительно список `Метод дополнения`; ресурсы `Ресурс1НачальныйОстаток/КонечныйОстаток/Оборот/Приход/Расход`).
5. «Запрос» показывает текст, совпадающий с эталонами спека §8.2 (вызов виртуальной таблицы с позиционными параметрами и псевдонимом `РегистрНакопленияОст<ВидВТ>`).

- [ ] **Step 3: Финальный прогон тестов**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 4: Обновить статус фазы в ROADMAP**

В `docs/ROADMAP.md` в подразделе «#### 4.3» дополнить строку плана ссылкой на этот файл (рядом со ссылкой на спек):

```markdown
План: [`plans/2026-06-03-phase4-accum-virtual-tables.md`](superpowers/plans/2026-06-03-phase4-accum-virtual-tables.md)
```

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: ссылка на план фазы 4.3 в ROADMAP"
```

---

## Самопроверка плана (для автора)

- **Покрытие спека:** §4.1 парсер (Task 1), §4.2 тип `slice` (Task 2), §5 `accumPeriodFields` (Task 3), §4.3 эмиссия ВТ + развёртка ресурсов (Task 4), §7 `VirtualParams` (Task 5), §8 генератор (Task 6), §9 диалог (Task 7), §6 период-поля в «Таблицы»/`fieldsForTable` (Task 8 + 9), §6 дерево — `DbTreePanel` подхватывает ВТ автоматически (доп. кода не нужно, проверяется в Task 10), §10 состояние webview без изменений (намеренно, отмечено в «Структуре файлов»).
- **Типы согласованы:** `VirtualParams` (period/startPeriod/endPeriod/periodicity/fillMethod/condition), `VirtualTableInfo.slice` (5 значений), `accumPeriodFields`, `PERIODICITY_VALUES`/`FILL_METHOD_VALUES`, проп `slice: VirtualTableInfo['slice']` — имена совпадают между задачами (parser → loader → model → generator → dialog → TablesPanel → App).
- **Развёртка ресурсов согласована** между Task 4 (loader) и эталонами Task 6 (generator): `Остатки`→`<R>Остаток`; `Обороты` (Balance)→`<R>Оборот/Приход/Расход`; `Обороты` (Turnovers)→`<R>Оборот`; `ОстаткиИОбороты`→5 колонок.
- **Плейсхолдеры:** код приведён полностью в каждом шаге; «TBD»/«TODO»/«handle edge cases» отсутствуют.
- **Сборочная последовательность:** Task 7/8 намеренно оставляют typecheck временно красным (проп `slice` передаётся в Task 9) — это явно отмечено в ожидаемом результате шага. Финальный зелёный typecheck — Task 9 Step 4.
- **Регрессии:** существующий тест `yamlLoader` `maps dimension/resource category` читает `tables[0]` (базовый регистр) — эмиссия ВТ после него не ломает ассерты; тесты срезов РС в `sdblGenerator` сохраняются новым `renderSource` (правило пустых позиций идентично).
```