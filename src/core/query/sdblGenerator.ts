import type { QueryModel, SelectedTable, SelectedField, AggregateFunction, FieldRef, Condition, Join, Order, Totals, TotalKind, BuilderField, Indexing } from './queryModel';
import { defaultTableAlias } from './queryModel';
import type { QueryDocument } from './unionModel';
import { deriveUnionColumns } from './unionModel';
import type { BatchDocument } from './batchModel';
import { needsFormatting, formatExpression, normalizeLeafCase, stripNegatedFieldParens, appendIsNotNullTrailingSpace } from './exprFormatter';

/**
 * Подавление автопсевдонима простых полей при рендере подзапроса оператора `В`
 * (`В (ВЫБРАТЬ …)`). Конструктор 1С не синтезирует `КАК <последний-сегмент>` для
 * полей подзапроса без явного псевдонима (в отличие от запроса верхнего уровня).
 * Флаг выставляется только на время `renderConditionSubquery`; сохраняется/
 * восстанавливается для корректной работы при вложенности.
 */
let suppressAutoAlias = false;

/** Оборачивает выражение в SDBL-функцию агрегирования. */
function wrapAggregate(func: AggregateFunction, expr: string): string {
  switch (func) {
    case 'Сумма': return `СУММА(${expr})`;
    case 'Количество': return `КОЛИЧЕСТВО(${expr})`;
    case 'КоличествоРазличных': return `КОЛИЧЕСТВО(РАЗЛИЧНЫЕ ${expr})`;
    case 'Максимум': return `МАКСИМУМ(${expr})`;
    case 'Минимум': return `МИНИМУМ(${expr})`;
    case 'Среднее': return `СРЕДНЕЕ(${expr})`;
  }
}

export function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = defaultTableAlias(t);
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

/**
 * Подзапрос правого операнда `В` (`В (ВЫБРАТЬ …)`), разнесённый по строкам как
 * конструктор 1С. Рендерит внутренний запрос канонически (`generateDocument`),
 * сдвигает все строки на `baseTabs` табов, оборачивает первую строку открывающей
 * скобкой (`(ВЫБРАТЬ`), а к последней строке приклеивает закрывающую `)`. Тело
 * запроса в результате получает отступ `baseTabs + 1` (канонический +1 таб тела).
 */
function renderConditionSubquery(subquery: QueryDocument, baseTabs: number): string {
  const pad = '\t'.repeat(baseTabs);
  const prev = suppressAutoAlias;
  suppressAutoAlias = true;
  let inner: string[];
  try {
    inner = generateDocument(subquery).split('\n');
  } finally {
    suppressAutoAlias = prev;
  }
  return inner
    .map((l, k) => (k === 0 ? `${pad}(${l}` : `${pad}${l}`))
    .join('\n') + ')';
}

function renderSource(t: SelectedTable): string {
  if (t.subquery) {
    const inner = generateDocument(t.subquery).split('\n');
    return inner.map((l, k) => (k === 0 ? '(' + l : '\t' + l)).join('\n') + ')';
  }
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

  // Обороты/ОстаткиИОбороты регистра накопления — фиксированная арность (как у
  // регистра бухгалтерии и по эталону конструктора 1С): хвостовые пустые позиции
  // сохраняются, скобки — только если задан хоть один параметр.
  //   Обороты:          (НачалоПериода, КонецПериода, Периодичность, Условие)        — 4
  //   ОстаткиИОбороты:  (НачалоПериода, КонецПериода, Периодичность, МетодДополнения, Условие) — 5
  if (slice === 'Обороты' || slice === 'ОстаткиИОбороты') {
    const positions = slice === 'Обороты'
      ? [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.condition ?? '']
      : [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.fillMethod ?? '', v.condition ?? ''];
    if (!positions.some(p => p !== '')) return t.fullName;
    return `${t.fullName}(${positions.join(', ')})`;
  }

  // Остатки/срезы регистра сведений и накопления: фиксированная арность (Период, Условие),
  // как у регистра бухгалтерии и по эталону конструктора 1С — хвостовые пустые позиции
  // сохраняются. Скобки — только если задан хоть один параметр.
  const positions = [v.period ?? '', v.condition ?? ''];
  if (!positions.some(p => p !== '')) return t.fullName;
  return `${t.fullName}(${positions.join(', ')})`;
}

/** Модификаторы выборки записей: РАЗРЕШЕННЫЕ → РАЗЛИЧНЫЕ → ПЕРВЫЕ N. */
function selectionModifiers(selection: QueryModel['selection']): string {
  if (!selection) return '';
  let m = '';
  if (selection.allowed) m += ' РАЗРЕШЕННЫЕ';
  if (selection.distinct) m += ' РАЗЛИЧНЫЕ';
  if (typeof selection.top === 'number' && selection.top > 0) m += ` ПЕРВЫЕ ${selection.top}`;
  return m;
}

/**
 * Ключевое слово соединения по галочкам «Все». Конструктор 1С сохраняет ПРАВОЕ
 * соединение как есть (не нормализует перестановкой в ЛЕВОЕ).
 */
