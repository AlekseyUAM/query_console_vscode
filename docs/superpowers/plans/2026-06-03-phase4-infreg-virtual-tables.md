# Phase 4.2 — Виртуальные таблицы регистров сведений + конструктор произвольных выражений: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать конструктору запросов виртуальные таблицы периодических регистров сведений (`СрезПервых`/`СрезПоследних`), окно «Параметры виртуальной таблицы», окно «Произвольное выражение» и генерацию соответствующего текста запроса.

**Architecture:** Логика — в `core` (pure-TS, тесты в Node через vitest); webview — тонкий UI поверх reducer-стора. Срезы рождаются в `yamlLoader` по периодичности из парсера; параметры среза и произвольные поля хранятся в `QueryModel`; генератор рендерит вызов виртуальной таблицы и произвольные выражения. Контракт сообщений `src/shared/messages.ts` не меняется.

**Tech Stack:** TypeScript, Vitest (`node`-окружение), React (webview, бандл esbuild), YAML.

**Дизайн:** [`specs/2026-06-03-phase4-infreg-virtual-tables-design.md`](../specs/2026-06-03-phase4-infreg-virtual-tables-design.md)

**Test commands:**
- Unit: `npm run test:unit` (весь набор) или `npx vitest run test/unit/<file>.test.ts`
- Typecheck (для .tsx-задач): `npx tsc -p tsconfig.json --noEmit`
- Bundle webview: `npm run build:webview`

---

## Структура файлов

**Создать:**
- `src/core/query/functionCatalog.ts` — статичный каталог функций языка запросов (дерево заготовок)
- `src/webview/components/ExpressionBuilder.tsx` — модалка «Произвольное выражение»
- `src/webview/components/VirtualTableParamsDialog.tsx` — модалка «Параметры виртуальной таблицы»
- `test/unit/functionCatalog.test.ts`

**Изменить:**
- `src/core/metadata/parser/informationRegister.ts` — сохранить периодичность в `properties`
- `src/core/metadata/types.ts` — `VirtualTableInfo`, `MetaTable.virtual`
- `src/core/metadata/yamlLoader.ts` — эмиссия таблиц-срезов
- `src/core/query/queryModel.ts` — `VirtualParams`, `SelectedTable.virtual`, `SelectedField.expression`
- `src/core/query/sdblGenerator.ts` — псевдонимы срезов, вызов виртуальной таблицы, произвольные поля
- `src/webview/state/queryStore.ts` — экшены `SET_VIRTUAL_PARAMS`, `ADD_EXPRESSION_FIELD`; `virtual` в `ADD_TABLE`
- `src/webview/components/TablesPanel.tsx` — кнопка «Параметры виртуальной таблицы»
- `src/webview/components/FieldsPanel.tsx` — кнопка «+» (добавить поле)
- `src/webview/App.tsx` — монтирование модалок, проброс состояния
- `test/unit/yamlLoader.test.ts`, `test/unit/sdblGenerator.test.ts`, `test/unit/queryStore.test.ts`, `test/unit/newParsers.test.ts` — новые тесты

---

## Task 1: Парсер сохраняет периодичность регистра сведений

**Files:**
- Modify: `src/core/metadata/parser/informationRegister.ts`
- Test: `test/unit/newParsers.test.ts`

- [ ] **Step 1: Добавить тест в `test/unit/newParsers.test.ts`**

В конец файла (импорт `parseInformationRegister` там уже есть):

```ts
describe('parseInformationRegister — periodicity property', () => {
  it('stores periodicity in properties for a periodical register', () => {
    const el = readObjectEl('InformationRegisters', 'АрхивСообщенийОбменов.xml');
    const result = parseInformationRegister(el)!;
    expect(result.properties?.periodicity).toBeTruthy();
    expect(result.properties?.periodicity).not.toBe('Nonperiodical');
  });

  it('stores periodicity Nonperiodical for a non-periodical register', () => {
    const el = readObjectEl('InformationRegisters', 'АдминистративнаяИерархия.xml');
    const result = parseInformationRegister(el)!;
    expect(result.properties?.periodicity).toBe('Nonperiodical');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run test/unit/newParsers.test.ts`
Expected: FAIL — `result.properties` is `undefined`.

- [ ] **Step 3: Изменить `informationRegister.ts`**

Заменить блок `return { ... }` (строки 34–41) на:

```ts
  return {
    version: 1,
    kind: 'РегистрСведений',
    name,
    fullName,
    uuid,
    properties: { periodicity: periodicity || 'Nonperiodical' },
    fields,
  };
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/newParsers.test.ts`
Expected: PASS (все тесты файла).

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata/parser/informationRegister.ts test/unit/newParsers.test.ts
git commit -m "feat: парсер РегистрСведений сохраняет периодичность в properties"
```

---

## Task 2: Тип `MetaTable.virtual`

**Files:**
- Modify: `src/core/metadata/types.ts`

- [ ] **Step 1: Добавить `VirtualTableInfo` и поле `virtual`**

В `src/core/metadata/types.ts` после интерфейса `MetaField` (перед `MetaTable`) добавить:

```ts
export interface VirtualTableInfo {
  slice: 'СрезПервых' | 'СрезПоследних';
  baseFullName: string;
}
```

И в `interface MetaTable` добавить последним полем:

```ts
  virtual?: VirtualTableInfo;
