import type { QueryModel, SelectedTable, SelectedField, AggregateFunction, FieldRef, Condition } from './queryModel';
import { defaultTableAlias } from './queryModel';
import type { QueryDocument } from './unionModel';
import { deriveUnionColumns } from './unionModel';

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

  // Остатки/срезы регистра сведений: хвостовые пустые позиции отбрасываются.
  const positions = [v.period ?? '', v.condition ?? ''];
  let last = positions.length - 1;
  while (last >= 0 && positions[last] === '') last--;
  if (last < 0) return t.fullName;
  return `${t.fullName}(${positions.slice(0, last + 1).join(', ')})`;
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

  const tableLines = model.tables.map((t, i) => {
    const alias = aliases.get(t.id) ?? t.id;
    const comma = i < model.tables.length - 1 ? ',' : '';
    return `\t${renderSource(t)} КАК ${alias}${comma}`;
  });

  const conditionLines = renderConditions(model.conditions, aliases);
  const groupingLines = renderGrouping(model.grouping, aliases);

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

  return [
    'ВЫБРАТЬ' + selectionModifiers(model.selection),
    ...lines,
    ...placeLines,
    'ИЗ',
    ...tableLines,
    ...conditionLines,
    ...groupingLines,
    ...lockLines,
  ].join('\n');
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
      const alias = f.alias ?? `Поле${++exprCounter}`;
      allLines.push(`\t${f.expression} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const func = aggregateFunc(f.tableId, f.path);
    const lhs = func
      ? wrapAggregate(func, `${tableAlias}.${f.path}`)
      : `${tableAlias}.${f.path}`;
    const expr = f.alias ? `${lhs} КАК ${f.alias}` : lhs;
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
      const alias = f.alias ?? `Поле${++exprCounter}`;
      allLines.push(`\t${f.expression} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const expr = f.alias ? `${tableAlias}.${f.path} КАК ${f.alias}` : `${tableAlias}.${f.path}`;
    allLines.push(`\t${expr}`);
  }

  return allLines;
}

/**
 * Выражение элемента выборки для одного поля БЕЗ части `КАК <псевдоним>`:
 * `${псевдонимТаблицы}.${path}` (с обёрткой агрегата, если поле суммируемое),
 * либо сырое `expression` для произвольного поля. Карта псевдонимов
 * вычисляется по `resolveAliases(model.tables)` — ровно та же, что у `generate`.
 * Используется генератором объединений для формирования ячеек колонок.
 */
export function fieldExpr(model: QueryModel, field: SelectedField): string {
  if (field.expression) return field.expression;
  const aliases = resolveAliases(model.tables);
  const tableAlias = aliases.get(field.tableId) ?? field.tableId;
  const func = (model.grouping?.aggregates ?? []).find(
    a => a.tableId === field.tableId && a.path === field.path
  )?.func;
  const lhs = `${tableAlias}.${field.path}`;
  return func ? wrapAggregate(func, lhs) : lhs;
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
  return buildQueryBlock(model, fieldLines, aliases);
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
  return out;
}

/** Рендер поля группировки `Псевдоним.Поле` по той же карте псевдонимов. */
function fieldRefExpr(f: FieldRef, aliases: Map<string, string>): string {
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
 * Секция ГДЕ (условия отбора). Возвращает [] если рендерящихся условий нет —
 * тогда вывод байт-в-байт как раньше. Первое условие на отдельной строке,
 * каждое последующее — с префиксом «И ».
 */
function renderConditions(
  conditions: Condition[] | undefined,
  aliases: Map<string, string>
): string[] {
  if (!conditions || conditions.length === 0) return [];

  const conds: string[] = [];
  for (const c of conditions) {
    if (c.custom) {
      const expr = (c.expression ?? '').trim();
      if (expr) conds.push(expr);
      continue;
    }
    if (!c.path) continue;
    const alias = aliases.get(c.tableId ?? '') ?? c.tableId;
    const param = c.param ?? `&${c.path.split('.').pop()}`;
    conds.push(`${alias}.${c.path} ${c.operator ?? '='} ${param}`);
  }

  if (conds.length === 0) return [];
  return ['ГДЕ', ...conds.map((c, i) => (i === 0 ? `\t${c}` : `\tИ ${c}`))];
}

export function formatAsBslString(text: string): string {
  const lines = text.split('\n');
  const body = lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map(l => `|${l}`).join('\n') : '');
  return `"${body}"`;
}
