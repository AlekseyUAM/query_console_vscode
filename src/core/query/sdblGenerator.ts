import type { QueryModel, SelectedTable, SelectedField, SelectedTabSectionField, AggregateFunction, FieldRef, Condition, Join, Order, Totals, TotalKind, BuilderField, Indexing } from './queryModel';
import { defaultTableAlias, accountingPositionKeys } from './queryModel';
import type { QueryDocument } from './unionModel';
import { deriveUnionColumns } from './unionModel';
import type { BatchDocument } from './batchModel';
import { needsFormatting, isRootNotGroup, formatExpression, formatJoinConjunct, normalizeLeafCase, stripNegatedFieldParens, stripNotFieldParens, stripRedundantLeafParens, appendIsNotNullTrailingSpace, renderOperatorRhs, flattenMultilineLeaf, reindentLeafSubquery, reindentLeafCase, reindentLeafBool, wrapBareCastOperand, reprintLeafArithmetic } from './exprFormatter';

/**
 * Подавление автопсевдонима простых полей при рендере подзапроса оператора `В`
 * (`В (ВЫБРАТЬ …)`). Конструктор 1С не синтезирует `КАК <последний-сегмент>` для
 * полей подзапроса без явного псевдонима (в отличие от запроса верхнего уровня).
 * Флаг выставляется только на время `renderConditionSubquery`; сохраняется/
 * восстанавливается для корректной работы при вложенности.
 */
let suppressAutoAlias = false;

/**
 * Рендер внутри подзапроса правого операнда `В` (`В (ВЫБРАТЬ … ГДЕ …)`).
 * Конструктор 1С печатает условия такого подзапроса по правилам произвольного
 * выражения: `В (&П)` / `В ИЕРАРХИИ (&П)` — С пробелом перед скобкой (MCP-пробы,
 * фаза 6.15.1). Подзапрос-источник (`ИЗ (ВЫБРАТЬ …)`) идёт структурным путём
 * без пробела — там флаг не взводится. Семантика сохранения/восстановления —
 * как у suppressAutoAlias.
 */
let inConditionSubquery = false;

/** Экранирует спецсимволы регулярного выражения в литеральной строке. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  // Раскладка из единого `accountingPositionKeys`. Субконто берём из v.subconto
  // (проставлен пост-разбором по метаданным); если флаг не задан (модель без
  // резолвера/из UI) — прежнее поведение `hasSubconto=true`. Корреспонденция — v.correspondence.
  const hasSubconto = v.subconto !== false;
  const keys = accountingPositionKeys(slice, hasSubconto, v.correspondence === true);
  return keys.map(k => (k ? ((v as Record<string, string | undefined>)[k] ?? '') : ''));
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
  const prevInSubquery = inConditionSubquery;
  suppressAutoAlias = true;
  inConditionSubquery = true;
  let text: string;
  try {
    text = generateDocument(subquery);
  } finally {
    suppressAutoAlias = prev;
    inConditionSubquery = prevInSubquery;
  }
  // Источник подзапроса-операнда с СИНТЕЗИРОВАННЫМ псевдонимом печатается ГОЛЫМ
  // (без `КАК`, см. renderFrom), и конструктор 1С квалифицирует его поля ИМЕНЕМ
  // источника как написано (`ИЗ Справочник.Пользователи` →
  // `Справочник.Пользователи.Ссылка`), а не авто-псевдонимом `defaultTableAlias`
  // (фаза 6.15.NN, MCP). Парсер/генератор уже разметили поля авто-псевдонимом —
  // переписываем `<авто>.` → `<имяИсточника>.` для каждого такого источника.
  // (У одно-сегментных временных таблиц авто-псевдоним совпадает с именем —
  // замена холостая.) Коррелированные/именованные источники не трогаем.
  for (const member of subquery.members) {
    for (const t of member.model.tables) {
      if (!t.aliasSynthesized || t.subquery) continue;
      const auto = defaultTableAlias(t);
      if (auto === t.fullName) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_.])${escapeRegExp(auto)}\\.`, 'gu');
      text = text.replace(re, `$1${t.fullName}.`);
    }
  }
  // Пустые строки-разделители вокруг `ОБЪЕДИНИТЬ ВСЕ` внутри подзапроса-операнда
  // конструктор отбивает на ОДИН таб мельче тела (`baseTabs - 1`), а не на baseTabs
  // (фаза 6.15.19, MCP). Прочие строки получают полный pad.
  const padBlank = '\t'.repeat(Math.max(0, baseTabs - 1));
  const inner = text.split('\n');
  return inner
    .map((l, k) => {
      if (l === '') return padBlank;
      return k === 0 ? `${pad}(${l}` : `${pad}${l}`;
    })
    .join('\n') + ')';
}

function renderSource(t: SelectedTable, bodyTabs = 1): string {
  if (t.subquery) {
    // Тело подзапроса-источника конструктор отбивает по отступу СТРОКИ источника:
    // первая строка инлайн (`(ВЫБРАТЬ`), продолжения — на `bodyTabs` табов. Источник
    // в списке ИЗ стоит на 1 табе (bodyTabs=1, по умолчанию); ПРИСОЕДИНЯЕМЫЙ источник
    // соединения — на 2+depth табах, его тело глубже соответственно (фаза 6.15.19, MCP).
    const inner = generateDocument(t.subquery).split('\n');
    const pad = '\t'.repeat(bodyTabs);
    return inner.map((l, k) => (k === 0 ? '(' + l : pad + l)).join('\n') + ')';
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
    if (!positions.some(p => p !== '') && !v.hadParens) return t.fullName;
    // Составное/подзапросное условие, стоящее ПОСЛЕДНЕЙ позицией, разносит параметры
    // по строкам (как у РН, фаза 6.16.11). Где условие не последнее (Обороты-корр,
    // ДвиженияССубконто) — инлайн.
    const cond = v.condition ?? '';
    if (cond && positions[positions.length - 1] === cond) {
      return renderVirtualParams(t.fullName, positions, cond, bodyTabs);
    }
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
    if (!positions.some(p => p !== '') && !v.hadParens) return t.fullName;
    // Условие (последняя позиция) — составное или подзапрос → конструктор разносит
    // все параметры по строкам (как у Остатки, фаза 6.16.2).
    return renderVirtualParams(t.fullName, positions, v.condition ?? '', bodyTabs);
  }

  // Остатки/срезы регистра сведений и накопления: фиксированная арность (Период, Условие),
  // как у регистра бухгалтерии и по эталону конструктора 1С — хвостовые пустые позиции
  // сохраняются. Скобки — только если задан хоть один параметр.
  const positions = [v.period ?? '', v.condition ?? ''];
  // Скобки опускаем, только если параметров нет И во вводе скобок не было. Пустые
  // скобки `(, )`, явно написанные в источнике, конструктор сохраняет (фаза 6.16.8).
  if (!positions.some(p => p !== '') && !v.hadParens) return t.fullName;
  return renderVirtualParams(t.fullName, positions, v.condition ?? '', bodyTabs);
}

/**
 * Ставит перенос строки перед каждым ВЕРХНЕУРОВНЕВЫМ оператором И/ИЛИ (вне скобок и
 * строк; `И` диапазона `МЕЖДУ a И b` не трогает). Если условие уже многострочное,
 * существующие переносы сохраняются (повторных не добавляем). Используется для
 * разбивки составного условия виртуальной таблицы по конъюнктам.
 */