```

- [ ] **Step 2: Проверить, что существующие тесты проходят**

Run: `npm run test:unit`
Expected: PASS — изменение обратносовместимо (поле опционально).

- [ ] **Step 3: Commit**

```bash
git add src/core/metadata/types.ts
git commit -m "feat: MetaTable.virtual + VirtualTableInfo"
```

---

## Task 3: `yamlLoader` эмитит таблицы-срезы

**Files:**
- Modify: `src/core/metadata/yamlLoader.ts`
- Test: `test/unit/yamlLoader.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/yamlLoader.test.ts`**

В конец `describe('loadMetadataFromYaml', ...)` добавить:

```ts
  it('emits СрезПервых and СрезПоследних for a periodical information register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы', file: 'InformationRegisters/Курсы.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Курсы.yaml', {
      version: 1, kind: 'РегистрСведений', name: 'Курсы', fullName: 'РегистрСведений.Курсы',
      properties: { periodicity: 'Day' },
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Активность', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'Период', category: 'standard', types: [{ kind: 'Дата' }] },
        { name: 'Валюта', category: 'dimension', types: [{ kind: 'Строка' }] },
        { name: 'Курс', category: 'resource', types: [{ kind: 'Число' }] },
      ],
    });

    const result: MetadataModel = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрСведений.Курсы');
    expect(names).toContain('РегистрСведений.Курсы.СрезПервых');
    expect(names).toContain('РегистрСведений.Курсы.СрезПоследних');

    const slice = result.tables.find(t => t.fullName === 'РегистрСведений.Курсы.СрезПоследних')!;
    expect(slice.virtual).toEqual({ slice: 'СрезПоследних', baseFullName: 'РегистрСведений.Курсы' });
    const fieldNames = slice.fields.map(f => f.name);
    expect(fieldNames).toEqual(['Период', 'ПериодОкончание', 'Валюта', 'Курс']);
    expect(fieldNames).not.toContain('НомерСтроки');
    expect(fieldNames).not.toContain('Активность');
  });

  it('does not emit slices for a non-periodical information register', () => {
    writeCfYaml(tmpDir, 'configuration.yaml', {
      version: 1, name: 'TestConf',
      objects: [
        { type: 'РегистрСведений', name: 'Иерархия', fullName: 'РегистрСведений.Иерархия', file: 'InformationRegisters/Иерархия.yaml' },
      ],
    });
    writeCfYaml(tmpDir, 'InformationRegisters/Иерархия.yaml', {
      version: 1, kind: 'РегистрСведений', name: 'Иерархия', fullName: 'РегистрСведений.Иерархия',
      properties: { periodicity: 'Nonperiodical' },
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число' }] },
        { name: 'Активность', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'Узел', category: 'dimension', types: [{ kind: 'Строка' }] },
      ],
    });

    const result = loadMetadataFromYaml(tmpDir);
    const names = result.tables.map(t => t.fullName);
    expect(names).toContain('РегистрСведений.Иерархия');
    expect(names.some(n => n.includes('Срез'))).toBe(false);
  });
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run test/unit/yamlLoader.test.ts`
Expected: FAIL — таблицы-срезы не эмитятся.

- [ ] **Step 3: Добавить эмиссию срезов в `yamlLoader.ts`**

Импорт типа `VirtualTableInfo` — расширить существующий импорт типов в строке 4:

```ts
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind, VirtualTableInfo } from './types';
```

После функции `parsedObjectToMetaTable` (после строки 70) добавить:

```ts
const SLICE_EXCLUDED: ReadonlySet<string> = new Set(['НомерСтроки', 'Активность', 'Регистратор', 'Период']);

function buildInfoRegSlices(obj: ParsedObject, base: MetaTable): MetaTable[] {
  if (obj.kind !== 'РегистрСведений') return [];
  const periodicity = (obj.properties as { periodicity?: string } | undefined)?.periodicity;
  if (!periodicity || periodicity === 'Nonperiodical') return [];

  const sliceFields: MetaField[] = [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'ПериодОкончание', kind: 'standard', types: [{ primitive: 'Дата' }] },
    ...base.fields.filter(f => !SLICE_EXCLUDED.has(f.name)),
  ];

  const slices: ('СрезПервых' | 'СрезПоследних')[] = ['СрезПервых', 'СрезПоследних'];
  return slices.map((slice): MetaTable => ({
    kind: 'РегистрСведений',
    name: `${obj.name}.${slice}`,
    fullName: `${obj.fullName}.${slice}`,
    fields: sliceFields,
    virtual: { slice, baseFullName: obj.fullName } as VirtualTableInfo,
  }));
}
```

Затем в `loadMetadataFromYaml`, в цикле, после блока, который добавляет табличные части (строки 129–131), добавить:

```ts
    for (const slice of buildInfoRegSlices(obj, metaTable)) {
      tables.push(slice);
    }
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/yamlLoader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/metadata/yamlLoader.ts test/unit/yamlLoader.test.ts
git commit -m "feat: yamlLoader эмитит виртуальные таблицы-срезы периодических РС"
```

---

## Task 4: Каталог функций языка запросов

**Files:**
- Create: `src/core/query/functionCatalog.ts`
- Create: `test/unit/functionCatalog.test.ts`

- [ ] **Step 1: Написать тест `test/unit/functionCatalog.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { FUNCTION_CATALOG, type FunctionGroup, type FunctionLeaf } from '../../src/core/query/functionCatalog';

function isLeaf(n: FunctionGroup | FunctionLeaf): n is FunctionLeaf {
  return 'template' in n;
}

function allLeaves(group: FunctionGroup): FunctionLeaf[] {
  return group.children.flatMap(c => (isLeaf(c) ? [c] : allLeaves(c)));
}