function joinKeyword(leftAll: boolean, rightAll: boolean): string {
  if (leftAll && rightAll) return 'ПОЛНОЕ';
  if (leftAll && !rightAll) return 'ЛЕВОЕ';
  if (!leftAll && rightAll) return 'ПРАВОЕ';
  return 'ВНУТРЕННЕЕ';
}

/**
 * Есть ли в выражении верхнеуровневый (вне скобок и строк) булев оператор И/ИЛИ.
 * Используется, чтобы отличить одиночное условие соединения от составного.
 */
function hasTopLevelBooleanOp(expr: string): boolean {
  const n = expr.length;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < n; i++) {
    const c = expr[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0) continue;
    // Граница слова на глубине 0: проверяем И и ИЛИ (регистронезависимо).
    if (!isWordChar(expr[i - 1])) {
      const up = expr.slice(i, i + 3).toUpperCase();
      if (up.startsWith('ИЛИ') && !isWordChar(expr[i + 3])) return true;
      if (expr[i].toUpperCase() === 'И' && !isWordChar(expr[i + 1])) return true;
    }
  }
  return false;
}

/**
 * Голое сравнение двух полей-ссылок: `<dotted> <op> <dotted>`, где каждая сторона —
 * точечный путь идентификаторов без скобок/параметров/литералов/функций. Такое условие
 * конструктор печатает без внешних скобок, даже когда оно попало в произвольный путь
 * из-за нерезолвимого псевдонима (фаза 6.12).
 */