function splitTopLevelBool(expr: string): string {
  const n = expr.length;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  let depth = 0;
  let inStr = false;
  let betweenPending = 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = expr[i];
    if (inStr) { out += c; if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '(') { depth++; out += c; continue; }
    if (c === ')') { depth--; out += c; continue; }
    if (depth === 0 && !isWordChar(expr[i - 1])) {
      const up = expr.slice(i, i + 6).toUpperCase();
      if (up.startsWith('МЕЖДУ') && !isWordChar(expr[i + 5])) { betweenPending++; out += c; continue; }
      const isIli = up.startsWith('ИЛИ') && !isWordChar(expr[i + 3]);
      const isI = expr[i].toUpperCase() === 'И' && !isWordChar(expr[i + 1]);
      if (isI && betweenPending > 0) { betweenPending--; out += c; continue; }
      if (isIli || isI) {
        // Заменяем предшествующий пробел/перенос на ровно один перенос строки
        // (существующий перенос многострочного ввода не удваиваем).
        out = out.replace(/[ \t\n]*$/u, '') + '\n';
        out += c;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Печатает параметры виртуальной таблицы. Если условие (последний параметр) —
 * СОСТАВНОЕ (есть верхнеуровневый И/ИЛИ), конструктор 1С разбивает все параметры
 * по строкам: `Имя(\n\t\t\tП1,\n\t\t\t<условие>...)` с параметрами на bodyTabs+2,
 * продолжениями условия на bodyTabs+3 (фаза 6.15.20, MCP). Простое (одночленное)
 * условие остаётся инлайн: `Имя(П1, условие)`.
 */
function renderVirtualParams(fullName: string, positions: string[], condition: string, bodyTabs: number): string {
  const hasBool = !!condition && hasTopLevelBooleanOp(condition);
  // Условие-подзапрос (`(поля) В (ВЫБРАТЬ …)`) тоже разносит параметры по строкам,
  // даже без верхнеуровневого И/ИЛИ: конструктор 1С печатает каждый параметр на своей
  // строке, а тело подзапроса перебазирует на base+1 (фаза 6.16, MCP). Признак —
  // многострочное условие (содержит перенос строки от тела `(ВЫБРАТЬ …)`).
  const hasSubquery = !!condition && condition.includes('\n');
  if (!condition || (!hasBool && !hasSubquery)) {
    return `${fullName}(${positions.join(', ')})`;
  }
  const base = bodyTabs + 2;
  const pad = '\t'.repeat(base);
  // Конструктор разбивает СОСТАВНОЕ условие по верхнеуровневым И/ИЛИ (даже если во
  // вводе оно на одной строке): каждый конъюнкт — на отдельной строке, продолжения
  // на base+1. Если входной текст уже многострочный — reindentLeafBool лишь
  // переотбивает отступы. Сперва принудительно ставим переносы перед верхнеуровневыми
  // И/ИЛИ, затем нормализуем отступ. Чистое условие-подзапрос (без И/ИЛИ) — через
  // reindentLeafSubquery: `(ВЫБРАТЬ` встаёт на base+1, тело — на base+2.
  const condText = hasBool
    ? reindentVtCondition(condition.trim(), base)
    : reindentLeafSubquery(condition.trim(), base + 1);
  const condLines = condText.split('\n');
  condLines[0] = pad + condLines[0].replace(/^\t+/u, '');
  // Предшествующие параметры (период и др.) — каждый на своей строке с запятой.
  const head = positions.slice(0, -1).map(p => pad + p);
  return `${fullName}(\n${[...head, condLines.join('\n')].join(',\n')})`;
}

/**
 * Делит условие на ВЕРХНЕУРОВНЕВЫЕ конъюнкты по И/ИЛИ (вне скобок и строк; `И`
 * диапазона `МЕЖДУ a И b` не считается), сохраняя оператор-разделитель. Первый
 * элемент несёт op=''. В отличие от splitTopLevelAnd учитывает и ИЛИ.
 */
function splitTopLevelBoolConjuncts(expr: string): { op: string; text: string }[] {
  const n = expr.length;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  const parts: { op: string; text: string }[] = [];
  let depth = 0, inStr = false, between = 0, start = 0, op = '', caseDepth = 0;
  for (let i = 0; i < n; i++) {
    const c = expr[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0) continue;
    if (!isWordChar(expr[i - 1])) {
      const up = expr.slice(i, i + 6).toUpperCase();
      // ВЫБОР…КОНЕЦ — сбалансированная область: `И`/`ИЛИ` ВНУТРИ CASE (продолжение
      // условия КОГДА или значения ТОГДА) не является границей верхнеуровневого
      // конъюнкта. Без этого учёта `И НЕ …` внутри КОГДА дробит CASE-блок.
      if (up.startsWith('ВЫБОР') && !isWordChar(expr[i + 5])) { caseDepth++; continue; }
      if (up.startsWith('КОНЕЦ') && !isWordChar(expr[i + 5])) { if (caseDepth > 0) caseDepth--; continue; }
      if (caseDepth > 0) continue;
      if (up.startsWith('МЕЖДУ') && !isWordChar(expr[i + 5])) { between++; continue; }
      const isIli = up.startsWith('ИЛИ') && !isWordChar(expr[i + 3]);
      const isI = expr[i].toUpperCase() === 'И' && !isWordChar(expr[i + 1]);
      if (isI && between > 0) { between--; continue; }
      if (isIli || isI) {
        parts.push({ op, text: expr.slice(start, i).trim() });
        op = isIli ? 'ИЛИ' : 'И';
        start = i + (isIli ? 3 : 1);
      }
    }
  }
  parts.push({ op, text: expr.slice(start).trim() });
  return parts;
}

/**
 * СОСТАВНОЕ условие виртуальной таблицы (И/ИЛИ) — фаза 6.16.4. Разбираем
 * поконъюнктно: конъюнкт 0 на base, каждый следующий `И`/`ИЛИ` на base+1. Случаи,
 * на которых пасуют reindentLeafBool (стоп по `ВЫБРАТЬ`) и reindentLeafSubquery
 * (блок подзапроса закрывается до конца из-за хвостовых конъюнктов):
 *   - конъюнкт-подзапрос (`… В (ВЫБРАТЬ …)`): тело подзапроса перебазируется на
 *     base+2 (АБСОЛЮТНО, не зависит от номера конъюнкта — проверено на корпусе);
 *   - многострочный конъюнкт-ИЛИ-группа (`(&A\n ИЛИ B)`): продолжения на ind+1.
 * Простые однострочные конъюнкты дают тот же вывод, что и reindentLeafBool.
 */
function reindentVtCondition(condition: string, base: number): string {
  const conjuncts = splitTopLevelBoolConjuncts(condition);
  const out: string[] = [];
  conjuncts.forEach((c, k) => {
    const ind = k === 0 ? base : base + 1;
    const prefix = k === 0 ? '' : `${c.op} `;
    if (c.text.includes('\n') && /\(ВЫБРАТЬ/u.test(c.text)) {
      const r = reindentLeafSubquery(c.text, base + 2).split('\n');
      r[0] = '\t'.repeat(ind) + prefix + r[0].replace(/^\t+/u, '');
      out.push(...r);
    } else if (c.text.includes('\n') && /(?:^|[^\p{L}\p{N}_])ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(c.text)) {
      // Конъюнкт-ВЫБОР: КОНЕЦ на base+1, КОГДА на base+2 (АБСОЛЮТНО относительно base,
      // не зависит от номера конъюнкта — проверено на корпусе). Строка ВЫБОР (line 0)
      // остаётся на ind конъюнкта.
      const r = reindentLeafCase(c.text, base + 1).split('\n');
      r[0] = '\t'.repeat(ind) + prefix + r[0].replace(/^\t+/u, '').replace(/\s+$/u, '');
      out.push(...r);
    } else if (c.text.includes('\n')) {
      const lines = c.text.split('\n');
      out.push('\t'.repeat(ind) + prefix + lines[0].trim());
      for (let j = 1; j < lines.length; j++) out.push('\t'.repeat(ind + 1) + lines[j].trim());
    } else {
      out.push('\t'.repeat(ind) + prefix + c.text);
    }
  });
  return out.join('\n');
}

/** Модификаторы выборки записей: РАЗРЕШЕННЫЕ → РАЗЛИЧНЫЕ → ПЕРВЫЕ N. */
function selectionModifiers(selection: QueryModel['selection']): string {
  if (!selection) return '';
  let m = '';
  if (selection.allowed) m += ' РАЗРЕШЕННЫЕ';
  if (selection.distinct) m += ' РАЗЛИЧНЫЕ';
  // ПЕРВЫЕ N печатается при заданном неотрицательном top, включая 0
  // (`ВЫБРАТЬ ПЕРВЫЕ 0`): конструктор 1С сохраняет нулевой лимит (MCP). Отсутствие
  // top парсер хранит как undefined; отрицательные значения трактуем как «нет лимита».
  if (typeof selection.top === 'number' && selection.top >= 0) m += ` ПЕРВЫЕ ${selection.top}`;
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
  let betweenPending = 0;
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
    // `И` диапазона `МЕЖДУ a И b` — не булев оператор (фаза 6.15.8).
    if (!isWordChar(expr[i - 1])) {
      const up = expr.slice(i, i + 6).toUpperCase();
      if (up.startsWith('МЕЖДУ') && !isWordChar(expr[i + 5])) { betweenPending++; continue; }
      if (up.startsWith('ИЛИ') && !isWordChar(expr[i + 3])) return true;
      if (expr[i].toUpperCase() === 'И' && !isWordChar(expr[i + 1])) {
        if (betweenPending > 0) { betweenPending--; continue; }
        return true;
      }
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
/**
 * Рендерит ОДИН произвольный ЛИСТОВОЙ конъюнкт условия `ПО` в скобках (фаза 6.13):
 * `(a = &П)`, `(joined.x = seed.y)`, `(функция(...))`. Сложные конъюнкты (ИЛИ/ВЫБОР/
 * подзапрос) сюда не попадают — для них `renderJoinCondition` выбирает legacy-путь.
 */
function renderArbitraryConjunct(expr: string, depth = 0): string {
  // Многострочный лист (`В (\n a,\n b)` и т.п.) конструктор сплющивает в одну
  // строку (правило 6.15.3, для ПО — фаза 6.15.5); стоп-условия (ВЫБРАТЬ/ВЫБОР/
  // И/ИЛИ/`{`) оставляют текст как есть. Лист с подзапросом (`X В\n(ВЫБРАТЬ …)`)
  // перебазируется на base+2 = 4+depth (фаза 6.15.9, MCP).
  return `(${normalizeLeafCase(reindentLeafSubquery(flattenMultilineLeaf(expr.trim()), 4 + depth))})`;
}

/**
 * Рендерит условие `ПО` поконъюнктно из `join.conditions` (фаза 6.13). Первый
 * конъюнкт — на той же строке после `ПО`, последующие — отдельными строками
 * `\t\t\tИ <ci>`. Каждый конъюнкт: стандартный (`seed.поле cmp joined.поле`) без
 * скобок, произвольный простой — в скобках, произвольный сложный (ИЛИ/ВЫБОР/
 * многострочный) — структурной переотрисовкой форматера с той же геометрией, что
 * у legacy-пути (фаза 6.15.5: ворота «сложный конъюнкт → legacy» сняты).
 */
function renderJoinConjuncts(conditions: NonNullable<Join['conditions']>, aliases: Map<string, string>, depth = 0, poOwnLine = false): string {
  const lines: string[] = [];
  // Внутри подзапроса-операнда условия (`В (ВЫБРАТЬ … СОЕДИНЕНИЕ … ПО …)`) конструктор
  // 1С печатает `ПО` на отдельной строке, а условие НИЖЕ с доп. отступом +1: первый
  // конъюнкт на base+1 (3+depth), продолжения `И` на base+2 (4+depth) (фаза 6.15.14,
  // MCP). На верхнем уровне (poOwnLine=false) — прежний layout: cond0 после `ПО `,
  // `И` на 3+depth.
  const cont = poOwnLine ? 4 + depth : 3 + depth;
  // Расщепление вложенной И-цепочки конъюнкта (фаза 6.15.12): источник вида
  // `(a = b) И (c = ЗНАЧЕНИЕ(…) И (d <> ""))` парсер делит лишь по ВНЕШНЕМУ И —
  // второй конъюнкт остаётся И-цепочкой `c = ЗНАЧЕНИЕ(…) И (d <> "")`. Конструктор
  // печатает её как ОТДЕЛЬНЫЕ конъюнкты на одном отступе base+1, каждый
  // нестандартный — в скобках (MCP). Разворачиваем такие конъюнкты в плоский
  // список; пьесы с ИЛИ/ВЫБОР не трогаем (их рендерит структурный путь).
  const expanded = expandAndChainConjuncts(conditions);
  expanded.forEach((c, k) => {
    let sub: string[];
    if (!c.custom) {
      const la = aliases.get(c.leftTableId ?? '') ?? c.leftTableId ?? '';
      const ra = aliases.get(c.rightTableId ?? '') ?? c.rightTableId ?? '';
      const op = c.operator ?? '=';
      sub = [`${la}.${c.leftPath ?? ''} ${op} ${ra}.${c.rightPath ?? ''}`];
    } else if (conjunctNeedsComplexFormat(c)) {
      sub = formatJoinConjunct((c.expression ?? '').trim(), k === 0, 2 + depth).split('\n');
    } else {
      sub = [renderArbitraryConjunct(c.expression ?? '', depth)];
    }
    if (k > 0) sub[0] = `${'\t'.repeat(cont)}И ${sub[0]}`;
    else if (poOwnLine) sub[0] = `${'\t'.repeat(3 + depth)}${sub[0]}`;
    lines.push(...sub);
  });
  return lines.join('\n');
}

/**
 * Делит выражение на конъюнкты по ВЕРХНЕУРОВНЕВОМУ `И` (вне скобок и строк); `И`
 * диапазона `МЕЖДУ a И b` не считается. Возвращает массив подвыражений (trim).
 */
function splitTopLevelAnd(expr: string): string[] {
  const n = expr.length;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let betweenPending = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = expr[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0) continue;
    if (!isWordChar(expr[i - 1])) {
      const up = expr.slice(i, i + 5).toUpperCase();
      if (up.startsWith('МЕЖДУ') && !isWordChar(expr[i + 5])) { betweenPending++; continue; }
      if (expr[i].toUpperCase() === 'И' && !isWordChar(expr[i + 1])) {
        if (betweenPending > 0) { betweenPending--; continue; }
        parts.push(expr.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/** Снимает ровно один полностью охватывающий слой скобок `(…)`, если он есть. */
function stripOneEnclosingParen(expr: string): string {
  const e = expr.trim();
  if (!(e.startsWith('(') && e.endsWith(')'))) return e;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++;
    else if (e[i] === ')') { depth--; if (depth === 0 && i !== e.length - 1) return e; }
  }
  return e.slice(1, -1).trim();
}

/**
 * Разворачивает конъюнкты-И-цепочки в плоский список конъюнктов (фаза 6.15.12).
 * Конъюнкт с верхнеуровневым `И` БЕЗ ИЛИ/ВЫБОР делится по `И`; каждая пьеса
 * освобождается от одного охватывающего слоя скобок (скобки восстановит
 * пер-конъюнктная логика). Конъюнкты с ИЛИ/ВЫБОР и не-custom оставляем как есть.
 */
function expandAndChainConjuncts(conditions: NonNullable<Join['conditions']>): NonNullable<Join['conditions']> {
  const out: NonNullable<Join['conditions']> = [];
  for (const c of conditions) {
    const e = (c.expression ?? '').trim();
    if (c.custom && e && hasTopLevelBooleanOp(e) && !/(^|[^\p{L}\p{N}_])(ИЛИ|ВЫБОР)([^\p{L}\p{N}_]|$)/iu.test(e)) {
      const parts = splitTopLevelAnd(e);
      if (parts.length > 1) {
        for (const p of parts) out.push({ custom: true, expression: stripOneEnclosingParen(p) });
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * Нуждается ли произвольный конъюнкт в МНОГОСТРОЧНОМ форматировании (ИЛИ/ВЫБОР/
 * вложенный подзапрос) — такие рендерятся `formatJoinConjunct` (структурная
 * переотрисовка), простые — однострочным `renderArbitraryConjunct`.
 */
function conjunctNeedsComplexFormat(c: NonNullable<Join['conditions']>[number]): boolean {
  if (!c.custom) return false;
  const e = (c.expression ?? '').trim();
  return hasTopLevelBooleanOp(e) || needsFormatting(e);
}

function renderJoinCondition(join: Join, aliases: Map<string, string>, depth = 0, poOwnLine = false): string {
  // Поконъюнктная модель (фаза 6.13): при наличии conditions[] рендерим из неё —
  // скобки решаются пер-конъюнкт по флагу custom, сложные конъюнкты — форматером
  // по месту (фаза 6.15.5). Legacy-путь ниже остаётся для моделей без conditions[]
  // (построенных вебвью/сторой).
  if (join.conditions && join.conditions.length > 0) {
    return renderJoinConjuncts(join.conditions, aliases, depth, poOwnLine);
  }
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
    const body = wrap ? `(${leaf})` : leaf;
    return poOwnLine ? `${'\t'.repeat(3 + depth)}${body}` : body;
  }
  const leftAlias = aliases.get(join.leftTableId) ?? join.leftTableId;
  const rightAlias = aliases.get(join.rightTableId) ?? join.rightTableId;
  const op = join.operator ?? '=';
  // Простое резолвленное условие конструктор всегда печатает без внешних скобок.
  const simple = `${leftAlias}.${join.leftPath ?? ''} ${op} ${rightAlias}.${join.rightPath ?? ''}`;
  return poOwnLine ? `${'\t'.repeat(3 + depth)}${simple}` : simple;
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
  const sourceLine = (t: SelectedTable, bodyTabs = 1): string => {
    // ВНУТРИ подзапроса-операнда условия (`В (ВЫБРАТЬ … ИЗ ВТ)`) конструктор 1С НЕ
    // печатает `КАК <имя>` для источника с СИНТЕЗИРОВАННЫМ псевдонимом (во вводе не
    // было явного `КАК`/голого псевдонима) — источник остаётся голым (`ИЗ ВТ`).
    // На верхнем уровне конструктор такой `КАК` добавляет (фаза 6.15.11c, MCP).
    if (inConditionSubquery && t.aliasSynthesized && !t.subquery) {
      return renderSource(t, bodyTabs);
    }
    return `${renderSource(t, bodyTabs)} КАК ${aliases.get(t.id) ?? t.id}`;
  };

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

  // Отложенные `ПО` правовложенного дерева (фаза 6.15.8): список joins — преордер
  // с глубиной; `ПО` соединения печатается после непрерывного хвоста соединений
  // БОЛЬШЕЙ глубины (его подцепочки). Для плоской цепочки (все depth 0) стек
  // выталкивается перед каждым следующим соединением — поведение прежнее.
  const pendingPo: Array<{ join: Join; depth: number }> = [];
  const flushPo = (toDepth: number): void => {
    while (pendingPo.length > 0 && pendingPo[pendingPo.length - 1].depth >= toDepth) {
      const p = pendingPo.pop()!;
      // Внутри подзапроса-операнда условия `ПО` печатается на отдельной строке, а
      // условие ниже с отступом (фаза 6.15.14). На верхнем уровне — условие на той
      // же строке после `ПО `.
      const poOwnLine = inConditionSubquery;
      const cond = renderJoinCondition(p.join, aliases, p.depth, poOwnLine);
      if (!cond) continue;
      // Опциональное соединение построителя (фаза 6.15.13) закрывается `}` после
      // условия `ПО`.
      const close = p.join.optional ? '}' : '';
      if (poOwnLine) {
        lines.push(`\t\t${'\t'.repeat(p.depth)}ПО`);
        lines.push(`${cond}${close}`);
      } else {
        lines.push(`\t\t${'\t'.repeat(p.depth)}ПО ${cond}${close}`);
      }
    }
  };

  joins.forEach((join, idx) => {
    // Источники соединения в порядке записи: затравка — левая таблица, присоединяемая —
    // правая. ПРАВОЕ соединение конструктор сохраняет без перестановки. Порядок
    // СЦЕПЛЕНИЯ берём из seedTableId/joinedTableId (текстовый порядок источников),
    // а не из leftTableId/rightTableId (порядок операндов условия) — конструктор 1С
    // сохраняет порядок источников разработчика. Для соединений из UI (без этих
    // полей) — откат к left/rightTableId (фаза 6.12).
    const seedId = join.seedTableId ?? join.leftTableId;
    const joinedId = join.joinedTableId ?? join.rightTableId;
    const depth = join.depth ?? 0;
    const keyword = joinKeyword(join.leftAll, join.rightAll);
    const seed = byId.get(seedId);
    const joined = byId.get(joinedId);
    if (!seed || !joined) return;

    flushPo(depth);
    if (idx === 0 || (depth === 0 && !inChain.has(seedId))) {
      lines.push(`\t${sourceLine(seed)}`);
      inChain.add(seedId);
    }
    inChain.add(seedId);
    // Опциональное соединение построителя (фаза 6.15.13) открывается `{` перед видом
    // соединения; закрывается `}` после условия `ПО` (см. flushPo).
    const open = join.optional ? '{' : '';
    // Присоединяемый источник стоит на отступе 2+depth — тело его подзапроса (если
    // источник — подзапрос) отбивается по этому же отступу (фаза 6.15.19).
    lines.push(`\t\t${'\t'.repeat(depth)}${open}${keyword} СОЕДИНЕНИЕ ${sourceLine(joined, 2 + depth)}`);
    inChain.add(joinedId);
    pendingPo.push({ join, depth });
  });
  flushPo(0);

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
  const isWhere = keyword === 'ГДЕ';
  // Элемент-условие `{ГДЕ}` печатается в скобках (фаза 6.15.7); `.*` при наличии
  // псевдонима конструктор отбрасывает (корпус: КонвертацияОбъектов bsl_5 дроп,
  // СервисКриптографии bsl_3 без псевдонима — сохраняется).
  const render = (f: BuilderField): string =>
    f.condition
      ? `(${f.ref})` + (f.alias ? ' КАК ' + f.alias : '')
      : f.ref + (f.child && !(isWhere && f.alias) ? '.*' : '') + (f.alias ? ' КАК ' + f.alias : '');
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
  // ВНУТРИ подзапроса-операнда условия (`В (ВЫБРАТЬ … СГРУППИРОВАТЬ … ИМЕЮЩИЕ …)`)
  // конструктор такие разделительные пустые строки НЕ ставит (фаза 6.15.11c,
  // MCP-пробы): секции идут вплотную.
  const sectionSep = inConditionSubquery ? [] : [''];
  const groupingInner = renderGrouping(model.grouping, aliases);
  const groupingLines = groupingInner.length ? [...sectionSep, ...groupingInner] : [];
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

/** Выражение — это ТОЛЬКО голый параметр `&Имя` (для отбраковки в группировке). */
function isBareParamExpr(expression: string | undefined): boolean {
  return expression !== undefined && BARE_PARAM.test(expression.trim());
}

/**
 * Источник — табличная часть (ТЧ) объекта (`Справочник.X.ТЧ`, `Документ.X.ТЧ`,
 * …): полное имя из ≥3 сегментов и НЕ виртуальная таблица регистра (та тоже
 * трёхсегментна — `РегистрНакопления.X.Остатки`, но всегда `virtual`). У ТЧ
 * ведущий сегмент пути `Ссылка` — навигация к владельцу, и конструктор 1С
 * отбрасывает его при синтезе автопсевдонима склейкой (фаза 6.16).
 */
function isTabularSectionSource(t: SelectedTable | undefined): boolean {
  if (!t || t.subquery || t.virtual) return false;
  return t.fullName.split('.').length >= 3;
}

/**
 * Автопсевдоним квалифицированного поля `<alias>.<path>` без явного `КАК`.
 * Конструктор 1С склеивает ВСЕ сегменты пути (`Родитель.Имя` → `РодительИмя`),
 * предварительно отбрасывая ведущий `Ссылка` у источника-ТЧ (где `Ссылка` —
 * навигация к владельцу; `Ссылка.Контрагент` → `Контрагент`). У справочника/
 * регистра ведущий `Ссылка` сохраняется (`Ссылка.Наименование` →
 * `СсылкаНаименование`). Голое (неквалифицированное) поле сюда не попадает —
 * ему даётся последний сегмент (курируемый 0043). Фаза 6.16, сверено MCP.
 */
function qualifiedAutoAlias(path: string, tabularSource: boolean): string {
  let segs = path.split('.');
  if (tabularSource && segs.length > 1 && segs[0].toUpperCase() === 'ССЫЛКА') {
    segs = segs.slice(1);
  }
  return segs.join('');
}

/**
 * Синтезированный автопсевдоним простого поля выборки без явного `КАК`, как его
 * ставит конструктор 1С. Квалифицированному полю (`Алиас.Путь`) — склейка
 * сегментов (с отбрасыванием ведущего `Ссылка` у ТЧ), голому — последний сегмент
 * (фаза 6.16). Источник поля определяется по `model.tables`. Единая точка правды
 * для генератора (fieldLine) и выравнивания колонок объединения (unionModel).
 */
export function synthesizedFieldAlias(model: QueryModel, field: SelectedField): string {
  if (field.qualified) {
    const t = model.tables.find(tb => tb.id === field.tableId);
    return qualifiedAutoAlias(field.path, isTabularSectionSource(t));
  }
  return field.path.split('.').pop() ?? field.path;
}

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
  // Резерв для legacy-моделей (UI), где функция агрегата живёт ТОЛЬКО в общем
  // списке, а на полях `func` не задан. Если хотя бы одно поле несёт `func`,
  // считаем модель «новой» (парсерной) и резерв НЕ применяем — иначе плоское поле,
  // делящее операнд с агрегатом, ошибочно подхватывало бы чужую функцию (баг 6.15.11a).
  const fieldsCarryFunc = model.fields.some(f => f.func !== undefined)
    || (model.trailingFields ?? []).some(f => f.func !== undefined);
  const aggregateFunc = (tableId: string, path: string): AggregateFunction | undefined =>
    fieldsCarryFunc ? undefined : aggregates.find(a => a.tableId === tableId && a.path === path)?.func;

  // Счётчик автопсевдонимов произвольных полей. Не проверяет коллизии с явными
  // псевдонимами — допустимо для фазы 4.2 (UI не смешивает их с полями «Поле{n}»).
  let exprCounter = 0;

  const fieldLine = (f: SelectedField): string => {
    if (f.expression) {
      // В подзапросе-операнде `В` (suppressAutoAlias) конструктор НЕ добавляет
      // автопсевдоним произвольному полю выборки (`1`/`ИСТИНА` остаются голыми);
      // явный (НЕ `Поле{n}`) псевдоним сохраняется (фаза 6.15.27, MCP). Парсер уже
      // навесил авто-`Поле{n}` (assignExpressionFieldAliases) — снимаем его здесь.
      if (suppressAutoAlias && (f.alias === undefined || /^Поле\d+$/u.test(f.alias))) {
        return `\t${formatSelectExpression(f.expression)}`;
      }
      const alias = f.alias ?? exprAutoAlias(f.expression, () => `Поле${++exprCounter}`);
      return `\t${formatSelectExpression(f.expression)} КАК ${alias}`;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    // Функция агрегата берётся ПРЯМО с поля (различает два агрегата одного
    // операнда, фаза 6.15.11a); общий список — лишь резерв для старых моделей.
    const func = f.func ?? aggregateFunc(f.tableId, f.path);
    const lhs = func
      ? wrapAggregate(func, `${tableAlias}.${f.path}`)
      : `${tableAlias}.${f.path}`;
    // Автопсевдоним простого поля без явного `КАК` (агрегаты — без автопсевдонима):
    //  • квалифицированное поле (`Алиас.Путь`) — склейка ВСЕХ сегментов пути
    //    (`Родитель.Имя` → `РодительИмя`), с отбрасыванием ведущего `Ссылка` у
    //    источника-ТЧ (см. qualifiedAutoAlias, фаза 6.16, сверено MCP);
    //  • голое поле (квалифицировано единственным источником) — последний сегмент
    //    (`Владелец.Наименование` → `Наименование`, курируемый 0043).
    const autoAlias = !func && !suppressAutoAlias
      ? synthesizedFieldAlias(model, f)
      : undefined;
    const effAlias = f.alias ?? autoAlias;
    return effAlias ? `\t${lhs} КАК ${effAlias}` : `\t${lhs}`;
  };

  // Печать одной строки колонки-выражения проекции ТЧ: формат как поле выборки, но
  // сдвинутый на +1 таб (содержимое проекции глубже на уровень: база 1 → 2). Псевдоним —
  // на последней строке. `comma` — добавляемая запятая (между колонками).
  const tsExprLines = (expression: string, alias: string | undefined, comma: string): string[] => {
    const rows = formatSelectExpression(expression).split('\n');
    const shifted = rows.map((l, j) => (j === 0 ? '\t\t' + l : '\t' + l));
    const tail = alias !== undefined ? ' КАК ' + alias : '';
    shifted[shifted.length - 1] = shifted[shifted.length - 1] + tail + comma;
    return shifted;
  };

  const tsLine = (tsf: SelectedTabSectionField): string => {
    const tableAlias = aliases.get(tsf.tableId) ?? tsf.tableId;
    let subLines: string[];
    if (tsf.columns && tsf.columns.length > 0) {
      // Смешанная проекция ТЧ (простые поля + произвольные выражения, в исходном
      // порядке). Простая колонка — голая (`<поле> КАК <псевдоним>`); выражение —
      // через formatSelectExpression с переквалификацией (выполнена парсером).
      subLines = tsf.columns.flatMap((c, i) => {
        const comma = i < tsf.columns!.length - 1 ? ',' : '';
        if (c.kind === 'field') {
          const colAlias = c.alias ?? c.field;
          return [`\t\t${c.field} КАК ${colAlias}${comma}`];
        }
        return tsExprLines(c.expression, c.alias, comma);
      });
    } else if (tsf.exprFields && tsf.exprFields.length > 0) {
      // Проекция ТЧ из произвольных выражений (агрегат над колонкой ТЧ, фаза 6.15.26).
      // Каждое выражение печатается как поле выборки, сдвинутое на +2 таба (содержимое
      // проекции глубже на 1 уровень от обычного поля = 1 таб → база 2), с синтетическим
      // псевдонимом `Поле{n}`. Запятая между элементами.
      subLines = tsf.exprFields.flatMap((ef, i) => {
        // formatSelectExpression выдаёт ПЕРВУЮ строку без отступа (вызывающий добавляет
        // 1 таб поля), продолжения — абсолютно из расчёта база первой строки = 1.
        // В проекции ТЧ база содержимого = 2: первой строке даём 2 таба, каждому
        // продолжению — +1 таб относительно его абсолютной позиции (rebase 1 → 2).
        const rows = formatSelectExpression(ef.expression).split('\n');
        const shifted = rows.map((l, j) => (j === 0 ? '\t\t' + l : '\t' + l));
        const comma = i < tsf.exprFields!.length - 1 ? ',' : '';
        shifted[shifted.length - 1] = shifted[shifted.length - 1] + ' КАК ' + ef.alias + comma;
        return shifted;
      });
    } else {
      subLines = tsf.fields.map((f, i) => {
        // Псевдоним колонки: отличный — печатаем как есть, иначе авто `<поле> КАК <поле>`.
        const colAlias = tsf.fieldAliases?.[i] ?? f;
        return `\t\t${f} КАК ${colAlias}${i < tsf.fields.length - 1 ? ',' : ''}`;
      });
    }
    return `\t${tableAlias}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t) КАК ${tsf.alias ?? tsf.tsName}`;
  };

  // Поля до первой ТЧ (`model.fields`) — всегда первыми и в своём порядке.
  const headLines = model.fields.map(fieldLine);

  // Остальные элементы (проекции ТЧ + поля после них) конструктор печатает в
  // ИСХОДНОМ порядке выборки (selectOrder, фаза 6.15.20): проекция ТЧ, стоящая
  // ПОСЛЕ скалярных полей, остаётся на своём месте, а не всплывает в общий блок ТЧ.
  // Старые (UI) модели без selectOrder сохраняют прежний порядок: все ТЧ, затем
  // хвостовые поля.
  type Item = { order: number | undefined; seq: number; render: () => string };
  const rest: Item[] = [];
  let seq = 0;
  for (const tsf of model.tabSectionFields ?? []) {
    rest.push({ order: tsf.selectOrder, seq: seq++, render: () => tsLine(tsf) });
  }
  for (const f of model.trailingFields ?? []) {
    rest.push({ order: f.selectOrder, seq: seq++, render: () => fieldLine(f) });
  }
  // Перемежение по selectOrder применяем ТОЛЬКО когда он задан у ВСЕХ элементов
  // (чистая парсерная модель). Если хоть у одного нет — это UI-модель или результат
  // развёртки звезды (которая формирует собственный порядок); сохраняем прежний
  // бакет-порядок: все ТЧ, затем хвостовые поля (фаза 6.15.20).
  if (rest.every(it => it.order !== undefined)) {
    rest.sort((a, b) => (a.order! - b.order!) || (a.seq - b.seq));
  }

  return [...headLines, ...rest.map(it => it.render())];
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
    // Квирк `… ЕСТЬ НЕ NULL ` (хвостовой пробел) действует и в слоте выборки: при
    // наличии `КАК <псевдоним>` это даёт двойной пробел `NULL  КАК` (как конструктор).
    // Многострочный лист (разбитый разработчиком вызов функции) конструктор
    // печатает одной строкой — сплющиваем до нормализации (фаза 6.15.3).
    // Лист-подзапрос (`ИСТИНА В\n(ВЫБРАТЬ …)`) перебазируется на отступ 2 (= 1+1,
    // фаза 6.15.9, MCP).
    // Вложенный в лист ВЫБОР (`СУММА(ВЫБОР …)`, `… - ВЫБОР …`) переотрисовывается
    // конструктором по глубине обрамляющих скобок: КОНЕЦ на (отступ поля = 1) +
    // число НЕзакрытых скобок перед ВЫБОР (фаза 6.15.9b, MCP).
    // Арифметика листа выборки переотрисовывается конструктором (пробелы вокруг
    // `+ - * /`, скобки по приоритету, обёртка ВЫРАЗИТЬ-операнда) — фаза 6.15.11a.
    // Плоская И/ИЛИ-цепочка поля (`X\n\t\t\tИ Y`) — продолжения на отступ 1+1
    // (фаза 6.15.19, reindentLeafBool); needsFormatting=false (нет OR/CASE), поэтому
    // булев принтер её не трогает.
    // Избыточные скобки вокруг всего листового поля (`(Поле ЕСТЬ NULL) КАК Алиас` →
    // `Поле ЕСТЬ NULL КАК Алиас`, `(Поле)` → `Поле`) конструктор снимает — как оракул.
    : appendIsNotNullTrailingSpace(normalizeLeafCase(reprintLeafArithmetic(reindentLeafBool(reindentLeafCase(reindentLeafSubquery(stripRedundantLeafParens(flattenMultilineLeaf(expression)), 2), 1), 1))));
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
  // Функция агрегата берётся ПРЯМО с поля. Общий список `grouping.aggregates` —
  // лишь резерв для legacy-моделей (UI), где `func` на полях не задан. Если хотя бы
  // одно поле модели несёт `func`, модель «новая» (парсерная) и резерв не применяем,
  // иначе плоское поле, делящее операнд с агрегатом (`КОЛИЧЕСТВО(Ответ)` в одной
  // ветке union и плоский `Ответ` в другой), ошибочно подхватывало бы чужую функцию
  // (тот же баг, что и 6.15.11a в `buildFieldLines`; здесь — для ветки объединения).
  const fieldsCarryFunc = model.fields.some(f => f.func !== undefined)
    || (model.trailingFields ?? []).some(f => f.func !== undefined);
  const func = field.func ?? (fieldsCarryFunc ? undefined : (model.grouping?.aggregates ?? []).find(
    a => a.tableId === field.tableId && a.path === field.path
  )?.func);
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
 * Текст ссылки поля секции (УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКС) БЕЗ флага qualified:
 * поле, входящее в выборку, адресуется псевдонимом выборки (`selectAliasFor`);
 * поле НЕ из выборки конструктор 1С печатает квалифицированно
 * `<псевдонимТаблицы>.<path>` (MCP, фаза 6.15.4). Нерезолвимая таблица —
 * прежний фолбэк по последнему сегменту пути. `tableAliases` — готовая карта
 * `resolveAliases(model.tables)` вызывающей секции (не пересчитываем на поле).
 */
function sectionFieldRefText(
  model: QueryModel,
  tableAliases: Map<string, string>,
  tableId: string,
  path: string
): string {
  const match = model.fields.find(f => f.tableId === tableId && f.path === path);
  if (match) return match.alias ?? (path.split('.').pop() ?? path);
  const alias = tableAliases.get(tableId);
  return alias !== undefined ? `${alias}.${path}` : (path.split('.').pop() ?? path);
}

/**
 * Секция УПОРЯДОЧИТЬ ПО (+ строка АВТОУПОРЯДОЧИВАНИЕ при `order.auto`). Без ведущей
 * пустой строки. Возвращает [] если порядок неактивен (нет полей и нет авто) —
 * тогда вывод байт-в-байт как раньше. Поле = `<псевдоним выборки>` + ` УБЫВ` при
 * `direction==='desc'`; запятая после всех, кроме последнего. При `auto` без полей
 * секция = только `['АВТОУПОРЯДОЧИВАНИЕ']`.
 */
function renderOrder(order: Order | undefined, model: QueryModel, includeAuto = true): string[] {
  if (!order) return [];
  const lines: string[] = [];
  if (order.fields.length > 0) {
    // Квалифицированные поля адресуются как `<псевдонимТаблицы>.<path>` (ссылка на поле
    // таблицы, как у конструктора 1С); прочие — по псевдониму выборки.
    const tableAliases = resolveAliases(model.tables);
    lines.push('УПОРЯДОЧИТЬ ПО');
    order.fields.forEach((f, i) => {
      const ref = f.expression
        // Параметр `&Имя` — дословно; вызов функции/арифметика — через нормализацию
        // выражений выборки (пробелы, скобки, регистр), как печатает конструктор 1С.
        ? (f.expression.trim().startsWith('&') ? f.expression : formatSelectExpression(f.expression))
        : f.qualified
        ? `${tableAliases.get(f.tableId) ?? f.tableId}.${f.path}`
        : sectionFieldRefText(model, tableAliases, f.tableId, f.path);
      // `ИЕРАРХИЯ` после поля упорядочивания конструктор 1С выводит ТОЛЬКО когда
      // поле — иерархическая ссылка (по схеме метаданных, недоступной здесь): для
      // стандартного поля `Ссылка` сохраняет (оно всегда ссылочное в иерархических
      // справочниках), для `Наименование`/`ЭтоГруппа`/`Элемент` — убирает. Прочие
      // имена (`Группа`↔`Элемент`) текстом не различимы, но в корпусе все KEEP-случаи
      // адресуются именно `…Ссылка`, поэтому ограничиваемся этим признаком. R3, 6.8.
      // Для источника БЕЗ метаданных (таблица-параметр `&Имя`, временная таблица,
      // подзапрос) конструктор отбрасывает ИЕРАРХИЯ даже у `…Ссылка` (MCP, 6.15.4).
      const lastSeg = f.path.split('.').pop();
      const ownerTable = model.tables.find(t => t.id === f.tableId);
      const metadataTable = ownerTable !== undefined && !ownerTable.subquery && ownerTable.fullName.includes('.');
      // Конструктор сохраняет ИЕРАРХИЯ, если источник — ИЕРАРХИЧЕСКИЙ справочник/ПВХ
      // (по метаданным, фаза 6.16.6): тогда ИЕРАРХИЯ держится на ЛЮБОМ поле
      // (Родитель/Наименование/…), а не только на `…Ссылка`. Прежний признак
      // `lastSeg === 'Ссылка'` оставлен как фолбэк для случаев без флага hierarchical.
      const hierKeep = metadataTable && (ownerTable!.hierarchical || lastSeg === 'Ссылка');
      const hierSuffix = f.hierarchy && hierKeep ? ' ИЕРАРХИЯ' : '';
      const suffix = (f.direction === 'desc' ? ' УБЫВ' : '') + hierSuffix;
      const comma = i < order.fields.length - 1 ? ',' : '';
      lines.push(`\t${ref}${suffix}${comma}`);
    });
  }
  if (order.auto && includeAuto) lines.push('АВТОУПОРЯДОЧИВАНИЕ');
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

  const tableAliases = resolveAliases(model.tables);
  const byList: string[] = [];
  if (totals.grand) byList.push('ОБЩИЕ');
  for (const g of totals.groupFields) {
    const alias = g.qualified
      ? `${tableAliases.get(g.tableId) ?? g.tableId}.${g.path}`
      : sectionFieldRefText(model, tableAliases, g.tableId, g.path);
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

  const tableAliases = resolveAliases(model.tables);
  const aliasOf = (f: FieldRef): string =>
    f.expression
      ? f.expression
      : f.qualified
      ? `${tableAliases.get(f.tableId) ?? f.tableId}.${f.path}`
      : sectionFieldRefText(model, tableAliases, f.tableId, f.path);

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

  // Запрос без источника (`ВЫБРАТЬ <конст/параметр> КАК Поле [ПОМЕСТИТЬ ВТ]`) —
  // допустим в 1С (создание ВТ из констант/параметров), buildQueryBlock не выводит
  // секцию ИЗ. Пусто только когда нет ни таблиц, ни полей.
  const hasFields = model.fields.length > 0 || (model.tabSectionFields?.length ?? 0) > 0;
  if (model.tables.length === 0 && !hasFields) return '';
  if (!hasFields) return '';

  const aliases = resolveAliases(model.tables);
  const fieldLines = buildFieldLines(model, aliases);
  let out = buildQueryBlock(model, fieldLines, aliases);
  const orderLines = renderOrder(model.order, model, false);
  if (orderLines.length > 0) out += '\n\n' + orderLines.join('\n');
  const totalsLines = renderTotals(model.totals, model);
  if (totalsLines.length > 0) out += '\n' + totalsLines.join('\n');
  const indexLines = renderIndex(model.indexing, model);
  if (indexLines.length > 0) out += '\n\n' + indexLines.join('\n');
  out += renderAutoOrder(model.order, orderLines.length > 0 || totalsLines.length > 0 || indexLines.length > 0);
  return out;
}

/**
 * АВТОУПОРЯДОЧИВАНИЕ — ПОСЛЕДНЯЯ строка запроса (после ИТОГИ/ИНДЕКС, фаза 6.16.9).
 * Если перед ним была секция (порядок-поля/ИТОГИ/индекс) — отбивка одним `\n`;
 * если auto единственное — двумя `\n` от тела (как раньше для order-only-auto).
 */
function renderAutoOrder(order: Order | undefined, hadSection: boolean): string {
  if (!order?.auto) return '';
  return (hadSection ? '\n' : '\n\n') + 'АВТОУПОРЯДОЧИВАНИЕ';
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

  // Внутри подзапроса-условия (`В (ВЫБРАТЬ … ОБЪЕДИНИТЬ …)`) конструктор НЕ
  // добавляет авто-псевдоним полю участника 0 (как и в не-union В-подзапросе,
  // suppressAutoAlias); ЯВНЫЙ псевдоним при этом сохраняется (MCP validate_query).
  const head0 = members[0]?.model.fields ?? [];
  const blocks = members.map((m, i) => {
    const fieldLines = columns.map((col, ci) => {
      const expr = col.cells[i] ?? 'NULL';
      if (i !== 0) return `\t${expr}`;
      // Авто-`Поле{n}` (assignExpressionFieldAliases) явным НЕ считается: в
      // suppressAutoAlias его не печатаем (`1`/`ИСТИНА` остаются голыми, фаза 6.15.27).
      const a0 = head0[ci]?.alias;
      const explicitAlias = a0 !== undefined && !/^Поле\d+$/u.test(a0);
      const emitAlias = !suppressAutoAlias || explicitAlias;
      return emitAlias ? `\t${expr} КАК ${col.alias}` : `\t${expr}`;
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
  // Ссылки секций резолвятся парсером по ПЕРВОМУ участнику (его псевдонимы выборки
  // и источники, фаза 6.15.4) — рендер использует его же поля/таблицы.
  const last = members[members.length - 1].model;
  const first = members[0].model;
  const orderLines = renderOrder(last.order, first, false);
  if (orderLines.length > 0) out += '\n\n' + orderLines.join('\n');
  const totalsLines = renderTotals(last.totals, first);
  if (totalsLines.length > 0) out += '\n' + totalsLines.join('\n');
  let indexEmitted = false;
  const tempCarrier = members.find(m => m.model.queryType === 'createTemp')?.model;
  if (last.indexing && tempCarrier) {
    const indexLines = renderIndex(last.indexing, { ...tempCarrier, fields: first.fields, tables: first.tables });
    if (indexLines.length > 0) { out += '\n\n' + indexLines.join('\n'); indexEmitted = true; }
  }
  out += renderAutoOrder(last.order, orderLines.length > 0 || totalsLines.length > 0 || indexEmitted);
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
    // Голый параметр `&Имя` в списке группировки конструктор 1С отбрасывает
    // (нельзя группировать по параметру) — фаза 6.15.11a, MCP. Удаляем такие
    // элементы; прочие выражения с параметром внутри (`ВЫРАЗИТЬ(… &Имя …)`) остаются.
    const fields = grouping.groupFields.filter(f => !isBareParamExpr(f.expression));
    if (fields.length === 0) return [];
    const lines = fields.map((f, i) => {
      const comma = i < fields.length - 1 ? ',' : '';
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
/** Строки отдельных условий (без ключевого слова секции и префиксов `И`). */
function buildConditionStrings(
  conditions: Condition[] | undefined,
  aliases: Map<string, string>,
  slot: 'where' | 'having' = 'where'
): string[] {
  if (!conditions || conditions.length === 0) return [];
  const conds: string[] = [];
  for (const c of conditions) {
    // Произвольное условие с текстом выражения. Условие-подзапрос (`В (ВЫБРАТЬ …)`)
    // помечено custom (мышкой не задать, фаза 6.14.4), но БЕЗ expression — оно
    // рендерится структурным путём ниже (многострочный перенос подзапроса);
    // заданное пользователем expression имеет приоритет.
    if (c.custom && ((c.expression ?? '').trim() || !c.subquery)) {
      const expr = (c.expression ?? '').trim();
      // ГДЕ/ИМЕЮЩИЕ: конструктор снимает скобки вокруг отрицания одиночного поля
      // (`(НЕ Алиас.Поле)` → `НЕ Алиас.Поле`); для остального — как раньше.
      // НЕ-блок (`НЕ (a И b)`) переотрисовывается даже без ИЛИ внутри (фаза 6.14).
      // Подзапрос в листе (`X В\n(ВЫБРАТЬ …)`) перебазируется на контекстный отступ
      // (фаза 6.15.9, MCP): корневое ГДЕ — 3 (= 1+2), условия внутри В-подзапроса
      // и ИМЕЮЩИЕ — 2 (= 1+1); ведущие НЕ листа добавляют +1 (внутри хелпера).
      const subBase = slot === 'where' && !inConditionSubquery ? 3 : 2;
      // Голый операнд-приведение ВЫРАЗИТЬ(…) в сравнении — в скобках (фаза 6.15.12).
      // Снятие избыточных скобок предиката в ГДЕ/ИМЕЮЩИЕ (как оракул): `НЕ (X В (…))`
      // → `НЕ X В (…)`, `(X ЕСТЬ NULL)` → `X ЕСТЬ NULL` (ПО — отдельный путь, скобки
      // там сохраняются). Применяем к простому листовому условию (без formatExpression).
      if (expr) conds.push(needsFormatting(expr) || isRootNotGroup(expr) ? formatExpression(expr, slot, inConditionSubquery ? 1 : undefined) : appendIsNotNullTrailingSpace(stripNotFieldParens(stripNegatedFieldParens(wrapBareCastOperand(stripRedundantLeafParens(normalizeLeafCase(reindentLeafCase(reindentLeafSubquery(flattenMultilineLeaf(expr), subBase), 1))))))));
      continue;
    }
    // Нессылочный левый операнд `В`-подзапроса (`1 В (ВЫБРАТЬ …)`, фаза 6.15.27):
    // печатаем сам текст LHS перед `В`, дальше — структурный подзапрос как обычно.
    // path при этом не задан; обрабатываем до гейта `!c.path`.
    if (c.leftExpr && c.subquery) {
      const subBase = (inConditionSubquery ? 2 : 3) + (c.negated ? 1 : 0);
      const negPrefix = c.negated ? 'НЕ ' : '';
      conds.push(`${negPrefix}${normalizeLeafCase(c.leftExpr)} В\n${renderConditionSubquery(c.subquery, subBase)}`);
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
      // `В ИЕРАРХИИ (ВЫБРАТЬ …)` — модификатор ИЕРАРХИИ перед переносом подзапроса
      // (фаза 6.15.NN). Внутри подзапроса-условия отступ блока на 1 меньше.
      // Ведущее `НЕ` (negated) сдвигает блок подзапроса на +1 (геометрия 1С).
      const opText = c.hierarchy ? `${op} ИЕРАРХИИ` : op;
      const negPrefix = c.negated ? 'НЕ ' : '';
      const subBase = (inConditionSubquery ? 2 : 3) + (c.negated ? 1 : 0);
      conds.push(`${negPrefix}${alias}.${c.path} ${opText}\n${renderConditionSubquery(c.subquery, subBase)}`);
      continue;
    }
    const param = normalizeLeafCase(c.param ?? `&${c.path.split('.').pop()}`);
    conds.push(`${alias}.${c.path} ${renderOperatorRhs(op, param, inConditionSubquery)}`);
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
 * форматирует условия как ГДЕ, НО разделитель списка — ЗАВЕРШАЮЩЕЕ ` И` в конце
 * последней строки условия, а не префикс `И ` следующего (фаза 6.14, MCP):
 *   `КОЛИЧЕСТВО(…) > 1 И\n\t&Параметр`. После `ЕСТЬ НЕ NULL ` (с хвостовым
 * пробелом) получается двойной пробел перед И — так печатает и конструктор.
 * Возвращает [] если условий нет.
 */
function renderHaving(
  having: Condition[] | undefined,
  aliases: Map<string, string>
): string[] {
  const conds = buildConditionStrings(having, aliases, 'having');
  if (conds.length === 0) return [];
  // Разделительная пустая строка перед ИМЕЮЩИЕ — только на верхнем уровне; внутри
  // подзапроса-операдна условия конструктор её не ставит (фаза 6.15.11c, MCP).
  const sep = inConditionSubquery ? [] : [''];
  return [...sep, 'ИМЕЮЩИЕ', ...conds.map((c, i) => `\t${c}${i < conds.length - 1 ? ' И' : ''}`)];
}

export function formatAsBslString(text: string): string {
  const lines = text.split('\n');
  const body = lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map(l => `|${l}`).join('\n') : '');
  return `"${body}"`;
}