describe('FUNCTION_CATALOG', () => {
  it('has the three top-level groups', () => {
    const labels = FUNCTION_CATALOG.children.map(c => c.label);
    expect(labels).toEqual(['Функции', 'Операторы', 'Прочее']);
  });

  it('includes ДОБАВИТЬКДАТЕ with a templated signature', () => {
    const leaf = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'ДОБАВИТЬКДАТЕ')!;
    expect(leaf.template).toBe('ДОБАВИТЬКДАТЕ(<Дата>, <Тип>, <Количество>)');
  });

  it('includes aggregate СУММА with templated argument', () => {
    const leaf = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'СУММА')!;
    expect(leaf.template).toBe('СУММА(<Выражение>)');
  });

  it('operators insert the symbol/keyword itself', () => {
    const and = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'И')!;
    expect(and.template).toBe('И');
    const eq = allLeaves(FUNCTION_CATALOG).find(l => l.label === '=')!;
    expect(eq.template).toBe('=');
  });

  it('Прочее contains СГРУППИРОВАНОПО', () => {
    const misc = FUNCTION_CATALOG.children.find(c => c.label === 'Прочее') as FunctionGroup;
    expect(allLeaves(misc).map(l => l.label)).toContain('СГРУППИРОВАНОПО');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run test/unit/functionCatalog.test.ts`
Expected: FAIL — `Cannot find module '.../functionCatalog'`.

- [ ] **Step 3: Создать `src/core/query/functionCatalog.ts`**

```ts
export interface FunctionLeaf {
  label: string;
  template: string;
}

export interface FunctionGroup {
  label: string;
  children: (FunctionGroup | FunctionLeaf)[];
}

const fn = (label: string, template: string): FunctionLeaf => ({ label, template });
const op = (symbol: string): FunctionLeaf => ({ label: symbol, template: symbol });

export const FUNCTION_CATALOG: FunctionGroup = {
  label: 'Функции языка запросов',
  children: [
    {
      label: 'Функции',
      children: [
        {
          label: 'Функции работы со строками',
          children: [
            fn('СТРОКА', 'СТРОКА(<Выражение>)'),
            fn('ДЛИНАСТРОКИ', 'ДЛИНАСТРОКИ(<Строка>)'),
            fn('ЛЕВ', 'ЛЕВ(<Строка>, <ЧислоСимволов>)'),
            fn('ПРАВ', 'ПРАВ(<Строка>, <ЧислоСимволов>)'),
            fn('ВРЕГ', 'ВРЕГ(<Строка>)'),
            fn('НРЕГ', 'НРЕГ(<Строка>)'),
            fn('ПОДСТРОКА', 'ПОДСТРОКА(<Строка>, <Позиция>, <Длина>)'),
            fn('СОКРЛ', 'СОКРЛ(<Строка>)'),
            fn('СОКРП', 'СОКРП(<Строка>)'),
            fn('СОКРЛП', 'СОКРЛП(<Строка>)'),
            fn('СТРНАЙТИ', 'СТРНАЙТИ(<Строка>, <ПодстрокаПоиска>)'),
            fn('СТРЗАМЕНИТЬ', 'СТРЗАМЕНИТЬ(<Строка>, <ПодстрокаПоиска>, <ПодстрокаЗамены>)'),
          ],
        },
        {
          label: 'Функции работы с датами',
          children: [
            fn('ГОД', 'ГОД(<Дата>)'),
            fn('КВАРТАЛ', 'КВАРТАЛ(<Дата>)'),
            fn('МЕСЯЦ', 'МЕСЯЦ(<Дата>)'),
            fn('ДЕНЬГОДА', 'ДЕНЬГОДА(<Дата>)'),
            fn('ДЕНЬ', 'ДЕНЬ(<Дата>)'),
            fn('НЕДЕЛЯ', 'НЕДЕЛЯ(<Дата>)'),
            fn('ДЕНЬНЕДЕЛИ', 'ДЕНЬНЕДЕЛИ(<Дата>)'),
            fn('ЧАС', 'ЧАС(<Дата>)'),
            fn('МИНУТА', 'МИНУТА(<Дата>)'),
            fn('СЕКУНДА', 'СЕКУНДА(<Дата>)'),
            fn('НАЧАЛОПЕРИОДА', 'НАЧАЛОПЕРИОДА(<Дата>, <Период>)'),
            fn('КОНЕЦПЕРИОДА', 'КОНЕЦПЕРИОДА(<Дата>, <Период>)'),
            fn('ДОБАВИТЬКДАТЕ', 'ДОБАВИТЬКДАТЕ(<Дата>, <Тип>, <Количество>)'),
            fn('РАЗНОСТЬДАТ', 'РАЗНОСТЬДАТ(<Дата1>, <Дата2>, <Тип>)'),
          ],
        },
        {
          label: 'Функции работы с числами',
          children: [
            fn('ACOS', 'ACOS(<Число>)'),
            fn('ASIN', 'ASIN(<Число>)'),
            fn('ATAN', 'ATAN(<Число>)'),
            fn('COS', 'COS(<Число>)'),
            fn('TAN', 'TAN(<Число>)'),
            fn('SIN', 'SIN(<Число>)'),
            fn('EXP', 'EXP(<Число>)'),
            fn('LOG', 'LOG(<Число>)'),
            fn('LOG10', 'LOG10(<Число>)'),
            fn('POW', 'POW(<Основание>, <Степень>)'),
            fn('SQRT', 'SQRT(<Число>)'),
            fn('ОКР', 'ОКР(<Число>, <Разрядность>)'),
            fn('ЦЕЛ', 'ЦЕЛ(<Число>)'),
          ],
        },
        {
          label: 'Агрегатные функции',
          children: [
            fn('СУММА', 'СУММА(<Выражение>)'),
            fn('МИНИМУМ', 'МИНИМУМ(<Выражение>)'),
            fn('МАКСИМУМ', 'МАКСИМУМ(<Выражение>)'),
            fn('СРЕДНЕЕ', 'СРЕДНЕЕ(<Выражение>)'),
            fn('КОЛИЧЕСТВО', 'КОЛИЧЕСТВО(<Выражение>)'),
            fn('КОЛИЧЕСТВО(РАЗЛИЧНЫЕ)', 'КОЛИЧЕСТВО(РАЗЛИЧНЫЕ <Выражение>)'),
          ],
        },
        {
          label: 'Прочие функции',
          children: [
            fn('ЕСТЬNULL', 'ЕСТЬNULL(<Выражение>, <ЗначениеЗамены>)'),
            fn('ПРЕДСТАВЛЕНИЕ', 'ПРЕДСТАВЛЕНИЕ(<Выражение>)'),
            fn('ПРЕДСТАВЛЕНИЕССЫЛКИ', 'ПРЕДСТАВЛЕНИЕССЫЛКИ(<Выражение>)'),
            fn('ТИПЗНАЧЕНИЯ', 'ТИПЗНАЧЕНИЯ(<Выражение>)'),
            fn('АВТОНОМЕРЗАПИСИ', 'АВТОНОМЕРЗАПИСИ()'),
            fn('РАЗМЕРХРАНИМЫХДАННЫХ', 'РАЗМЕРХРАНИМЫХДАННЫХ(<Выражение>)'),
            fn('УНИКАЛЬНЫЙИДЕНТИФИКАТОР', 'УНИКАЛЬНЫЙИДЕНТИФИКАТОР(<Выражение>)'),
          ],
        },
      ],
    },
    {
      label: 'Операторы',
      children: [
        {
          label: 'Арифметические операторы',
          children: [op('+'), op('-'), op('*'), op('/')],
        },
        {
          label: 'Логические операторы',
          children: [
            op('='), op('<>'), op('<'), op('<='), op('>'), op('>='),
            op('И'), op('ИЛИ'), op('НЕ'), op('ПОДОБНО'), op('В'),
            op('В ИЕРАРХИИ'), op('МЕЖДУ'), op('ЕСТЬ NULL'), op('ССЫЛКА'),
          ],
        },
        {
          label: 'Прочие операторы',
          children: [
            fn('ВЫБОР', 'ВЫБОР КОГДА <Условие> ТОГДА <Значение> ИНАЧЕ <Значение> КОНЕЦ'),
            fn('ВЫРАЗИТЬ', 'ВЫРАЗИТЬ(<Выражение> КАК <Тип>)'),
          ],
        },
      ],
    },
    {
      label: 'Прочее',
      children: [
        fn('ДАТАВРЕМЯ', 'ДАТАВРЕМЯ(<Год>, <Месяц>, <День>)'),
        fn('ЗНАЧЕНИЕ', 'ЗНАЧЕНИЕ(<ПолноеИмя>)'),
        fn('ТИП', 'ТИП(<ИмяТипа>)'),
        fn('СГРУППИРОВАНОПО', 'СГРУППИРОВАНОПО(<Поле>)'),
      ],
    },
  ],
};
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run test/unit/functionCatalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/query/functionCatalog.ts test/unit/functionCatalog.test.ts
git commit -m "feat: каталог функций языка запросов (functionCatalog)"
```

---

## Task 5: Расширить `QueryModel`

**Files:**
- Modify: `src/core/query/queryModel.ts`

- [ ] **Step 1: Добавить `VirtualParams` и новые поля**

Заменить содержимое `src/core/query/queryModel.ts` на:

```ts
export interface VirtualParams {
  period?: string;
  condition?: string;
}

export interface SelectedTable {
  id: string;
  fullName: string;
  alias?: string;
  virtual?: VirtualParams;
}

export interface SelectedField {
  tableId: string;
  path: string;
  alias?: string;
  expression?: string;
}

export interface SelectedTabSectionField {
  tableId: string;
  tsName: string;
  tsFullName: string;
  fields: string[];
}

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
  tabSectionFields?: SelectedTabSectionField[];
}
```

- [ ] **Step 2: Проверить, что существующие тесты проходят**

Run: `npm run test:unit`
Expected: PASS — поля опциональны, обратносовместимо.

- [ ] **Step 3: Commit**

```bash
git add src/core/query/queryModel.ts
git commit -m "feat: QueryModel — VirtualParams, SelectedTable.virtual, SelectedField.expression"
```

---

## Task 6: Генератор — виртуальные таблицы и произвольные поля

**Files:**
- Modify: `src/core/query/sdblGenerator.ts`
- Test: `test/unit/sdblGenerator.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/sdblGenerator.test.ts`**

В конец `describe('generate', ...)` добавить:

```ts
  it('renders a virtual slice table without parens when no params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: {} }],
      fields: [{ tableId: 't1', path: 'Период' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК КурсыСрезПоследних'
    );
  });

  it('renders a virtual slice table with period and condition params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК КурсыСрезПоследних'
    );
  });

  it('renders only period when condition empty', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toContain('РегистрСведений.Курсы.СрезПоследних(&Период) КАК КурсыСрезПоследних');
  });

  it('renders leading comma when only condition set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toContain('РегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК КурсыСрезПоследних');
  });

  it('renders an expression field with explicit alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: '', expression: 'ВЫРАЗИТЬ(Валюты.Код КАК ЧИСЛО)', alias: 'КодЧисло' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВЫРАЗИТЬ(Валюты.Код КАК ЧИСЛО) КАК КодЧисло\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('auto-generates aliases Поле1, Поле2 for expression fields without alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: '', expression: 'СУММА(Валюты.Код)' },
        { tableId: 't1', path: '', expression: 'МАКСИМУМ(Валюты.Код)' },
      ],
    };
    const text = generate(model);
    expect(text).toContain('\tСУММА(Валюты.Код) КАК Поле1,');
    expect(text).toContain('\tМАКСИМУМ(Валюты.Код) КАК Поле2\n');
  });
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: FAIL — псевдоним среза неверный, скобки/выражения не поддержаны.