function isPlainFieldComparison(expr: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*\s*(?:<>|>=|<=|=|>|<)\s*[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(expr.trim());
}

/**
 * Текст условия `ПО`. Простое: `<alias>.<path> <op> <alias>.<path>`; произвольное
 * оборачивается в скобки. Условие построено по псевдонимам и от порядка таблиц
 * (перестановки при правом соединении) не зависит. Возвращает '' если условия нет.
 */
function renderJoinCondition(join: Join, aliases: Map<string, string>): string {
  if (join.custom) {
    // Составное условие (верхнеуровневый И/ИЛИ) или структура (ИЛИ/ВЫБОР) —
    // переотрисовываем форматером (фаза 6.10); внешние скобки тут НЕ ставятся,
    // они уже распределены по подконъюнктам (`(a) И (b)`).
    const expr = (join.expression ?? '').trim();
    if (!expr) return '';
    if (hasTopLevelBooleanOp(expr)) return formatExpression(expr, 'join');
    if (needsFormatting(expr)) return formatExpression(expr, 'join');
    // Одиночное произвольное условие. Решение о внешних скобках (фаза 6.12):
    //  - конструктор СОХРАНЯЕТ скобки, если разработчик обернул всё во вводе
    //    (`ПО (a = b)` → `(a = b)`);
    //  - голое сравнение полей `a.b = c.d`, попавшее в произвольный путь лишь из-за
    //    нерезолвимого псевдонима (временные таблицы), конструктор печатает БЕЗ
    //    скобок — как и резолвленное простое условие;
    //  - всё прочее голое (параметр `&X`, константа `ИСТИНА`, функция `ТИПЗНАЧЕНИЯ(…)`)
    //    конструктор оборачивает в скобки.
    const leaf = normalizeLeafCase(expr);
    const wrap = join.parenthesized || !isPlainFieldComparison(expr);
    return wrap ? `(${leaf})` : leaf;
  }
  const leftAlias = aliases.get(join.leftTableId) ?? join.leftTableId;
  const rightAlias = aliases.get(join.rightTableId) ?? join.rightTableId;
  const op = join.operator ?? '=';
  // Простое резолвленное условие конструктор всегда печатает без внешних скобок.
  return `${leftAlias}.${join.leftPath ?? ''} ${op} ${rightAlias}.${join.rightPath ?? ''}`;
}

/**
 * Строки секции `ИЗ` (после `ИЗ`).
 * - Нет активных связей → каждая таблица `\t<источник> КАК <alias>` через запятую.
 * - Есть связи → левоассоциативная цепочка соединений; нормализация правого
 *   соединения (`!leftAll && rightAll`) — перестановкой таблиц (затравка = rightTable),
 *   условие `ПО` при этом не меняется. Таблицы, не вошедшие в цепочку, дописываются
 *   после неё через запятую (последняя строка цепочки получает запятую).
 */
function renderFrom(model: QueryModel, aliases: Map<string, string>): string[] {
  const sourceLine = (t: SelectedTable): string =>
    `${renderSource(t)} КАК ${aliases.get(t.id) ?? t.id}`;

  const joins = model.joins ?? [];
  if (joins.length === 0) {
    return model.tables.map((t, i) => {
      const comma = i < model.tables.length - 1 ? ',' : '';
      return `\t${sourceLine(t)}${comma}`;
    });
  }

  const byId = new Map(model.tables.map(t => [t.id, t]));
  const inChain = new Set<string>();
  const lines: string[] = [];

  joins.forEach((join, idx) => {
    // Источники соединения в порядке записи: затравка — левая таблица, присоединяемая —
    // правая. ПРАВОЕ соединение конструктор сохраняет без перестановки. Порядок
    // СЦЕПЛЕНИЯ берём из seedTableId/joinedTableId (текстовый порядок источников),
    // а не из leftTableId/rightTableId (порядок операндов условия) — конструктор 1С
    // сохраняет порядок источников разработчика. Для соединений из UI (без этих
    // полей) — откат к left/rightTableId (фаза 6.12).
    const seedId = join.seedTableId ?? join.leftTableId;
    const joinedId = join.joinedTableId ?? join.rightTableId;
    const keyword = joinKeyword(join.leftAll, join.rightAll);
    const seed = byId.get(seedId);
    const joined = byId.get(joinedId);
    if (!seed || !joined) return;

    if (idx === 0 || !inChain.has(seedId)) {
      lines.push(`\t${sourceLine(seed)}`);
      inChain.add(seedId);
    }
    lines.push(`\t\t${keyword} СОЕДИНЕНИЕ ${sourceLine(joined)}`);
    inChain.add(joinedId);
    const cond = renderJoinCondition(join, aliases);
    if (cond) lines.push(`\t\tПО ${cond}`);
  });

  // Таблицы, не участвующие ни в одной связи — дописываем после цепочки.
  const trailing = model.tables.filter(t => !inChain.has(t.id));
  if (trailing.length > 0 && lines.length > 0) {
    lines[lines.length - 1] += ',';
    trailing.forEach((t, i) => {
      const comma = i < trailing.length - 1 ? ',' : '';
      lines.push(`\t${sourceLine(t)}${comma}`);
    });
  }

  return lines;
}

/**
 * Блок построителя `{<ключевое слово> …}`. Возвращает [] если полей нет. Иначе:
 * первая строка `'{' + keyword`; затем по строке на поле `'\t' + render(f)` с
 * запятой после всех, кроме последнего; закрывающая `}` дописывается к строке
 * последнего поля (без отдельной строки). Поле:
 * `ref + (child ? '.*' : '') + (alias ? ' КАК ' + alias : '')`.
 */
function builderBlock(keyword: string, fields: BuilderField[]): string[] {
  if (fields.length === 0) return [];
  const render = (f: BuilderField): string =>
    f.ref + (f.child ? '.*' : '') + (f.alias ? ' КАК ' + f.alias : '');
  const lines = ['{' + keyword];
  fields.forEach((f, i) => {
    const last = i === fields.length - 1;
    lines.push('\t' + render(f) + (last ? '}' : ','));
  });
  return lines;
}

/**
 * Сборка блока одного запроса из ГОТОВЫХ строк полей (без хвостовых запятых).
 * Используется как обычным `generate`, так и генератором объединений
 * `generateDocument` (где список полей формируется из колонок объединения, а не
 * из `model.fields`). Возвращает текст блока (ВЫБРАТЬ … ИЗ … ГДЕ … и т.д.).
 *
 * `fieldLines` — строки элементов выборки БЕЗ запятых; запятые добавляются здесь.
 * Не обрабатывает случай `dropTemp` (он самостоятельный — см. `generate`).
 */
function buildQueryBlock(
  model: QueryModel,
  fieldLines: string[],
  aliases: Map<string, string>
): string {
  const lines = fieldLines.map((l, i) => (i < fieldLines.length - 1 ? l + ',' : l));

  // Запрос без источника (`ВЫБРАТЬ &Параметр КАК Поле [ПОМЕСТИТЬ ВТ]`) —
  // конструктор не выводит секцию `ИЗ`. Иначе обычный список таблиц.
  const hasFrom = model.tables.length > 0;
  const fromLines = hasFrom ? ['ИЗ', ...renderFrom(model, aliases)] : [];

  const conditionLines = renderConditions(model.conditions, aliases);
  // Конструктор 1С отделяет блок группировки пустой строкой (в отличие от ГДЕ).
  const groupingInner = renderGrouping(model.grouping, aliases);
  const groupingLines = groupingInner.length ? ['', ...groupingInner] : [];
  // ИМЕЮЩИЕ — сразу за группировкой, тоже с предшествующей пустой строкой.
  const havingLines = renderHaving(model.having, aliases);

  // ПОМЕСТИТЬ/ДОБАВИТЬ <ВТ> между списком полей и ИЗ.
  const placeLines: string[] =
    model.queryType === 'createTemp' && model.tempTableName
      ? ['ПОМЕСТИТЬ ' + model.tempTableName]
      : model.queryType === 'appendTemp' && model.tempTableName
        ? ['ДОБАВИТЬ ' + model.tempTableName]
        : [];

  // ДЛЯ ИЗМЕНЕНИЯ <таблицы> — в самом конце, с пустой строкой-разделителем.
  const lockLines: string[] = model.lockForUpdate?.length
    ? ['', 'ДЛЯ ИЗМЕНЕНИЯ', ...model.lockForUpdate.map(name => '\t' + name)]
    : [];

  const builderSelect = builderBlock('ВЫБРАТЬ', model.builder?.fields ?? []);
  const builderWhere = builderBlock('ГДЕ', model.builder?.conditions ?? []);
  const builderOrder = builderBlock('УПОРЯДОЧИТЬ ПО', model.builder?.order ?? []);
  const builderTotals = builderBlock('ИТОГИ ПО', model.builder?.totals ?? []);

  return [
    'ВЫБРАТЬ' + selectionModifiers(model.selection),
    ...lines,
    ...builderSelect,
    ...placeLines,
    ...fromLines,
    ...conditionLines,
    ...builderWhere,
    ...groupingLines,
    ...havingLines,
    ...builderOrder,
    ...builderTotals,
    ...lockLines,
  ].join('\n');
}

/** Голый параметр выборки `&Имя` (без вызова/индексации/прочего). */
const BARE_PARAM = /^&([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)$/u;

/**
 * Автопсевдоним произвольного поля выборки без явного `КАК`. Конструктор 1С
 * для голого параметра `&Имя` ставит псевдоним = имени параметра (без `&`),
 * для остального — сквозной `Поле{n}`. Возвращает выбранный псевдоним; для
 * варианта `Поле{n}` инкрементирует переданный счётчик.
 */
function exprAutoAlias(expression: string, next: () => string): string {
  const m = BARE_PARAM.exec(expression.trim());
  return m ? m[1] : next();
}

/**
 * Строки элементов выборки (БЕЗ хвостовых запятых) из собственных полей модели:
 * `model.fields`, табличные части и хвостовые поля. Совпадает байт-в-байт с тем,
 * что раньше формировал `generate`.
 */
function buildFieldLines(model: QueryModel, aliases: Map<string, string>): string[] {
  const aggregates = model.grouping?.aggregates ?? [];
  const aggregateFunc = (tableId: string, path: string): AggregateFunction | undefined =>
    aggregates.find(a => a.tableId === tableId && a.path === path)?.func;

  const allLines: string[] = [];
  // Счётчик автопсевдонимов произвольных полей. Не проверяет коллизии с явными
  // псевдонимами — допустимо для фазы 4.2 (UI не смешивает их с полями «Поле{n}»).
  let exprCounter = 0;

  for (const f of model.fields) {
    if (f.expression) {
      const alias = f.alias ?? exprAutoAlias(f.expression, () => `Поле${++exprCounter}`);
      const expr = formatSelectExpression(f.expression);
      allLines.push(`\t${expr} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const func = aggregateFunc(f.tableId, f.path);
    const lhs = func
      ? wrapAggregate(func, `${tableAlias}.${f.path}`)
      : `${tableAlias}.${f.path}`;
    // Конструктор 1С всегда даёт простому полю псевдоним = последний сегмент пути,
    // если явный не задан (Таблица.Ссылка → Таблица.Ссылка КАК Ссылка). Агрегаты
    // без явного псевдонима оставляем как есть.
    const autoAlias = !func && !suppressAutoAlias ? (f.path.split('.').pop() ?? f.path) : undefined;
    const effAlias = f.alias ?? autoAlias;
    const expr = effAlias ? `${lhs} КАК ${effAlias}` : lhs;
    allLines.push(`\t${expr}`);
  }

  for (const tsf of model.tabSectionFields ?? []) {
    const tableAlias = aliases.get(tsf.tableId) ?? tsf.tableId;
    const subLines = tsf.fields.map((f, i) =>
      `\t\t${f} КАК ${f}${i < tsf.fields.length - 1 ? ',' : ''}`
    );
    allLines.push(`\t${tableAlias}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t) КАК ${tsf.tsName}`);
  }

  // Поля, которые должны появляться после табличных частей (Предопределенный, ИмяПредопределенныхДанных).
  for (const f of model.trailingFields ?? []) {
    if (f.expression) {
      const alias = f.alias ?? exprAutoAlias(f.expression, () => `Поле${++exprCounter}`);
      const expr = formatSelectExpression(f.expression);
      allLines.push(`\t${expr} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const func = aggregateFunc(f.tableId, f.path);
    const lhs = func
      ? wrapAggregate(func, `${tableAlias}.${f.path}`)
      : `${tableAlias}.${f.path}`;
    // Тот же авто-псевдоним по последнему сегменту пути, что и для обычных полей.
    const autoAlias = !func && !suppressAutoAlias ? (f.path.split('.').pop() ?? f.path) : undefined;
    const effAlias = f.alias ?? autoAlias;
    const expr = effAlias ? `${lhs} КАК ${effAlias}` : lhs;
    allLines.push(`\t${expr}`);
  }

  return allLines;
}

/**
 * Каноническое выражение произвольного поля выборки (без части `КАК <псевдоним>`).
 * Единый источник правды для одиночного запроса (`buildFieldLines`) и для ячеек
 * колонок объединения (`fieldExpr`): структурные выражения (ВЫБОР/ИЛИ/И) проходят
 * переотрисовку конструктора через `formatExpression(..., 'select')`, остальные —
 * только нормализацию регистра/пробелов листа.
 */
export function formatSelectExpression(expression: string): string {
  return needsFormatting(expression)
    ? formatExpression(expression.trim(), 'select')
    : normalizeLeafCase(expression);
}

/**
 * Выражение элемента выборки для одного поля БЕЗ части `КАК <псевдоним>`:
 * `${псевдонимТаблицы}.${path}` (с обёрткой агрегата, если поле суммируемое),
 * либо произвольное `expression` для произвольного поля (с переотрисовкой
 * структуры конструктором). Карта псевдонимов вычисляется по
 * `resolveAliases(model.tables)` — ровно та же, что у `generate`.
 * Используется генератором объединений для формирования ячеек колонок.
 */
export function fieldExpr(model: QueryModel, field: SelectedField): string {
  if (field.expression) return formatSelectExpression(field.expression);
  const aliases = resolveAliases(model.tables);
  const tableAlias = aliases.get(field.tableId) ?? field.tableId;
  const func = (model.grouping?.aggregates ?? []).find(
    a => a.tableId === field.tableId && a.path === field.path
  )?.func;
  const lhs = `${tableAlias}.${field.path}`;
  return func ? wrapAggregate(func, lhs) : lhs;
}

/**
 * Псевдоним выборки для поля `(tableId, path)`: `alias` соответствующего поля из
 * `model.fields`, иначе последний сегмент `path`. Используется секциями
 * УПОРЯДОЧИТЬ ПО (5.6) и ИТОГИ (5.7), где поля адресуются по псевдониму выборки.
 */
export function selectAliasFor(model: QueryModel, tableId: string, path: string): string {
  const match = model.fields.find(f => f.tableId === tableId && f.path === path);
  if (match?.alias) return match.alias;
  return path.split('.').pop() ?? path;
}

/**
 * Секция УПОРЯДОЧИТЬ ПО (+ строка АВТОУПОРЯДОЧИВАНИЕ при `order.auto`). Без ведущей
 * пустой строки. Возвращает [] если порядок неактивен (нет полей и нет авто) —
 * тогда вывод байт-в-байт как раньше. Поле = `<псевдоним выборки>` + ` УБЫВ` при
 * `direction==='desc'`; запятая после всех, кроме последнего. При `auto` без полей
 * секция = только `['АВТОУПОРЯДОЧИВАНИЕ']`.
 */
function renderOrder(order: Order | undefined, model: QueryModel): string[] {
  if (!order) return [];
  const lines: string[] = [];
  if (order.fields.length > 0) {
    // Квалифицированные поля адресуются как `<псевдонимТаблицы>.<path>` (ссылка на поле
    // таблицы, как у конструктора 1С); прочие — по псевдониму выборки.
    const tableAliases = resolveAliases(model.tables);
    lines.push('УПОРЯДОЧИТЬ ПО');
    order.fields.forEach((f, i) => {
      const ref = f.qualified
        ? `${tableAliases.get(f.tableId) ?? f.tableId}.${f.path}`
        : selectAliasFor(model, f.tableId, f.path);
      const suffix = f.direction === 'desc' ? ' УБЫВ' : '';
      const comma = i < order.fields.length - 1 ? ',' : '';
      lines.push(`\t${ref}${suffix}${comma}`);
    });
  }
  if (order.auto) lines.push('АВТОУПОРЯДОЧИВАНИЕ');
  return lines;
}

/** Суффикс группировочного поля по типу итогов. */
function totalKindSuffix(kind: TotalKind): string {
  switch (kind) {
    case 'elements': return '';
    case 'hierarchy': return ' ИЕРАРХИЯ';
    case 'onlyHierarchy': return ' ТОЛЬКО ИЕРАРХИЯ';
  }
}

/**
 * Секция ИТОГИ … ПО … (без ведущей пустой строки). Возвращает [] если итоги
 * неактивны (нет группировочных полей и нет «Общих итогов») — тогда вывод
 * байт-в-байт как раньше.
 *
 * Поля адресуются по псевдониму выборки (как УПОРЯДОЧИТЬ ПО). Список агрегатов =
 * `totalFields` (`expression ?? СУММА(<псевдоним>)`); список ПО: при `grand`
 * первым `ОБЩИЕ`, затем каждое группировочное поле `<псевдоним><суффикс>` +
 * (` КАК <alias>` если задан). Два формата: с агрегатами — `ИТОГИ … ПО …`, без —
 * `ИТОГИ ПО …`. Запятая после всех элементов списка, кроме последнего; отступ 1 таб.
 */
export function renderTotals(totals: Totals | undefined, model: QueryModel): string[] {
  if (!totals) return [];
  const active = totals.groupFields.length > 0 || totals.grand;
  if (!active) return [];

  const byList: string[] = [];
  if (totals.grand) byList.push('ОБЩИЕ');
  for (const g of totals.groupFields) {
    const alias = selectAliasFor(model, g.tableId, g.path);
    const as = g.alias ? ` КАК ${g.alias}` : '';
    byList.push(`${alias}${totalKindSuffix(g.kind)}${as}`);
  }

  const aggList = totals.totalFields.map(f =>
    f.expression ? normalizeLeafCase(f.expression) : `СУММА(${selectAliasFor(model, f.tableId, f.path)})`
  );

  const withCommas = (items: string[]): string[] =>
    items.map((s, i) => `\t${s}${i < items.length - 1 ? ',' : ''}`);

  if (aggList.length > 0) {
    return ['ИТОГИ', ...withCommas(aggList), 'ПО', ...withCommas(byList)];
  }
  return ['ИТОГИ ПО', ...withCommas(byList)];
}

/**
 * Секция ИНДЕКСИРОВАТЬ ПО / ИНДЕКСИРОВАТЬ ПО НАБОРАМ. Возвращает [] если индексы
 * неактивны (нет indexing, тип запроса не createTemp, нет непустых индексов) —
 * тогда вывод байт-в-байт как раньше. Поля адресуются по псевдониму выборки.
 *
 * Один индекс → `ИНДЕКСИРОВАТЬ ПО` + поля `\t<псевдоним>` (запятая после всех,
 * кроме последнего); уникальность для одиночного индекса не выражается. Два и более
 * → `ИНДЕКСИРОВАТЬ ПО НАБОРАМ`, наборы в скобках `(…)`, суффикс ` УНИКАЛЬНО` при
 * `ix.unique`, запятая между наборами.
 */
export function renderIndex(indexing: Indexing | undefined, model: QueryModel): string[] {
  if (!indexing || model.queryType !== 'createTemp') return [];
  const indexes = indexing.indexes.filter(ix => ix.fields.length > 0);
  if (indexes.length === 0) return [];

  const aliasOf = (f: FieldRef): string => selectAliasFor(model, f.tableId, f.path);

  if (indexes.length === 1) {
    const fields = indexes[0].fields;
    const lines = fields.map((f, i) => {
      const comma = i < fields.length - 1 ? ',' : '';
      return `\t${aliasOf(f)}${comma}`;
    });
    return ['ИНДЕКСИРОВАТЬ ПО', ...lines];
  }

  const setLines: string[] = [];
  indexes.forEach((ix, idx) => {
    const setComma = idx < indexes.length - 1 ? ',' : '';
    const uniq = ix.unique ? ' УНИКАЛЬНО' : '';
    const fields = ix.fields;
    if (fields.length === 1) {
      setLines.push(`\t(${aliasOf(fields[0])})${uniq}${setComma}`);
      return;
    }
    fields.forEach((f, i) => {
      const alias = aliasOf(f);
      if (i === 0) setLines.push(`\t(${alias},`);
      else if (i < fields.length - 1) setLines.push(`\t${alias},`);
      else setLines.push(`\t${alias})${uniq}${setComma}`);
    });
  });
  return ['ИНДЕКСИРОВАТЬ ПО НАБОРАМ', '(', ...setLines, ')'];
}

export function generate(model: QueryModel): string {
  // УНИЧТОЖИТЬ — самостоятельный запрос, до всех остальных проверок.
  if (model.queryType === 'dropTemp') {
    return model.tempTableName ? `УНИЧТОЖИТЬ ${model.tempTableName}` : '';
  }

  if (model.tables.length === 0) return '';
  const hasFields = model.fields.length > 0 || (model.tabSectionFields?.length ?? 0) > 0;
  if (!hasFields) return '';

  const aliases = resolveAliases(model.tables);
  const fieldLines = buildFieldLines(model, aliases);
  let out = buildQueryBlock(model, fieldLines, aliases);
  const orderLines = renderOrder(model.order, model);
  if (orderLines.length > 0) out += '\n\n' + orderLines.join('\n');
  const totalsLines = renderTotals(model.totals, model);
  if (totalsLines.length > 0) out += '\n' + totalsLines.join('\n');
  const indexLines = renderIndex(model.indexing, model);
  if (indexLines.length > 0) out += '\n\n' + indexLines.join('\n');
  return out;
}

/**
 * Текст объединённого запроса по документу конструктора.
 * - 0 участников → ''.
 * - 1 участник → ровно `generate(members[0].model)` (объединение игнорируется).
 * - иначе: список выборки каждого участника формируется из колонок объединения
 *   (а ИЗ/ГДЕ/СГРУППИРОВАТЬ/ДЛЯ ИЗМЕНЕНИЯ/модификаторы — из его собственной
 *   модели). У участника 0 каждый элемент с `КАК <псевдоним>`, у остальных — без.
 *   Разделитель между участниками: `ОБЪЕДИНИТЬ ВСЕ` или `ОБЪЕДИНИТЬ`
 *   (если у следующего участника `distinct === true`), с пустыми строками вокруг.
 */
export function generateDocument(doc: QueryDocument): string {
  const members = doc.members;
  if (members.length === 0) return '';
  if (members.length === 1) return generate(members[0].model);

  const columns = deriveUnionColumns(members);

  const blocks = members.map((m, i) => {
    const fieldLines = columns.map(col => {
      const expr = col.cells[i] ?? 'NULL';
      return i === 0 ? `\t${expr} КАК ${col.alias}` : `\t${expr}`;
    });
    const aliases = resolveAliases(m.model.tables);
    return buildQueryBlock(m.model, fieldLines, aliases);
  });

  let out = blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    const keyword = members[i].distinct ? 'ОБЪЕДИНИТЬ' : 'ОБЪЕДИНИТЬ ВСЕ';
    out += `\n\n${keyword}\n\n${blocks[i]}`;
  }

  // Модификаторы УПОРЯДОЧИТЬ ПО / ИТОГИ ПО / ИНДЕКСИРОВАТЬ ПО относятся ко ВСЕМУ
  // объединению и записываются после последнего участника. ИНДЕКСИРОВАТЬ ПО валидно
  // лишь для `ПОМЕСТИТЬ`-объединения, чей маркер createTemp несёт первый участник, —
  // поэтому индекс рендерим в контексте createTemp-участника (фаза 6.12).
  const last = members[members.length - 1].model;
  const orderLines = renderOrder(last.order, last);
  if (orderLines.length > 0) out += '\n\n' + orderLines.join('\n');
  const totalsLines = renderTotals(last.totals, last);
  if (totalsLines.length > 0) out += '\n' + totalsLines.join('\n');
  const tempCarrier = members.find(m => m.model.queryType === 'createTemp')?.model;
  if (last.indexing && tempCarrier) {
    const indexLines = renderIndex(last.indexing, { ...tempCarrier, fields: last.fields, tables: last.tables });
    if (indexLines.length > 0) out += '\n\n' + indexLines.join('\n');
  }
  return out;
}

/**
 * Текст пакета запросов по документу пакета.
 * - 0 участников → ''.
 * - 1 участник → ровно `generateDocument(members[0])` (без `;` и разделителя),
 *   что гарантирует байт-в-байт совместимость с существующим выводом (golden-сьют,
 *   фазы 5.x).
 * - иначе: каждый участник рендерится `generateDocument`, пустые строки (`''`)
 *   отбрасываются, остальные соединяются разделителем пакета 1С: строка `;`,
 *   пустая строка, ровно 80 символов `/`, перевод строки.
 */
export function generateBatch(batch: BatchDocument): string {
  const SEP = '\n;\n\n' + '/'.repeat(80) + '\n';
  const members = batch.members;
  if (members.length === 0) return '';
  if (members.length === 1) return generateDocument(members[0]);

  const blocks = members.map(generateDocument).filter(b => b !== '');
  return blocks.join(SEP);
}

/** Рендер поля группировки `Псевдоним.Поле` по той же карте псевдонимов. */
function fieldRefExpr(f: FieldRef, aliases: Map<string, string>): string {
  // Произвольное выражение группировки (`ГОД(Т.Дата)`, `ВЫБОР … КОНЕЦ`) —
  // переотрисовываем тем же форматтером, что и выражения секции ВЫБРАТЬ.
  if (f.expression) return formatSelectExpression(f.expression);
  const tableAlias = aliases.get(f.tableId) ?? f.tableId;
  return `${tableAlias}.${f.path}`;
}

/**
 * Секция СГРУППИРОВАТЬ ПО (или ГРУППИРУЮЩИМ НАБОРАМ). Возвращает [] если
 * группировка не задана или неактивна — тогда вывод байт-в-байт как раньше.
 */
function renderGrouping(
  grouping: QueryModel['grouping'],
  aliases: Map<string, string>
): string[] {
  if (!grouping) return [];

  if (!grouping.multiple) {
    if (grouping.groupFields.length === 0) return [];
    const lines = grouping.groupFields.map((f, i) => {
      const comma = i < grouping.groupFields.length - 1 ? ',' : '';
      return `\t${fieldRefExpr(f, aliases)}${comma}`;
    });
    return ['СГРУППИРОВАТЬ ПО', ...lines];
  }

  // multiple=true: наборы группировки
  const sets = grouping.groupSets.filter(s => s.length > 0);
  if (sets.length === 0) return [];
  const setLines = sets.map((set, i) => {
    const fields = set.map(f => fieldRefExpr(f, aliases));
    const inner = fields
      .map((expr, j) => `\t${j === 0 ? '(' : '\t'}${expr}${j < fields.length - 1 ? ',' : ')'}`)
      .join('\n');
    const comma = i < sets.length - 1 ? ',' : '';
    return inner + comma;
  });
  return ['СГРУППИРОВАТЬ ПО ГРУППИРУЮЩИМ НАБОРАМ', '(', ...setLines, ')'];
}

/**
 * Правая часть простого условия `<op> <param>`. Конструктор 1С не ставит пробел перед
 * скобкой списка значений у оператора `В` (и `В ИЕРАРХИИ`): `В (&Список)` → `В(&Список)`,
 * `В ИЕРАРХИИ (&Род)` → `В ИЕРАРХИИ(&Род)`. Перед подзапросом (`В (ВЫБРАТЬ …)`) конструктор
 * переносит на новую строку — это вне модели простых условий (фаза 6.11), здесь не трогаем.
 */
function renderOperatorRhs(op: string, param: string): string {
  if (op === 'В') {
    if (param.startsWith('(')) {
      // Список из 2+ элементов конструктор отделяет пробелом: `В (a, b)`; список из
      // одного элемента — без пробела: `В(a)` (доказано на корпусе оракула:
      // multi 18 пробел / 0 без; single 14 пробел / 249 без — single оставляем как есть).
      return `В${valueListIsMulti(param) ? ' ' : ''}${param}`;
    }
    if (param.startsWith('ИЕРАРХИИ (')) return 'В ИЕРАРХИИ' + param.slice('ИЕРАРХИИ'.length).replace(/^ \(/, '(');
  }
  return `${op} ${param}`;
}

/**
 * Список значений `(…)` оператора `В` содержит 2+ элемента верхнего уровня?
 * Считает запятые вне вложенных скобок (ЗНАЧЕНИЕ(…) и т.п. — один элемент).
 * Подзапрос (`(ВЫБРАТЬ …)`) — не список значений, трактуется как один элемент.
 */
function valueListIsMulti(param: string): boolean {
  const inner = param.slice(1, param.lastIndexOf(')'));
  if (/(^|[^\p{L}\p{N}_])ВЫБРАТЬ([^\p{L}\p{N}_]|$)/u.test(inner)) return false;
  let depth = 0;
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

/**
 * Секция ГДЕ (условия отбора). Возвращает [] если рендерящихся условий нет —
 * тогда вывод байт-в-байт как раньше. Первое условие на отдельной строке,
 * каждое последующее — с префиксом «И ».
 */
/** Строки отдельных условий (без ключевого слова секции и префиксов `И`). */
function buildConditionStrings(
  conditions: Condition[] | undefined,
  aliases: Map<string, string>,
  slot: 'where' | 'having' = 'where'
): string[] {
  if (!conditions || conditions.length === 0) return [];
  const conds: string[] = [];
  for (const c of conditions) {
    if (c.custom) {
      const expr = (c.expression ?? '').trim();
      // ГДЕ/ИМЕЮЩИЕ: конструктор снимает скобки вокруг отрицания одиночного поля
      // (`(НЕ Алиас.Поле)` → `НЕ Алиас.Поле`); для остального — как раньше.
      if (expr) conds.push(needsFormatting(expr) ? formatExpression(expr, slot) : appendIsNotNullTrailingSpace(stripNegatedFieldParens(normalizeLeafCase(expr))));
      continue;
    }
    if (!c.path) continue;
    const alias = aliases.get(c.tableId ?? '') ?? c.tableId;
    const op = c.operator ?? '=';
    // Подзапрос в правом операнде `В` (`В (ВЫБРАТЬ …)`): конструктор переносит на
    // новую строку. Оператор `В` остаётся в конце строки условия; подзапрос
    // начинается со следующей строки как `(ВЫБРАТЬ …` с отступом base+2 табы
    // (условие ГДЕ на отступе 1 → `(ВЫБРАТЬ` на 3 табах; тело +1 → 4 таба).
    // `renderConditions` добавит ведущий `\t` к первой строке (отступ 1 условия).
    if (c.subquery) {
      conds.push(`${alias}.${c.path} ${op}\n${renderConditionSubquery(c.subquery, 3)}`);
      continue;
    }
    const param = normalizeLeafCase(c.param ?? `&${c.path.split('.').pop()}`);
    conds.push(`${alias}.${c.path} ${renderOperatorRhs(op, param)}`);
  }
  return conds;
}

function renderConditions(
  conditions: Condition[] | undefined,
  aliases: Map<string, string>
): string[] {
  const conds = buildConditionStrings(conditions, aliases);
  if (conds.length === 0) return [];
  return ['ГДЕ', ...conds.map((c, i) => (i === 0 ? `\t${c}` : `\tИ ${c}`))];
}

/**
 * Секция ИМЕЮЩИЕ (фильтр по агрегатам). Конструктор 1С отделяет её пустой строкой и
 * форматирует условия как ГДЕ. Возвращает [] если условий нет.
 */
function renderHaving(
  having: Condition[] | undefined,
  aliases: Map<string, string>
): string[] {
  const conds = buildConditionStrings(having, aliases, 'having');
  if (conds.length === 0) return [];
  return ['', 'ИМЕЮЩИЕ', ...conds.map((c, i) => (i === 0 ? `\t${c}` : `\tИ ${c}`))];
}

export function formatAsBslString(text: string): string {
  const lines = text.split('\n');
  const body = lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map(l => `|${l}`).join('\n') : '');
  return `"${body}"`;
}
