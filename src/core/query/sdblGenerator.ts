import type { QueryModel, SelectedTable, SelectedField, SelectedTabSectionField, AggregateFunction, FieldRef, Condition, Join, Order, Totals, TotalKind, BuilderField, Indexing } from './queryModel';
import { defaultTableAlias, accountingPositionKeys } from './queryModel';
import type { QueryDocument } from './unionModel';
import { deriveUnionColumns, unionHasTabSection, unionHasTrailing, orderedSelectElements, elementAlias, type UnionMember } from './unionModel';
import type { BatchDocument } from './batchModel';
import { parseDocument } from './sdblParser';
import { needsFormatting, selectColumnNeedsBoolWrap, isRootNotGroup, formatExpression, formatJoinConjunct, normalizeLeafCase, stripNegatedFieldParens, stripNotFieldParens, stripRedundantLeafParens, appendIsNotNullTrailingSpace, renderOperatorRhs, flattenMultilineLeaf, reindentLeafSubquery, reindentLeafCase, reindentLeafBool, wrapBareCastOperand, reprintLeafArithmetic, canonicalizeComparisonOperands, setInlineSubqueryReflow, tightenLeafInOperator } from './exprFormatter';
import { tokenize } from './sdblLexer';

// Регистрируем в exprFormatter канонический ре-рендер инлайн-подзапроса членства
// (`Поле В (ВЫБРАТЬ …)` в листе ГДЕ/ПО/ИМЕЮЩИЕ): exprFormatter не может импортировать
// генератор (цикл), поэтому передаём реализацию через хук. Лист печатается без отступа
// строки 0 (его добавит булев принтер), `(ВЫБРАТЬ` — на subBase. Фаза 6.16.
setInlineSubqueryReflow((text, subBase) => reflowInlineMembershipSubquery(text, 0, subBase, ''));

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
function renderConditionSubquery(subquery: QueryDocument, baseTabs: number, leadingNot = false): string {
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
  // (фаза 6.15.19, MCP). Ведущее `НЕ` подзапроса (`И НЕ Поле В (…)`) дало baseTabs
  // лишний +1 на ВСЁ тело — но разделитель объединения этот +1 НЕ перенимает, поэтому
  // при negated он на `baseTabs - 2` (MCP-проба `И НЕ Поле В (ВЫБРАТЬ … ОБЪЕДИНИТЬ …)`,
  // фаза 6.16). Прочие строки получают полный pad.
  const padBlank = '\t'.repeat(Math.max(0, baseTabs - 1 - (leadingNot ? 1 : 0)));
  // generateDocument ставит пустую строку-разделитель перед УПОРЯДОЧИТЬ/ИТОГИ всего
  // объединения (`\n\n`), но ВНУТРИ подзапроса-операнда `В` конструктор такие
  // НЕ-союзные пустые строки убирает (MCP-проба `В (ВЫБРАТЬ … ГДЕ …\n\nУПОРЯДОЧИТЬ …)`
  // → пустой строки нет). Сохраняем только разделители, СОСЕДНИЕ с `ОБЪЕДИНИТЬ`
  // (объединение участников), прочие пустые строки удаляем (фаза 6.16).
  const isUKw = (s: string): boolean => /^\t*ОБЪЕДИНИТЬ(?:\s+ВСЕ)?\s*$/u.test(s.trim());
  const raw = text.split('\n');
  const inner = raw.filter((l, k) => {
    if (l.trim() !== '') return true;
    const prevKw = k > 0 && isUKw(raw[k - 1]);
    const nextKw = k + 1 < raw.length && isUKw(raw[k + 1]);
    return prevKw || nextKw;
  });
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

  // Критерий отбора `КритерийОтбора.<Имя>(<значение>)` — параметризованный источник с
  // ОДНИМ аргументом-значением, без слота условия. Обобщённая ветка ниже навязала бы
  // ему арность (период, условие) с хвостовым пустым параметром (`(&Клиент, )`);
  // конструктор 1С печатает ровно один аргумент (`(&Клиент)`). Скобки опускаем, только
  // если аргумента нет и во вводе скобок не было.
  if (kind === 'КритерийОтбора') {
    if ((v.period ?? '') === '' && !v.hadParens) return t.fullName;
    return `${t.fullName}(${v.period ? normalizeLeafCase(v.period) : ''})`;
  }

  // Регистр бухгалтерии: фиксированная арность, хвостовые пустые позиции сохраняются,
  // скобки — только если задан хоть один параметр.
  if (kind === 'РегистрБухгалтерии') {
    let positions = accountingPositions(slice, v);
    if (!positions.some(p => p !== '') && !v.hadParens) return t.fullName;
    // Автопсевдоним `Поле<2k>` для выражений в DCS-скобках `{(…)}` (как в renderVirtualParams).
    const dcsStateAcc = { k: 0 };
    positions = positions.map(p => (p ? aliasDcsBraceExprs(wrapDcsBraceParam(p), dcsStateAcc) : p));
    // Конструктор 1С разносит вызов виртуальной таблицы регистра бухгалтерии по
    // строкам, когда хотя бы одна позиция — СОСТАВНОЕ выражение (верхнеуровневый И/ИЛИ)
    // или многострочный подзапрос: каждый позиционный параметр (включая пустые и
    // хвостовые после условия) на отдельной строке (фаза 6.16.70). Условие может стоять
    // НЕ последней позицией (Обороты-корр), поэтому реиндентируем КАЖДУЮ составную
    // позицию, а не только последнюю. Простые параметры (период, ровные условия `=`/`В`)
    // остаются инлайн.
    const multiline = positions.some(p => p && (hasTopLevelBooleanOp(p) || (p.includes('\n') && /\(ВЫБРАТЬ/u.test(p))));
    if (multiline) {
      return renderAccountingParams(t.fullName, positions, v.condition ?? '', bodyTabs);
    }
    return `${t.fullName}(${positions.map(p => (p ? normalizeLeafCase(p) : p)).join(', ')})`;
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
/**
 * DCS-параметр виртуальной таблицы в фигурных скобках (`{<выражение>}`) конструктор 1С
 * печатает с обязательной ВНУТРЕННЕЙ парой скобок: `{&НачПериода}` → `{(&НачПериода)}`.
 * Оборачиваем содержимое скобок в `(…)`, только когда оно — ОДИНОЧНОЕ ГОЛОЕ выражение-
 * параметр (`&Имя`): без уже имеющейся охватывающей пары скобок, без верхнеуровневой
 * запятой (не список полей DCS `{поле1, поле2}`) и без псевдонима `КАК`. Уже
 * обёрнутое `{(…)}` (в т.ч. `{(…) КАК Поле2}`) не трогаем — синтез алиаса вне нашей
 * задачи. Узкий гейт: содержимое начинается с `&`. Фаза 6.16.79.
 */
function wrapDcsBraceParam(text: string): string {
  if (!text.includes('{')) return text;
  return text.replace(/\{([^{}]*)\}/gu, (whole, inner: string) => {
    const c = inner.trim();
    if (!c.startsWith('&')) return whole;
    if (c.startsWith('(')) return whole;
    // Верхнеуровневая запятая или `КАК` → не одиночный параметр, не трогаем.
    if (hasTopLevelComma(c) || /(^|[^\p{L}\p{N}_])КАК([^\p{L}\p{N}_]|$)/iu.test(c)) return whole;
    return `{(${c})}`;
  });
}

/**
 * Содержимое DCS-фигурного параметра ВТ (`{(<выражение>)}`) — выражение (не голый
 * параметр `&Имя` и не список полей с запятой) — конструктор 1С снабжает
 * автопсевдонимом `Поле<2k>`, где k — порядковый номер ИМЕНУЕМОГО выражения-скобки
 * (1-based) среди всех `{…}`-параметров вызова ВТ; голые `{(&Имя)}` не нумеруются и
 * счётчик не двигают (сверено живым оракулом validate_query). Применяется к каждой
 * позиции/условию ВТ с общим счётчиком `state` через все позиции вызова.
 */
function aliasDcsBraceExprs(text: string, state: { k: number }): string {
  if (!text.includes('{')) return text;
  return text.replace(/\{([^{}]*)\}/gu, (whole, inner: string) => {
    const c = inner.trim();
    // Уже с псевдонимом — не трогаем (но всё равно считаем выражением-слотом).
    if (/(^|[^\p{L}\p{N}_])КАК([^\p{L}\p{N}_]|$)/iu.test(c)) { state.k += 1; return whole; }
    // Должна быть одиночная охватывающая пара скобок `( … )`.
    if (!c.startsWith('(') || !c.endsWith(')')) return whole;
    // Внутреннее содержимое.
    const innerExpr = c.slice(1, -1).trim();
    // Голый параметр `&Имя` — не нумеруется.
    if (/^&[\p{L}\p{N}_]+$/u.test(innerExpr)) return whole;
    // Список полей DCS (верхнеуровневая запятая) — не наш случай.
    if (hasTopLevelComma(c)) return whole;
    state.k += 1;
    return `{${c} КАК Поле${2 * state.k}}`;
  });
}

/**
 * DCS-секция параметра ВТ может состоять из НЕСКОЛЬКИХ соседних фигурных скобок
 * (`{(Ном).* КАК Ном} {(Хар).* КАК Хар} …`) — конструктор 1С СКЛЕИВАЕТ их в ОДНУ
 * пару `{a, b, …}`, перечисляя содержимое через запятую и сплющивая внутренние
 * переносы/отступы в один пробел (корпус ТоварныйОтчетТОРГ29). Одиночную `{…}`-скобку
 * НЕ трогаем (её внутренний перенос конструктор сохраняет дословно — корпус
 * ОстаткиИОборотыРезервов). Гейт: строка содержит ≥2 верхнеуровневых `{…}` подряд.
 * Фаза 6.16.
 */
function mergeDcsBraces(text: string): string {
  if (!text.includes('{')) return text;
  const inners: string[] = [];
  let i = 0, count = 0;
  const n = text.length;
  // Между скобками допускаются только пробелы/переносы; иначе это не чистая DCS-секция.
  while (i < n) {
    const c = text[i];
    if (c === '{') {
      let depth = 0, j = i;
      for (; j < n; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
      }
      if (j >= n) return text; // несбалансированная — не трогаем
      inners.push(text.slice(i + 1, j).replace(/\s+/gu, ' ').trim());
      count++;
      i = j + 1;
      continue;
    }
    if (/\s/u.test(c)) { i++; continue; }
    return text; // непробельный символ вне скобок — не чистая DCS-секция
  }
  if (count < 2) return text;
  return `{${inners.join(', ')}}`;
}

function renderVirtualParams(fullName: string, positions: string[], condition: string, bodyTabs: number): string {
  // Регистровая нормализация параметров виртуальной таблицы (период, условие):
  // конструктор приводит зарезервированные слова/функции/литералы к ВЕРХНЕМУ
  // регистру и здесь (`Значение(` → `ЗНАЧЕНИЕ(`, `Есть NULL` → `ЕСТЬ NULL`).
  // normalizeLeafCase не трогает сегменты `.`-пути и тело строковых литералов и
  // безопасен для многострочных условий-подзапросов (правит лишь промежутки без
  // переводов строк).
  // Склейка нескольких соседних DCS-скобок в одну (`{a} {b}` → `{a, b}`) до всех
  // прочих преобразований — иначе посчитаем их раздельными параметрами.
  positions = positions.map(p => (p ? mergeDcsBraces(p) : p));
  condition = condition ? mergeDcsBraces(condition) : condition;
  positions = positions.map(p => (p ? wrapDcsBraceParam(normalizeLeafCase(p)) : p));
  condition = condition ? wrapDcsBraceParam(normalizeLeafCase(condition)) : condition;
  // Автопсевдоним `Поле<2k>` для выражений в DCS-скобках `{(…)}` вызова ВТ (см.
  // aliasDcsBraceExprs). Общий счётчик идёт по позициям; условие (= последняя позиция)
  // нумеруется тем же счётчиком только если оно НЕ дубликат positions[last].
  const dcsState = { k: 0 };
  const condDup = condition !== '' && positions.length > 0 && positions[positions.length - 1] === condition;
  positions = positions.map(p => (p ? aliasDcsBraceExprs(p, dcsState) : p));
  if (condition && condition.includes('{')) {
    condition = condDup ? positions[positions.length - 1] : aliasDcsBraceExprs(condition, dcsState);
  }
  // Сплющиваем «лишние» переносы разработчика внутри ПРОСТОГО условия-параметра
  // (`Валюта В (&А,\n  &Б)` → одна строка): конструктор печатает такой параметр ВТ
  // инлайн (фаза 6.16.72). flattenMultilineLeaf консервативен — НЕ трогает условие с
  // подзапросом (`В (ВЫБРАТЬ …)`), верхнеуровневым И/ИЛИ или ВЫБОР: они остаются
  // многострочными по своим правилам. То же для предшествующих позиций (период и др.).
  positions = positions.map(p => (p ? flattenMultilineLeaf(p) : p));
  condition = condition ? flattenMultilineLeaf(condition) : condition;
  // Снятие ИЗБЫТОЧНЫХ обрамляющих скобок простого условия-параметра
  // (`(СтруктурнаяЕдиница = &Организация)` → без скобок, фаза 6.16.72): конструктор
  // печатает одиночное сравнение в параметре ВТ без скобок. stripRedundantLeafParens
  // аккуратен с кортежами `(a, b) В (…)` (по контексту соседей) и однострочен.
  condition = condition ? stripRedundantLeafParens(condition) : condition;
  // То же снятие для позиции-условия в списке positions (инлайн-ветка печатает
  // positions.join, а не condition): синхронизируем последнюю позицию с условием.
  if (condition && positions.length > 0 && positions[positions.length - 1]) {
    const li = positions.length - 1;
    positions[li] = stripRedundantLeafParens(flattenMultilineLeaf(positions[li]));
  }
  // DCS-условие в фигурных скобках (`{(…)}`, в т.ч. многострочное и с внутренним И/ИЛИ
  // или списком полей `{(Ном).* КАК Ном, …}`) конструктор 1С печатает ВЕСЬ вызов ВТ
  // ИНЛАЙН: позиционные параметры остаются на строке вызова, а содержимое скобок (с
  // уже проставленными автопсевдонимами `КАК Поле2`) идёт дословно. Внутренний перенос
  // строки и булевы операторы НЕ должны навязывать многострочную раскладку параметров
  // (это отличает DCS-условие `{…}` от обычного составного условия/подзапроса). Узкий
  // гейт: условие целиком обёрнуто в одну пару `{…}`. Фаза 6.16.
  const condTrim = condition.trim();
  const condIsDcsBrace =
    condTrim.startsWith('{') && condTrim.endsWith('}') &&
    positions.length > 0 && positions[positions.length - 1].trim() === condTrim;
  if (condIsDcsBrace) {
    return `${fullName}(${positions.join(', ')})`;
  }
  const hasBool = !!condition && hasTopLevelBooleanOp(condition);
  // Условие-подзапрос (`(поля) В (ВЫБРАТЬ …)`) тоже разносит параметры по строкам,
  // даже без верхнеуровневого И/ИЛИ: конструктор 1С печатает каждый параметр на своей
  // строке, а тело подзапроса перебазирует на base+1 (фаза 6.16, MCP). Признак —
  // многострочное условие (содержит перенос строки от тела `(ВЫБРАТЬ …)`).
  const hasSubquery = !!condition && condition.includes('\n');
  // Условие-членство `Поле В (ВЫБРАТЬ …)`, набранное ИНЛАЙН (без переноса строки):
  // конструктор 1С тоже разносит параметры ВТ по строкам и раскладывает подзапрос
  // (корпус ОстаткиПартийЗЕРНО.Остатки(, Партия В (ВЫБРАТЬ …))). Без переноса строки
  // hasSubquery его не ловит — детектируем по `В (ВЫБРАТЬ` (тот же гейт, что у inlineCond).
  const hasInlineSubquery =
    !!condition &&
    /(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\(\s*ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(condition);
  if (!condition || (!hasBool && !hasSubquery && !hasInlineSubquery)) {
    return `${fullName}(${positions.join(', ')})`;
  }
  // ВНУТРИ подзапроса-операнда членства (`… В (ВЫБРАТЬ … ИЗ Рег.X.Остатки(, Условие) …)`)
  // конструктор 1С НЕ разносит позиции ВТ по отдельным строкам, а сохраняет вызов
  // ИНЛАЙН: `Остатки(, <первый-конъюнкт>` остаётся на строке источника, а составное
  // условие раскладывается по конъюнктам на отступе строки-источника+1 (как обычное
  // условие, а не как параметр верхнего уровня). На ВЕРХНЕМ уровне (≈300 эталонных
  // случаев) каждый параметр печатается на своей строке — туда эта ветка НЕ заходит
  // (узкий гейт по inConditionSubquery + составному условию). Фаза 6.16.77.
  if (inConditionSubquery && hasBool) {
    // Конъюнкты составного условия идут на bodyTabs+1 (отступ строки источника +1).
    // reindentVtCondition печатает конъюнкты k>0 на base+1 → base = bodyTabs.
    const ibase = bodyTabs;
    const condLines = reindentVtCondition(condition.trim(), ibase).split('\n');
    // Первый конъюнкт (line 0) приклеиваем к `Имя(<предш.-позиции>, `.
    const headInline = positions.slice(0, -1).join(', ');
    condLines[0] = condLines[0].replace(/^\t+/u, '');
    return `${fullName}(${headInline}, ${condLines.join('\n')})`;
  }
  const base = bodyTabs + 2;
  const pad = '\t'.repeat(base);
  // Конструктор разбивает СОСТАВНОЕ условие по верхнеуровневым И/ИЛИ (даже если во
  // вводе оно на одной строке): каждый конъюнкт — на отдельной строке, продолжения
  // на base+1. Если входной текст уже многострочный — reindentLeafBool лишь
  // переотбивает отступы. Сперва принудительно ставим переносы перед верхнеуровневыми
  // И/ИЛИ, затем нормализуем отступ. Чистое условие-подзапрос (без И/ИЛИ) — через
  // reindentLeafSubquery: `(ВЫБРАТЬ` встаёт на base+1, тело — на base+2.
  // Условие-параметр = ОДИНОЧНЫЙ многострочный CASE (`Имя = ВЫБОР … КОНЕЦ`) без
  // верхнеуровневого И/ИЛИ и без подзапроса (`ВЫБРАТЬ`): конструктор раскладывает его
  // как лист-CASE на отступе строки параметра — КОНЕЦ на base, КОГДА на base+1 — а не
  // как подзапрос (reindentLeafSubquery дал бы лишний +1 на всё тело). Узкий гейт:
  // первая строка условия ОКАНЧИВАЕТСЯ словом ВЫБОР и нет `ВЫБРАТЬ` (корпус
  // СдельныйНаряд: `ДокументПроизводства = ВЫБОР … КОНЕЦ`).
  const condFirstLine0 = condition.includes('\n') ? condition.slice(0, condition.indexOf('\n')) : condition;
  const isCaseValueParam =
    !hasBool &&
    !/\bВЫБРАТЬ\b/iu.test(condition) &&
    // Параметр-CASE: первая строка либо ОКАНЧИВАЕТСЯ словом ВЫБОР (`Имя = ВЫБОР`,
    // корпус СдельныйНаряд), либо НАЧИНАЕТСЯ им (селекторный `ВЫБОР &Парам …` или
    // условный `ВЫБОР КОГДА …`, корпус ПланФактныйАнализПродаж). В обоих случаях это
    // лист-CASE на отступе строки параметра (КОНЕЦ на base), не подзапрос.
    (/(^|[^\p{L}\p{N}_])ВЫБОР\s*$/u.test(condFirstLine0) ||
      /^ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(condition.trim()));
  // Чистое условие-членство `Поле В (ВЫБРАТЬ … ИЗ …)`, набранное ИНЛАЙН: перепарсиваем
  // внутренний запрос и рендерим канонически (`(ВЫБРАТЬ` на base+1, тело глубже), как
  // оракул. reindentLeafSubquery инлайн-подзапрос не раскладывает (фаза 6.16).
  const inlineCond =
    !hasBool && !isCaseValueParam &&
    /(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\(\s*ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(condition)
      ? reflowInlineMembershipSubquery(condition.trim(), base, base + 1, '')
      : null;
  if (inlineCond) {
    inlineCond[0] = pad + inlineCond[0].replace(/^\t+/u, '');
    const head0 = positions.slice(0, -1).map(p => pad + p);
    return `${fullName}(\n${[...head0, inlineCond.join('\n')].join(',\n')})`;
  }
  const condText = hasBool
    ? reindentVtCondition(condition.trim(), base)
    : isCaseValueParam
      ? reindentLeafCase(condition.trim(), base)
      : reindentLeafSubquery(condition.trim(), base + 1);
  const condLines = condText.split('\n');
  condLines[0] = pad + condLines[0].replace(/^\t+/u, '');
  // Предшествующие параметры (период и др.) — каждый на своей строке с запятой.
  const head = positions.slice(0, -1).map(p => pad + p);
  return `${fullName}(\n${[...head, condLines.join('\n')].join(',\n')})`;
}

/**
 * Печатает параметры виртуальной таблицы регистра бухгалтерии ВСЕГДА по строкам:
 * каждый позиционный параметр на своей строке (включая пустые слоты и хвостовые
 * позиции ПОСЛЕ условия — напр. `корСчетУсловие` у Обороты-корр), позиция условия
 * реиндентируется как составное/подзапросное выражение. Используется только когда
 * у вызова есть параметры (фаза 6.16.70). Отличие от `renderVirtualParams`: условие
 * не обязано быть последней позицией.
 */
function renderAccountingParams(fullName: string, positions: string[], _condition: string, bodyTabs: number): string {
  positions = positions.map(p => (p ? normalizeLeafCase(p) : p));
  const base = bodyTabs + 2;
  const pad = '\t'.repeat(base);
  // Любая позиция-СОСТАВНОЕ выражение (условие счёта, условие, …) реиндентируется по
  // конъюнктам как условие ВТ: верхнеуровневые И/ИЛИ — на отдельных строках, тело
  // подзапроса — глубже. Простые позиции (период, периодичность) — инлайн на pad.
  const renderPos = (p: string): string => {
    if (!p) return pad;
    const hasBool = hasTopLevelBooleanOp(p);
    const text = hasBool
      ? reindentVtCondition(p.trim(), base)
      : (p.includes('\n') && /\(ВЫБРАТЬ/u.test(p) ? reindentLeafSubquery(p.trim(), base + 1) : p.trim());
    const lines = text.split('\n');
    lines[0] = pad + lines[0].replace(/^\t+/u, '');
    return lines.join('\n');
  };
  return `${fullName}(\n${positions.map(renderPos).join(',\n')})`;
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
 * Конъюнкт-подзапрос членства `LHS [НЕ] В [ИЕРАРХИИ] (ВЫБРАТЬ …)`, записанный
 * разработчиком ИНЛАЙН (`Поле В (ВЫБРАТЬ … ИЗ …)` на одной строке) либо с
 * нестандартными переносами, конструктор 1С перекладывает КАНОНИЧЕСКИ: `LHS … В`
 * на строке конъюнкта, затем `(ВЫБРАТЬ` на отдельной строке (base+2), тело —
 * глубже. reindentLeafSubquery умеет лишь равномерно сдвигать УЖЕ многострочное
 * тело и не раскладывает инлайн-подзапрос. Здесь вычленяем текст внутреннего
 * запроса, парсим его и рендерим тем же путём, что подзапрос условия ГДЕ
 * (renderConditionSubquery — подавление автопсевдонима, квалификация по имени
 * источника), получая байт-в-байт каноническую раскладку.
 *
 * Возвращает готовый блок строк или null, если конъюнкт не распознан как
 * инлайн-членство (тогда вызывающий идёт прежним путём). `prefix` — префикс
 * оператора конъюнкта (`И `/`ИЛИ `/``), `ind` — отступ строки конъюнкта,
 * `subBase` — отступ строки `(ВЫБРАТЬ` (обычно base+2).
 */
/**
 * Содержит ли тело подзапроса секцию `ГДЕ`/`ИМЕЮЩИЕ`, чья ВЕРХНЕУРОВНЕВАЯ ИЛИ-цепочка
 * НЕ обёрнута в единственную внешнюю пару скобок (`ГДЕ A > 0 ИЛИ B`)? Конструктор 1С
 * (внутри подзапроса-операнда) оборачивает такую цепочку в `(…)`, а текстовый путь
 * сохраняет исходную геометрию — поэтому при canonical-геометрии тела всё равно нужно
 * развернуть его структурно. Узкий гейт (фаза 6.16). Для КАЖДОЙ секции берём её текст
 * до следующей секции/конца, ищем верхнеуровневый (depth==0) `ИЛИ`; если он есть И
 * выражение НЕ целиком в одной внешней паре скобок — возвращаем true.
 */
function bodyHasUnwrappedBoolOr(inner: string): boolean {
  const secRe = /(?:^|[^\p{L}\p{N}_])(ГДЕ|ИМЕЮЩИЕ)(?![\p{L}\p{N}_])/gu;
  const nextSec = /(?:^|[^\p{L}\p{N}_])(?:СГРУППИРОВАТЬ|ИМЕЮЩИЕ|УПОРЯДОЧИТЬ|ИНДЕКСИРОВАТЬ|ОБЪЕДИНИТЬ|ИТОГИ|ГДЕ)(?![\p{L}\p{N}_])/u;
  const isW = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(inner)) !== null) {
    let seg = inner.slice(m.index + m[0].length);
    const nm = nextSec.exec(seg);
    if (nm) seg = seg.slice(0, nm.index);
    seg = seg.trim();
    if (!seg) continue;
    // Верхнеуровневый ИЛИ (depth==0, вне строк)?
    let depth = 0, inStr = false, topOr = false;
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (inStr) { if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth--; continue; }
      if (depth === 0 && (ch === 'И' || ch === 'и') && !isW(seg[i - 1]) && /^ИЛИ(?![\p{L}\p{N}_])/iu.test(seg.slice(i))) { topOr = true; break; }
    }
    if (!topOr) continue;
    // ИЛИ верхнеуровневый ⇒ выражение НЕ обёрнуто в одну внешнюю пару (иначе ИЛИ был бы
    // на depth==1). Расхождение с оракулом ⇒ нужно развернуть.
    return true;
  }
  return false;
}

/**
 * Поле выборки-членство `Поле В (ВЫБРАТЬ … ИЗ …)`, набранное инлайн: поле на ind=0
 * (отступ добавит вызывающий), `(ВЫБРАТЬ` на 2, тело глубже. Тонкая обёртка над
 * reflowInlineMembershipSubquery (фаза 6.16).
 */
function inlineSelectMembershipReflow(text: string): string[] | null {
  return reflowInlineMembershipSubquery(text, 0, 2, '');
}

function reflowInlineMembershipSubquery(
  text: string,
  ind: number,
  subBase: number,
  prefix: string
): string[] | null {
  // Ведущие `НЕ` листа: каждое сдвигает блок подзапроса на +1 (геометрия 1С, как в
  // reindentLeafSubquery). Считаем их и НЕ ищем в них оператор `В`.
  const neMatch = /^((?:НЕ\s+)+)/iu.exec(text);
  const neCount = neMatch ? (neMatch[1].match(/НЕ/giu) ?? []).length : 0;
  subBase += neCount;
  // Находим верхнеуровневый оператор `В`/`В ИЕРАРХИИ` (вне скобок/строк), за которым
  // сразу открывается подзапрос `(ВЫБРАТЬ …)`.
  const n = text.length;
  let depth = 0, inStr = false;
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth !== 0) continue;
    // Слово `В` на верхнем уровне.
    if ((ch === 'В' || ch === 'в') && !isWord(text[i - 1]) && !isWord(text[i + 1])) {
      let j = i + 1;
      // Опциональный модификатор ` ИЕРАРХИИ`.
      const restUp = text.slice(j).replace(/^\s+/u, '').toUpperCase();
      let hier = '';
      if (restUp.startsWith('ИЕРАРХИИ') && !isWord(restUp[8])) {
        hier = ' ИЕРАРХИИ';
        const m = /^\s+ИЕРАРХИИ/iu.exec(text.slice(j));
        if (m) j += m[0].length;
      }
      // Пропускаем пробелы до открывающей скобки.
      while (j < n && /\s/u.test(text[j])) j++;
      if (text[j] !== '(') return null;
      // Содержимое скобки начинается с ВЫБРАТЬ?
      const afterParen = text.slice(j + 1).replace(/^\s+/u, '');
      if (!/^ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(afterParen)) return null;
      // Парная закрывающая скобка.
      let d2 = 0, inS2 = false, close = -1;
      for (let k = j; k < n; k++) {
        const c2 = text[k];
        if (inS2) { if (c2 === '"') inS2 = false; continue; }
        if (c2 === '"') { inS2 = true; continue; }
        if (c2 === '(') d2++;
        else if (c2 === ')') { d2--; if (d2 === 0) { close = k; break; } }
      }
      if (close < 0) return null;
      // Хвост после закрытия подзапроса (напр. ` И …`) — не наш случай (составное
      // условие; пусть его раскладывает прежний путь поконъюнктно).
      if (text.slice(close + 1).trim() !== '') return null;
      const lhs = text.slice(0, i).trim();
      const innerText = text.slice(j + 1, close);
      // Узкий гейт: ре-рендерим только НЕКАНОНИЧНО набранные подзапросы, которые
      // reindentLeafSubquery (равномерный сдвиг авторских строк) НЕ способен разложить:
      //   • тело целиком на одной строке (инлайн), либо
      //   • секция `ИЗ` склеена с источником на одной строке (`ИЗ Имя …`).
      // Канонично набранное тело (каждая секция/поле — на своей строке, `ИЗ` отдельной
      // строкой) reindentLeafSubquery сдвигает байт-в-байт (сохраняя геометрию пустых
      // строк-разделителей и скобок ПО, где канонический ре-рендер расходится с
      // оракулом) — такие подзапросы НЕ трогаем.
      // Склеенное СОЕДИНЕНИЕ на строке источника (`ВТ КАК А ВНУТРЕННЕЕ СОЕДИНЕНИЕ Б
      // КАК В`) — тоже неканон: reindentLeafSubquery его не разнесёт, а оракул печатает
      // соединение отдельной строкой. Признак: в строке есть текст ПЕРЕД ключевым словом
      // соединения (т.е. соединение не в начале строки).
      const gluedJoin = /(?:^|[^\p{L}\p{N}_])\S[^\n]*?[ \t](?:ВНУТРЕННЕЕ|ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ)(?:[ \t]+ВНЕШНЕЕ)?[ \t]+СОЕДИНЕНИЕ(?:[^\p{L}\p{N}_]|$)/u
        .test(innerText);
      const isCanonical =
        innerText.includes('\n') &&
        !/(?:^|[^\p{L}\p{N}_])ИЗ[ \t]+\S/u.test(innerText) &&
        !gluedJoin;
      // ИСКЛЮЧЕНИЕ из canonical-bail (фаза 6.16): тело СО ВНЕШНЕ-канонической геометрией,
      // но с секцией `ГДЕ`/`ИМЕЮЩИЕ`, чья ВЕРХНЕУРОВНЕВАЯ ИЛИ-цепочка НЕ обёрнута во
      // внешние скобки (`ГДЕ A > 0 ИЛИ B`). Внутри подзапроса-операнда конструктор 1С
      // ОБОРАЧИВАЕТ такую цепочку в `(…)` и разносит по строкам, а текстовый (равномерный
      // сдвиг) путь оставляет её как в исходнике — расхождение. Разворачиваем структурно
      // (renderConditionSubquery → formatExpression), где обёртка ставится байт-в-байт.
      // ИСКЛЮЧЕНИЕ №2 (фаза 6.16): тело со внешне-канонической геометрией, но с
      // ВЛОЖЕННЫМ многострочным CASE-как-значением (`ТОГДА ВЫБОР … КОНЕЦ`). Разработчик
      // нередко набирает внутренний ВЫБОР на ОДИН уровень мельче канона (его КОГДА на
      // ТОГДА+1, а не ТОГДА+2; продолжение `И` условия — вровень с КОГДА). Равномерный
      // сдвиг (reindentLeafSubquery) сохранил бы эту НЕканоническую вложенность; оракул
      // же ВКЛАДЫВАЕТ внутренний CASE структурно. Перепарсиваем и рендерим канонически.
      // Признак: строка-значение `ТОГДА`/`ИНАЧЕ`, ОКАНЧИВАЮЩАЯСЯ голым словом ВЫБОР.
      const hasNestedCaseValue =
        /(?:^|[^\p{L}\p{N}_])(?:ТОГДА|ИНАЧЕ)[ \t]+ВЫБОР[ \t]*(?:\r?\n|$)/u.test(innerText);
      if (isCanonical && !bodyHasUnwrappedBoolOr(innerText) && !hasNestedCaseValue) return null;
      let doc: QueryDocument;
      try { doc = parseDocument(innerText); }
      catch { return null; }
      const block = renderConditionSubquery(doc, subBase).split('\n');
      // ЛЕВЫЙ операнд `В` — кортеж `(поле1, поле2, …)`, набранный разработчиком на
      // НЕСКОЛЬКИХ строках: конструктор 1С печатает его на ОДНОЙ строке. Сплющиваем
      // внутренние переносы/отступы lhs в одиночные пробелы (как делает reindentLeaf-
      // Subquery со своей головой-кортежем), нормализуя стыки `( `/` )`/` ,`.
      const lhsFlat = lhs
        .replace(/[ \t\r\n]+/gu, ' ')
        .replace(/\(\s+/gu, '(')
        .replace(/\s+\)/gu, ')')
        .replace(/\s+,/gu, ',')
        .trim();
      const head = '\t'.repeat(ind) + prefix + lhsFlat + ' В' + hier;
      return [head, ...block];
    }
  }
  return null;
}

/**
 * Конъюнкт виртуальной таблицы — скобочная булева группа, набранная ИНЛАЙН
 * (`(X ИЛИ Y)`, `(A И B ИЛИ C)`): ставит переносы перед каждым верхнеуровневым
 * (внутри ведущей скобки, depth==1) оператором `И`/`ИЛИ`, превращая конъюнкт в
 * многострочную группу. Дальше штатная ветка reindentVtCondition отобьёт отступы по
 * приоритету И>ИЛИ. Возвращает исходный текст без изменений, если:
 *   • текст не начинается с `(`;
 *   • внутри есть подзапрос (`ВЫБРАТЬ`) или `ВЫБОР` (их раскладывают свои ветки);
 *   • нет ни одного верхнеуровневого оператора группы.
 * Хвост после закрывающей группу скобки (`) {…}`, `) КАК …`) остаётся на ПОСЛЕДНЕЙ
 * строке (переносы ставятся только внутри группы). Фаза 6.16.
 */
function breakInlineParenGroup(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith('(')) return text;
  if (/(?:^|[^\p{L}\p{N}_])(?:ВЫБРАТЬ|ВЫБОР)(?:[^\p{L}\p{N}_]|$)/u.test(t)) return text;
  const lead = text.slice(0, text.length - t.length);
  let depth = 0;
  let inStr = false;
  let out = '';
  let changed = false;
  // Диапазонное `И` из `МЕЖДУ a И b` — не булев разделитель, перенос перед ним не ставим.
  let betweenPending = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { out += ch; if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '(') { depth++; out += ch; continue; }
    if (ch === ')') { depth--; out += ch; continue; }
    // Слово `МЕЖДУ` на верхнем уровне группы — следующее `И` диапазонное.
    if ((ch === 'М' || ch === 'м') && !/[\p{L}\p{N}_]/u.test(t[i - 1] ?? '')) {
      const mm = /^МЕЖДУ(?![\p{L}\p{N}_])/iu.exec(t.slice(i));
      if (mm) { betweenPending++; out += t.slice(i, i + mm[0].length); i += mm[0].length - 1; continue; }
    }
    // Верхнеуровневый (depth==1) оператор `И`/`ИЛИ` внутри ведущей скобки.
    if (depth === 1 && (ch === 'И' || ch === 'и')) {
      const prev = t[i - 1];
      const m = /^(И|ИЛИ)(?![\p{L}\p{N}_])/u.exec(t.slice(i));
      if (m && m[1] === 'И' && betweenPending > 0 && (prev === undefined || !/[\p{L}\p{N}_]/u.test(prev))) {
        betweenPending--;
        out += m[1];
        i += m[1].length - 1;
        continue;
      }
      if (m && (prev === undefined || !/[\p{L}\p{N}_]/u.test(prev))) {
        // Срезаем уже накопленный пробел перед оператором, ставим перенос.
        out = out.replace(/[ \t]+$/u, '') + '\n' + m[1] + ' ';
        i += m[1].length;
        // Пропускаем пробелы после оператора.
        while (i + 1 < t.length && /[ \t]/u.test(t[i + 1])) i++;
        changed = true;
        continue;
      }
    }
    out += ch;
  }
  return changed ? lead + out : text;
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
  // Приоритет И>ИЛИ: когда в условии есть хоть один верхнеуровневый `ИЛИ`, ВСЯ цепочка —
  // это ИЛИ-цепочка из И-групп (`A И B ИЛИ C И D`), и КАЖДЫЙ конъюнкт `И` принадлежит
  // вложенной И-группе под своим `ИЛИ` → отбивается на base+2 (даже `И B` ПЕРЕД первым
  // `ИЛИ` — он операнд первой И-группы). Конъюнкт `ИЛИ` всегда на base+1. Чистая
  // И-цепочка без `ИЛИ` остаётся на base+1 (корпус Баланс/АнализСчетов/НалогиИВзносы).
  const hasAnyOr = conjuncts.some((c) => c.op === 'ИЛИ');
  const out: string[] = [];
  conjuncts.forEach((c, k) => {
    const andUnderOr = c.op === 'И' && hasAnyOr;
    const ind = k === 0 ? base : andUnderOr ? base + 2 : base + 1;
    const prefix = k === 0 ? '' : `${c.op} `;
    // Сплющиваем «лишние» переносы разработчика внутри ПРОСТОГО конъюнкта-списка
    // значений (`Организация В\n(&Массив)` → одна строка, фаза 6.16.72):
    // flattenMultilineLeaf не трогает конъюнкт с подзапросом (`В (ВЫБРАТЬ …)`) и ВЫБОР
    // — они раскладываются по строкам ниже своими ветками.
    if (c.text.includes('\n')) c = { ...c, text: flattenMultilineLeaf(c.text) };
    // Конъюнкт — скобочная ИЛИ-группа, набранная разработчиком ИНЛАЙН (`И (X ИЛИ Y)`
    // на одной строке): конструктор 1С разносит её по строкам (operand0 на строке `(`,
    // каждый `ИЛИ`/`И` внутри группы — на новой строке +1). reindentVtCondition умеет
    // раскладывать только УЖЕ многострочную группу (ветка ниже), поэтому ставим переносы
    // перед верхнеуровневыми (depth-1) операторами ведущей скобки — дальше штатная ветка
    // отобьёт отступы. Узкий гейт: конъюнкт начинается с `(`, без подзапроса/ВЫБОР внутри,
    // и содержит верхнеуровневый оператор группы. Фаза 6.16.
    if (!c.text.includes('\n')) {
      const broken = breakInlineParenGroup(c.text);
      if (broken !== c.text) c = { ...c, text: broken };
    }
    // Конъюнкт-членство `Поле В (ВЫБРАТЬ … ИЗ …)`, набранный разработчиком ИНЛАЙН
    // (подзапрос целиком на одной строке): reindentLeafSubquery умеет лишь сдвигать
    // уже многострочное тело, инлайн он не раскладывает. Перепарсиваем внутренний
    // запрос и рендерим канонически (`(ВЫБРАТЬ` на base+2, тело глубже). Гейтим узко:
    // подзапрос ИНЛАЙН (`В (ВЫБРАТЬ` подряд) и закрывается в конце конъюнкта — иначе
    // прежний путь (фаза 6.16).
    const inlineReflow =
      /(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\(\s*ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(c.text)
        ? reflowInlineMembershipSubquery(c.text, ind, base + 2, prefix)
        : null;
    // Конъюнкт — CASE (`ВЫБОР … КОНЕЦ`), В ТЕЛЕ которого есть подзапрос `В (ВЫБРАТЬ …)`
    // (значение ветки ТОГДА/ИНАЧЕ — членство): это НЕ подзапрос-операнд верхнего уровня,
    // а CASE с вложенным подзапросом. Подзапросная ветка ниже (reindentLeafSubquery)
    // равномерно сдвинула бы ВЕСЬ CASE на лишний +1 (КОГДА/ТОГДА/КОНЕЦ over-shift); CASE
    // должен раскладываться структурно (reindentLeafCase), а его внутренний подзапрос —
    // reindentLeafSubquery уже изнутри. Узкий гейт: текст НАЧИНАЕТСЯ словом ВЫБОР (фаза 6.16).
    const conjunctIsCase = /^ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(c.text.trim());
    if (inlineReflow) {
      // Разделитель ОБЪЕДИНИТЬ внутри подзапроса-операнда `В` параметра условия ВТ
      // оракул печатает на отступе БАЗЫ условия (`base`), а не относительно ключевого
      // слова (renderConditionSubquery даёт baseTabs−1). Перебиваем пустые строки-
      // разделители, соседние с `ОБЪЕДИНИТЬ`, на `base` табов — как в reindentLeaf-
      // Subquery-ветке ниже (фаза 6.16).
      const isUKw = (s: string): boolean => /^\t*ОБЪЕДИНИТЬ(?:\s+ВСЕ)?\s*$/u.test(s.trim());
      for (let q = 0; q < inlineReflow.length; q++) {
        if (inlineReflow[q].trim() !== '') continue;
        const adj = (q > 0 && isUKw(inlineReflow[q - 1])) || (q + 1 < inlineReflow.length && isUKw(inlineReflow[q + 1]));
        if (adj) inlineReflow[q] = '\t'.repeat(base);
      }
      out.push(...inlineReflow);
    } else if (!conjunctIsCase && c.text.includes('\n') && /\(\s*\n\s*ВЫБРАТЬ(?![\p{L}\p{N}_])|\(ВЫБРАТЬ/u.test(c.text)) {
      const r = reindentLeafSubquery(c.text, base + 2).split('\n');
      r[0] = '\t'.repeat(ind) + prefix + r[0].replace(/^\t+/u, '');
      // Разделитель ОБЪЕДИНИТЬ внутри подзапроса-операнда `В`, вложенного в параметр
      // условия ВТ, оракул печатает на отступе БАЗЫ условия (`base`), а не относительно
      // ключевого слова (как делает reindentLeafSubquery, kwInd−1). Перебиваем пустые
      // строки-разделители, соседние с `ОБЪЕДИНИТЬ`, на `base` табов (фаза 6.16, MCP).
      const isUKw = (s: string): boolean => /^\t*ОБЪЕДИНИТЬ(?:\s+ВСЕ)?\s*$/u.test(s);
      for (let q = 0; q < r.length; q++) {
        if (r[q].trim() !== '') continue;
        const adj = (q > 0 && isUKw(r[q - 1])) || (q + 1 < r.length && isUKw(r[q + 1]));
        if (adj) r[q] = '\t'.repeat(base);
      }
      out.push(...r);
    } else if (c.text.includes('\n') && /(?:^|[^\p{L}\p{N}_])ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(c.text)) {
      // Конъюнкт-ВЫБОР: КОНЕЦ на base+1, КОГДА на base+2 (АБСОЛЮТНО относительно base,
      // не зависит от номера конъюнкта — проверено на корпусе). Строка ВЫБОР (line 0)
      // остаётся на ind конъюнкта.
      //
      // Исключение (фаза 6.16.43): когда CASE — ЕДИНСТВЕННЫЙ конъюнкт условия ВТ
      // (нет соседних И/ИЛИ верхнего уровня, т.е. весь параметр условия — это `ВЫБОР …
      // КОНЕЦ`, стоящий ОТДЕЛЬНОЙ строкой сразу после запятой-периода), КОНЕЦ выровнен
      // ПО строке ВЫБОР (base), а КОГДА на base+1 — оракул не вкладывает CASE на лишний
      // уровень, т.к. конъюнкции нет (ср. составное условие bsl_32: `ВЫБОР … КОНЕЦ
      // И Номенклатура = …` — там КОНЕЦ на base+1). Узко гейтим по числу конъюнктов.
      const caseBase = conjuncts.length === 1 ? base : base + 1;
      const r = reindentLeafCase(c.text, caseBase).split('\n');
      r[0] = '\t'.repeat(ind) + prefix + r[0].replace(/^\t+/u, '').replace(/\s+$/u, '');
      out.push(...r);
    } else if (c.text.includes('\n')) {
      // Многострочный конъюнкт-группа `И (… ИЛИ … И …)`. Продолжения `И`/`ИЛИ`
      // отбиваются по приоритету (И > ИЛИ): базовый отступ ind+1 плюс +1 за каждый
      // незакрытый уровень скобок группы, плюс ещё +1 для конъюнкта `И` на скобочном
      // уровне, несущем верхнеуровневый `ИЛИ` (фаза 6.16.42, тот же приоритет, что
      // в reindentLeafCase/orLevelsForCondition). Чистая `И`/`ИЛИ`-цепочка без
      // вложенного `ИЛИ`-уровня даёт прежний плоский ind+1.
      const lines = c.text.split('\n');
      const parenDelta = (s: string): number => {
        let d = 0;
        let inS = false;
        for (let p = 0; p < s.length; p++) {
          const ch = s[p];
          if (ch === '"') { inS = !inS; continue; }
          if (inS) continue;
          if (ch === '(') d++;
          else if (ch === ')') d--;
        }
        return d;
      };
      const firstWord = (s: string): string => {
        const m = /^[\t ]*([\p{L}]+)/u.exec(s);
        return m ? m[1].toUpperCase() : '';
      };
      // Скобочные уровни, несущие верхнеуровневый `ИЛИ` среди продолжений конъюнкта.
      const orLevels = new Set<number>();
      let scanLvl = parenDelta(lines[0]);
      for (let j = 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        const fw = firstWord(lines[j]);
        if (fw === 'И' || fw === 'ИЛИ') {
          if (fw === 'ИЛИ') orLevels.add(scanLvl);
          scanLvl += parenDelta(lines[j]);
        } else break;
      }
      out.push('\t'.repeat(ind) + prefix + lines[0].trim());
      // Конъюнкт-группа открывает скобку (`И (…`): отбиваем продолжения по глубине
      // скобок + приоритету И>ИЛИ. Иначе (просто перенесённый по строкам лист, без
      // верхнеуровневой скобки) — прежний плоский ind+1.
      const headDelta = parenDelta(lines[0]);
      let condParen = headDelta;
      for (let j = 1; j < lines.length; j++) {
        if (headDelta <= 0) { out.push('\t'.repeat(ind + 1) + lines[j].trim()); continue; }
        const fw = firstWord(lines[j]);
        const orShift = fw === 'И' && orLevels.has(condParen) ? 1 : 0;
        out.push('\t'.repeat(ind + condParen + orShift) + lines[j].trim());
        condParen += parenDelta(lines[j]);
      }
    } else {
      // Одиночный однострочный конъюнкт-ОТРИЦАНИЕ поля: снимаем избыточную обёртку, как
      // оракул (`И (НЕ Поле)` → `И НЕ Поле`; фаза 6.16.78). ВАЖНО: прочие предикатные
      // обёртки (`И (Год МЕЖДУ a И b)`, `И (a = b)`) в параметре ВТ оракул СОХРАНЯЕТ —
      // поэтому общий stripRedundantLeafParens здесь НЕ применяем (корпус УчётНДФЛ,
      // ЖурналУчётаСчетовФактур).
      const cText = stripNotFieldParens(stripNegatedFieldParens(c.text));
      out.push('\t'.repeat(ind) + prefix + cText);
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
  const m = /^([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*(?:<>|>=|<=|=|>|<)\s*([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)$/u.exec(expr.trim());
  if (!m) return false;
  // Операнд-ЛИТЕРАЛ (`ИСТИНА`/`ЛОЖЬ`/`NULL`/`НЕОПРЕДЕЛЕНО`) — это НЕ сравнение двух полей:
  // оракул `field = ЛОЖЬ` печатает В СКОБКАХ (а `field = field` — без), фаза корпус
  // РаботаСПодарочнымиСертификатами (живой оракул `ПО (Т.Код = ЛОЖЬ)`).
  const LIT = new Set(['ИСТИНА', 'ЛОЖЬ', 'NULL', 'НЕОПРЕДЕЛЕНО']);
  if (LIT.has(m[1].toUpperCase()) || LIT.has(m[2].toUpperCase())) return false;
  return true;
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
function renderArbitraryConjunct(expr: string, depth = 0, caseEndBase?: number, fromAndSplit = false): string {
  // Многострочный лист (`В (\n a,\n b)` и т.п.) конструктор сплющивает в одну
  // строку (правило 6.15.3, для ПО — фаза 6.15.5); стоп-условия (ВЫБРАТЬ/ВЫБОР/
  // И/ИЛИ/`{`) оставляют текст как есть. Лист с подзапросом (`X В\n(ВЫБРАТЬ …)`)
  // перебазируется на base+2 = 4+depth (фаза 6.15.9, MCP).
  const flatExpr = flattenMultilineLeaf(expr.trim());
  // Лист-членство `Поле В (ВЫБРАТЬ … ИЗ …)`, набранный ИНЛАЙН: канонический ре-рендер
  // подзапроса (`(ВЫБРАТЬ` на 4+depth, тело глубже), как оракул. reindentLeafSubquery
  // инлайн не раскладывает. Обёртка `(…)` конъюнкта добавляется ниже (фаза 6.16).
  const inlineConj =
    /(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\(\s*ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(flatExpr)
      ? reflowInlineMembershipSubquery(flatExpr, 0, 4 + depth, '')
      : null;
  if (inlineConj) {
    return appendIsNotNullTrailingSpace('(' + inlineConj.join('\n') + ')');
  }
  let body = reindentLeafSubquery(flatExpr, 4 + depth);
  // Сравнение с ОДИНОЧНЫМ многострочным CASE в правой части (`поле = ВЫБОР … КОНЕЦ`):
  // конструктор раскладывает CASE на отступе КОНКРЕТНОГО конъюнкта (КОНЕЦ на
  // отступе строки конъюнкта = caseEndBase, КОГДА на +1), а НЕ сохраняет табы
  // ввода (фаза 6.16.53). Guard узкий: CASE открыт сравнением `… = ВЫБОР` (слово ВЫБОР
  // в конце первой строки ЛИБО разработчик отбил его на следующую строку — `поле =\n
  // ВЫБОР`, тогда reindentLeafCase сам сошьёт `= ВЫБОР`) и в теле РОВНО ОДИН КОНЕЦ —
  // это исключает CASE-цепочки (`ВЫБОР…КОНЕЦ + ВЫБОР…КОНЕЦ`) и ВЫРАЗИТЬ-обёртки.
  if (caseEndBase !== undefined && body.includes('\n')) {
    const bodyLines = body.split('\n');
    const firstLine = bodyLines[0];
    const secondLine = (bodyLines.find((l, i) => i > 0 && l.trim() !== '') ?? '');
    const oneCase = (body.match(/(^|[^\p{L}\p{N}_])КОНЕЦ(?=[^\p{L}\p{N}_]|$)/gu) ?? []).length === 1;
    const opensCase = /(^|[^\p{L}\p{N}_])ВЫБОР\s*$/u.test(firstLine) ||
      (/[=<>]\s*$/u.test(firstLine) && /^[\t ]*ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(secondLine));
    if (oneCase && opensCase) {
      body = reindentLeafCase(body, caseEndBase);
    }
  }
  // Конъюнкт-отрицание `НЕ (<сравнение>)`: конструктор снимает скобки вокруг
  // ЕДИНСТВЕННОГО операнда `НЕ`, ОХВАТЫВАЮЩИХ всё выражение, и печатает `НЕ ` с
  // пробелом — `НЕ ВТ_321.С170 = 0` (а не `НЕ(…)`, что дал бы normalizeLeafCase).
  // ВАЖНО: в `ПО` конструктор СОХРАНЯЕТ прочие избыточные скобки (`(ВЫРАЗИТЬ(…)) = X`),
  // поэтому общий stripRedundantLeafParens здесь неприменим — снимаем строго пару
  // вокруг операнда ведущего `НЕ` (фаза 6.16.59).
  // Голый операнд-приведение `ВЫРАЗИТЬ(…)` сравнения в конъюнкте ПО оракул печатает в
  // СВОИХ скобках (`= (ВЫРАЗИТЬ(…))`), сверх обёртки конъюнкта (фаза 6.16.78, корпус
  // ЭлектронныеДокументыЭДО/Синхронизация...). wrapBareCastOperand узок (одностр., только
  // целый операнд ВЫРАЗИТЬ; обычные вызовы/`.Поле`-доступ не трогает).
  const norm = wrapBareCastOperand(normalizeLeafCase(stripLeadingNotOperandParens(body)));
  // Конъюнкт ПО, расщеплённый из ВЛОЖЕННОЙ И-группы (`И (a = b И f(x) >= &П)`),
  // конструктор печатает БЕЗ обёртки, если это ПРОСТОЕ сравнение двух ссылок на поля
  // (`Алиас.Путь <оп> Алиас.Путь`); прочие (литерал/параметр/функция/унарность) — в
  // скобках (живой оракул, фаза 6.16.78). ВАЖНО: правило применимо ТОЛЬКО к конъюнктам,
  // полученным расщеплением И-цепочки (fromAndSplit) — самостоятельный `ПО (a = b)`
  // оракул оставляет В СКОБКАХ (temp/builder-таблицы, корпус ВидыКонтактнойИнформации).
  if (fromAndSplit && !norm.includes('\n') && isPlainFieldComparison(norm)) {
    return appendIsNotNullTrailingSpace(norm);
  }
  // Внутри ПОДЗАПРОСА-ОПЕРАНДА условия (`В (ВЫБРАТЬ … СОЕДИНЕНИЕ … ПО a = b)`) одиночный
  // конъюнкт ПО — ПРОСТОЕ сравнение двух ссылок на поля — оракул печатает БЕЗ обёртки
  // `(…)` (в отличие от самостоятельного верхнеуровневого `ПО (a = b)` temp-таблицы).
  // Узкий гейт: только в условном подзапросе и только голое сравнение полей.
  if (inConditionSubquery && !norm.includes('\n') && isPlainFieldComparison(norm)) {
    return appendIsNotNullTrailingSpace(norm);
  }
  // Квирк `… ЕСТЬ НЕ NULL )` (один пробел перед закрывающей скобкой группы) — после
  // обёртки конъюнкта в `(…)` (фаза 6.16.76, корпус ВедомостьНаВыплатуЗарплаты).
  return appendIsNotNullTrailingSpace(`(${norm})`);
}

/**
 * `(a, b) НЕ В …` → `НЕ (a, b) В …`: переносит `НЕ` оператора членства кортежа
 * ПЕРЕД кортеж (как печатает конструктор 1С). Срабатывает СТРОГО когда выражение
 * НАЧИНАЕТСЯ с охватывающего кортежа `(…)` с верхнеуровневой запятой, за которым
 * сразу следует `НЕ В` (или `НЕ В ИЕРАРХИИ`). Иначе текст без изменений.
 */
function moveNotBeforeTuple(text: string): string {
  if (text[0] !== '(') return text;
  // Закрывающая скобка кортежа.
  let depth = 0;
  let inStr = false;
  let close = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return text;
  const tuple = text.slice(0, close + 1);
  // Кортеж = скобка с верхнеуровневой запятой (а не группировка/вызов).
  if (!hasTopLevelComma(text.slice(1, close))) return text;
  const rest = text.slice(close + 1);
  const m = /^\s+НЕ\s+(В)(\s+ИЕРАРХИИ)?(?![\p{L}\p{N}_])/u.exec(rest);
  if (!m) return text;
  const tail = rest.slice(m[0].length);
  return `НЕ ${tuple} В${m[2] ?? ''}${tail}`;
}

/** Есть ли запятая на ВЕРХНЕМ уровне скобок/строк (признак списка/кортежа). */
function hasTopLevelComma(text: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return true;
  }
  return false;
}

/**
 * `НЕ (<выражение>)` → `НЕ <выражение>`, когда `(` сразу после ведущего `НЕ` парна
 * ПОСЛЕДНЕМУ символу строки (скобка охватывает ВЕСЬ операнд отрицания) и внутри нет
 * верхнеуровневой запятой (не список) и нет верхнеуровневого И/ИЛИ (раскладку
 * структурного булева слота не трогаем). Однострочный лист; иначе текст без изменений.
 */
function stripLeadingNotOperandParens(text: string): string {
  if (text.includes('\n')) return text;
  const m = /^НЕ\s*\(/iu.exec(text);
  if (!m) return text;
  const open = m[0].length - 1; // позиция '('
  // Парная закрывающая для этой '(' должна быть последним символом строки.
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        if (i !== text.length - 1) return text;
        const inner = text.slice(open + 1, i).trim();
        // Список (`НЕ (a, b)`) или булева цепочка (`НЕ (a И b)`) — НЕ снимаем: смысл/
        // раскладка изменятся (такие конъюнкты обычно идут отдельным сложным путём).
        if (hasTopLevelComma(inner) || hasTopLevelBooleanOp(inner)) return text;
        return `НЕ ${inner}`;
      }
    }
  }
  return text;
}

/**
 * Рендерит условие `ПО` поконъюнктно из `join.conditions` (фаза 6.13). Первый
 * конъюнкт — на той же строке после `ПО`, последующие — отдельными строками
 * `\t\t\tИ <ci>`. Каждый конъюнкт: стандартный (`seed.поле cmp joined.поле`) без
 * скобок, произвольный простой — в скобках, произвольный сложный (ИЛИ/ВЫБОР/
 * многострочный) — структурной переотрисовкой форматера с той же геометрией, что
 * у legacy-пути (фаза 6.15.5: ворота «сложный конъюнкт → legacy» сняты).
 */
function renderJoinConjuncts(conditions: NonNullable<Join['conditions']>, aliases: Map<string, string>, depth = 0, poOwnLine = false, joinParenthesized = true): string {
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
      // Для продолжающего конъюнкта (`И …`) известен отступ его строки (cont):
      // многострочный CASE в правой части сравнения раскладываем на нём (КОНЕЦ=cont).
      // Первый конъюнкт (k===0) на верхнем уровне стоит ИНЛАЙН после `ПО ` (отступ
      // 2+depth); обёртка конъюнкта `(…)` добавляет +1 уровня, поэтому КОНЕЦ его
      // RHS-CASE — на 3+depth (КОГДА на +1). При poOwnLine конъюнкт стоит на 3+depth →
      // КОНЕЦ на 4+depth. Гейт раскладки узкий (CASE-на-RHS, ровно один КОНЕЦ).
      const caseBase = k > 0 ? cont : (poOwnLine ? 4 + depth : 3 + depth);
      // Единственный самостоятельный конъюнкт БЕЗ скобок во вводе (`ПО a = b`),
      // ставший произвольным лишь из-за переквалификации голого поля
      // (`ПО Ссылка = T.Поле` → `ПО Алиас.Ссылка = T.Поле`), оракул печатает БЕЗ
      // обёртки — как простое сравнение. Гейт: ровно один конъюнкт и !parenthesized
      // (скобки во вводе → сохраняем обёртку, фаза ВидыКонтактнойИнформации).
      const standaloneUnwrap = expanded.length === 1 && !joinParenthesized;
      sub = [renderArbitraryConjunct(c.expression ?? '', depth, caseBase, !!(c as { __fromAndSplit?: boolean }).__fromAndSplit || standaloneUnwrap)];
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
        // Помечаем пьесы как полученные расщеплением И-цепочки (фаза 6.16.78):
        // простое сравнение полей среди них печатается без обёртки (renderArbitraryConjunct).
        for (const p of parts) out.push({ custom: true, expression: stripOneEnclosingParen(p), __fromAndSplit: true } as NonNullable<Join['conditions']>[number]);
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
    return renderJoinConjuncts(join.conditions, aliases, depth, poOwnLine, join.parenthesized ?? true);
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

  // Верхнеуровневые записи `ИЗ` печатаются в ПОРЯДКЕ ОБЪЯВЛЕНИЯ источников (порядок
  // `model.tables`) — конструктор 1С сохраняет порядок разработчика. Запись — это либо
  // одиночная таблица (не участвует ни в одном соединении), либо ЗАТРАВКА дерева
  // соединений (печатается со всем своим поддеревом). Строки каждого дерева копятся в
  // `chainLines`, ключ — id затравки верхнего уровня (depth 0); одиночные таблицы
  // собираются на этапе сборки. `currentSeedId` указывает, в какую запись писать строки.
  const chainLines = new Map<string, string[]>();
  let currentSeedId = '';
  const lines: string[] = [];
  const push = (line: string): void => {
    (chainLines.get(currentSeedId) ?? lines).push(line);
  };

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
      // условия `ПО`. В блоке из НЕСКОЛЬКИХ соединений (`{J1 ПО … J2 ПО …}`) `}`
      // ставится только после ПОСЛЕДНЕГО — он помечен в `optionalBlockEnd` (фаза 6.16).
      const close = optionalBlockEnd.has(p.join) ? '}' : '';
      if (poOwnLine) {
        push(`\t\t${'\t'.repeat(p.depth)}ПО`);
        push(`${cond}${close}`);
      } else {
        push(`\t\t${'\t'.repeat(p.depth)}ПО ${cond}${close}`);
      }
    }
  };

  // Границы блоков `{…}` опциональных соединений построителя (фаза 6.16). Идущие
  // подряд опциональные соединения образуют ОДИН блок: `{` перед первым, `}` после
  // последнего. Последним считаем соединение с флагом `optionalLast`, а при его
  // отсутствии (модели до 6.16 / UI) — каждое опциональное соединение само по себе
  // (один блок на соединение), что воспроизводит прежнее поведение.
  const optionalBlockStart = new Set<Join>();
  const optionalBlockEnd = new Set<Join>();
  {
    let prevWasOpenBlock = false;
    joins.forEach((j, i) => {
      if (!j.optional) { prevWasOpenBlock = false; return; }
      if (!prevWasOpenBlock) optionalBlockStart.add(j);
      // Конец блока: явный флаг `optionalLast`, либо (для моделей без флага) —
      // следующее соединение не опциональное / соединений больше нет.
      const next = joins[i + 1];
      const isLast = j.optionalLast === true ||
        (j.optionalLast === undefined && (!next || !next.optional));
      if (isLast) { optionalBlockEnd.add(j); prevWasOpenBlock = false; }
      else prevWasOpenBlock = true;
    });
  }

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
      // Начало новой верхнеуровневой записи `ИЗ` — заводим под неё буфер строк с
      // ключом-затравкой, последующие строки дерева пишутся в него (через `push`).
      currentSeedId = seedId;
      chainLines.set(seedId, []);
      push(`\t${sourceLine(seed)}`);
      inChain.add(seedId);
    }
    inChain.add(seedId);
    // Опциональное соединение построителя (фаза 6.15.13) открывается `{` перед видом
    // соединения; закрывается `}` после условия `ПО` (см. flushPo). В блоке из
    // нескольких соединений `{` ставится только перед первым (фаза 6.16).
    const open = optionalBlockStart.has(join) ? '{' : '';
    // Присоединяемый источник стоит на отступе 2+depth — тело его подзапроса (если
    // источник — подзапрос) отбивается по этому же отступу (фаза 6.15.19).
    push(`\t\t${'\t'.repeat(depth)}${open}${keyword} СОЕДИНЕНИЕ ${sourceLine(joined, 2 + depth)}`);
    inChain.add(joinedId);
    pendingPo.push({ join, depth });
  });
  flushPo(0);

  // Сборка в ПОРЯДКЕ ОБЪЯВЛЕНИЯ (порядок `model.tables`). Верхнеуровневая запись — это
  // одиночная таблица (не в `inChain`) ИЛИ затравка дерева (есть буфер в `chainLines`).
  // Прочие таблицы (присоединяемые / непервичные затравки) пропускаем — они уже внутри
  // буферов своих деревьев. У каждой записи, кроме последней, последняя физическая
  // строка получает запятую (для дерева — после его последнего условия `ПО`).
  const entries: string[][] = [];
  for (const t of model.tables) {
    if (chainLines.has(t.id)) entries.push(chainLines.get(t.id)!);
    else if (!inChain.has(t.id)) entries.push([`\t${sourceLine(t)}`]);
  }
  const out: string[] = [];
  entries.forEach((entry, i) => {
    if (entry.length === 0) return;
    if (i < entries.length - 1) entry[entry.length - 1] += ',';
    out.push(...entry);
  });
  return out;
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
  // Элемент-условие `{ГДЕ}` печатается в скобках (фаза 6.15.7). Суффикс `.*`
  // («использовать дочерние») сохраняется всегда — и в `{ВЫБРАТЬ}`, и в `{ГДЕ}`,
  // с псевдонимом и без (живой оракул: `Поле.* КАК Алиас` сохраняет `.*`).
  // Скобочная форма `(выражение).*` приходит как условие с `child: true`: `.*`
  // дописывается ПОСЛЕ скобок, а не оборачивается ещё одной парой (корпус:
  // ЕСТЬNULL(...).* КАК КассаККМ, ЗНАЧЕНИЕ(...).* КАК Группа).
  const render = (f: BuilderField): string => {
    // Регистровая нормализация выражения поля/условия (КАК, ЕСТЬ, НЕ, литералы,
    // имена функций): конструктор приводит зарезервированные слова к ВЕРХНЕМУ
    // регистру и в элементах построителя (`{ГДЕ (Не … ЕСТЬ NULL)}`). Путь поля
    // (`Таблица.Поле`) не затрагивается — normalizeLeafCase не трогает сегменты `.`.
    // Многострочный ВЫБОР в скобочном условии построителя (`(ВЫБОР…КОНЕЦ) КАК …`)
    // конструктор раскладывает по КАНОНУ относительно позиции поля в блоке (поле на
    // относительном табе 1, охватывающая `(` даёт +1 → КОНЕЦ на 2), а НЕ сохраняет
    // абсолютный отступ исходника (фаза 6.16.fmt, корпус СтатистикаЧековПоЧасам).
    const isMultilineCase = f.condition && f.ref.includes('\n') &&
      /(^|[^\p{L}\p{N}_])ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(f.ref);
    // Многострочное БУЛЕВО условие построителя без ВЫБОР (`(A >= &X И (B ИЛИ C))`),
    // набранное разработчиком плоско: конструктор раскладывает его по конъюнктам
    // относительно позиции поля (поле на относительном табе 1 — база reindentLeafBool=1;
    // вложенные группы И/ИЛИ отбиваются по глубине скобок). Гейт узкий: условие, есть
    // перенос строки, есть верхнеуровневый булев оператор, нет ВЫБОР/подзапроса (фаза 6.16).
    const isMultilineBool = !isMultilineCase && f.condition && f.ref.includes('\n') &&
      hasTopLevelBooleanOp(f.ref) &&
      !/(?:^|[^\p{L}\p{N}_])(?:ВЫБОР|ВЫБРАТЬ)(?:[^\p{L}\p{N}_]|$)/u.test(f.ref) &&
      // Группа `НЕ(…)` несёт лишний +1 (НЕ — отдельный уровень), который reindentLeafBool
      // НЕ учитывает; такие условия не реиндентируем (оставляем геометрию как есть).
      !/(?:^|[^\p{L}\p{N}_])НЕ\s*\(/u.test(f.ref);
    const ref = isMultilineCase
      ? reindentLeafCase(normalizeLeafCase(f.ref), 2)
      : isMultilineBool
        // Условие построителя оборачивается ещё одной парой `(…)` ниже (render), чья
        // ведущая `(` стоит на строке поля (таб 1) и добавляет +1 уровень продолжениям:
        // база reindentLeafBool = 2 (1 поле + 1 охватывающая скобка).
        ? reindentLeafBool(normalizeLeafCase(f.ref), 2)
        : normalizeLeafCase(f.ref);
    return f.condition
      ? `(${ref})` + (f.child ? '.*' : '') + (f.alias ? ' КАК ' + f.alias : '')
      : ref + (f.child ? '.*' : '') + (f.alias ? ' КАК ' + f.alias : '');
  };
  const lines = ['{' + keyword];
  fields.forEach((f, i) => {
    const last = i === fields.length - 1;
    lines.push('\t' + render(f) + (last ? '}' : ','));
  });
  return lines;
}

/**
 * Нормализация дословного блока характеристик СКД `{ХАРАКТЕРИСТИКИ … }`: оракул
 * сохраняет его геометрию байт-в-байт, КРОМЕ выражений полей подзапроса, разнесённых
 * разработчиком по нескольким строкам — их он СКЛЕИВАЕТ в одну (как и любую арифметику/
 * конкатенацию в списке выборки). Единственный наблюдаемый триггер (корпус
 * РаботаСНоменклатуройПереопределяемый): строка-продолжение, у которой ПРЕДЫДУЩАЯ
 * значимая строка оканчивается БИНАРНЫМ оператором `+ - * /` (перенос внутри выражения).
 * Склеиваем такую пару: хвостовой пробел слева + одиночный пробел + строка справа без
 * ведущих пробелов. Прочую геометрию (структурные строки подзапроса, ПОЛЕ-секции) не
 * трогаем — узкий гейт по трейлинг-оператору исключает их (они оператором не кончаются).
 */
function reflowCharacteristics(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  // Строка оканчивается бинарным оператором `+ - * /` (вне строкового литерала),
  // т.е. это незавершённое выражение, перенесённое разработчиком на следующую строку.
  const endsWithBinaryOp = (s: string): boolean => {
    const t = s.replace(/\s+$/u, '');
    if (!/[+\-*/]$/u.test(t)) return false;
    // Звезда проекции `Поле.*` (точка перед `*`) — не оператор умножения.
    if (/\.\*$/u.test(t)) return false;
    // Оператор не должен быть внутри незакрытого строкового литерала.
    let inStr = false;
    for (let i = 0; i < t.length; i++) { if (t[i] === '"') inStr = !inStr; }
    return !inStr;
  };
  for (const line of lines) {
    if (out.length > 0 && line.trim() !== '' && endsWithBinaryOp(out[out.length - 1])) {
      out[out.length - 1] = out[out.length - 1].replace(/\s+$/u, '') + ' ' + line.replace(/^[\t ]+/u, '');
    } else {
      out.push(line);
    }
  }
  // Закрывающую `}` блока характеристик оракул отделяет от содержимого пробелом
  // (`ПОЛЕЗНАЧЕНИЯ Значение }`), если разработчик прижал её к тексту (`Значение}`).
  if (out.length > 0) {
    out[out.length - 1] = out[out.length - 1].replace(/([^\s{])\}$/u, '$1 }');
  }
  return out.join('\n');
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
  // Фаза 8.1 (шаг 5) — восстановление комментариев запроса. Без данных о
  // комментариях все вставки пусты → вывод байт-в-байт прежний.
  // Вид 1 (commentTrailing) — после запятой на строке поля (с пробелом).
  const linesBase = fieldLines.map((l, i) => {
    const withComma = i < fieldLines.length - 1 ? l + ',' : l;
    const trailing = i < model.fields.length ? model.fields[i]?.commentTrailing : undefined;
    return trailing ? withComma + ' ' + trailing : withComma;
  });
  // Вид 2 (commentLeading) — отдельные строки с нулевым отступом ПЕРЕД полем.
  const lines: string[] = [];
  for (let i = 0; i < linesBase.length; i++) {
    const leading = i < model.fields.length ? model.fields[i]?.commentLeading : undefined;
    if (leading?.length) lines.push(...leading);
    lines.push(linesBase[i]);
  }

  // Запрос без источника (`ВЫБРАТЬ &Параметр КАК Поле [ПОМЕСТИТЬ ВТ]`) —
  // конструктор не выводит секцию `ИЗ`. Иначе обычный список таблиц.
  // Вид 4 (afterFrom) — строки после `ИЗ`, перед телом источника.
  const hasFrom = model.tables.length > 0;
  const fromLines = hasFrom
    ? ['ИЗ', ...(model.comments?.afterFrom ?? []), ...renderFrom(model, aliases)]
    : [];

  const conditionLines = renderConditions(model.conditions, aliases);
  // Конструктор 1С отделяет блок группировки пустой строкой (в отличие от ГДЕ).
  // ВНУТРИ подзапроса-операнда условия (`В (ВЫБРАТЬ … СГРУППИРОВАТЬ … ИМЕЮЩИЕ …)`)
  // конструктор такие разделительные пустые строки НЕ ставит (фаза 6.15.11c,
  // MCP-пробы): секции идут вплотную.
  const sectionSep = inConditionSubquery ? [] : [''];
  const groupingInner = renderGrouping(model.grouping, aliases, model);
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
  // Голая секция (`ДЛЯ ИЗМЕНЕНИЯ` без перечня таблиц — блокировка всех источников)
  // помечается `lockForUpdateBare`; перечень таблиц — `lockForUpdate`. Пустой массив
  // `lockForUpdate` без флага трактуется как «секции нет» (совместимость с webview).
  const lockLines: string[] = (model.lockForUpdate?.length || model.lockForUpdateBare)
    ? ['', 'ДЛЯ ИЗМЕНЕНИЯ', ...(model.lockForUpdate ?? []).map(name => '\t' + name)]
    : [];

  const builderSelect = builderBlock('ВЫБРАТЬ', model.builder?.fields ?? []);
  const builderWhere = builderBlock('ГДЕ', model.builder?.conditions ?? []);
  const builderOrder = builderBlock('УПОРЯДОЧИТЬ ПО', model.builder?.order ?? []);
  const builderTotals = builderBlock('ИТОГИ ПО', model.builder?.totals ?? []);

  return [
    // Вид 3 (beforeSelect) — строки перед `ВЫБРАТЬ`, нулевой отступ.
    ...(model.comments?.beforeSelect ?? []),
    'ВЫБРАТЬ' + selectionModifiers(model.selection),
    ...lines,
    // {ВЫБРАТЬ …} конструктор печатает ПОСЛЕ ПОМЕСТИТЬ/ДОБАВИТЬ (если те есть),
    // перед ИЗ; без ПОМЕСТИТЬ placeLines пуст и блок идёт сразу за списком полей.
    ...placeLines,
    ...builderSelect,
    ...fromLines,
    ...conditionLines,
    ...builderWhere,
    ...groupingLines,
    ...havingLines,
    ...builderOrder,
    ...builderTotals,
    ...lockLines,
    // Блок характеристик СКД `{ХАРАКТЕРИСТИКИ … }` — почти дословно (байт-в-байт),
    // последним; единственная нормализация — склейка арифметики/конкатенации поля
    // подзапроса, разнесённой разработчиком по строкам (оракул печатает её одной строкой).
    ...(model.characteristics ? reflowCharacteristics(model.characteristics).split('\n') : []),
  ].join('\n');
}

/** Голый параметр выборки `&Имя` (без вызова/индексации/прочего). */
const BARE_PARAM = /^&([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)$/u;

/** Выражение — это ТОЛЬКО голый параметр `&Имя` (для отбраковки в группировке). */
function isBareParamExpr(expression: string | undefined): boolean {
  return expression !== undefined && BARE_PARAM.test(expression.trim());
}

// Константное выражение группировки, которое конструктор 1С ОТБРАСЫВАЕТ из
// `СГРУППИРОВАТЬ ПО` (нельзя группировать по константе): строковый/числовой литерал,
// `ЗНАЧЕНИЕ(…)`/`ТИП(…)`/`ДАТАВРЕМЯ(…)` целиком, ИСТИНА/ЛОЖЬ/НЕОПРЕДЕЛЕНО, &параметр.
// Выражения с полем (`ВЫРАЗИТЬ(Поле …)`, `Поле + 1`) НЕ константны и сохраняются.
const CONST_GROUP_RE = /^("(?:[^"]|"")*"|\d+(?:\.\d+)?|ИСТИНА|ЛОЖЬ|НЕОПРЕДЕЛЕНО|(?:ЗНАЧЕНИЕ|ТИП|ДАТАВРЕМЯ)\s*\([^()]*\))$/iu;
function isConstGroupExpr(expression: string | undefined): boolean {
  if (expression === undefined) return false;
  const e = expression.trim();
  return isBareParamExpr(e) || CONST_GROUP_RE.test(e);
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
    // Нерезолвимая навигация по источнику-ВТ: автопсевдоним = ПОЛНЫЙ точечный путь
    // дословно (`СтавкаНДС.Перечисление`), без склейки сегментов (фаза 6.18, парсер
    // `markDottedAutoAlias`).
    if (field.autoAliasDotted) return field.path;
    const t = model.tables.find(tb => tb.id === field.tableId);
    return qualifiedAutoAlias(field.path, isTabularSectionSource(t));
  }
  return field.path.split('.').pop() ?? field.path;
}

/**
 * Многострочный рендер проекции ТЧ (`<алиас>.<ТЧ>.(\n\t\t<колонки>\n\t) КАК <алиас>`).
 * Единый источник правды для одиночного запроса (`buildFieldLines`) и для ячеек
 * вертикального объединения (`generateDocument`). Опция `suppress` (для НЕ-первого
 * участника объединения) убирает внешний `КАК <алиас>` И внутренние псевдонимы
 * колонок (как делает конструктор 1С для позиционных столбцов: первый участник
 * задаёт псевдонимы, остальные печатают голые проекции — сверено с golden-корпусом).
 * `outerAlias` — функция выбора псевдонима всей ТЧ (для дедупликации в одиночном
 * запросе); при `suppress` не вызывается.
 */
export function renderTabProjection(
  model: QueryModel,
  tsf: SelectedTabSectionField,
  aliases: Map<string, string>,
  opts: { suppress: boolean; outerAlias?: (name: string, explicit: string | undefined) => string }
): string {
  const tableAlias = aliases.get(tsf.tableId) ?? tsf.tableId;
  // Проекция ТЧ, ДОСТИГНУТАЯ через ссылочную навигацию (путь до `.(` длиннее одного
  // сегмента, напр. `СтатусыОтправки.Основание.ПричиныОтказа` — таблица → ссылка
  // `Основание` → её ТЧ `ПричиныОтказа`), нумерует автопсевдонимы ГОЛЫХ колонок
  // позиционно `Поле{n}` вместо имени поля. Для ПРЯМОЙ ТЧ (`Таблица.ТЧ`, tsName без
  // точки) автопсевдоним = имя поля. Сверено по всему golden-корпусу: 206 прямых
  // голых колонок → имя; глубокие → Поле1/Поле2/… (фаза 6.16.59). Касается лишь
  // голых колонок БЕЗ явного псевдонима; явные `КАК` сохраняются как есть.
  const deepPath = tsf.tsName.includes('.');
  // Позиционный `Поле{n}` — ТОЛЬКО для голой колонки (без явного `КАК`) глубокой ТЧ.
  // `alias` — сохранённый явный псевдоним (≠ имени поля); `wasExplicit` — был ли
  // явный `КАК` вообще (в т.ч. совпавший с именем). Явный псевдоним печатается всегда.
  const autoColAlias = (
    alias: string | undefined,
    fieldName: string,
    pos: number,
    wasExplicit: boolean
  ): string => {
    if (alias !== undefined) return alias;
    if (deepPath && !wasExplicit) return `Поле${pos + 1}`;
    // Автопсевдоним голой колонки-ПУТИ (`Заказ.Номер`) — сегменты пути склеены без
    // точек (`ЗаказНомер`): идентификатор не может содержать точку. Оракул печатает
    // именно склейку; одно-сегментное поле остаётся как есть.
    return fieldName.replace(/\./g, '');
  };
  const tsExprLines = (expression: string, alias: string | undefined, comma: string): string[] => {
    const rows = formatSelectExpression(expression).split('\n');
    const shifted = rows.map((l, j) => (j === 0 ? '\t\t' + l : '\t' + l));
    const tail = !opts.suppress && alias !== undefined ? ' КАК ' + alias : '';
    shifted[shifted.length - 1] = shifted[shifted.length - 1] + tail + comma;
    return shifted;
  };
  let subLines: string[];
  if (tsf.columns && tsf.columns.length > 0) {
    subLines = tsf.columns.flatMap((c, i) => {
      const comma = i < tsf.columns!.length - 1 ? ',' : '';
      if (c.kind === 'field') {
        // Голая колонка: первый участник — `<поле> КАК <псевдоним>`; прочие — `<поле>`.
        // Нормализация регистра головы: литерал-колонка `Неопределено`/`ЛОЖЬ` → ВЕРХ;
        // имя поля (`ДокументОснование`) не распознаётся как литерал и не трогается.
        const tail = opts.suppress ? '' : ` КАК ${autoColAlias(c.alias, c.field, i, c.aliasExplicit === true)}`;
        return [`\t\t${normalizeLeafCase(c.field)}${tail}${comma}`];
      }
      return tsExprLines(c.expression, c.alias, comma);
    });
  } else if (tsf.exprFields && tsf.exprFields.length > 0) {
    subLines = tsf.exprFields.flatMap((ef, i) => {
      const rows = formatSelectExpression(ef.expression).split('\n');
      const shifted = rows.map((l, j) => (j === 0 ? '\t\t' + l : '\t' + l));
      const comma = i < tsf.exprFields!.length - 1 ? ',' : '';
      const tail = opts.suppress ? '' : ' КАК ' + ef.alias;
      shifted[shifted.length - 1] = shifted[shifted.length - 1] + tail + comma;
      return shifted;
    });
  } else {
    subLines = tsf.fields.map((f, i) => {
      const tail = opts.suppress
        ? ''
        : ` КАК ${autoColAlias(tsf.fieldAliases?.[i], f, i, tsf.fieldAliasExplicit?.[i] === true)}`;
      // Литерал-колонка ТЧ (`Неопределено`/`ЛОЖЬ`/`NULL`) → ВЕРХ; имя поля не трогается.
      return `\t\t${normalizeLeafCase(f)}${tail}${i < tsf.fields.length - 1 ? ',' : ''}`;
    });
  }
  // Голова проекции: псевдоним таблицы (`Алиас.ТЧ`) либо выражение-приведение
  // (`ВЫРАЗИТЬ(…).ТЧ`, фаза 6.16) — печатается дословно из castPrefix.
  const head = tsf.castPrefix !== undefined ? tsf.castPrefix : tableAlias;
  const body = `\t${head}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t)`;
  if (opts.suppress) return body;
  const tsAlias = opts.outerAlias ? opts.outerAlias(tsf.tsName, tsf.alias) : (tsf.alias ?? tsf.tsName);
  return `${body} КАК ${tsAlias}`;
}

/**
 * Автопсевдоним произвольного поля выборки без явного `КАК`. Конструктор 1С
 * для голого параметра `&Имя` ставит псевдоним = имени параметра (без `&`),
 * для остального — сквозной `Поле{n}`. Возвращает выбранный псевдоним; для
 * варианта `Поле{n}` инкрементирует переданный счётчик.
 */
function exprAutoAlias(expression: string, next: () => string): string {
  const m = BARE_PARAM.exec(expression.trim());
  if (m) return m[1];
  const repr = representationAutoAlias(expression);
  return repr ?? next();
}

/**
 * Автопсевдоним вызова `ПРЕДСТАВЛЕНИЕ(<поле>)` / `ПРЕДСТАВЛЕНИЕССЫЛКИ(<поле>)` без
 * явного `КАК`: конструктор 1С даёт ему `<ПоследнийСегмент>Представление`
 * (`ПРЕДСТАВЛЕНИЕ(T.Номенклатура)` → `НоменклатураПредставление`,
 * `ПРЕДСТАВЛЕНИЕССЫЛКИ(Сотрудники.Ставка)` → `СтавкаПредставление`). Узко: ровно
 * один аргумент-поле (последовательность сегментов через точку, без иных символов).
 * Возвращает `undefined`, если выражение не подходит. Фаза 6.16.73.
 */
function representationAutoAlias(expression: string): string | undefined {
  const m = /^(?:ПРЕДСТАВЛЕНИЕ|ПРЕДСТАВЛЕНИЕССЫЛКИ)\s*\(\s*([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_.]*)\s*\)$/iu
    .exec(expression.trim());
  if (!m) return undefined;
  const lastSeg = m[1].split('.').pop();
  return lastSeg ? `${lastSeg}Представление` : undefined;
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

  // Дедупликация автопсевдонимов простых полей (фаза 6.16, сверено MCP): при
  // коллизии вычисленного автопсевдонима с уже занятым именем конструктор 1С
  // добавляет наименьший целый суффикс (`Комментарий` → `Комментарий1`). Явные `КАК`
  // и автопсевдонимы выражений (`Поле{n}`/имя параметра) регистрируются как есть.
  // Порядок исполнения `fieldLine`/`tsLine` совпадает с порядком печати, поэтому
  // суффикс назначается по позиции в выборке, как у оракула.
  const usedAliases = new Set<string>();
  const uniqueAlias = (alias: string): string => {
    if (!usedAliases.has(alias)) { usedAliases.add(alias); return alias; }
    let k = 1;
    while (usedAliases.has(`${alias}${k}`)) k++;
    const out = `${alias}${k}`;
    usedAliases.add(out);
    return out;
  };

  const fieldLine = (f: SelectedField): string => {
    if (f.expression) {
      // В подзапросе-операнде `В` (suppressAutoAlias) конструктор НЕ добавляет
      // автопсевдоним произвольному полю выборки (`1`/`ИСТИНА` остаются голыми);
      // явный (НЕ `Поле{n}`) псевдоним сохраняется (фаза 6.15.27, MCP). Парсер уже
      // навесил авто-`Поле{n}` (assignExpressionFieldAliases) — снимаем его здесь.
      if (suppressAutoAlias && (f.alias === undefined || /^Поле\d+$/u.test(f.alias))) {
        // Явно написанный разработчиком `Поле{n}` конструктор СОХРАНЯЕТ даже под
        // подавлением (MCP-проба); синтезированный — снимает (фаза 6.16.77).
        if (f.exprAliasExplicit) {
          return `\t${formatSelectExpression(f.expression)} КАК ${f.exprAliasExplicit}`;
        }
        return `\t${formatSelectExpression(f.expression)}`;
      }
      // `ПРЕДСТАВЛЕНИЕ(<поле>)`/`ПРЕДСТАВЛЕНИЕССЫЛКИ(<поле>)` без явного `КАК` получает
      // `<ПоследнийСегмент>Представление` (а не сквозной `Поле{n}`). Парсер уже навесил
      // авто-`Поле{n}` (assignExpressionFieldAliases), поэтому распознаём этот случай по
      // авто-псевдониму (`Поле{n}` или его отсутствию) и пересчитываем. Явный `КАК` (не
      // `Поле{n}`) сохраняется как есть.
      const autoExpr = f.alias === undefined || /^Поле\d+$/u.test(f.alias);
      const repr = autoExpr ? representationAutoAlias(f.expression) : undefined;
      const alias = repr ?? f.alias ?? exprAutoAlias(f.expression, () => `Поле${++exprCounter}`);
      usedAliases.add(alias);
      return `\t${formatSelectExpression(f.expression)} КАК ${alias}`;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    // Функция агрегата берётся ПРЯМО с поля (различает два агрегата одного
    // операнда, фаза 6.15.11a); общий список — лишь резерв для старых моделей.
    const func = f.func ?? aggregateFunc(f.tableId, f.path);
    const lhs = func
      ? wrapAggregate(func, `${tableAlias}.${f.path}`)
      : `${tableAlias}.${f.path}`;
    // Автопсевдоним простого поля без явного `КАК`:
    //  • квалифицированное поле (`Алиас.Путь`) — склейка ВСЕХ сегментов пути
    //    (`Родитель.Имя` → `РодительИмя`), с отбрасыванием ведущего `Ссылка` у
    //    источника-ТЧ (см. qualifiedAutoAlias, фаза 6.16, сверено MCP);
    //  • голое поле (квалифицировано единственным источником) — последний сегмент
    //    (`Владелец.Наименование` → `Наименование`, курируемый 0043).
    // Агрегат над КВАЛИФИЦИРОВАННЫМ операндом (`МАКСИМУМ(Док.Контрагент.Наименование)`)
    // тоже получает автопсевдоним склейкой сегментов (`КонтрагентНаименование`) —
    // сверено по golden-корпусу (195 случаев) и живому оракулу; агрегат над ГОЛЫМ
    // операндом (`МАКСИМУМ(ИмяУзла)`) остаётся без псевдонима (13 случаев). Применяем
    // лишь к парсерным агрегатам с флагом `funcOperandQualified` (legacy/UI-модели,
    // где функция из общего списка `aggregates`, не трогаем).
    let autoAlias: string | undefined;
    if (!suppressAutoAlias) {
      if (!func) {
        autoAlias = synthesizedFieldAlias(model, f);
      } else if (f.func !== undefined && f.funcOperandQualified) {
        const tbl = model.tables.find(tb => tb.id === f.tableId);
        autoAlias = qualifiedAutoAlias(f.path, isTabularSectionSource(tbl));
      }
    }
    let effAlias = f.alias ?? autoAlias;
    if (effAlias !== undefined) {
      // Явный псевдоним регистрируется как есть; автопсевдоним простого поля —
      // через дедуп (наименьший целый суффикс при коллизии).
      effAlias = f.alias !== undefined ? (usedAliases.add(f.alias), f.alias) : uniqueAlias(effAlias);
    }
    return effAlias ? `\t${lhs} КАК ${effAlias}` : `\t${lhs}`;
  };

  const tsLine = (tsf: SelectedTabSectionField): string =>
    renderTabProjection(model, tsf, aliases, {
      suppress: false,
      // Дедупликация псевдонима всей ТЧ (как раньше): явный — как есть, авто — через
      // наименьший целый суффикс при коллизии.
      outerAlias: (name, explicit) =>
        explicit !== undefined ? (usedAliases.add(explicit), explicit) : uniqueAlias(name),
    });

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
 * Конструктор 1С при печати МНОГОСТРОЧНОГО строкового литерала (перенос строки
 * ВНУТРИ двойных кавычек) добавляет к каждой строке-продолжению базовый отступ
 * поля выборки. На собственном уровне списка ВЫБРАТЬ это +1 таб (поле всегда на
 * относительном табе 1); внешняя вложенность подзапроса сдвигает блок целиком и
 * сохраняет относительный отступ. Сверено живым оракулом validate_query: лист
 * `ЕСТЬNULL(Поле, "abc\n<N таб>def")` печатается как `…"abc\n<N+1 таб>def")`,
 * причём прибавка равна базовому отступу поля (0→1, 1→2, 4→5 на верхнем уровне;
 * 0→2 во вложенном подзапросе). Затрагиваем ТОЛЬКО переносы ВНУТРИ строкового
 * литерала — структурные переносы (раскладка ВЫБОР/И-ИЛИ) не трогаем, поэтому
 * скан учитывает кавычки и экранирование `""`.
 */
function indentStringLiteralNewlines(text: string, tabs: number): string {
  if (tabs <= 0 || !text.includes('\n') || !text.includes('"')) return text;
  const pad = '\t'.repeat(tabs);
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inStr && text[i + 1] === '"') { out += '""'; i++; continue; }
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === '\n' && inStr) { out += '\n' + pad; continue; }
    out += ch;
  }
  return out;
}

/**
 * Каноническое выражение произвольного поля выборки (без части `КАК <псевдоним>`).
 * Единый источник правды для одиночного запроса (`buildFieldLines`) и для ячеек
 * колонок объединения (`fieldExpr`): структурные выражения (ВЫБОР/ИЛИ/И) проходят
 * переотрисовку конструктора через `formatExpression(..., 'select')`, остальные —
 * только нормализацию регистра/пробелов листа.
 */
export function formatSelectExpression(expression: string): string {
  // Поле выборки-членство `Поле В (ВЫБРАТЬ … ИЗ …)`, набранное ИНЛАЙН (подзапрос на
  // одной строке): конструктор 1С РАЗВОРАЧИВАЕТ его — `Поле В` на строке поля, `(ВЫБРАТЬ`
  // на отступе 2, тело глубже, а часть `КАК Алиас` (её добавляет вызывающий) приклеивается
  // к строке закрытия `)` (фаза 6.16, MCP: `Поле В (ВЫБРАТЬ … ИЗ …) КАК А` всегда
  // раскрывается). reindentLeafSubquery инлайн не раскладывает. Через reflowInlineMembership-
  // Subquery (поле на ind=0, `(ВЫБРАТЬ` на subBase=2) перепарсиваем подзапрос и рендерим
  // канонически. Гейт узкий: `В (ВЫБРАТЬ` подряд, без верхнеуровневых OR/CASE (их ведёт
  // formatExpression), хвоста после подзапроса нет (псевдоним отделён) — иначе прежний путь.
  if (
    !needsFormatting(expression) &&
    !selectColumnNeedsBoolWrap(expression) &&
    /(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\(\s*ВЫБРАТЬ(?![\p{L}\p{N}_])/iu.test(expression.trim())
  ) {
    const reflowed = inlineSelectMembershipReflow(expression.trim());
    if (reflowed) return appendIsNotNullTrailingSpace(reflowed.join('\n'));
  }
  // Верхнеуровневая булева цепочка поля (`A И B КАК алиас`) переносится конструктором
  // даже без OR/CASE (фаза 6.16.71) — needsFormatting её не ловит, поэтому проверяем
  // отдельным select-предикатом. ОБА пути ведут в formatExpression('select').
  return needsFormatting(expression) || selectColumnNeedsBoolWrap(expression)
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
    : indentStringLiteralNewlines(appendIsNotNullTrailingSpace(normalizeLeafCase(reprintLeafArithmetic(reindentLeafBool(reindentLeafCase(reindentLeafSubquery(stripRedundantLeafParens(flattenMultilineLeaf(expression)), 2), 1, true), 1)))), 1);
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
  path: string,
  selectAlias?: string
): string {
  // Явно адресованный псевдоним выборки (когда несколько колонок делят (tableId,path)
  // под разными псевдонимами) печатается дословно — иначе first-match подставит чужой.
  if (selectAlias !== undefined) return selectAlias;
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
        // Голый псевдоним выборки — дословно (дизамбигуация полей с общим (tableId, path),
        // фаза 6.16.47).
        : f.selectAlias !== undefined
        ? f.selectAlias
        : f.qualified
        ? `${tableAliases.get(f.tableId) ?? f.tableId}.${f.path}`
        : sectionFieldRefText(model, tableAliases, f.tableId, f.path);
      // `ИЕРАРХИЯ` после поля упорядочивания конструктор 1С выводит, опираясь на то,
      // МОЖЕТ ли он переопределить иерархичность поля по схеме источника:
      //  • КВАЛИФИЦИРОВАННАЯ ссылка `<алиас>.<path>` на реальную таблицу МЕТАДАННЫХ
      //    (`Справочник.X`, `РегистрСведений.X`, ПВХ — fullName с точкой): конструктор
      //    знает схему и СОХРАНЯЕТ ИЕРАРХИЯ только для ИЕРАРХИЧЕСКОГО справочника/ПВХ
      //    либо для стандартного `…Ссылка` (всегда ссылочного); прочее (`Наименование`/
      //    `ЭтоГруппа`/…) — УБИРАЕТ (curated 0078). R3, 6.8.
      //  • Поле, адресованное ПСЕВДОНИМОМ ВЫБОРКИ (`f.selectAlias`): конструктор видит
      //    лишь псевдоним и НЕ может переопределить иерархичность → СОХРАНЯЕТ входной
      //    ИЕРАРХИЯ дословно — НО лишь когда источник всё же резолвим (метаданные/ВТ);
      //    у таблицы-параметра `&Имя` ИЕРАРХИЯ отбрасывается даже по псевдониму
      //    (golden DROP `Элемент` на `&ИмяТаблицы`).
      //  • ВРЕМЕННАЯ таблица `ВТ…`/результат `ПОМЕСТИТЬ` (fullName без точки и не `&`):
      //    схемы поля нет → конструктор СОХРАНЯЕТ входной ИЕРАРХИЯ (still `Подразделение`).
      //  • Таблица-параметр `&Имя`/подзапрос/нерезолвимое — ОТБРАСЫВАЕТ. Фаза 6.16.73.
      const lastSeg = f.path.split('.').pop();
      const ownerTable = model.tables.find(t => t.id === f.tableId);
      const resolvable = ownerTable !== undefined && ownerTable.subquery === undefined;
      const paramTable = ownerTable !== undefined && ownerTable.fullName.startsWith('&');
      const metadataTable = resolvable && !paramTable && ownerTable!.fullName.includes('.');
      const tempTable = resolvable && !paramTable && !ownerTable!.fullName.includes('.');
      const hierKeep =
        // Резолвимый источник, адресованный псевдонимом выборки (не &параметр): KEEP.
        (resolvable && !paramTable && f.selectAlias !== undefined) ||
        // Временная таблица (схемы нет): KEEP.
        tempTable ||
        // Квалифицированная ссылка на метаданные: KEEP лишь для иерарх./`…Ссылка`.
        (metadataTable && (ownerTable!.hierarchical || lastSeg === 'Ссылка'));
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
    // Квалифицированное группировочное поле, СОВПАДАЮЩЕЕ с колонкой выборки по
    // (tableId, path), конструктор 1С печатает по ПСЕВДОНИМУ этой колонки (а не
    // `<алиас>.<path>`): `ИТОГИ ПО ДанныеПула.ЗаказНаЭмиссию` → `ИТОГИ ПО
    // ЗаказНаЭмиссию`/`… КАК <алиас>` (MCP-проба, фаза 6.17). Применяем УЗКО:
    // ровно одна колонка выборки делит (tableId, path) и несёт псевдоним.
    const qualifiedSelectMatches = g.qualified && !g.expression
      ? model.fields.filter(f => f.tableId === g.tableId && f.path === g.path && f.alias)
      : [];
    const alias = g.expression
      ? g.expression
      : g.selectAlias !== undefined
      ? g.selectAlias
      : qualifiedSelectMatches.length === 1
      ? qualifiedSelectMatches[0].alias!
      : g.qualified
      ? `${tableAliases.get(g.tableId) ?? g.tableId}.${g.path}`
      : sectionFieldRefText(model, tableAliases, g.tableId, g.path);
    const as = g.alias ? ` КАК ${g.alias}` : '';
    const period = g.periodBy ? ` ${g.periodBy}` : '';
    // Модификатор ИЕРАРХИЯ/ТОЛЬКО ИЕРАРХИЯ конструктор отбрасывает, когда источник
    // поля — таблица-ПАРАМЕТР (`&ИмяТаблицы`): схемы (иерархичности) у него нет, тот
    // же критерий, что в УПОРЯДОЧИТЬ ПО (golden DROP на &параметре). Фаза 6.17.
    const ownerTable = model.tables.find(t => t.id === g.tableId);
    const paramTable = ownerTable !== undefined && ownerTable.fullName.startsWith('&');
    const kind = paramTable ? 'elements' : g.kind;
    byList.push(`${alias}${period}${totalKindSuffix(kind)}${as}`);
  }

  // Позиция колонки выборки в ИСХОДНОМ порядке (для сортировки агрегатов) по
  // ПСЕВДОНИМУ колонки: индекс элемента orderedSelectElements, чей псевдоним равен
  // операнду агрегата. Первое вхождение псевдонима.
  const selectPosByAlias = new Map<string, number>();
  orderedSelectElements(model).forEach((el, i) => {
    const a = elementAlias(el, model).toUpperCase();
    if (a !== '' && !selectPosByAlias.has(a)) selectPosByAlias.set(a, i);
  });

  // Рендер одного агрегата. Простой агрегат с распознанной колонкой-операндом
  // (func + operandAlias) печатается канонически ФУНКЦИЯ(<псевдонимКолонки>)
  // (операнд -> псевдоним, хвостовой КАК уже снят парсером). Прочие -- дословным
  // expression, либо СУММА(<псевдоним>) для legacy-формы без выражения.
  const renderAgg = (f: typeof totals.totalFields[number]): string => {
    if (f.func && f.operandAlias !== undefined) return wrapAggregate(f.func, f.operandAlias);
    if (f.expression === undefined) return `СУММА(${selectAliasFor(model, f.tableId, f.path)})`;
    // Многострочный ВЫБОР…КОНЕЦ в ИТОГИ (агрегат-в-CASE, напр. `ВЫБОР … ТОГДА
    // МАКСИМУМ(…) ИНАЧЕ СУММА(…) КОНЕЦ КАК …`) конструктор раскладывает по канону
    // относительно отступа агрегата (база 1; `withCommas` ниже добавляет ведущий таб
    // первой строке, поэтому реиндентируем к базе 1 и СНИМАЕМ его — он вернётся при
    // склейке). Иначе continuation-строки сохраняют исходный (пробельный) отступ
    // разработчика. Гейт узкий: многострочное выражение, содержащее слово ВЫБОР.
    if (f.expression.includes('\n') &&
        /(?:^|[^\p{L}\p{N}_])ВЫБОР(?:[^\p{L}\p{N}_]|$)/u.test(f.expression)) {
      return reindentLeafCase(normalizeLeafCase(f.expression), 1).replace(/^\t+/u, '');
    }
    return normalizeLeafCase(f.expression);
  };

  // Конструктор 1С СОРТИРУЕТ список агрегатов по позиции колонки-операнда в выборке
  // (стабильно): агрегаты над колонкой выборки -- по её порядку; агрегат, операнд
  // которого НЕ колонка (не распознан / параметр / выражение без совпадения), уходит
  // ПОСЛЕ всех распознанных, сохраняя исходный относительный порядок (фаза 6.16).
  const NOPOS = Number.MAX_SAFE_INTEGER;
  const posOf = (f: typeof totals.totalFields[number]): number => {
    const key = f.operandAlias ?? f.sortAlias;
    if (key === undefined) return NOPOS;
    const pos = selectPosByAlias.get(key.toUpperCase());
    return pos === undefined ? NOPOS : pos;
  };
  const ordered = totals.totalFields
    .map((f, seq) => ({ f, seq, pos: posOf(f) }))
    .sort((a, b) => (a.pos - b.pos) || (a.seq - b.seq));
  const aggList = ordered.map(o => renderAgg(o.f));

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
      : sectionFieldRefText(model, tableAliases, f.tableId, f.path, f.selectAlias);

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
  if (!hasFields) {
    // `ВЫБРАТЬ *` по источнику без метаданных (временная `#`/`Вт`-таблица) сворачивает
    // звезду в НОЛЬ колонок: оракул печатает пустые секции ВЫБРАТЬ/ИЗ (две пустые
    // строки) и СОХРАНЯЕТ хвостовые секции (`УПОРЯДОЧИТЬ ПО`/`ИТОГИ`/`ИНДЕКСИРОВАТЬ`).
    // Без хвоста запрос остаётся пустым (как раньше).
    const oLines = renderOrder(model.order, model, false);
    const tLines = renderTotals(model.totals, model);
    const iLines = renderIndex(model.indexing, model);
    let tail = '';
    if (oLines.length > 0) tail += '\n\n' + oLines.join('\n');
    if (tLines.length > 0) tail += '\n' + tLines.join('\n');
    if (iLines.length > 0) tail += '\n\n' + iLines.join('\n');
    tail += renderAutoOrder(model.order, oLines.length > 0 || tLines.length > 0 || iLines.length > 0);
    return tail ? '\n\n' + tail.replace(/^\n+/, '') : '';
  }

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
  // АВТОУПОРЯДОЧИВАНИЕ — всегда последняя строка, отбивается ОДНИМ `\n` от тела
  // (и от предшествующей секции порядок/ИТОГИ/индекс). Конструктор 1С не вставляет
  // пустую строку перед бесхозным АВТОУПОРЯДОЧИВАНИЕ (фаза 6.16.46).
  void hadSection;
  return '\n' + 'АВТОУПОРЯДОЧИВАНИЕ';
}

/**
 * Блоки участников СКАЛЯРНОГО объединения (без проекций ТЧ) — прежний путь через
 * deriveUnionColumns: ровно по `model.fields`, позиционно.
 */
function buildUnionBlocksScalar(members: UnionMember[]): string[] {
  const columns = deriveUnionColumns(members);
  // Внутри подзапроса-условия (`В (ВЫБРАТЬ … ОБЪЕДИНИТЬ …)`) конструктор НЕ
  // добавляет авто-псевдоним полю участника 0 (как и в не-union В-подзапросе,
  // suppressAutoAlias); ЯВНЫЙ псевдоним при этом сохраняется (MCP validate_query).
  const head0 = members[0]?.model.fields ?? [];
  return members.map((m, i) => {
    const fieldLines = columns.map((col, ci) => {
      const expr = col.cells[i] ?? 'NULL';
      if (i !== 0) return `\t${expr}`;
      const a0 = head0[ci]?.alias;
      const explicitAlias = a0 !== undefined && !/^Поле\d+$/u.test(a0);
      const emitAlias = !suppressAutoAlias || explicitAlias;
      return emitAlias ? `\t${expr} КАК ${col.alias}` : `\t${expr}`;
    });
    const aliases = resolveAliases(m.model.tables);
    return buildQueryBlock(m.model, fieldLines, aliases);
  });
}

/**
 * Блоки участников объединения С ПРОЕКЦИЕЙ ТЧ. Столбцы выравниваются позиционно по
 * `orderedSelectElements` (скалярные поля + проекции ТЧ + хвостовые поля в порядке
 * selectOrder). Скалярный столбец рендерится как раньше (`fieldExpr` + псевдоним у
 * участника 0); проекция ТЧ — многострочной (renderTabProjection): у участника 0 с
 * псевдонимами (внешним и колонок), у остальных — голой (suppress). Отсутствующий
 * у участника столбец → `NULL` (фаза 6.16).
 */
function buildUnionBlocksWithTabSection(members: UnionMember[]): string[] {
  const memberEls = members.map(m => orderedSelectElements(m.model));
  const width = memberEls.reduce((w, els) => Math.max(w, els.length), 0);
  const head = memberEls[0] ?? [];
  return members.map((m, i) => {
    const aliases = resolveAliases(m.model.tables);
    const fieldLines: string[] = [];
    for (let ci = 0; ci < width; ci++) {
      const el = memberEls[i][ci];
      if (el === undefined) { fieldLines.push('\tNULL'); continue; }
      if (el.kind === 'ts') {
        fieldLines.push(renderTabProjection(m.model, el.tsf, aliases, { suppress: i !== 0 }));
        continue;
      }
      const expr = fieldExpr(m.model, el.field);
      if (i !== 0) { fieldLines.push(`\t${expr}`); continue; }
      // Псевдоним столбца берём с поля участника-головы (его псевдоним выборки).
      const alias = elementAlias(el, m.model);
      const explicitAlias = !/^Поле\d+$/u.test(alias);
      const emitAlias = !suppressAutoAlias || explicitAlias;
      fieldLines.push(emitAlias ? `\t${expr} КАК ${alias}` : `\t${expr}`);
    }
    return buildQueryBlock(m.model, fieldLines, aliases);
  });
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

  // Объединение с проекцией ТЧ выравнивается по ПОЛНОМУ списку элементов выборки
  // (скалярные поля + проекции ТЧ + хвостовые поля, в порядке selectOrder) — иначе
  // проекция ТЧ и всё после неё терялись (только `model.fields` шли в столбцы,
  // фаза 6.16). Скалярные объединения — прежним путём (deriveUnionColumns).
  const blocks = unionHasTabSection(members) || unionHasTrailing(members)
    ? buildUnionBlocksWithTabSection(members)
    : buildUnionBlocksScalar(members);

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
  // Хвостовой разделитель без завершающего перевода строки: пакет, чей ПОСЛЕДНИЙ
  // оператор дал пустое тело (`ВЫБРАТЬ * ПОМЕСТИТЬ … ИЗ &Параметр` — звезда по
  // параметру разворачивается в ноль колонок), конструктор всё равно завершает
  // разделителем-«хвостом» (`\n;\n\n////…` без `\n` в конце; golden-корпус, MCP).
  const TAIL_SEP = '\n;\n\n' + '/'.repeat(80);
  const members = batch.members;
  if (members.length === 0) return '';
  if (members.length === 1) return generateDocument(members[0]);

  // Тело каждого оператора. Пустые тела (нерезолвимая звезда и т. п.) НЕ участвуют
  // как блоки, но отслеживаются: пустой ПОСЛЕДНИЙ оператор оставляет хвостовой
  // разделитель (асимметрия конструктора — пустой оператор В СЕРЕДИНЕ отбрасывается
  // полностью, MCP-проба).
  const rendered = members.map(generateDocument);
  const blocks = rendered.filter(b => b !== '');
  const out = blocks.join(SEP);
  const lastEmpty = rendered[rendered.length - 1] === '';
  // Хвост ставим только если есть хоть один непустой блок (иначе пакет пуст).
  return lastEmpty && blocks.length > 0 ? out + TAIL_SEP : out;
}

/** Рендер поля группировки `Псевдоним.Поле` по той же карте псевдонимов. */
function fieldRefExpr(f: FieldRef, aliases: Map<string, string>): string {
  // Произвольное выражение группировки (`ГОД(Т.Дата)`, `ВЫБОР … КОНЕЦ`) —
  // переотрисовываем тем же форматтером, что и выражения секции ВЫБРАТЬ.
  if (f.expression) return formatSelectExpression(f.expression);
  const tableAlias = aliases.get(f.tableId) ?? f.tableId;
  return `${tableAlias}.${f.path}`;
}

const AGG_WORDS_GROUP = new Set(['СУММА', 'КОЛИЧЕСТВО', 'МАКСИМУМ', 'МИНИМУМ', 'СРЕДНЕЕ']);
const DISPLAY_META_WORDS = new Set(['ЗНАЧЕНИЕ', 'ТИП', 'ПРЕДСТАВЛЕНИЕ', 'ПРЕДСТАВЛЕНИЕССЫЛКИ']);
/**
 * Разбор произвольного выражения выборки (`ВЫБОР…КОНЕЦ`, `ЕСТЬNULL(…)`,
 * `ВЫРАЗИТЬ(…)`, арифметика) на: (а) содержит ли оно агрегат
 * (`СУММА/КОЛИЧЕСТВО/МАКСИМУМ/МИНИМУМ/СРЕДНЕЕ`) и (б) множество текстов точечных
 * полей-цепочек `Алиас.Поле…`, считающихся ссылками НА ДАННЫЕ. Полем НЕ считаются:
 *   - аргументы агрегатов;
 *   - содержимое display/meta-вызовов `ЗНАЧЕНИЕ/ТИП/ПРЕДСТАВЛЕНИЕ/ПРЕДСТАВЛЕНИЕССЫЛКИ`;
 *   - имя ТИПА после `КАК` (приведение `ВЫРАЗИТЬ(… КАК Справочник.X)`) и после
 *     оператора `ССЫЛКА` (`Поле ССЫЛКА Документ.X`).
 * Результат используется для решения, дописывать ли выражение целиком в
 * СГРУППИРОВАТЬ ПО (см. appendMissingGroupRefs). Тексты полей берутся в исходном
 * написании, чтобы сравниваться с отрендеренным списком группировки.
 * Возвращает `undefined` при ошибке токенизации.
 */
function analyzeGroupExpr(expression: string): { hasAgg: boolean; fields: string[] } | undefined {
  let toks;
  try { toks = tokenize(expression); } catch { return undefined; }
  const sig = toks.filter(t => t.type !== 'eof');
  let depth = 0;
  const aggDepths: number[] = [];
  const metaDepths: number[] = [];
  let hasAgg = false;
  const fields: string[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type === 'punct' && t.value === '(') {
      const head = sig[i - 1];
      const headV = head ? (head.text ?? head.value).toUpperCase() : '';
      depth++;
      if (AGG_WORDS_GROUP.has(headV)) { aggDepths.push(depth); hasAgg = true; }
      else if (DISPLAY_META_WORDS.has(headV)) metaDepths.push(depth);
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      if (aggDepths.length && aggDepths[aggDepths.length - 1] === depth) aggDepths.pop();
      if (metaDepths.length && metaDepths[metaDepths.length - 1] === depth) metaDepths.pop();
      if (depth > 0) depth--;
      continue;
    }
    if (t.type === 'ident' || t.type === 'keyword') {
      const prev = sig[i - 1];
      const next = sig[i + 1];
      if (prev && prev.type === 'punct' && prev.value === '.') continue; // хвост цепочки
      const prevV = prev ? (prev.text ?? prev.value).toUpperCase() : '';
      // Имя ТИПА метаданных, а не поле: после `КАК` (приведение `ВЫРАЗИТЬ(… КАК Тип)`)
      // или после оператора проверки типа `… ССЫЛКА Тип`. Точечная цепочка тут —
      // составное имя типа (`Справочник.Номенклатура`, `Документ.ПоступлениеВКассу`).
      if (prevV === 'КАК' || prevV === 'ССЫЛКА') continue;
      const dotted = next && next.type === 'punct' && next.value === '.';
      if (!dotted) continue; // голый идентификатор/имя функции — не поле
      if (aggDepths.length || metaDepths.length) continue; // под агрегатом / ЗНАЧЕНИЕ / ПРЕДСТАВЛЕНИЕ
      // Собираем полный текст точечной цепочки `Алиас.Поле.Поле…`.
      let chain = t.text ?? t.value;
      let j = i + 1;
      while (j + 1 < sig.length && sig[j].type === 'punct' && sig[j].value === '.'
             && (sig[j + 1].type === 'ident' || sig[j + 1].type === 'keyword')) {
        chain += '.' + (sig[j + 1].text ?? sig[j + 1].value);
        j += 2;
      }
      fields.push(chain);
    }
  }
  return { hasAgg, fields };
}

/**
 * НЕагрегатные ПРОСТЫЕ поля ВЫБРАТЬ (в порядке выборки), которых не хватает в
 * исходном списке группировки `existing`, — для дополнения СГРУППИРОВАТЬ ПО.
 * Сопоставление по ОТРЕНДЕРЕННОМУ тексту (тот же `fieldRefExpr`, что и у
 * группировки), с учётом КРАТНОСТИ: поле, встречающееся в ВЫБРАТЬ N раз и в
 * группировке M<N раз, дополняется (N−M) раз (дубли разных псевдонимов, напр.
 * `Т.Дата КАК Период, Т.Дата КАК ДатаДокумента` → второе `Т.Дата`).
 * Агрегаты и произвольные выражения здесь НЕ дописываются (см. ниже).
 */
function appendMissingGroupRefs(
  model: QueryModel,
  existing: FieldRef[],
  aliases: Map<string, string>
): FieldRef[] {
  // Счётчик уже покрытых группировкой вхождений по тексту.
  const covered = new Map<string, number>();
  // Множество ПРОСТЫХ точечных полей, уже присутствующих в группировке (по
  // отрендеренному тексту). Нужно для SQL-проверки зависимостей выражений: если
  // ВСЕ поля выражения уже сгруппированы по отдельности, выражение целиком в
  // группировку НЕ дописывается (`ЕСТЬNULL(Т.Поле,0)` при `Т.Поле` в группировке).
  const existingFieldTexts = new Set<string>();
  for (const f of existing) {
    const key = fieldRefExpr(f, aliases);
    covered.set(key, (covered.get(key) ?? 0) + 1);
    if (f.expression === undefined) existingFieldTexts.add(key);
  }
  const out: FieldRef[] = [];
  // Поля, агрегированные через ОТДЕЛЬНЫЙ список `grouping.aggregates` (модель webview,
  // где агрегат не помечен на самом поле через `func`): такие поля — агрегаты, в
  // группировку не дописываются. Без этого корректная группировка из конструктора UI
  // (СУММА по `aggregates`, поле в выборке скаляром) ошибочно дописывала бы агрегат.
  const aggregated = new Set<string>();
  for (const a of model.grouping?.aggregates ?? []) {
    aggregated.add(`${a.tableId} ${a.path}`);
  }
  // Кандидаты — скалярные НЕагрегатные поля выборки (головные + хвостовые после ТЧ),
  // в порядке выборки. Проекции ТЧ в группировку не участвуют.
  const candidates = [...model.fields, ...(model.trailingFields ?? [])];
  for (const f of candidates) {
    if (f.func !== undefined) continue; // агрегат (на поле) — не группируется
    if (aggregated.has(`${f.tableId} ${f.path}`)) continue; // агрегат (в grouping.aggregates)
    // Произвольное выражение выборки (`ЕСТЬNULL(…)`, `ВЫБОР…`, `ВЫРАЗИТЬ(…)`).
    // Дописываем ЦЕЛИКОМ по SQL-семантике зависимостей GROUP BY тогда и только тогда,
    // когда выражение:
    //   1) НЕ содержит агрегата (агрегатное выражение само не группируется; его
    //      НЕагрегированные подссылки — отдельный кейс декомпозиции, здесь не делаем);
    //   2) ссылается ≥1 раз на поле таблицы вне ЗНАЧЕНИЕ/ТИП/ПРЕДСТАВЛЕНИЕ;
    //   3) ХОТЯ БЫ ОДНА такая полевая ссылка ещё НЕ покрыта группировкой по отдельности
    //      (если ВСЕ поля выражения уже сгруппированы — выражение валидно как есть и
    //      конструктор его НЕ дописывает, сверено живым оракулом validate_query).
    // Сопоставление с существующей группировкой — по ОТРЕНДЕРЕННОМУ тексту.
    if (f.expression !== undefined) {
      const info = analyzeGroupExpr(f.expression);
      if (!info || info.hasAgg || info.fields.length === 0) continue;
      const ref: FieldRef = { tableId: '', path: '', expression: f.expression };
      const key = fieldRefExpr(ref, aliases);
      const need = covered.get(key) ?? 0;
      if (need > 0) { covered.set(key, need - 1); continue; } // выражение уже в группировке
      // Все поля выражения уже сгруппированы по отдельности → не дописываем.
      const allCovered = info.fields.every(fld => existingFieldTexts.has(fld));
      if (allCovered) continue;
      out.push(ref);
      continue;
    }
    if (f.tableId === '' || f.path === '') continue;
    const ref: FieldRef = { tableId: f.tableId, path: f.path };
    const key = fieldRefExpr(ref, aliases);
    const need = covered.get(key) ?? 0;
    if (need > 0) { covered.set(key, need - 1); continue; }
    out.push(ref);
  }
  return out;
}

/**
 * Перекладка дублей в списке СГРУППИРОВАТЬ ПО под порядок конструктора 1С (фаза
 * 6.16, кластер reorder). Конструктор НЕ сохраняет позиции повторов ЯВНОГО списка
 * группировки: применяет СТАБИЛЬНУЮ дедупликацию ЯВНОЙ части — сначала идут все
 * различные поля (в порядке первого появления), затем «хвост» из лишних копий В
 * ИСХОДНОМ порядке, и лишь ПОТОМ автодописанные парсером расширения выборки.
 * Так явное `…A, B, A, C, B…` → `…A, B, C, A, B`, а явное `…A, B, A` (дубль в
 * конце) — фиксированная точка, остаётся как есть. Поле, дописанное генератором
 * из ВЫБРАТЬ (`appended`), встаёт в хвост явной части сразу ПОСЛЕ последней копии
 * того же поля (примыкает к своим дублям), иначе — в самый конец. Если дублей в
 * явной части нет И дописок нет — порядок НЕ меняется (байт-в-байт как раньше).
 *
 * @param fields       grouping.groupFields (явные + автодописанные парсером)
 * @param explicitCount граница явной части в `fields`
 * @param appended     поля, дописанные генератором (appendMissingGroupRefs)
 */
function clusterGroupDuplicates(
  fields: FieldRef[],
  explicitCount: number,
  appended: FieldRef[],
  aliases: Map<string, string>
): FieldRef[] {
  const explicit = fields.slice(0, explicitCount);
  const parserAppended = fields.slice(explicitCount);
  // Индекс ПОСЛЕДНЕГО произвольного выражения (`ВЫБОР…`, `ЕСТЬNULL(…)`) в явной части.
  // Выражения — НЕПОДВИЖНЫЕ якоря: дубль простого поля, после которого (по индексу)
  // ещё есть выражение, конструктор 1С НЕ переносит в конец (он остаётся на месте);
  // переносятся лишь дубли из «хвостового» простого участка (после последнего ВЫБОР).
  // ИСКЛЮЧЕНИЕ (фаза 6.16, корпус ОтчётКомиссионера_24): дубль простого поля,
  // непосредственно за которым идёт ХВОСТОВОЙ блок выражений до конца списка (т.е.
  // выражение(я) — последние элементы, и сам дубль НЕ дублируется вместе с ними как
  // повторяющийся блок), конструктор переносит ЗА эти выражения. Точный триггер:
  // дубль на позиции i, после которого до конца идут ТОЛЬКО выражения, КАЖДОЕ из
  // которых уникально (не повтор более раннего) — тогда это «хвостовой» дубль перед
  // финальным CASE, и он уезжает в самый конец (сверено живым оракулом: `Код, Код,
  // ВЫБОР` → `Код, ВЫБОР, Код`). Повторяющийся блок `…, Код, Артикул, ВЫБОР` (где ВЫБОР —
  // дубль) этим триггером НЕ затрагивается: его ВЫБОР не уникален.
  let lastExprIdx = -1;
  for (let i = 0; i < explicit.length; i++) {
    if (explicit[i].expression !== undefined) lastExprIdx = i;
  }
  // Множество текстов выражений, встречающихся в явной части БОЛЕЕ ОДНОГО раза
  // (повторяющиеся выражения — часть повторяющегося блока, не «финальный CASE»).
  const exprCounts = new Map<string, number>();
  for (const f of explicit) {
    if (f.expression !== undefined) {
      const k = fieldRefExpr(f, aliases);
      exprCounts.set(k, (exprCounts.get(k) ?? 0) + 1);
    }
  }
  // Признак: всё, что стоит ПОСЛЕ позиции i (до конца явной части), — только
  // УНИКАЛЬНЫЕ выражения (финальный хвост из CASE без повторов). Для такого дубля
  // действует ИСКЛЮЧЕНИЕ (перенос за выражения).
  const tailIsUniqueExprsAfter = (i: number): boolean => {
    let sawExpr = false;
    for (let j = i + 1; j < explicit.length; j++) {
      const f = explicit[j];
      if (f.expression === undefined) return false; // ещё есть простое поле — не финальный хвост
      if ((exprCounts.get(fieldRefExpr(f, aliases)) ?? 0) > 1) return false; // повторяющийся блок
      sawExpr = true;
    }
    return sawExpr;
  };
  const movable = (i: number): boolean => i > lastExprIdx || tailIsUniqueExprsAfter(i);
  // Быстрый выход: в ЯВНОЙ части нет переносимых дублей и нет дописок → как раньше.
  if (appended.length === 0) {
    const seen = new Set<string>();
    let hasMovableDup = false;
    for (let i = 0; i < explicit.length; i++) {
      const f = explicit[i];
      if (f.expression !== undefined) continue;
      const k = fieldRefExpr(f, aliases);
      if (seen.has(k) && movable(i)) { hasMovableDup = true; break; }
      seen.add(k);
    }
    if (!hasMovableDup) return fields;
  }
  // Стабильная дедупликация ЯВНОЙ части: различные поля → core; лишняя копия → tail
  // ТОЛЬКО если она переносима (movable: после её позиции нет выражения-якоря ЛИБО
  // дальше только уникальные хвостовые CASE), иначе остаётся на месте (core).
  const core: FieldRef[] = [];
  const tail: FieldRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < explicit.length; i++) {
    const f = explicit[i];
    if (f.expression !== undefined) { core.push(f); continue; }
    const k = fieldRefExpr(f, aliases);
    if (!seen.has(k)) { seen.add(k); core.push(f); }
    else if (movable(i)) tail.push(f);
    else core.push(f);
  }
  // Дописанные генератором поля встают в хвост явной части, примыкая к последней
  // копии того же поля; если такого поля в хвосте нет — в самый конец хвоста.
  for (const a of appended) {
    const k = fieldRefExpr(a, aliases);
    let pos = -1;
    for (let i = 0; i < tail.length; i++) {
      if (fieldRefExpr(tail[i], aliases) === k) pos = i;
    }
    if (pos >= 0) tail.splice(pos + 1, 0, a);
    else tail.push(a);
  }
  return [...core, ...tail, ...parserAppended];
}

/**
 * Кратность НЕагрегатных ПРОСТЫХ полей ВЫБРАТЬ (голова + хвост), по
 * отрендеренному тексту `Алиас.Путь`. Поле выборки с агрегатом (`func`) или
 * произвольным выражением (`expression`) не учитывается — оно не порождает
 * группировку. Дубли разных псевдонимов одного поля (`Т.Док КАК Документ,
 * Т.Док КАК ДокументПродажи`) дают кратность 2.
 */
function selectFieldMultiplicity(
  model: QueryModel,
  aliases: Map<string, string>
): Map<string, number> {
  const m = new Map<string, number>();
  const aggregated = new Set<string>();
  for (const a of model.grouping?.aggregates ?? []) {
    aggregated.add(`${a.tableId} ${a.path}`);
  }
  const candidates = [...model.fields, ...(model.trailingFields ?? [])];
  for (const f of candidates) {
    if (f.func !== undefined) continue;
    if (f.expression !== undefined) {
      // Произвольное выражение выборки (`ВЫБОР…КОНЕЦ`) тоже порождает кратность —
      // его дубли в группировке урезаются до числа вхождений в ВЫБРАТЬ. Агрегатные
      // выражения исключаем: они не группируются (свой ключ в группировку не идёт).
      const info = analyzeGroupExpr(f.expression);
      if (info && info.hasAgg) continue;
      const key = fieldRefExpr({ tableId: '', path: '', expression: f.expression }, aliases);
      m.set(key, (m.get(key) ?? 0) + 1);
      continue;
    }
    if (f.tableId === '' || f.path === '') continue;
    if (aggregated.has(`${f.tableId} ${f.path}`)) continue;
    const key = fieldRefExpr({ tableId: f.tableId, path: f.path }, aliases);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/**
 * Ограничение кратности ДУБЛЕЙ простого поля в ЯВНОМ списке группировки до числа
 * его НЕагрегатных вхождений в ВЫБРАТЬ (сверено корпусом: исходный
 * `СГРУППИРОВАТЬ ПО … Период … Период` при единственном `Период` в выборке
 * конструктор 1С схлопывает до одного, тогда как `Документ` с двумя псевдонимами
 * в выборке сохраняет обе копии). Удаляются ПОЗДНИЕ лишние копии (ранние позиции
 * сохраняются). Капается ТОЛЬКО поле, присутствующее в выборке (кратность > 0):
 * поля группировки, которых в выборке нет вовсе, не трогаем (отдельная семантика).
 * Произвольные выражения и поля вне выборки — фиксированные точки.
 * Возвращает новый список ИЛИ исходный (если ничего не урезано — байт-в-байт).
 */
function capGroupDuplicatesToSelect(
  fields: FieldRef[],
  explicitCount: number,
  selectMult: Map<string, number>,
  aggregatedTexts: Set<string>,
  aliases: Map<string, string>
): FieldRef[] {
  const kept: FieldRef[] = [];   // явная часть (в исходном порядке)
  const tail: FieldRef[] = [];   // автодописанное парсером (i >= explicitCount)
  const seen = new Map<string, number>();
  let changed = false;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (i >= explicitCount) { tail.push(f); continue; }
    const key = fieldRefExpr(f, aliases);
    const cap = selectMult.get(key);
    if (cap === undefined) {
      // Произвольное выражение группировки, которого НЕТ отдельной колонкой выборки,
      // конструктор 1С отбрасывает, если ВСЕ его полевые ссылки — АГРЕГИРУЕМЫЕ поля:
      // такое выражение зависит лишь от агрегата и группой быть не может (сверено
      // корпусом: трейлинг `ВЫБОР КОГДА …Количество > 0 …` при `СУММА(Количество)` в
      // выборке отбрасывается). Прочие поля/выражения вне выборки оставляем как есть
      // (попытки урезать/переставлять многосегментные пути и сами выражения по
      // структуре давали регрессии — поведение конструктора зависит от метаданных).
      if (f.expression !== undefined) {
        const info = analyzeGroupExpr(f.expression);
        if (info && !info.hasAgg && info.fields.length > 0
            && info.fields.every(fld => aggregatedTexts.has(fld))) {
          changed = true; continue;
        }
      }
      kept.push(f); continue;
    }
    const cnt = (seen.get(key) ?? 0);
    if (cnt >= cap) { changed = true; continue; } // лишняя копия — отбрасываем
    seen.set(key, cnt + 1);
    kept.push(f);
  }
  return changed ? [...kept, ...tail] : fields;
}

/**
 * Секция СГРУППИРОВАТЬ ПО (или ГРУППИРУЮЩИМ НАБОРАМ). Возвращает [] если
 * группировка не задана или неактивна — тогда вывод байт-в-байт как раньше.
 */
function renderGrouping(
  grouping: QueryModel['grouping'],
  aliases: Map<string, string>,
  model?: QueryModel
): string[] {
  if (!grouping) return [];

  if (!grouping.multiple) {
    // Голый параметр `&Имя` в списке группировки конструктор 1С отбрасывает
    // (нельзя группировать по параметру) — фаза 6.15.11a, MCP. Удаляем такие
    // элементы; прочие выражения с параметром внутри (`ВЫРАЗИТЬ(… &Имя …)`) остаются.
    const fieldsRaw = grouping.groupFields.filter(f => !isConstGroupExpr(f.expression));
    // Граница явной части: `explicitGroupCount` считался до фильтрации `isConstGroupExpr`,
    // поэтому пересчитываем её относительно отфильтрованного списка.
    const rawExplicitRaw = grouping.explicitGroupCount ?? grouping.groupFields.length;
    const explicitCountRaw = grouping.groupFields
      .slice(0, rawExplicitRaw)
      .filter(f => !isConstGroupExpr(f.expression)).length;
    // Урезание дублей простого поля в ЯВНОЙ части до кратности в ВЫБРАТЬ.
    const selectMult = model ? selectFieldMultiplicity(model, aliases) : new Map<string, number>();
    // Тексты агрегируемых полей (для отбрасывания выражений, зависящих лишь от
    // агрегата). Берём из выборки (`func`) и из grouping.aggregates.
    const aggregatedTexts = new Set<string>();
    for (const f of (model?.fields ?? [])) {
      if (f.func !== undefined && f.tableId && f.path) {
        aggregatedTexts.add(fieldRefExpr({ tableId: f.tableId, path: f.path }, aliases));
      }
    }
    for (const a of (model?.grouping?.aggregates ?? [])) {
      aggregatedTexts.add(fieldRefExpr({ tableId: a.tableId, path: a.path }, aliases));
    }
    const fields = model
      ? capGroupDuplicatesToSelect(fieldsRaw, explicitCountRaw, selectMult, aggregatedTexts, aliases)
      : fieldsRaw;
    // Пересчёт границы явной части после урезания: число элементов с индексом
    // < explicitCountRaw, оставшихся в `fields` (выражения и неурезанные поля).
    const explicitCount = fields.length === fieldsRaw.length
      ? explicitCountRaw
      : explicitCountRaw - (fieldsRaw.length - fields.length) >= 0
        ? // все урезанные были в явной части (cap трогает только явную)
          explicitCountRaw - (fieldsRaw.length - fields.length)
        : 0;
    // Согласование СГРУППИРОВАТЬ ПО с НЕагрегатными полями ВЫБРАТЬ (фаза 6.16):
    // конструктор 1С дописывает в группировку каждое НЕагрегатное ПРОСТОЕ поле
    // выборки, которого в исходной группировке НЕ ХВАТАЕТ (по числу вхождений
    // отрендеренного текста), в порядке следования в ВЫБРАТЬ. Так воспроизводятся
    // дубли (`Т.Дата КАК Период, Т.Дата КАК ДатаДокумента` → второе `Т.Дата`).
    // Здесь реализована только консервативная (нулевые регрессии) половина правила:
    // ОТБРАСЫВАНИЕ полей группировки и ДОПИСЫВАНИЕ произвольных выражений (`ВЫБОР…`,
    // `ЕСТЬNULL(…)`, `ПОДСТРОКА(…)`) требует полной SQL-семантики зависимостей
    // GROUP BY (выражение дописывается лишь когда его поле НЕ сгруппировано) — не
    // делаем, чтобы не сломать множество проходящих случаев.
    // Дописываем ТОЛЬКО при АКТИВНОЙ группировке (есть хотя бы одно явное поле
    // группировки): пустой список = группировки нет, и дописка не должна порождать
    // секцию СГРУППИРОВАТЬ ПО на ровном месте.
    const appended = model && fields.length > 0 ? appendMissingGroupRefs(model, fields, aliases) : [];
    const all = clusterGroupDuplicates(fields, explicitCount, appended, aliases);
    if (all.length === 0) return [];
    const lines = all.map((f, i) => {
      const comma = i < all.length - 1 ? ',' : '';
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
/**
 * ИМЕЮЩИЕ: конъюнкт-условие, ЦЕЛИКОМ являющийся вызовом `МАКСИМУМ(X)`/`МИНИМУМ(X)`
 * БЕЗ обрамляющего сравнения/арифметики (т.е. агрегат булева выражения используется
 * как самостоятельное условие), конструктор 1С печатает БЕЗ агрегатной обёртки —
 * как просто `X` (сверено живым оракулом validate_query: `МАКСИМУМ(Т.Флаг) И
 * МИНИМУМ(Т.Флаг)` → `Т.Флаг И Т.Флаг`, тогда как `МАКСИМУМ(Т.Код) > 0` и
 * `КОЛИЧЕСТВО(…) > 1` остаются как есть). СУММА/КОЛИЧЕСТВО/СРЕДНЕЕ не разворачиваем
 * (для них голый булев результат недопустим). Возвращает аргумент агрегата либо
 * исходный текст, если разворот не применим.
 */
function unwrapHavingMaxMin(expr: string): string {
  const flat = expr.trim();
  const m = /^(МАКСИМУМ|МИНИМУМ)\s*\(/iu.exec(flat);
  if (!m) return expr;
  let toks;
  try { toks = tokenize(flat); } catch { return expr; }
  const sig = toks.filter(t => t.type !== 'eof');
  // Первый значимый токен — имя агрегата, второй — открывающая `(`.
  if (sig.length < 3 || sig[1].type !== 'punct' || sig[1].value !== '(') return expr;
  // Находим парную закрывающую скобку для `sig[1]`; она ДОЛЖНА быть последним токеном
  // (иначе после агрегата идёт хвост — сравнение/оператор — и разворот неверен).
  let depth = 0;
  let closeIdx = -1;
  for (let i = 1; i < sig.length; i++) {
    if (sig[i].type === 'punct' && sig[i].value === '(') depth++;
    else if (sig[i].type === 'punct' && sig[i].value === ')') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx !== sig.length - 1) return expr;
  // Аргумент — текст между внутренней частью скобок (исходные срезы, регистр позже
  // нормализует normalizeLeafCase в общем тракте).
  const innerStart = sig[1].pos + 1;
  const innerEnd = sig[closeIdx].pos;
  return flat.slice(innerStart, innerEnd).trim();
}

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
      // `(a, b) НЕ В …` → `НЕ (a, b) В …` (фаза 6.16.59): конструктор 1С печатает
      // отрицание членства КОРТЕЖА с `НЕ` ПЕРЕД кортежем, а не между кортежем и `В`.
      // Ведущее `НЕ` подхватывает reindentLeafSubquery (+1 к отступу подзапроса) —
      // как у обычного `НЕ X В (…)`. Только для кортежа (скобка с верхнеуровневой
      // запятой); одиночный операнд `X НЕ В` сюда не попадает.
      let expr = moveNotBeforeTuple((c.expression ?? '').trim());
      // ИМЕЮЩИЕ: голый агрегат МАКСИМУМ/МИНИМУМ булева выражения как самостоятельный
      // конъюнкт конструктор печатает без обёртки (см. unwrapHavingMaxMin).
      if (slot === 'having') expr = unwrapHavingMaxMin(expr);
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
      // ВЫБОР внутри листа-условия ГДЕ/ИМЕЮЩИЕ конструктор отступает на один уровень
      // ГЛУБЖЕ, чем в листе поля выборки (КОНЕЦ = отступ листа + 1 + число обрамляющих
      // ВЫЗОВ-функции скобок) — то есть базовый отступ CASE здесь `subBase − 1`
      // (root ГДЕ: subBase=3 → base=2; внутри В-подзапроса/ИМЕЮЩИЕ: subBase=2 → base=1).
      // MCP-пробы оракула: `ГДЕ ЕСТЬNULL(ВЫБОР…)` даёт КОНЕЦ на 3 (поле — на 2).
      // Ведущее `НЕ` листового условия (`НЕ СУММА(ВЫБОР…) ЕСТЬ NULL`) сдвигает CASE
      // на +1: как и подзапрос (см. reindentLeafSubquery, «ведущие НЕ добавляют +1»),
      // конструктор отступает ВЫБОР под `НЕ` на уровень глубже. База без `НЕ` —
      // прежняя `subBase − 1` (ГДЕ: 2, ИМЕЮЩИЕ/В-подзапрос: 1), байт-в-байт.
      const leadsWithNot = /^НЕ(?![\p{L}\p{N}_])/u.test(flattenMultilineLeaf(expr).trimStart());
      const caseBaseLeaf = subBase - 1 + (leadsWithNot ? 1 : 0);
      // Канонизация операндов сравнения (`&П = Поле` → `Поле = &П`) в ГДЕ/ИМЕЮЩИЕ —
      // только для простого листа-сравнения (не formatExpression, не ПО). Фаза 6.16.76.
      // Лист-условие ГДЕ верхнего уровня (НЕ внутри подзапроса): одиночный `В (&П)`
      // оракул печатает БЕЗ пробела (`В(&П)`), как структурный путь — даже когда
      // условие стало произвольным листом из-за переквалификации голого поля.
      const tightenIn = (s: string): string =>
        slot === 'where' && !inConditionSubquery ? tightenLeafInOperator(s) : s;
      if (expr) conds.push(needsFormatting(expr) || isRootNotGroup(expr) ? formatExpression(expr, slot, inConditionSubquery ? 1 : undefined) : appendIsNotNullTrailingSpace(tightenIn(stripNotFieldParens(stripNegatedFieldParens(wrapBareCastOperand(stripRedundantLeafParens(normalizeLeafCase(reindentLeafCase(reindentLeafSubquery(canonicalizeComparisonOperands(flattenMultilineLeaf(expr)), subBase), caseBaseLeaf, true)))))))));
      continue;
    }
    // Нессылочный левый операнд `В`-подзапроса (`1 В (ВЫБРАТЬ …)`, фаза 6.15.27):
    // печатаем сам текст LHS перед `В`, дальше — структурный подзапрос как обычно.
    // path при этом не задан; обрабатываем до гейта `!c.path`.
    if (c.leftExpr && c.subquery) {
      const subBase = (inConditionSubquery ? 2 : 3) + (c.negated ? 1 : 0);
      const negPrefix = c.negated ? 'НЕ ' : '';
      conds.push(`${negPrefix}${normalizeLeafCase(c.leftExpr)} В\n${renderConditionSubquery(c.subquery, subBase, c.negated)}`);
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
      conds.push(`${negPrefix}${alias}.${c.path} ${opText}\n${renderConditionSubquery(c.subquery, subBase, c.negated)}`);
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