- [ ] **Step 3: Переписать `src/core/query/sdblGenerator.ts`**

```ts
import type { QueryModel, SelectedTable } from './queryModel';

function defaultAlias(t: SelectedTable): string {
  if (t.alias) return t.alias;
  const parts = t.fullName.split('.');
  if (t.virtual && parts.length >= 3) return parts[1] + parts[2];
  return parts[1] ?? t.fullName;
}

function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = defaultAlias(t);
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

function renderSource(t: SelectedTable): string {
  if (!t.virtual) return t.fullName;
  const p = t.virtual.period ?? '';
  const c = t.virtual.condition ?? '';
  if (!p && !c) return t.fullName;
  const inner = c ? `${p}, ${c}` : p;
  return `${t.fullName}(${inner})`;
}

export function generate(model: QueryModel): string {
  if (model.tables.length === 0) return '';
  const hasFields = model.fields.length > 0 || (model.tabSectionFields?.length ?? 0) > 0;
  if (!hasFields) return '';

  const aliases = resolveAliases(model.tables);

  const allLines: string[] = [];
  let exprCounter = 0;

  for (const f of model.fields) {
    if (f.expression) {
      const alias = f.alias ?? `Поле${++exprCounter}`;
      allLines.push(`\t${f.expression} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const expr = f.alias ? `${tableAlias}.${f.path} КАК ${f.alias}` : `${tableAlias}.${f.path}`;
    allLines.push(`\t${expr}`);
  }

  for (const tsf of model.tabSectionFields ?? []) {
    const tableAlias = aliases.get(tsf.tableId) ?? tsf.tableId;
    const subLines = tsf.fields.map((f, i) =>
      `\t\t${f} КАК ${f}${i < tsf.fields.length - 1 ? ',' : ''}`
    );
    allLines.push(`\t${tableAlias}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t) КАК ${tsf.tsName}`);
  }

  const fieldLines = allLines.map((l, i) => i < allLines.length - 1 ? l + ',' : l);

  const tableLines = model.tables.map((t, i) => {
    const alias = aliases.get(t.id) ?? t.id;
    const comma = i < model.tables.length - 1 ? ',' : '';
    return `\t${renderSource(t)} КАК ${alias}${comma}`;
  });

  return ['ВЫБРАТЬ', ...fieldLines, 'ИЗ', ...tableLines].join('\n');
}

export function formatAsBslString(text: string): string {
  const lines = text.split('\n');
  const body = lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map(l => `|${l}`).join('\n') : '');
  return `"${body}"`;
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/sdblGenerator.test.ts`
Expected: PASS (включая существующие тесты).

- [ ] **Step 5: Commit**

```bash
git add src/core/query/sdblGenerator.ts test/unit/sdblGenerator.test.ts
git commit -m "feat: генератор — виртуальные таблицы-срезы и произвольные поля"
```

---

## Task 7: Reducer — параметры среза и произвольные поля

**Files:**
- Modify: `src/webview/state/queryStore.ts`
- Test: `test/unit/queryStore.test.ts`

- [ ] **Step 1: Добавить тесты в `test/unit/queryStore.test.ts`**

В начало файла добавить мок виртуальной таблицы (после `mockTable2`):

```ts
const mockSlice: MetaTable = {
  kind: 'РегистрСведений',
  name: 'Курсы.СрезПоследних',
  fullName: 'РегистрСведений.Курсы.СрезПоследних',
  fields: [{ name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] }],
  virtual: { slice: 'СрезПоследних', baseFullName: 'РегистрСведений.Курсы' },
};
```

В конец `describe('queryStore reducer', ...)` добавить:

```ts
  it('ADD_TABLE marks a virtual table with empty params', () => {
    const state = reducer(initialState(), { type: 'ADD_TABLE', table: mockSlice });
    expect(state.selectedTables[0].virtual).toEqual({});
  });

  it('ADD_TABLE leaves non-virtual tables without virtual marker', () => {
    const state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    expect(state.selectedTables[0].virtual).toBeUndefined();
  });

  it('SET_VIRTUAL_PARAMS writes params to the matching table', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockSlice });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'SET_VIRTUAL_PARAMS', tableId, params: { period: '&Период', condition: 'Валюта = &В' } });
    expect(state.selectedTables[0].virtual).toEqual({ period: '&Период', condition: 'Валюта = &В' });
  });

  it('ADD_EXPRESSION_FIELD appends an expression field', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_EXPRESSION_FIELD', tableId, expression: 'СУММА(Валюты.Код)' });
    expect(state.selectedFields).toHaveLength(1);
    expect(state.selectedFields[0].expression).toBe('СУММА(Валюты.Код)');
    expect(state.selectedFields[0].tableId).toBe(tableId);
  });
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run test/unit/queryStore.test.ts`
Expected: FAIL — нет экшенов / `virtual` не проставляется.

- [ ] **Step 3: Изменить `src/webview/state/queryStore.ts`**

В импорт типов (строка 2) добавить `VirtualParams`:

```ts
import type { SelectedTable, SelectedField, SelectedTabSectionField, VirtualParams } from '../../core/query/queryModel';
```

В union `QueryAction` добавить два варианта (после `FOCUS_SELECTED_FIELD`):

```ts
  | { type: 'SET_VIRTUAL_PARAMS'; tableId: string; params: VirtualParams }
  | { type: 'ADD_EXPRESSION_FIELD'; tableId: string; expression: string; alias?: string };
```

В `ADD_TABLE` заменить формирование нового элемента, чтобы пометить виртуальную таблицу. Текущий блок:

```ts
      const id = `t${++_tableCounter}`;
      return {
        ...state,
        selectedTables: [...state.selectedTables, { id, fullName: action.table.fullName }],
        focusedSelectedTableId: id,
      };
```

на:

```ts
      const id = `t${++_tableCounter}`;
      const newTable: SelectedTable = { id, fullName: action.table.fullName };
      if (action.table.virtual) newTable.virtual = {};
      return {
        ...state,
        selectedTables: [...state.selectedTables, newTable],
        focusedSelectedTableId: id,
      };
```

Перед `default:` добавить два кейса:

```ts
    case 'SET_VIRTUAL_PARAMS': {
      const selectedTables = state.selectedTables.map(t =>
        t.id === action.tableId ? { ...t, virtual: action.params } : t
      );
      return { ...state, selectedTables };
    }

    case 'ADD_EXPRESSION_FIELD': {
      const field: SelectedField = { tableId: action.tableId, path: '', expression: action.expression };
      if (action.alias) field.alias = action.alias;
      return { ...state, selectedFields: [...state.selectedFields, field] };
    }
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run test/unit/queryStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/state/queryStore.ts test/unit/queryStore.test.ts
git commit -m "feat: reducer — SET_VIRTUAL_PARAMS, ADD_EXPRESSION_FIELD, virtual в ADD_TABLE"
```

---

## Task 8: Компонент «Произвольное выражение» (ExpressionBuilder)

**Files:**
- Create: `src/webview/components/ExpressionBuilder.tsx`

Компонент чистый (UI), без vitest-теста — проверяется typecheck и бандлом (паттерн проекта: .tsx не покрываются unit-тестами).

- [ ] **Step 1: Создать `src/webview/components/ExpressionBuilder.tsx`**

```tsx
import * as React from 'react';
import { FUNCTION_CATALOG, type FunctionGroup, type FunctionLeaf } from '../../core/query/functionCatalog';

interface Props {
  title?: string;
  availableFields: string[]; // алиас-квалифицированные имена, напр. 'КурсыСрезПоследних.Период'
  initialText?: string;
  onOk: (text: string) => void;
  onCancel: () => void;
}

function isLeaf(n: FunctionGroup | FunctionLeaf): n is FunctionLeaf {
  return 'template' in n;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};

const PANEL: React.CSSProperties = {
  background: 'var(--vscode-editor-background, #1e1e1e)',
  border: '1px solid var(--vscode-panel-border, #555)',
  borderRadius: 4, padding: 12, width: '70vw', height: '70vh',
  display: 'flex', flexDirection: 'column', gap: 8,
};

const BTN: React.CSSProperties = {
  padding: '4px 12px', cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none', borderRadius: 2, fontSize: 12,
};

function FunctionTree({ node, depth, onPick }: { node: FunctionGroup | FunctionLeaf; depth: number; onPick: (template: string) => void }): React.ReactElement {
  const [open, setOpen] = React.useState(depth === 0);
  if (isLeaf(node)) {
    return (
      <div
        draggable
        onDragStart={e => { e.dataTransfer.setData('text/plain', node.template); e.dataTransfer.effectAllowed = 'copy'; }}
        onDoubleClick={() => onPick(node.template)}
        style={{ paddingLeft: 8 + depth * 14, paddingTop: 1, fontSize: 12, cursor: 'default', userSelect: 'none' }}
      >
        {node.label}
      </div>
    );
  }
  return (
    <div>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ paddingLeft: 8 + depth * 14, fontSize: 12, cursor: 'default', userSelect: 'none', display: 'flex', gap: 4 }}
      >
        <span style={{ width: 12 }}>{open ? '▼' : '▶'}</span>
        <span>{node.label}</span>
      </div>
      {open && node.children.map((c, i) => (
        <FunctionTree key={`${c.label}:${i}`} node={c} depth={depth + 1} onPick={onPick} />
      ))}
    </div>
  );
}

export function ExpressionBuilder({ title = 'Произвольное выражение', availableFields, initialText = '', onOk, onCancel }: Props): React.ReactElement {
  const [text, setText] = React.useState(initialText);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  function insertAtCursor(snippet: string) {
    const ta = taRef.current;
    if (!ta) { setText(prev => prev + snippet); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + snippet.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const snippet = e.dataTransfer.getData('text/plain');
    if (snippet) insertAtCursor(snippet);
  }

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>{title}</div>
        <div style={{ display: 'flex', flex: 1, gap: 8, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--vscode-panel-border, #444)' }}>
            <div style={{ fontSize: 11, padding: '2px 6px', opacity: 0.7 }}>Поле</div>
            {availableFields.map(f => (
              <div
                key={f}
                draggable
                onDragStart={e => { e.dataTransfer.setData('text/plain', f); e.dataTransfer.effectAllowed = 'copy'; }}
                onDoubleClick={() => insertAtCursor(f)}
                style={{ padding: '1px 8px', fontSize: 12, cursor: 'default', userSelect: 'none' }}
              >
                {f}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--vscode-panel-border, #444)' }}>
            <FunctionTree node={FUNCTION_CATALOG} depth={0} onPick={insertAtCursor} />
          </div>
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={handleDrop}
          style={{ height: 120, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 13, resize: 'none' }}
        />
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end' }}>
          <button data-testid="expr-ok" style={BTN} onClick={() => onOk(text)}>ОК</button>
          <button data-testid="expr-cancel" style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }} onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Проверить typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (нет ошибок типов).

- [ ] **Step 3: Проверить сборку webview**

Run: `npm run build:webview`
Expected: бандл собирается без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/ExpressionBuilder.tsx
git commit -m "feat: модалка Произвольное выражение (ExpressionBuilder)"
```

---

## Task 9: Компонент «Параметры виртуальной таблицы» (VirtualTableParamsDialog)

**Files:**
- Create: `src/webview/components/VirtualTableParamsDialog.tsx`

- [ ] **Step 1: Создать `src/webview/components/VirtualTableParamsDialog.tsx`**

```tsx
import * as React from 'react';
import type { VirtualParams } from '../../core/query/queryModel';

interface Props {
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
  borderRadius: 4, padding: 16, minWidth: 420,
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

export function VirtualTableParamsDialog({ initial, onOpenConditionBuilder, onOk, onCancel }: Props): React.ReactElement {
  const [period, setPeriod] = React.useState(initial.period ?? '');
  const [condition, setCondition] = React.useState(initial.condition ?? '');

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Параметры виртуальной таблицы</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ width: 80, fontSize: 12 }}>Период</label>
          <input data-testid="vt-period" style={INPUT} value={period} onChange={e => setPeriod(e.target.value)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ width: 80, fontSize: 12 }}>Условие</label>
          <input data-testid="vt-condition" style={INPUT} value={condition} onChange={e => setCondition(e.target.value)} />
          <button
            style={{ ...BTN, padding: '2px 8px' }}
            title="Произвольное выражение"
            onClick={() => onOpenConditionBuilder(condition, setCondition)}
          >
            …
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button
            data-testid="vt-ok"
            style={BTN}
            onClick={() => onOk({ ...(period ? { period } : {}), ...(condition ? { condition } : {}) })}
          >
            ОК
          </button>
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
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/VirtualTableParamsDialog.tsx
git commit -m "feat: модалка Параметры виртуальной таблицы"
```

---

## Task 10: Кнопка «Параметры виртуальной таблицы» в панели «Таблицы»

**Files:**
- Modify: `src/webview/components/TablesPanel.tsx`

- [ ] **Step 1: Расширить пропсы и тулбар `TablesPanel.tsx`**

В `interface Props` добавить:

```ts
  onOpenVirtualParams: (tableId: string) => void;
```

В деструктуризации параметров функции `TablesPanel` добавить `onOpenVirtualParams`.

Внутри компонента, перед `return`, вычислить признак виртуальной выбранной таблицы:

```ts
  const focusedTable = selectedTables.find(t => t.id === focusedSelectedTableId);
  const focusedMeta = focusedTable ? metaTables.find(m => m.fullName === focusedTable.fullName) : undefined;
  const focusedIsVirtual = !!focusedMeta?.virtual;
```

В блок тулбара (рядом с кнопкой ✕, внутри `<div style={{ display: 'flex', gap: 4 }}>`) добавить вторую кнопку:

```tsx
        <button
          style={BTN}
          title="Параметры виртуальной таблицы"
          disabled={!focusedIsVirtual}
          onClick={() => focusedSelectedTableId && onOpenVirtualParams(focusedSelectedTableId)}
        >
          ⚙
        </button>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: FAIL временно — `App.tsx` ещё не передаёт `onOpenVirtualParams` (исправим в Task 12). Допустимо: переходим дальше, финальный typecheck — в Task 12.

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/TablesPanel.tsx
git commit -m "feat: кнопка Параметры виртуальной таблицы в панели Таблицы"
```

---

## Task 11: Кнопка «+» (добавить поле) в панели «Поля»

**Files:**
- Modify: `src/webview/components/FieldsPanel.tsx`

- [ ] **Step 1: Расширить пропсы и тулбар `FieldsPanel.tsx`**

В `interface Props` добавить:

```ts
  canAddExpression: boolean;
  onAddExpression: () => void;
```

В деструктуризации параметров функции добавить `canAddExpression, onAddExpression`.

В тулбар (внутри `<div style={{ display: 'flex', gap: 4 }}>`, рядом с кнопкой ✕) добавить:

```tsx
        <button
          style={BTN}
          title="Добавить поле (произвольное выражение)"
          disabled={!canAddExpression}
          onClick={onAddExpression}
        >
          +
        </button>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: FAIL временно — `App.tsx` ещё не передаёт новые пропсы (исправим в Task 12).

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/FieldsPanel.tsx
git commit -m "feat: кнопка + (добавить произвольное поле) в панели Поля"
```

---

## Task 12: Монтирование модалок и проводка состояния в `App.tsx`

**Files:**
- Modify: `src/webview/App.tsx`

- [ ] **Step 1: Добавить импорты и состояние модалок**

После строки `import { FieldsPanel } from './components/FieldsPanel';` добавить:

```ts
import { VirtualTableParamsDialog } from './components/VirtualTableParamsDialog';
import { ExpressionBuilder } from './components/ExpressionBuilder';
import type { VirtualParams } from '../core/query/queryModel';
import type { MetaField, MetaTable } from '../core/metadata/types';
```

Внутри `App`, рядом с прочими `useState`, добавить:

```ts
  const [vtDialogTableId, setVtDialogTableId] = useState<string | null>(null);
  const [exprBuilder, setExprBuilder] = useState<null | {
    fields: string[];
    initial: string;
    onOk: (text: string) => void;
  }>(null);
```

- [ ] **Step 2: Добавить хелпер для алиас-квалифицированных полей таблицы**

Внутри `App`, перед `return`, добавить функцию, собирающую доступные поля выбранной таблицы (плоский список верхнего уровня; раскрытие ссылок переиспользует `expandedRefs`):

```ts
  function aliasOf(t: { fullName: string; virtual?: VirtualParams }): string {
    const parts = t.fullName.split('.');
    if (t.virtual && parts.length >= 3) return parts[1] + parts[2];
    return parts[1] ?? t.fullName;
  }

  // qualified=true → 'Alias.Поле' (для произвольного поля в SELECT);
  // qualified=false → 'Поле' (для условия внутри скобок виртуальной таблицы).
  function fieldsForTable(tableId: string, qualified: boolean): string[] {
    const sel = state.selectedTables.find(t => t.id === tableId);
    if (!sel) return [];
    const meta: MetaTable | undefined = state.tables.find(m => m.fullName === sel.fullName);
    if (!meta) return [];
    const alias = aliasOf(sel);
    return meta.fields.map((f: MetaField) => qualified ? `${alias}.${f.name}` : f.name);
  }
```

- [ ] **Step 3: Передать новые пропсы в `TablesPanel` и `FieldsPanel`**

В JSX `<TablesPanel ... />` добавить проп:

```tsx
            onOpenVirtualParams={tableId => setVtDialogTableId(tableId)}
```

В JSX `<FieldsPanel ... />` добавить пропсы:

```tsx
            canAddExpression={state.focusedSelectedTableId !== null}
            onAddExpression={() => {
              const tableId = state.focusedSelectedTableId;
              if (!tableId) return;
              setExprBuilder({
                fields: fieldsForTable(tableId, true),
                initial: '',
                onOk: text => {
                  if (text.trim()) dispatch({ type: 'ADD_EXPRESSION_FIELD', tableId, expression: text.trim() });
                  setExprBuilder(null);
                },
              });
            }}
```

- [ ] **Step 4: Отрендерить модалки**

Перед закрывающим `</div>` корневого контейнера (после блока Query preview modal) добавить:

```tsx
      {/* Virtual table params modal */}
      {vtDialogTableId !== null && (() => {
        const sel = state.selectedTables.find(t => t.id === vtDialogTableId);
        if (!sel) return null;
        return (
          <VirtualTableParamsDialog
            initial={sel.virtual ?? {}}
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
        );
      })()}

      {/* Expression builder modal */}
      {exprBuilder && (
        <ExpressionBuilder
          availableFields={exprBuilder.fields}
          initialText={exprBuilder.initial}
          onOk={exprBuilder.onOk}
          onCancel={() => setExprBuilder(null)}
        />
      )}
```

- [ ] **Step 5: Финальный typecheck и сборка**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (все пропсы из Task 10/11 теперь переданы).

Run: `npm run build:webview`
Expected: бандл собирается без ошибок.

- [ ] **Step 6: Прогнать весь unit-набор**

Run: `npm run test:unit`
Expected: PASS (все тесты).

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.tsx
git commit -m "feat: монтирование модалок виртуальной таблицы и произвольного выражения"
```

---

## Task 13: Ручная проверка (smoke) и финальная фиксация

**Files:** —

- [ ] **Step 1: Собрать и запустить расширение**

Run: `npm run build`
Затем `npm run dev` (или запуск из VS Code) — открыть конструктор на `.bsl`-файле.

- [ ] **Step 2: Проверить сценарий по скриншотам**

Убедиться вручную (нужен распарсенный YAML с периодическим РС; при необходимости нажать «Обновить кэш»):
1. В дереве «База данных» под «Регистры сведений» у периодического регистра видны строки `<Имя>.СрезПервых` и `<Имя>.СрезПоследних`.
2. Перетащить срез в «Таблицы»; кнопка «⚙ Параметры виртуальной таблицы» активна.
3. В окне параметров задать Период (`&Период`) и через «…» собрать Условие.
4. Кнопкой «+» в «Поля» добавить произвольное поле через окно выражения.
5. «Запрос» показывает `РегистрСведений.<Имя>.СрезПоследних(&Период, …) КАК <Имя>СрезПоследних` и произвольное поле с псевдонимом.

- [ ] **Step 3: Финальный прогон тестов**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 4 (опционально): e2e**

Если расширяются Playwright-тесты: `npm run pretest:e2e && npm run test:e2e`. В рамках 4.2 не обязательно — основная дисциплина проекта — unit-тесты ядра и reducer.

---

## Самопроверка плана (для автора)

- **Покрытие спека:** §4 (Task 1), §4.2 (Task 2), §4.3 (Task 3), §6 (Task 5), §7 (Task 6), §8 (Task 9 + 10 + 12), §9.1 (Task 4), §9.2/9.3 (Task 8 + 11 + 12), §10 (Task 7), §5 дерево — существующий `DbTreePanel` подхватывает срезы автоматически (доп. кода не нужно, проверяется в Task 13). §7 контракт сообщений без изменений — отдельной задачи нет (намеренно).
- **Типы согласованы:** `VirtualParams`, `VirtualTableInfo`, `SelectedTable.virtual`, `SelectedField.expression`, экшены `SET_VIRTUAL_PARAMS`/`ADD_EXPRESSION_FIELD`, `FunctionGroup`/`FunctionLeaf` — имена совпадают между задачами.
- **Плейсхолдеры:** код приведён полностью в каждом шаге; «TBD»/«TODO»/«handle edge cases» отсутствуют.
- **Сборочная последовательность:** Task 10/11 намеренно оставляют typecheck временно красным (пропсы передаются в Task 12) — это явно отмечено в ожидаемом результате шага.
