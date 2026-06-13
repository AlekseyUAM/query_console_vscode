/**
 * Форматер произвольных выражений SDBL (фаза 6.10).
 *
 * Конструктор 1С переотрисовывает произвольные выражения (условия ГДЕ/ИМЕЮЩИЕ,
 * условия соединений ПО, поля выборки) в собственном каноническом виде: дерево
 * булевых операторов (ИЛИ < И < НЕ) и оператора ВЫБОР раскладывается по строкам
 * с фиксированными отступами и скобками; ЛИСТЬЯ (сравнения, вызовы функций,
 * арифметика, МЕЖДУ a И b, ЕСТЬ [НЕ] NULL, ПОДОБНО … СПЕЦСИМВОЛ …) сохраняются
 * ДОСЛОВНО срезом исходной строки по позициям токенов.
 *
 * Самодостаточный модуль: переиспользует `tokenize` из sdblLexer (без правок
 * лексера). Распознаёт не-ключевые слова ИЛИ/НЕ/ВЫБОР/КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ/ЕСТЬ
 * по `.value.toUpperCase()`.
 */
import { tokenize, type Token } from './sdblLexer';
import { FUNCTION_CATALOG, type FunctionGroup, type FunctionLeaf } from './functionCatalog';

export type ExprSlot = 'where' | 'having' | 'join' | 'select';

const TAB = '\t';

// --- Нормализация регистра ключевых слов в листьях (фаза 6.12) ---------------
//
// Конструктор 1С приводит к ВЕРХНЕМУ регистру РАСПОЗНАННЫЕ имена функций,
// операторов, литералы и имена примитивных типов внутри произвольных выражений,
// сохраняя при этом регистр идентификаторов (поля, псевдонимы, параметры &X,
// сегменты пути после точки, ссылки на типы метаданных вида Справочник.Имя).

/** Слова-имена функций/операторов из каталога (только буквенные ярлыки). */
const FUNCTION_WORDS: Set<string> = (() => {
  const acc: string[] = [];
  const walk = (n: FunctionGroup | FunctionLeaf): void => {
    if ('children' in n) n.children.forEach(walk);
    else acc.push(n.label);
  };
  walk(FUNCTION_CATALOG);
  const wordRe = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9]*$/u;
  return new Set(acc.filter((l) => wordRe.test(l)).map((l) => l.toUpperCase()));
})();

/** Литералы-ключевые слова: всегда верхний регистр (вне пути/параметра). */
const LITERAL_WORDS = new Set(['НЕОПРЕДЕЛЕНО', 'ИСТИНА', 'ЛОЖЬ', 'NULL']);

/** Примитивные типы: верхний регистр в позиции типа (ВЫРАЗИТЬ … КАК <Тип>, ТИП(<Тип>)). */
const PRIMITIVE_TYPE_WORDS = new Set(['СТРОКА', 'ЧИСЛО', 'ДАТА', 'БУЛЕВО']);

/**
 * Литералы периода (гранулярность) в позиции аргумента `<Период>` функций дат
 * (НАЧАЛОПЕРИОДА, КОНЕЦПЕРИОДА, ДОБАВИТЬКДАТЕ, РАЗНОСТЬДАТ): конструктор 1С приводит
 * их к ВЕРХНЕМУ регистру (`…, День)` → `…, ДЕНЬ)`). Распознаются как голый токен-слово
 * в позиции аргумента (после `,` или `(`), НЕ как `.`-квалифицированное поле и НЕ как
 * имя функции (за словом не следует `(`).
 */
const PERIOD_WORDS = new Set([
  'ГОД', 'ПОЛУГОДИЕ', 'КВАРТАЛ', 'МЕСЯЦ', 'ДЕКАДА', 'НЕДЕЛЯ', 'ДЕНЬ', 'ЧАС', 'МИНУТА', 'СЕКУНДА',
]);

/** Функции дат, принимающие аргумент `<Период>` (гранулярность). */
const PERIOD_FUNCTIONS = new Set(['НАЧАЛОПЕРИОДА', 'КОНЕЦПЕРИОДА', 'ДОБАВИТЬКДАТЕ', 'РАЗНОСТЬДАТ']);

function tokUpper(t: Token): string {
  return (t.text ?? t.value).toUpperCase();
}

// --- Нормализация пробелов в листьях (фаза 6.12, класс C-misc) ----------------
//
// Конструктор 1С нормализует пробелы между токенами произвольного выражения,
// сохраняя при этом содержимое строковых ("…") и датовых ('…') литералов дословно.
// Доказанные на корпусе оракула правила (нулевая регрессия на принятых файлах):
//   1) одиночный пробел вокруг бинарных операторов сравнения  = <> < > <= >=
//      (`a =b` → `a = b`, `X.Поле=Y` → `X.Поле = Y`);
//   2) одиночный пробел после запятой (`f(a,  b)` → `f(a, b)`, `(1,1,1)` → `(1, 1, 1)`);
//   3) схлопывание серий из 2+ пробелов в один (`ЕСТЬNULL(X,  "")` → `…, "")`).
// Нормализация применяется ТОЛЬКО к пробельным промежуткам между токенами и
// ТОЛЬКО если промежуток не содержит перевода строки (многострочные выражения
// сохраняют свою структуру). Литералы не затрагиваются: их внутренние пробелы —
// часть текста токена, а лексер выдаёт литерал одним токеном.

/** Операторы сравнения (пунктуация), вокруг которых конструктор ставит ровно один пробел. */
const COMPARISON_PUNCT = new Set(['=', '<>', '<', '>', '<=', '>=']);

/**
 * Сплющивает лист в ОДНУ строку: конструктор 1С печатает листовое подвыражение
 * (значение после ТОГДА/ИНАЧЕ, операнд условия КОГДА, сравнение/вызов) на одной
 * строке вне зависимости от того, как разработчик разбил его в исходнике. Любая
 * серия пробельных символов МЕЖДУ токенами (включая переводы строк и табы)
 * схлопывается в один пробел; содержимое строковых ("…") и датовых ('…') литералов
 * сохраняется дословно (лексер выдаёт литерал одним токеном, промежутки правятся
 * только между токенами). Возвращает исходник без изменений, если он не
 * токенизируется.
 */
/**
 * Содержит ли лист вложенный подзапрос (ключевое слово ВЫБРАТЬ среди токенов).
 * Подзапрос в `В (ВЫБРАТЬ …)` конструктор раскладывает по строкам как полноценный
 * запрос — такой лист нельзя сплющивать в одну строку.
 */
export function leafHasSubquery(raw: string): boolean {
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return false;
  }
  return toks.some((t) => (t.type === 'keyword' || t.type === 'ident') && t.value.toUpperCase() === 'ВЫБРАТЬ');
}

/**
 * Содержит ли лист вложенный ВЫБОР…КОНЕЦ (`ВЫБОР… КОНЕЦ <op> …` как значение-слот).
 * Такой CASE конструктор раскладывает построчно (reindentLeafCase) — лист сплющивать
 * нельзя, иначе схлопнется в одну строку (фаза 6.15.21).
 */
export function leafHasCase(raw: string): boolean {
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return false;
  }
  return toks.some((t) => (t.type === 'keyword' || t.type === 'ident') && t.value.toUpperCase() === 'ВЫБОР');
}

/**
 * Квирк конструктора 1С: листовое булево условие, оканчивающееся предикатом
 * `ЕСТЬ НЕ NULL`, печатается с ОДНИМ хвостовым пробелом (`… ЕСТЬ НЕ NULL `). Форма
 * без `НЕ` (`ЕСТЬ NULL`) хвостового пробела НЕ получает. Подтверждено по корпусу:
 * `ЕСТЬ НЕ NULL` — 5/5 строк с хвостовым пробелом, `ЕСТЬ NULL` — 0/219. Применяется
 * к финальной строке листа в булевом слоте (ГДЕ/ИМЕЮЩИЕ/КОГДА).
 */
const EST_NE_NULL_RE = /(^|[^\p{L}\p{N}_])ЕСТЬ\s+НЕ\s+NULL$/u;
export function appendIsNotNullTrailingSpace(text: string): string {
  return EST_NE_NULL_RE.test(text) ? text + ' ' : text;
}

/**
 * Квирк конструктора 1С (фаза 6.15.12, paren-only): «голый» вызов-приведение
 * `ВЫРАЗИТЬ(…)`, стоящий ЦЕЛИКОМ операндом сравнения (`ВЫРАЗИТЬ(…) cmp X` или
 * `X cmp ВЫРАЗИТЬ(…)`), конструктор печатает в скобках: `(ВЫРАЗИТЬ(…)) cmp X`.
 * Правило УЗКОЕ — подтверждено MCP-пробами:
 *   - `ВЫРАЗИТЬ(…).Поле <> …` (доступ к полю после приведения) — НЕ оборачивается;
 *   - `ТИПЗНАЧЕНИЯ(…) = ТИП(…)` и обычные вызовы функций — НЕ оборачиваются;
 *   - оборачивается ТОЛЬКО операнд, а не всё сравнение; работает с обеих сторон.
 * Применяется к листу булева слота (ГДЕ/ИМЕЮЩИЕ/ПО). Лист с переводом строки или с
 * верхнеуровневым булевым оператором сюда не приходит (это уже не лист-сравнение).
 */
const COMPARE_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);
export function wrapBareCastOperand(text: string): string {
  if (text.includes('\n')) return text;
  let toks: Token[];
  try {
    toks = tokenize(text);
  } catch {
    return text;
  }
  const sig = toks.filter((t) => t.type !== 'eof');
  if (sig.length === 0) return text;
  // Найти ЕДИНСТВЕННЫЙ верхнеуровневый оператор сравнения (глубина скобок 0).
  let depth = 0;
  let cmpIdx = -1;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const v = t.text ?? t.value;
    if (v === '(') { depth++; continue; }
    if (v === ')') { if (depth > 0) depth--; continue; }
    if (depth !== 0) continue;
    if (t.type === 'punct' && COMPARE_OPS.has(v)) {
      if (cmpIdx !== -1) return text; // более одного — не наш случай
      cmpIdx = i;
    }
  }
  if (cmpIdx === -1) return text;
  const left = sig.slice(0, cmpIdx);
  const right = sig.slice(cmpIdx + 1);
  // Голый вызов-приведение ВЫРАЗИТЬ: токены `ВЫРАЗИТЬ` `(` … сбалансированно `)`,
  // покрывающие ВЕСЬ операнд (за `)` ничего нет — иначе это `.Поле` или арифметика).
  const isBareCast = (ops: Token[]): boolean => {
    if (ops.length < 3) return false;
    const head = ops[0];
    if ((head.text ?? head.value).toUpperCase() !== 'ВЫРАЗИТЬ') return false;
    if ((ops[1].text ?? ops[1].value) !== '(') return false;
    let d = 0;
    for (let i = 1; i < ops.length; i++) {
      const v = ops[i].text ?? ops[i].value;
      if (v === '(') d++;
      else if (v === ')') { d--; if (d === 0) return i === ops.length - 1; }
    }
    return false;
  };
  const opStr = (ops: Token[]): string => {
    const first = ops[0];
    const last = ops[ops.length - 1];
    const end = last.pos + (last.text ?? last.value).length;
    return text.slice(first.pos, end);
  };
  const cmp = sig[cmpIdx].text ?? sig[cmpIdx].value;
  const leftStr = isBareCast(left) ? `(${opStr(left)})` : opStr(left);
  const rightStr = isBareCast(right) ? `(${opStr(right)})` : opStr(right);
  if (leftStr === opStr(left) && rightStr === opStr(right)) return text;
  return `${leftStr} ${cmp} ${rightStr}`;
}

/**
 * Содержит ли лист верхнеуровневый булев оператор И/ИЛИ (вне скобок и вне `МЕЖДУ a
 * И b`). Такой «лист» — на самом деле булево значение-выражение, которое конструктор
 * раскладывает по строкам с переносом по оператору; сплющивать его нельзя.
 */
export function leafHasTopBoolean(raw: string): boolean {
  return leafHasBoolean(raw, false);
}

/**
 * Обобщение: булев оператор И/ИЛИ на верхнем уровне (`anyDepth=false`) либо на
 * ЛЮБОЙ глубине скобок (`anyDepth=true`); `И` диапазона `МЕЖДУ a И b` не считается.
 * Конструктор переносит строку по И/ИЛИ и внутри скобочной группы
 * (`a <> (x И y)` печатается с переносом) — для сплющивания листа важна
 * любая глубина.
 */
function leafHasBoolean(raw: string, anyDepth: boolean): boolean {
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return false;
  }
  let depth = 0;
  let betweenPending = 0;
  for (const t of toks) {
    if (t.type === 'eof') break;
    if (t.type === 'punct' && t.value === '(') { depth++; continue; }
    if (t.type === 'punct' && t.value === ')') { if (depth > 0) depth--; continue; }
    if (!anyDepth && depth !== 0) continue;
    if (isWord(t, 'МЕЖДУ')) { betweenPending++; continue; }
    if (isOr(t)) return true;
    if (isAnd(t)) {
      if (betweenPending > 0) betweenPending--;
      else return true;
    }
  }
  return false;
}

export function flattenLeafText(raw: string): string {
  if (!raw || !/\s/.test(raw)) return raw;
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  const sig = toks.filter((t) => t.type !== 'eof');
  if (sig.length === 0) return raw;
  let out = '';
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const text = t.text ?? t.value;
    if (i > 0) {
      const prev = sig[i - 1];
      const gapFrom = prev.pos + (prev.text ?? prev.value).length;
      const gap = raw.slice(gapFrom, t.pos);
      // Пунктуационное сплющивание как у конструктора 1С: пробел не ставится
      // СРАЗУ ПОСЛЕ открывающей `(` и ПЕРЕД закрывающей `)` / запятой, даже если в
      // исходнике там был перенос строки/отступ (`(\n\tЗНАЧЕНИЕ…` → `(ЗНАЧЕНИЕ…`).
      const prevText = prev.text ?? prev.value;
      const noSpaceAfter = prevText === '(';
      const noSpaceBefore = text === ')' || text === ',';
      out += gap.length > 0 && !noSpaceAfter && !noSpaceBefore ? ' ' : '';
    }
    out += text;
  }
  return out;
}

/**
 * Сплющивание МНОГОСТРОЧНОГО листового выражения в одну строку, если это
 * безопасно (фаза 6.15.3, MCP-пробы): конструктор 1С печатает листовые выражения
 * (вложенные вызовы функций вида `ЕСТЬNULL(a, ЕСТЬNULL(b, c))`, разбитые
 * разработчиком по строкам) ОДНОЙ строкой — и в списке выборки, и в ГДЕ.
 * Не сплющиваем: лист с вложенным подзапросом (`В (ВЫБРАТЬ …)` раскладывается
 * по строкам), лист с верхнеуровневым И/ИЛИ (конструктор переносит по
 * оператору, в т.ч. ВНУТРИ скобочной группы: `a <> (x И y)`), лист с ВЫБОР
 * где угодно — даже внутри вызова функции (`СУММА(ВЫБОР … КОНЕЦ)`) конструктор
 * раскладывает ВЫБОР по строкам, — а также лист, в который парсер ошибочно
 * захватил хвостовые секции запроса (`…3\n\nУПОРЯДОЧИТЬ ПО …`, `{ГДЕ …}`) —
 * их многострочную геометрию трогать нельзя. Однострочный текст возвращается
 * как есть.
 */
export function flattenMultilineLeaf(raw: string): string {
  return raw.includes('\n') && !leafFlattenBlocked(raw) && !leafHasBoolean(raw, true)
    ? flattenLeafText(raw)
    : raw;
}

/**
 * Стоп-слова сплющивания листа: подзапрос (ВЫБРАТЬ), ВЫБОР, секции запроса,
 * которые парсер мог затянуть в хвост листа, и `{` построителя.
 *
 * Стоп-слово как СЕГМЕНТ ПУТИ (`Док.Итоги`, `ВТ.Поместить`) сплющивание НЕ
 * блокирует: после точки это имя поля, а не секция запроса (подтверждено
 * MCP-пробой: `ЕСТЬNULL(ВТВалюты.Итоги,\n "")` конструктор печатает одной
 * строкой). Исключение — зарезервированные ВЫБРАТЬ/ВЫБОР: они блокируют
 * безусловно (именем поля быть не могут).
 */
const FLATTEN_STOP_WORDS = new Set([
  'ВЫБРАТЬ', 'ВЫБОР', 'УПОРЯДОЧИТЬ', 'СГРУППИРОВАТЬ', 'ИТОГИ', 'ОБЪЕДИНИТЬ',
  'ИНДЕКСИРОВАТЬ', 'ИМЕЮЩИЕ', 'ПОМЕСТИТЬ',
]);
const FLATTEN_STOP_RESERVED = new Set(['ВЫБРАТЬ', 'ВЫБОР']);
function leafFlattenBlocked(raw: string): boolean {
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return true;
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'punct' && (t.value === '{' || t.value === '}')) return true;
    if ((t.type === 'keyword' || t.type === 'ident') && FLATTEN_STOP_WORDS.has(t.value.toUpperCase())) {
      if (FLATTEN_STOP_RESERVED.has(t.value.toUpperCase())) return true;
      const prev = toks[k - 1];
      const isPathSegment = prev !== undefined && prev.type === 'punct' && prev.value === '.';
      if (!isPathSegment) return true;
    }
  }
  return false;
}

/**
 * Перебазировка подзапроса внутри листа (фаза 6.15.9, MCP-пробы): конструктор 1С
 * переотрисовывает блок `(ВЫБРАТЬ …)` правого операнда `В`/`В ИЕРАРХИИ` как
 * полноценный запрос с отступом строки `(ВЫБРАТЬ` по КОНТЕКСТУ слота, игнорируя
 * отступы разработчика. Здесь — РАВНОМЕРНЫЙ сдвиг блока (внутренняя относительная
 * геометрия сохраняется): полный ре-рендер парсером ломает коррелированные
 * подзапросы (квалификация ссылок на внешние таблицы без знания их псевдонимов).
 * `base` — целевой отступ строки `(ВЫБРАТЬ`; каждый ведущий `НЕ` головы листа
 * добавляет +1. Хвостовой пробел строки перед подзапросом (`… В `) конструктор
 * срезает.
 *
 * Консервативно: перебазируются ТОЛЬКО листья, у которых блок подзапроса
 * начинается с собственной строки и закрывается на ПОСЛЕДНЕЙ строке листа
 * (баланс скобок, кавычки учитываются). Листья сложнее (И/ИЛИ-цепочка значения
 * с двумя подзапросами, хвост после скобки) сохраняют геометрию исходника.
 */
/**
 * Сплющивает в одну строку многострочные СПИСКИ ЗНАЧЕНИЙ оператора `В (\n a,\n b)`
 * внутри тела подзапроса (фаза 6.15.20). Находит строку, заканчивающуюся на ` В (`
 * или ` В(` (открытие списка), где за `(` НЕ следует подзапрос (ВЫБРАТЬ), собирает
 * последующие строки до закрытия скобок списка и склеивает их в одну строку с
 * пунктуационным сплющиванием (как flattenLeafText). Хвост после закрытия списка
 * (`)) КАК …` и т. п.) сохраняется на той же строке. Прочее не трогает.
 */
function flattenInlineValueLists(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Открытие списка значений: строка кончается на `В (` / `В(` (вне строкового
    // литерала; кавычки в строке не учитываем — список значений их не содержит).
    const opensList =
      /(?:^|[^\p{L}\p{N}_])В\s*\($/u.test(line) &&
      i + 1 < lines.length &&
      !/^[\t ]*ВЫБРАТЬ(?![\p{L}\p{N}_])/u.test(lines[i + 1]);
    if (!opensList) { out.push(line); continue; }
    // Считаем баланс скобок начиная с этой строки, пока список не закроется.
    let depth = 0;
    let inStr = false;
    const buf: string[] = [];
    let j = i;
    let closed = false;
    for (; j < lines.length; j++) {
      buf.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { closed = true; } }
      }
      if (closed) break;
    }
    if (!closed) { out.push(line); continue; }
    // Подзапрос внутри списка — не сплющиваем (страховка).
    if (buf.some(b => /(?:^|[^\p{L}\p{N}_])ВЫБРАТЬ(?![\p{L}\p{N}_])/u.test(b))) {
      out.push(line); continue;
    }
    // Сохраняем ведущий отступ первой строки, сплющиваем содержимое.
    const indent = (buf[0].match(/^\t*/u) ?? [''])[0];
    out.push(indent + flattenLeafText(buf.join('\n').replace(/^\t*/u, '')));
    i = j;
  }
  return out.join('\n');
}

export function reindentLeafSubquery(text: string, base: number): string {
  if (!text.includes('\n')) return text;
  // Многострочный СПИСОК ЗНАЧЕНИЙ оператора `В (\n a,\n b)` внутри тела подзапроса
  // конструктор печатает инлайн на одной строке (фаза 6.15.20, MCP). Списки
  // подзапроса (`В (ВЫБРАТЬ …)`) НЕ трогаем (после `(` идёт ВЫБРАТЬ).
  text = flattenInlineValueLists(text);
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  // Склеенная открывающая скобка `… В (` в конце строки, когда `ВЫБРАТЬ` стоит на
  // СЛЕДУЮЩЕЙ строке (геометрия разработчика `В (\n\tВЫБРАТЬ …`). Конструктор 1С
  // переносит `(` на строку `ВЫБРАТЬ` (`… В` + `\n` + отступ + `(ВЫБРАТЬ …`).
  // Нормализуем перед перебазировкой: отделяем хвостовую `(` оператора `В`/
  // `В ИЕРАРХИИ` и приклеиваем к началу следующей строки. Срабатывает только если
  // отдельной строки `(ВЫБРАТЬ` ещё нет.
  if (!lines.some((l) => l.replace(/^[\t ]+/u, '').startsWith('(ВЫБРАТЬ'))) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (!/(?:^|[^\p{L}\p{N}_])В(?:\s+ИЕРАРХИИ)?\s*\($/u.test(lines[i])) continue;
      if (!lines[i + 1].replace(/^[\t ]+/u, '').startsWith('ВЫБРАТЬ')) continue;
      lines[i] = lines[i].replace(/\s*\($/u, '');
      lines[i + 1] = lines[i + 1].replace(/^([\t ]*)/u, '$1(');
      break;
    }
  }
  let start = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/^[\t ]+/u, '').startsWith('(ВЫБРАТЬ')) { start = i; break; }
  }
  if (start <= 0) return text;
  // Баланс скобок блока (вне строковых литералов) должен закрыться в конце листа.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === '(') depth++;
      else if (!inStr && ch === ')') depth--;
    }
    if (depth <= 0 && i < lines.length - 1) return text;
  }
  if (depth > 0) return text;
  // Ведущие НЕ головы листа (включая после открывающих скобок): по +1 каждое.
  const neMatch = /^[\s(]*((?:НЕ\s+)+)/u.exec(lines[0]);
  const neCount = neMatch ? (neMatch[1].match(/НЕ/gu) ?? []).length : 0;
  const target = base + neCount;
  // Хвостовые пробелы строки перед подзапросом (`… В ` → `… В`).
  lines[start - 1] = lines[start - 1].replace(/[ \t]+$/u, '');
  const cur = (lines[start].match(/^\t*/u) ?? [''])[0].length;
  const delta = target - cur;
  if (delta !== 0) {
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() === '') continue; // пустые/разделительные строки не трогаем
      if (delta > 0) {
        lines[i] = TAB.repeat(delta) + lines[i];
      } else {
        const have = (lines[i].match(/^\t*/u) ?? [''])[0].length;
        if (have < -delta) return text; // нечего срезать — геометрия нестандартная, не трогаем
        lines[i] = lines[i].slice(-delta);
      }
    }
  }
  // Хвостовые пробелы СОДЕРЖАТЕЛЬНЫХ строк подзапроса конструктор срезает
  // (`ИЗ ` → `ИЗ`). Не трогаем: строки со строковым литералом (там пробел может быть
  // значимым) и пустые/только-пробельные строки-разделители (конструктор сохраняет их
  // отступ, напр. `\t\t` вокруг `ОБЪЕДИНИТЬ ВСЕ`).
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (!lines[i].includes('"')) lines[i] = lines[i].replace(/[ \t]+$/u, '');
  }
  // Внутри подзапроса-операнда условия `ПО` соединения печатается на отдельной
  // строке, а условие — НИЖЕ с отступом +1 (фаза 6.15.14, MCP). В сыром тексте
  // подзапроса (`В (ВЫБРАТЬ … СОЕДИНЕНИЕ … ПО <условие>)`) перекладываем строку
  // `<таб>ПО <условие>` в две: `<таб>ПО` + `<таб+1><условие>`. Продолжения `И`
  // конъюнктов уже стоят на нужном отступе в исходнике — их не трогаем.
  const split: string[] = [];
  for (const l of lines) {
    const m = /^(\t*)ПО\s+(\S.*)$/u.exec(l);
    if (m) {
      split.push(`${m[1]}ПО`);
      split.push(`${m[1]}${TAB}${m[2]}`);
    } else {
      split.push(l);
    }
  }
  // Закрывающая скобка В-подзапроса на ОТДЕЛЬНОЙ последней строке (`…\n\t)`):
  // конструктор приклеивает её к последней содержательной строке тела
  // (`…&КлючВарианта)`), а псевдоним поля добавляет вызывающий (фаза 6.15.20, MCP).
  // Срабатывает только когда последняя строка — ровно закрывающие скобки.
  const last = split.length - 1;
  if (last > start && /^\t*\)+$/u.test(split[last])) {
    const close = split[last].trim();
    split.splice(last, 1);
    split[split.length - 1] = split[split.length - 1].replace(/[ \t]+$/u, '') + close;
  }
  return split.join('\n');
}

/**
 * Канонический отступ блока ВЫБОР, ВЛОЖЕННОГО внутрь листа (фаза 6.15.9b, MCP-пробы).
 * Конструктор 1С переотрисовывает ВЫБОР/КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ даже когда ВЫБОР стоит
 * внутри вызова функции (`СУММА(ВЫБОР … КОНЕЦ)`), арифметики (`… - ВЫБОР … КОНЕЦ`) или
 * условия соединения (`ПО (ВЫБОР … КОНЕЦ)`) — то есть там, где парсер выражений
 * поглощает весь блок одним листом и не строит узел case. Раскладка (проба
 * `СУММА(ВЫБОР …)`): КОНЕЦ = E, КОГДА = E+1, продолжения условия (`И`/`ИЛИ`) = E+3
 * (whenInd+2), ТОГДА = E+2, ИНАЧЕ = E+1, где E = `base` + число НЕзакрытых скобок,
 * стоящих между началом листа и словом ВЫБОР. Вложенный ВЫБОР после ТОГДА/ИНАЧЕ
 * получает свой E = (отступ ТОГДА/ИНАЧЕ) + 1.
 *
 * Реализация — построчная переустановка ведущих табов СТРУКТУРНЫХ строк (тех, что
 * начинаются ключевым словом ВЫБОР/КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ/И/ИЛИ); прочее содержимое
 * (тексты значений, хвосты) сохраняется побайтно. Полный ре-парс не используем —
 * он терял бы дословный текст листьев. Консервативно: при любой неожиданной
 * геометрии (значение на нескольких строках, рассинхрон стека ВЫБОР/КОНЕЦ,
 * подзапрос внутри) функция возвращает исходный текст без изменений.
 */
export function reindentLeafCase(text: string, base: number): string {
  if (!text.includes('\n')) return text;
  // Подзапросы внутри листа обрабатывает reindentLeafSubquery — здесь не трогаем.
  if (/\bВЫБРАТЬ\b/u.test(text)) return text;
  const lines = text.split('\n');

  // Найти первую строку, ОКАНЧИВАЮЩУЮСЯ словом ВЫБОР (открытие CASE — конструктор
  // всегда переносит после ВЫБОР). До неё считаем баланс скобок (вне литералов).
  const endsWithVybor = (s: string): boolean => /(^|[^\p{L}\p{N}_])ВЫБОР\s*$/u.test(s);
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (endsWithVybor(lines[i])) { openIdx = i; break; }
  }
  if (openIdx < 0) return text;

  // Баланс скобок от начала листа до слова ВЫБОР на строке openIdx. Параллельно
  // считаем «эффективную» глубину: подряд идущие открывающие скобки `((` конструктор
  // 1С трактует как ОДИН уровень отступа (избыточная группировка `ЕСТЬNULL((СУММА(…`
  // даёт КОНЕЦ на base+2, а не base+3) — фаза 6.15.19, MCP. Если перед ВЫБОР
  // встречается закрывающая скобка (нетривиальная геометрия), эффективную глубину не
  // считаем и откатываемся на полный баланс (консервативно).
  let parenDepth = 0;
  let effectiveDepth = 0;
  let sawClose = false;
  let prevOpen = false;
  let inStr = false;
  for (let i = 0; i <= openIdx; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '(') {
        parenDepth++;
        if (!prevOpen) effectiveDepth++; // первая скобка в серии `(((` — один уровень
        prevOpen = true;
        continue;
      }
      if (ch === ')') { parenDepth--; sawClose = true; prevOpen = false; continue; }
      if (ch !== ' ' && ch !== '\t') prevOpen = false;
    }
  }
  if (parenDepth < 0) return text;

  const E0 = base + (sawClose ? parenDepth : effectiveDepth);
  // Стек контекстов ВЫБОР: каждый элемент — отступ КОНЕЦ (E) данного ВЫБОР.
  const stack: number[] = [E0];
  // Текущий whenInd (для продолжений условия И/ИЛИ) — обновляется на строке КОГДА.
  let curWhen = -1;
  // Баланс скобок внутри текущего условия КОГДА (сбрасывается на КОГДА): продолжение
  // (`И`/`ИЛИ`), стоящее внутри вложенной скобочной группы условия, конструктор
  // отступает на +1 за каждый незакрытый уровень скобок.
  let condParen = 0;
  // Множество скобочных уровней текущего условия КОГДА, на которых встречается
  // верхнеуровневый `ИЛИ` (см. orLevelsForCondition). На таком уровне конъюнкты `И`
  // конструктор отступает на +1 глубже строк `ИЛИ` (приоритет И выше ИЛИ; фаза
  // 6.15.21, MCP). Чистая `И`-цепочка (без `ИЛИ` на уровне) сдвига НЕ получает.
  let condOrLevels = new Set<number>();
  // Чистый баланс скобок строки (вне строковых литералов).
  const parenDelta = (s: string): number => {
    let d = 0;
    let inS = false;
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '"') { inS = !inS; continue; }
      if (inS) continue;
      if (ch === '(') d++;
      else if (ch === ')') d--;
    }
    return d;
  };
  const tabsOf = (s: string): number => (s.match(/^\t*/u) ?? [''])[0].length;
  // Переустановка ведущих табов + нормализация хвостовых пробелов: конструктор
  // срезает хвостовой пробел структурных строк, КРОМЕ предиката `ЕСТЬ НЕ NULL `,
  // который сохраняет ровно один хвостовой пробел (см. appendIsNotNullTrailingSpace).
  const reTab = (s: string, n: number): string =>
    '\t'.repeat(n) + appendIsNotNullTrailingSpace(s.replace(/^\t+/u, '').replace(/\s+$/u, ''));
  const firstWord = (s: string): string => {
    const m = /^\t*([\p{L}]+)/u.exec(s);
    return m ? m[1].toUpperCase() : '';
  };
  // Предсканирование условия КОГДА (строка startIdx — сама КОГДА): какие скобочные
  // уровни несут верхнеуровневый `ИЛИ`. Уровень строки = баланс скобок к её НАЧАЛУ
  // (после строки КОГДА). На таких уровнях конъюнкты `И` идут глубже (приоритет И>ИЛИ).
  const orLevelsForCondition = (startIdx: number): Set<number> => {
    const levels = new Set<number>();
    let lvl = parenDelta(lines[startIdx]); // незакрытые скобки после строки КОГДА
    for (let j = startIdx + 1; j < lines.length; j++) {
      const r = lines[j];
      if (r.trim() === '') continue;
      const fw = firstWord(r);
      if (fw === 'И' || fw === 'ИЛИ') {
        if (fw === 'ИЛИ') levels.add(lvl);
        lvl += parenDelta(r);
      } else {
        break; // ТОГДА/КОНЕЦ/прочее — конец условия
      }
    }
    return levels;
  };

  for (let i = openIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue; // пустые/разделительные строки не трогаем
    const E = stack[stack.length - 1];
    if (E === undefined) return text; // стек опустошён раньше времени — нестандартно
    const w = firstWord(raw);
    if (w === 'КОГДА') {
      const whenInd = E + 1;
      curWhen = whenInd;
      condParen = 0;
      condOrLevels = orLevelsForCondition(i);
      lines[i] = reTab(raw, whenInd);
      condParen += parenDelta(raw);
    } else if (w === 'И' || w === 'ИЛИ') {
      // Продолжение условия КОГДА: базовый отступ whenInd+2, плюс по +1 за каждый
      // незакрытый уровень скобок условия (вложенная группа `И (… ИЛИ …)`). Если на
      // текущем уровне есть верхнеуровневый `ИЛИ`, конъюнкт `И` идёт ещё на +1 глубже
      // (приоритет И>ИЛИ; фаза 6.15.21, MCP).
      if (curWhen < 0) return text;
      const orShift = w === 'И' && condOrLevels.has(condParen) ? 1 : 0;
      lines[i] = reTab(raw, curWhen + 2 + condParen + orShift);
      condParen += parenDelta(raw);
    } else if (w === 'ТОГДА') {
      lines[i] = reTab(raw, E + 2);
      if (endsWithVybor(raw)) { stack.push(E + 2 + 1); curWhen = -1; }
    } else if (w === 'ИНАЧЕ') {
      lines[i] = reTab(raw, E + 1);
      if (endsWithVybor(raw)) { stack.push(E + 1 + 1); curWhen = -1; }
    } else if (w === 'КОНЕЦ') {
      lines[i] = reTab(raw, E);
      stack.pop();
      curWhen = -1;
      // Соседний ВЫБОР на той же строке КОНЕЦ (`КОНЕЦ + ВЫБОР`, `КОНЕЦ) + СУММА(ВЫБОР`):
      // арифметика из нескольких ВЫБОР внутри одного листа. Конструктор открывает
      // новый блок с E, сдвинутым на чистый баланс скобок строки ДО слова ВЫБОР
      // (закрытие `)` сразу скомпенсировано открытием `(` следующего вызова → E тот
      // же). Переоткрываем стек и продолжаем (фаза 6.15.19).
      if (endsWithVybor(lines[i])) {
        const head = lines[i].replace(/(^|[^\p{L}\p{N}_])ВЫБОР\s*$/u, '$1');
        stack.push(E + parenDelta(head));
        continue;
      }
      if (stack.length === 0) {
        // Достигли КОНЕЦ внешнего ВЫБОР: оставшиеся строки (если есть непустые) —
        // нестандартный хвост, который не должен возникать; всё ок если их нет.
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() !== '') return text;
        }
        break;
      }
    } else {
      // Строка не начинается структурным ключевым словом: это либо значение
      // ТОГДА/ИНАЧЕ, перенесённое на свою строку (геометрия не каноническая),
      // либо неожиданная конструкция. Сверяем её отступ — если он уже совпадает с
      // ожидаемым (значение инлайн с ТОГДА/ИНАЧЕ кладётся на ту же строку, сюда
      // такие не попадают), пропускаем; иначе bail.
      const t = tabsOf(raw);
      if (t < E) return text; // мельче КОНЕЦ — точно чужая геометрия
      // Иное продолжение значения — не трогаем абсолютную позицию (bail безопаснее).
      return text;
    }
  }
  if (stack.length !== 0) return text; // не все ВЫБОР закрылись — нестандартно
  return lines.join('\n');
}

/**
 * Рефлоу СЕЛЕКТОРНОГО ВЫБОР, ВЛОЖЕННОГО в значение ТОГДА/ИНАЧЕ внутрь вызова функции
 * (фаза 6.15.26, MCP-пробы). Когда значение ветки CASE — листовой вызов вида
 * `ЕСТЬNULL(a, ЕСТЬNULL(ВЫБОР sel КОГДА … ТОГДА … КОНЕЦ, b))`, конструктор 1С:
 *   (а) сплющивает аргументы функции до строки `… ЕСТЬNULL(ВЫБОР sel` (первая строка);
 *   (б) РЕФЛОИТ встроенный CASE — разбивает инлайн `КОГДА X ТОГДА Y` на отдельные
 *       строки с канонической геометрией: КОГДА=E+1, ТОГДА=E+2, ИНАЧЕ=E+1, КОНЕЦ=E,
 *       где E = `valueBaseInd` (отступ значения-листа = отступ ТОГДА/ИНАЧЕ + 2) +
 *       число НЕзакрытых скобок, стоящих перед словом ВЫБОР;
 *   (в) хвост после КОНЕЦ (закрывающие аргументы `, b))`) кладёт на строку КОНЕЦ.
 *
 * Применяется ТОЛЬКО когда: лист содержит ВЫБОР на глубине скобок > 0 (внутри вызова,
 * а не голым значением — голый ВЫБОР парсер делает узлом case), у этого ВЫБОР есть
 * СЕЛЕКТОР (`ВЫБОР <выражение> КОГДА`, а не `ВЫБОР КОГДА`), и весь CASE закрывается
 * на верхнем уровне скобок одним КОНЕЦ. Любая иная геометрия (несколько ВЫБОР,
 * подзапрос, вложенный ВЫБОР в ТОГДА) → возврат входа без изменений.
 *
 * ВАЖНО: в каноне всего корпуса нет ни одного инлайн `КОГДА X ТОГДА Y`, поэтому
 * направленный сплит однострочных КОГДА/ТОГДА безопасен.
 */
export function reflowLeafSelectorCase(text: string, valueBaseInd: number): string | null {
  if (!text) return null;
  // Сплющиваем весь лист в одну строку (аргументы вызова), сохраняя пунктуацию.
  const flat = flattenLeafText(text);
  let toks: Token[];
  try {
    toks = tokenize(flat);
  } catch {
    return null;
  }
  const sig = toks.filter((t) => t.type !== 'eof');
  const isW = (t: Token, w: string): boolean =>
    (t.type === 'keyword' || t.type === 'ident') && t.value.toUpperCase() === w;
  if (!sig.some((t) => isW(t, 'ВЫБОР'))) return null;
  if (sig.some((t) => isW(t, 'ВЫБРАТЬ'))) return null; // подзапрос — не наша зона
  // Глубина скобок ПЕРЕД каждым токеном.
  const depthBefore: number[] = [];
  let d = 0;
  for (const t of sig) {
    depthBefore.push(d);
    if (t.type === 'punct' && t.value === '(') d++;
    else if (t.type === 'punct' && t.value === ')') d--;
  }
  // Первый ВЫБОР на глубине > 0 (внутри вызова функции).
  let vi = -1;
  for (let k = 0; k < sig.length; k++) {
    if (isW(sig[k], 'ВЫБОР') && depthBefore[k] > 0) { vi = k; break; }
  }
  if (vi < 0) return null;
  // Более одного ВЫБОР в листе — арифметика/иная геометрия, не наш случай.
  if (sig.some((t, k) => k !== vi && isW(t, 'ВЫБОР'))) return null;
  const caseDepth = depthBefore[vi];
  // У ВЫБОР должен быть СЕЛЕКТОР: следующий значимый токен — не КОГДА.
  if (vi + 1 >= sig.length || isW(sig[vi + 1], 'КОГДА')) return null;
  // Найти первый КОГДА на уровне CASE (после селектора).
  let firstWhen = -1;
  for (let k = vi + 1; k < sig.length; k++) {
    if (depthBefore[k] === caseDepth && isW(sig[k], 'КОГДА')) { firstWhen = k; break; }
    // Скобка закрылась раньше КОГДА — нестандартно.
    if (depthBefore[k] < caseDepth) return null;
  }
  if (firstWhen < 0) return null;
  // E (отступ КОНЕЦ) = базовый отступ значения-листа − 1 + число НЕзакрытых скобок
  // перед ВЫБОР. (valueBaseInd = отступ ТОГДА/ИНАЧЕ + 2; MCP-пробы фазы 6.15.26.)
  const E = valueBaseInd - 1 + caseDepth;
  // Первая строка: всё от начала листа до начала первого КОГДА (включая `ВЫБОР sel`).
  const out: string[] = [];
  out.push(flat.slice(0, sig[firstWhen].pos).replace(/\s+$/u, ''));
  // Перебор КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ на уровне CASE; текст между ключевыми словами
  // прикрепляется к предыдущему ключевому слову (инлайн-значение/условие).
  type Mark = { k: number; word: 'КОГДА' | 'ТОГДА' | 'ИНАЧЕ' | 'КОНЕЦ' };
  const marks: Mark[] = [];
  for (let k = firstWhen; k < sig.length; k++) {
    if (depthBefore[k] !== caseDepth) continue;
    const t = sig[k];
    if (isW(t, 'КОГДА')) marks.push({ k, word: 'КОГДА' });
    else if (isW(t, 'ТОГДА')) marks.push({ k, word: 'ТОГДА' });
    else if (isW(t, 'ИНАЧЕ')) marks.push({ k, word: 'ИНАЧЕ' });
    else if (isW(t, 'КОНЕЦ')) { marks.push({ k, word: 'КОНЕЦ' }); break; }
  }
  // Последний mark обязан быть КОНЕЦ (CASE закрылся на своём уровне).
  if (marks.length === 0 || marks[marks.length - 1].word !== 'КОНЕЦ') return null;
  // Вложенный ВЫБОР в значении ветки исключён выше (единственный ВЫБОР в листе).
  for (let m = 0; m < marks.length; m++) {
    const cur = marks[m];
    const ind = cur.word === 'КОГДА' ? E + 1
      : cur.word === 'ТОГДА' ? E + 2
      : cur.word === 'ИНАЧЕ' ? E + 1
      : E; // КОНЕЦ
    // Текст строки: от начала текущего ключевого слова до начала следующего
    // (для КОНЕЦ — до конца листа, включая хвостовые `, b))`).
    const from = cur.k;
    const to = m + 1 < marks.length ? marks[m + 1].k : -1;
    const sliceFrom = sig[from].pos;
    const sliceTo = to >= 0 ? sig[to].pos : flat.length;
    const seg = flat.slice(sliceFrom, sliceTo).replace(/\s+$/u, '');
    out.push('\t'.repeat(ind) + seg);
  }
  return out.join('\n');
}

/**
 * Переотступ продолжений булева листа поля выборки (фаза 6.15.19, MCP). Конструктор
 * нормализует отступ строк-продолжений `И`/`ИЛИ` плоской И/ИЛИ-цепочки поля выборки
 * к `base + 1` НЕЗАВИСИМО от исходного отступа разработчика (`X\n\t\t\tИ Y` →
 * `X\n\tИ Y` при base=1). Применяется только к ПЛОСКОЙ цепочке: первая строка —
 * операнд0 (любой текст), все последующие непустые строки обязаны начинаться с
 * `И`/`ИЛИ` на верхнем уровне скобок. Любая иная геометрия (ВЫБОР, подзапрос,
 * перенос операнда без И/ИЛИ, непарный баланс скобок) → возврат входа без изменений.
 */
export function reindentLeafBool(text: string, base: number): string {
  if (!text.includes('\n')) return text;
  if (/\bВЫБРАТЬ\b|\bВЫБОР\b/u.test(text)) return text; // подзапрос/CASE — не наша зона
  const lines = text.split('\n');
  const parenDelta = (s: string): number => {
    let d = 0;
    let inS = false;
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '"') { inS = !inS; continue; }
      if (inS) continue;
      if (ch === '(') d++;
      else if (ch === ')') d--;
    }
    return d;
  };
  const firstWord = (s: string): string => {
    const m = /^\t*([\p{L}]+)/u.exec(s);
    return m ? m[1].toUpperCase() : '';
  };
  // Баланс скобок к началу каждой следующей строки: продолжение `И`/`ИЛИ` считаем
  // верхнеуровневым, только если до него все скобки сбалансированы (depth 0).
  let depth = parenDelta(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') { depth += parenDelta(raw); continue; }
    const w = firstWord(raw);
    if (depth !== 0 || (w !== 'И' && w !== 'ИЛИ')) return text; // не плоская цепочка
    lines[i] = '\t'.repeat(base + 1) + raw.replace(/^\t+/u, '').replace(/\s+$/u, '');
    depth += parenDelta(lines[i]);
  }
  return lines.join('\n');
}

/**
 * Правая часть простого условия `<op> <param>`. Конструктор 1С не ставит пробел перед
 * скобкой списка значений у оператора `В` (и `В ИЕРАРХИИ`): `В (&Список)` → `В(&Список)`,
 * `В ИЕРАРХИИ (&Род)` → `В ИЕРАРХИИ(&Род)`. Перед подзапросом (`В (ВЫБРАТЬ …)`) конструктор
 * переносит на новую строку — это вне модели простых условий (фаза 6.11), здесь не трогаем.
 * Общая точка генератора и парсера (фаза 6.14.4): парсер строит этим же рендером
 * текст произвольного условия с не-параметром справа — байт-в-байт со старым выводом.
 *
 * `leafSpacing` (фаза 6.15.1, MCP-пробы): условие целиком лежит ВНУТРИ подзапроса
 * правого операнда `В` (`В (ВЫБРАТЬ … ГДЕ …)`) — конструктор печатает такой текст
 * по правилам произвольного выражения, С пробелом перед скобкой: `В (&П)`,
 * `В ИЕРАРХИИ (&П)`. Подзапрос-источник (`ИЗ (ВЫБРАТЬ …)`) рендерится БЕЗ пробела
 * (структурный путь) — там флаг не взводится.
 */
export function renderOperatorRhs(op: string, param: string, leafSpacing = false): string {
  if (op === 'В') {
    if (param.startsWith('(')) {
      // Список значений `В (a, b, …)` конструктор печатает ИНЛАЙН на одной строке,
      // даже если разработчик разбил его по запятым на несколько строк. Сплющиваем
      // многострочный список в одну строку. Сплющиваем ТОЛЬКО если param —
      // сбалансированный список `( … )` БЕЗ хвоста (иногда парсер ошибочно
      // захватывает в param хвостовые секции вида `\n\nУПОРЯДОЧИТЬ ПО …` — их
      // сплющивать нельзя) и БЕЗ вложенного подзапроса `(ВЫБРАТЬ …)`.
      const list =
        param.includes('\n') && isPureBalancedList(param) && !leafHasSubquery(param)
          ? flattenLeafText(param)
          : param;
      // Список из 2+ элементов конструктор отделяет пробелом: `В (a, b)`; список из
      // одного элемента — без пробела: `В(a)` (доказано на корпусе оракула:
      // multi 18 пробел / 0 без; single 14 пробел / 249 без — single оставляем как есть).
      return `В${leafSpacing || valueListIsMulti(list) ? ' ' : ''}${list}`;
    }
    if (/^ИЕРАРХИИ ?\(/.test(param)) {
      return 'В ИЕРАРХИИ' + (leafSpacing ? ' ' : '') + param.slice('ИЕРАРХИИ'.length).replace(/^ ?\(/, '(');
    }
  }
  return `${op} ${param}`;
}

/**
 * `param` — сбалансированный список `( … )` без хвостовых символов после внешней
 * закрывающей скобки. Используется, чтобы НЕ сплющивать param, в который парсер
 * ошибочно затянул хвост запроса (`(&X)\n\nУПОРЯДОЧИТЬ ПО …`).
 */
function isPureBalancedList(param: string): boolean {
  if (param[0] !== '(') return false;
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === param.length - 1;
    }
  }
  return false;
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
 * Удаляет незначащие ведущие нули из целой части числового литерала:
 * `01` → `1`, `007` → `7`, `00` → `0`, `00.5` → `0.5`. Дробную часть не трогает.
 */
function stripLeadingZeros(value: string): string {
  const dot = value.indexOf('.');
  const intPart = dot >= 0 ? value.slice(0, dot) : value;
  const frac = dot >= 0 ? value.slice(dot) : '';
  const trimmed = intPart.replace(/^0+(?=\d)/, '');
  return trimmed + frac;
}

export function normalizeLeafWhitespace(raw: string): string {
  if (!raw) return raw;
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  const sig = toks.filter((t) => t.type !== 'eof');

  const isCmp = (t: Token): boolean => t.type === 'punct' && COMPARISON_PUNCT.has(t.value);

  // Оператор включения `В (…)` / `В ИЕРАРХИИ (…)` в листовом (произвольном)
  // выражении конструктор 1С печатает С пробелом перед скобкой, даже если
  // разработчик написал `В(…)`. (Простые структурированные условия идут другим
  // путём — renderOperatorRhs, где у одиночного элемента пробела нет.)
  const isInOpWord = (t: Token): boolean =>
    (t.type === 'keyword' || t.type === 'ident') &&
    (t.value.toUpperCase() === 'В' || t.value.toUpperCase() === 'ИЕРАРХИИ');

  // Правки промежутков (gap) между соседними токенами, применяем справа налево.
  const edits: Array<{ from: number; to: number; text: string }> = [];

  // Нормализация числовых литералов: удаление незначащих ведущих нулей
  // (`01` → `1`, `00` → `0`), как делает конструктор 1С (напр. `ДАТАВРЕМЯ(2000, 1, 1)`).
  for (const t of sig) {
    if (t.type !== 'number') continue;
    const v = t.value;
    const stripped = stripLeadingZeros(v);
    if (stripped !== v) {
      edits.push({ from: t.pos, to: t.pos + v.length, text: stripped });
    }
  }

  for (let i = 0; i < sig.length - 1; i++) {
    const a = sig[i];
    const b = sig[i + 1];
    const gapFrom = a.pos + (a.text ?? a.value).length;
    const gapTo = b.pos;
    if (gapTo <= gapFrom) {
      // Нет пробела между токенами. Пробел нужен, если один из них — оператор
      // сравнения, либо предыдущий токен — запятая (`(1,1)` → `(1, 1)`). Запятую
      // перед `)` не разделяем (висячих запятых в выражениях нет, но на всякий случай).
      const needSpace =
        isCmp(a) || isCmp(b) ||
        (a.type === 'punct' && a.value === ',' && !(b.type === 'punct' && b.value === ')')) ||
        (isInOpWord(a) && b.type === 'punct' && b.value === '(');
      if (needSpace) edits.push({ from: gapFrom, to: gapTo, text: ' ' });
      continue;
    }
    const gap = raw.slice(gapFrom, gapTo);
    if (gap.includes('\n')) continue; // многострочный промежуток — не трогаем
    if (isCmp(a) || isCmp(b)) {
      if (gap !== ' ') edits.push({ from: gapFrom, to: gapTo, text: ' ' });
      continue;
    }
    if (a.type === 'punct' && a.value === ',') {
      if (gap !== ' ') edits.push({ from: gapFrom, to: gapTo, text: ' ' });
      continue;
    }
    // Схлопывание серий из 2+ пробелов в один. Табы в однострочном промежутке
    // не трогаем (могут быть значимым отступом форматирования разработчика).
    if (/ {2,}/.test(gap) && !gap.includes('\t')) {
      const collapsed = gap.replace(/ {2,}/g, ' ');
      if (collapsed !== gap) edits.push({ from: gapFrom, to: gapTo, text: collapsed });
    }
  }

  if (!edits.length) return raw;
  edits.sort((x, y) => y.from - x.from);
  let out = raw;
  for (const e of edits) {
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  return out;
}

/**
 * Приводит к верхнему регистру РАСПОЗНАННЫЕ ключевые слова в листе выражения,
 * сохраняя всё остальное (идентификаторы, строки, параметры, пробелы) дословно.
 * Применяется к каждому листовому срезу перед выводом.
 */
/**
 * Имя функции, чьему списку аргументов непосредственно принадлежит токен sig[idx]:
 * идёт назад по значимым токенам, отслеживая баланс скобок, до «лишней» открывающей
 * скобки текущего уровня; токен-слово прямо перед ней — имя функции. Возвращает true,
 * если это имя (в верхнем регистре) входит в `names`.
 */
function enclosingFunctionIs(sig: Token[], idx: number, names: Set<string>): boolean {
  let depth = 0;
  for (let k = idx - 1; k >= 0; k--) {
    const t = sig[k];
    if (t.type === 'punct' && t.value === ')') depth++;
    else if (t.type === 'punct' && t.value === '(') {
      if (depth === 0) {
        const fn = sig[k - 1];
        return !!fn && (fn.type === 'ident' || fn.type === 'keyword') && names.has(tokUpper(fn));
      }
      depth--;
    }
  }
  return false;
}

/**
 * Канонизация лексики листа (фаза 6.15.10): конструктор 1С нормализует ряд
 * англоязычных/перестановочных форм предикатов внутри листового выражения. Правила
 * подтверждены MCP-пробами `validate_query`:
 *   1) `IS NULL`   → `ЕСТЬ NULL`   (англоязычная форма предиката ЕСТЬ NULL);
 *   2) `ISNULL(`   → `ЕСТЬNULL(`   (англоязычное имя функции ЕСТЬNULL);
 *   3) `x НЕ В (…)` → `НЕ x В (…)`  (отрицание оператора В выносится перед операндом).
 * Применяется к листу до нормализации регистра/пробелов (`normalizeLeafCase`). Замены
 * делаются по позициям токенов справа налево, исходные пробелы между токенами не
 * затрагиваются (кроме переноса `НЕ ` в правиле 3). Многострочный лист в правило 3 не
 * попадает: предикат `В` приходит листом-сравнением без переносов строк.
 */
export function canonicalizeLeafLexemes(raw: string): string {
  if (!raw) return raw;
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  const sig = toks.filter((t) => t.type !== 'eof');
  if (sig.length === 0) return raw;
  const upOf = (t: Token): string => (t.text ?? t.value).toUpperCase();
  const isW = (t: Token | undefined): boolean => !!t && (t.type === 'ident' || t.type === 'keyword');
  // Сегмент пути после точки трогать нельзя (это идентификатор).
  const afterDot = (k: number): boolean => {
    const p = sig[k - 1];
    return !!p && p.type === 'punct' && p.value === '.';
  };

  let out = raw;

  // Правила 1 и 2 — позиционные текстовые замены (длина меняется), справа налево.
  type Repl = { pos: number; len: number; to: string };
  const repls: Repl[] = [];
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (!isW(t) || afterDot(k)) continue;
    const u = upOf(t);
    const text = t.text ?? t.value;
    // 2) ISNULL( → ЕСТЬNULL(
    if (u === 'ISNULL') {
      const nx = sig[k + 1];
      if (nx && nx.type === 'punct' && nx.value === '(') {
        repls.push({ pos: t.pos, len: text.length, to: 'ЕСТЬNULL' });
      }
      continue;
    }
    // 1) IS NULL → ЕСТЬ NULL (NULL приводит к ВЕРХнему регистру normalizeLeafCase).
    if (u === 'IS') {
      const nx = sig[k + 1];
      if (nx && isW(nx) && upOf(nx) === 'NULL') {
        repls.push({ pos: t.pos, len: text.length, to: 'ЕСТЬ' });
      }
    }
  }
  if (repls.length) {
    repls.sort((a, b) => b.pos - a.pos);
    for (const r of repls) out = out.slice(0, r.pos) + r.to + out.slice(r.pos + r.len);
  }

  // 3) x НЕ В (…) → НЕ x В (…). Срабатывает только на однострочном листе-сравнении
  //    (без переносов): ищем `НЕ`, за которым непосредственно следует оператор `В`,
  //    при наличии операнда слева. Переносим `НЕ ` в начало операнда (= начало листа).
  if (!out.includes('\n')) {
    let toks2: Token[];
    try {
      toks2 = tokenize(out);
    } catch {
      return out;
    }
    const sig2 = toks2.filter((t) => t.type !== 'eof');
    for (let k = 1; k < sig2.length - 1; k++) {
      const t = sig2[k];
      if (!isW(t) || upOf(t) !== 'НЕ') continue;
      const nx = sig2[k + 1];
      const isVOp = !!nx && nx.type === 'keyword' && upOf(nx) === 'В';
      if (!isVOp) continue;
      // Операнд — всё от начала листа до токена `НЕ` (лист атомарен: верхнеуровневых
      // булевых операторов в нём нет, они расщепляются раньше).
      const operandStart = sig2[0].pos;
      if (t.pos <= operandStart) continue;
      const neEnd = t.pos + (t.text ?? t.value).length;
      // Кусок между `НЕ` и оператором `В` (обычно один пробел) — сохраняем как разделитель.
      const before = out.slice(operandStart, t.pos).replace(/\s+$/u, '');
      out = out.slice(0, operandStart) + 'НЕ ' + before + out.slice(neEnd);
      break; // одно вхождение на лист
    }
  }

  return out;
}

// --- Переотрисовка арифметики листа (фаза 6.15.11a) -------------------------
//
// Конструктор 1С переотрисовывает арифметические выражения листа в каноническом
// виде (подтверждено MCP validate_query):
//   - бинарные операторы `+ - * / %` окружаются пробелами;
//   - лишние скобки снимаются по приоритету/ассоциативности (левый операнд `/`,`-`
//     без скобок: `(a - 1) - 2` → `a - 1 - 2`; правый — сохраняет: `a - (1 - 2)`);
//   - вызов-приведение `ВЫРАЗИТЬ(…)`, стоящий ОПЕРАНДОМ арифметики, оборачивается
//     в скобки: `ВЫРАЗИТЬ(…) * &П` → `(ВЫРАЗИТЬ(…)) * &П` (расширение правила
//     6.15.12 со сравнения на арифметику);
//   - унарный минус/плюс к пробелам оператора не относится (`-Поле`, `- -1`).
// Реализация — самостоятельный рекурсивный парсер арифметики; при ЛЮБОМ незнакомом
// токене (сравнение, булевы операторы, ЕСТЬ/МЕЖДУ/В/ПОДОБНО, `[` `?` `@`, ВЫБОР и
// т. п.) возвращает исходный текст без изменений (чтобы не задеть прочие листья).
// Регистр/числа/прочее НЕ трогает — этим занимается `normalizeLeafCase` после.

interface ArithNode {
  /** Готовый текст узла без внешних скобок. */
  text: string;
  /** Приоритет верхнего оператора узла: 2 = `* / %`, 1 = `+ -`, 3 = атом/унарный. */
  prec: number;
  /** Узел — голый вызов `ВЫРАЗИТЬ(…)` (особое правило обёртки операнда). */
  bareCast: boolean;
}

const ARITH_ADD = new Set(['+', '-']);
const ARITH_MUL = new Set(['*', '/', '%']);
// Токены, при встрече которых арифметический парсер сдаётся (не наш случай).
const ARITH_STOP_PUNCT = new Set(['<', '>', '=', '<=', '>=', '<>', '[', ']', '?', '@', ';']);
const ARITH_STOP_WORDS = new Set([
  'ИЛИ', 'И', 'НЕ', 'ВЫБОР', 'КОГДА', 'ТОГДА', 'ИНАЧЕ', 'КОНЕЦ', 'ЕСТЬ',
  'МЕЖДУ', 'В', 'ПОДОБНО', 'ССЫЛКА', 'СПЕЦСИМВОЛ', 'ИЕРАРХИИ',
]);

class ArithError extends Error {}

class ArithReprinter {
  private i = 0;
  constructor(private readonly sig: Token[]) {}

  private peek(): Token | undefined { return this.sig[this.i]; }
  private next(): Token { return this.sig[this.i++]; }
  private val(t: Token | undefined): string { return t ? (t.text ?? t.value) : ''; }

  /** Полный разбор: выражение должно занять все токены. */
  parseAll(): string {
    const node = this.parseExpr();
    if (this.i !== this.sig.length) throw new ArithError('хвост');
    return node.text;
  }

  private parseExpr(): ArithNode {
    let left = this.parseTerm();
    while (this.peek() && this.peek()!.type === 'punct' && ARITH_ADD.has(this.peek()!.value)) {
      const op = this.next().value;
      const right = this.parseTerm();
      left = {
        text: `${this.wrap(left, 1, 'left', op)} ${op} ${this.wrap(right, 1, 'right', op)}`,
        prec: 1,
        bareCast: false,
      };
    }
    return left;
  }

  private parseTerm(): ArithNode {
    let left = this.parseUnary();
    while (this.peek() && this.peek()!.type === 'punct' && ARITH_MUL.has(this.peek()!.value)) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = {
        text: `${this.wrap(left, 2, 'left', op)} ${op} ${this.wrap(right, 2, 'right', op)}`,
        prec: 2,
        bareCast: false,
      };
    }
    return left;
  }

  private parseUnary(): ArithNode {
    const t = this.peek();
    if (t && t.type === 'punct' && (t.value === '-' || t.value === '+')) {
      this.next();
      const operand = this.parseUnary();
      // Унарный минус/плюс без пробела: `-Поле`, `- -1` (родитель уже отделил).
      return { text: `${t.value}${this.atomText(operand)}`, prec: 3, bareCast: false };
    }
    return this.parsePrimary();
  }

  /** Операнд унарного оператора в скобках, если это бинарная арифметика. */
  private atomText(n: ArithNode): string {
    return n.prec < 3 ? `(${n.text})` : n.text;
  }

  private parsePrimary(): ArithNode {
    const t = this.peek();
    if (!t) throw new ArithError('конец');
    if (t.type === 'punct' && t.value === '(') {
      this.next();
      const inner = this.parseExpr();
      const close = this.next();
      if (!close || !(close.type === 'punct' && close.value === ')')) throw new ArithError('нет )');
      // Скобочная группа: возвращаем содержимое, родитель решит про скобки.
      return inner;
    }
    if (t.type === 'number' || t.type === 'string' || t.type === 'param' || t.type === 'date') {
      this.next();
      return { text: this.val(t), prec: 3, bareCast: false };
    }
    if (t.type === 'ident' || t.type === 'keyword') {
      // Стоп-слова булевой/предикатной логики — не арифметика.
      if (ARITH_STOP_WORDS.has((t.text ?? t.value).toUpperCase())) throw new ArithError('стоп-слово');
      return this.parseNameOrCall();
    }
    if (t.type === 'punct' && ARITH_STOP_PUNCT.has(t.value)) throw new ArithError('стоп-пункт');
    throw new ArithError('неизвестно');
  }

  /** Точечный путь `Имя(.Имя)*` или вызов `Имя(arg, …)`. */
  private parseNameOrCall(): ArithNode {
    const headTok = this.next();
    const head = this.val(headTok);
    // Путь: Имя.Имя…
    let path = head;
    while (this.peek() && this.peek()!.type === 'punct' && this.peek()!.value === '.') {
      this.next();
      const seg = this.next();
      if (!seg || (seg.type !== 'ident' && seg.type !== 'keyword' && seg.type !== 'number')) {
        throw new ArithError('сегмент пути');
      }
      path += '.' + this.val(seg);
    }
    // Вызов функции? Открывающая скобка СРАЗУ за именем (без точки).
    if (path === head && this.peek() && this.peek()!.type === 'punct' && this.peek()!.value === '(') {
      this.next(); // (
      const args = this.parseArgList();
      const close = this.next();
      if (!close || !(close.type === 'punct' && close.value === ')')) throw new ArithError('нет ) вызова');
      const isCast = head.toUpperCase() === 'ВЫРАЗИТЬ';
      return { text: `${head}(${args.join(', ')})`, prec: 3, bareCast: isCast };
    }
    return { text: path, prec: 3, bareCast: false };
  }

  /** Список аргументов вызова: каждый — арифметика, опц. с `КАК <тип>` (ВЫРАЗИТЬ). */
  private parseArgList(): string[] {
    const args: string[] = [];
    if (this.peek() && this.peek()!.type === 'punct' && this.peek()!.value === ')') return args;
    for (;;) {
      args.push(this.parseArg());
      const t = this.peek();
      if (t && t.type === 'punct' && t.value === ',') { this.next(); continue; }
      break;
    }
    return args;
  }

  /** Аргумент вызова: арифм. выражение и опц. `КАК <тип-выражение>` (приведение). */
  private parseArg(): string {
    const expr = this.parseExpr();
    const t = this.peek();
    if (t && (t.type === 'keyword' || t.type === 'ident') && (t.text ?? t.value).toUpperCase() === 'КАК') {
      this.next(); // КАК
      // Тип — это вызов/имя (`ЧИСЛО(11, 0)`, `СТРОКА(10)`, ссылочный тип). Печатаем
      // через тот же примитив (parseNameOrCall) для нормализации запятых внутри.
      const type = this.parseNameOrCall();
      return `${expr.text} КАК ${type.text}`;
    }
    return expr.text;
  }

  /**
   * Решает обрамление дочернего операнда скобками. `parentPrec` — приоритет
   * родительского оператора; `side` — слева/справа от него.
   *   - Голый ВЫРАЗИТЬ-операнд арифметики всегда в скобках (особое правило 1С).
   *   - prec < parentPrec → нужны скобки (защита приоритета).
   *   - prec == parentPrec и правый операнд под `- /` (non-assoc) → скобки.
   */
  private wrap(n: ArithNode, parentPrec: number, side: 'left' | 'right', op: string): string {
    if (n.bareCast) return `(${n.text})`;
    if (n.prec < parentPrec) return `(${n.text})`;
    // Правый операнд при равном приоритете ВСЕГДА сохраняет скобки: конструктор 1С
    // не снимает их даже у ассоциативных `+`/`*` (`a + (b - c)`, `a + (b + c)`,
    // `a * (b * c)`, `a * (b / c)` — все сохранены, MCP, фаза 6.15.20). Левый операнд
    // при равном приоритете скобок не требует (левая ассоциативность):
    // `(a - 1) - 2` → `a - 1 - 2`, `(a + b) + c` → `a + b + c`.
    if (n.prec === parentPrec && side === 'right') {
      return `(${n.text})`;
    }
    return n.text;
  }
}

/**
 * Переотрисовка арифметики листа. Возвращает канонический текст; при незнакомой
 * конструкции — исходный (без изменений). См. комментарий выше.
 */
export function reprintLeafArithmetic(raw: string): string {
  if (!raw || raw.includes('\n')) return raw;
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  const sig = toks.filter((t) => t.type !== 'eof');
  if (sig.length === 0) return raw;
  // Должна присутствовать арифметика (оператор `+ - * / %` на каком-либо уровне)
  // ИЛИ голый ВЫРАЗИТЬ-операнд — иначе незачем (и не рискуем чужими листьями).
  const hasArithOp = sig.some(
    (t) => t.type === 'punct' && (ARITH_ADD.has(t.value) || ARITH_MUL.has(t.value))
  );
  if (!hasArithOp) return raw;
  try {
    const out = new ArithReprinter(sig).parseAll();
    return out;
  } catch {
    return raw;
  }
}

export function normalizeLeafCase(raw: string): string {
  if (!raw) return raw;
  raw = canonicalizeLeafLexemes(raw);
  let toks: Token[];
  try {
    toks = tokenize(raw);
  } catch {
    return raw;
  }
  // Индексы значимых (не-eof) токенов для просмотра соседей.
  const sig = toks.filter((t) => t.type !== 'eof');
  // Карта: позиция токена -> его индекс в sig.
  const spans: Array<{ pos: number; len: number; up: string }> = [];

  const prevSig = (idx: number): Token | undefined => sig[idx - 1];
  const nextSig = (idx: number): Token | undefined => sig[idx + 1];
  const isWordTok = (t: Token | undefined): boolean =>
    !!t && (t.type === 'ident' || t.type === 'keyword');

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (!isWordTok(t)) continue;
    const prev = prevSig(i);
    // Сегмент пути после точки — идентификатор, не трогаем.
    if (prev && prev.type === 'punct' && prev.value === '.') continue;
    const up = tokUpper(t);
    const text = t.text ?? t.value;
    if (text === up) continue; // уже в верхнем регистре

    const next = nextSig(i);
    const followedByParen = !!next && next.type === 'punct' && next.value === '(';

    let shouldUpper = false;

    // 1) Имя функции в позиции вызова: WORD(
    if (FUNCTION_WORDS.has(up) && followedByParen) shouldUpper = true;

    // 2) Литерал-ключевое слово (вне пути; параметры &X — отдельный тип токена).
    if (!shouldUpper && LITERAL_WORDS.has(up)) shouldUpper = true;

    // 3) Примитивный тип в позиции типа: после КАК, либо первый токен внутри ТИП(.
    if (!shouldUpper && PRIMITIVE_TYPE_WORDS.has(up)) {
      const afterKak = !!prev && prev.type === 'keyword' && prev.value === 'КАК';
      // ТИП( <тип> : prev = '(', prev-prev = ТИП
      let insideTip = false;
      if (prev && prev.type === 'punct' && prev.value === '(') {
        const pp = prevSig(i - 1);
        if (pp && isWordTok(pp) && tokUpper(pp) === 'ТИП') insideTip = true;
      }
      if (afterKak || insideTip) shouldUpper = true;
    }

    // 4) Литерал периода в позиции аргумента функции даты (НАЧАЛОПЕРИОДА/КОНЕЦПЕРИОДА/
    //    ДОБАВИТЬКДАТЕ/РАЗНОСТЬДАТ). Голый токен-слово внутри списка аргументов такой
    //    функции, за которым НЕ следует `(` (иначе это имя функции ДЕНЬ(…)) и НЕ
    //    следует `.` (иначе голова `.`-пути). Принадлежность аргументного списка
    //    конкретной функции проверяем по имени перед охватывающей скобкой — это не
    //    даёт задеть голый идентификатор `Год`, стоящий после запятой в списках
    //    УПОРЯДОЧИТЬ ПО / ВЫБРАТЬ и т. п.
    if (!shouldUpper && PERIOD_WORDS.has(up)) {
      const nextIsDot = !!next && next.type === 'punct' && next.value === '.';
      if (!followedByParen && !nextIsDot && enclosingFunctionIs(sig, i, PERIOD_FUNCTIONS)) {
        shouldUpper = true;
      }
    }

    // 5) Операторы-идентификаторы (лексер не делает их keyword): НЕ/ИЛИ — никогда не
    //    имена полей, приводим к ВЕРХ всегда (вне пути). ССЫЛКА — ещё и имя поля,
    //    поэтому ВЕРХ только в ИНФИКСНОЙ позиции `<выражение> ССЫЛКА <Тип>`
    //    (фаза 6.16.7, MCP).
    if (!shouldUpper && (up === 'НЕ' || up === 'ИЛИ')) shouldUpper = true;
    if (!shouldUpper && up === 'ССЫЛКА') {
      const prevIsExprEnd = !!prev && (
        prev.type === 'number' || prev.type === 'string' ||
        (prev.type === 'punct' && prev.value === ')') ||
        ((prev.type === 'ident' || prev.type === 'keyword') && !(prev.type === 'keyword' && prev.value === 'КАК'))
      );
      if (prevIsExprEnd && isWordTok(next)) shouldUpper = true;
    }

    if (shouldUpper) spans.push({ pos: t.pos, len: text.length, up });
  }

  // Применяем замены регистра справа налево (длина не меняется), затем нормализуем
  // пробелы (класс C-misc). Регистровые замены сохраняют позиции, поэтому порядок
  // безопасен.
  let out = raw;
  if (spans.length) {
    spans.sort((a, b) => b.pos - a.pos);
    for (const s of spans) {
      out = out.slice(0, s.pos) + s.up + out.slice(s.pos + s.len);
    }
  }
  return normalizeLeafWhitespace(out);
}

// --- AST --------------------------------------------------------------------

type Node =
  | { kind: 'or'; operands: Node[] }
  | { kind: 'and'; operands: Node[] }
  | { kind: 'not'; child: Node }
  | { kind: 'group'; child: Node } // скобочная группа верхнего уровня
  | { kind: 'case'; clauses: CaseClause[]; elseExpr?: Node | null; elseText?: string; selector?: string; trailing?: string }
  | { kind: 'leaf'; text: string };

interface CaseClause {
  // условие после КОГДА (булев слот)
  whenNode: Node;
  // значение после ТОГДА (value-слот): либо вложенный ВЫБОР, либо дословный текст
  thenNode: Node;
}

// --- helpers для распознавания слов-операторов ------------------------------

function up(t: Token): string {
  return t.value.toUpperCase();
}
function isWord(t: Token, w: string): boolean {
  return (t.type === 'ident' || t.type === 'keyword') && up(t) === w;
}
function isOr(t: Token): boolean {
  return isWord(t, 'ИЛИ');
}
function isAnd(t: Token): boolean {
  return t.type === 'keyword' && t.value === 'И';
}
function isNot(t: Token): boolean {
  return isWord(t, 'НЕ');
}
function isCase(t: Token): boolean {
  return isWord(t, 'ВЫБОР');
}
function isWhen(t: Token): boolean {
  return isWord(t, 'КОГДА');
}
function isThen(t: Token): boolean {
  return isWord(t, 'ТОГДА');
}
function isElse(t: Token): boolean {
  return isWord(t, 'ИНАЧЕ');
}
function isEnd(t: Token): boolean {
  return isWord(t, 'КОНЕЦ');
}

/**
 * Добавляет операнд в список операндов ИЛИ, разворачивая левую ассоциативность:
 * ВЕДУЩАЯ скобочная группа, обёртывающая ИЛИ (`(a ИЛИ b) ИЛИ c`), — избыточные
 * скобки, которые конструктор 1С снимает (печатает `a ИЛИ b ИЛИ c`). Применяется
 * только к ПЕРВОМУ операнду (operands пуст): хвостовая группа `x ИЛИ (a ИЛИ b)`
 * сохраняет скобки. Голый ИЛИ-операнд (после такой же раскрутки ниже) тоже вливаем.
 */
function pushOrOperand(operands: Node[], op: Node): void {
  if (operands.length === 0) {
    if (op.kind === 'or') {
      operands.push(...op.operands);
      return;
    }
    if (op.kind === 'group' && op.child.kind === 'or') {
      operands.push(...op.child.operands);
      return;
    }
  }
  // Скобки вокруг И-группы операнда ИЛИ — избыточны (И связывает крепче ИЛИ);
  // конструктор их снимает: `… ИЛИ (a И b)` → `… ИЛИ a И b` (фаза 6.15.21, MCP).
  // Применимо к любой позиции операнда (приоритет операторов не зависит от места).
  if (op.kind === 'group' && op.child.kind === 'and') {
    operands.push(op.child);
    return;
  }
  operands.push(op);
}

// --- Parser -----------------------------------------------------------------

class Parser {
  private toks: Token[];
  private raw: string;
  private i = 0;
  /**
   * Сплющивать ли многострочные листья в одну строку. Включается только для слота
   * `select` (поля выборки и значения ВЫБОР), где конструктор печатает листовое
   * подвыражение на одной строке. В слотах ГДЕ/ИМЕЮЩИЕ/ПО исторически сохраняется
   * многострочная структура исходника дословно (нулевая регрессия принятых файлов).
   */
  private flattenLeaves: boolean;

  constructor(raw: string, flattenLeaves = false) {
    this.raw = raw;
    this.flattenLeaves = flattenLeaves;
    // исключаем eof из рабочего набора (но позиция eof нужна для среза «до конца»)
    this.toks = tokenize(raw);
  }

  private peek(): Token {
    return this.toks[this.i];
  }
  private atEof(): boolean {
    return this.peek().type === 'eof';
  }

  /** Срез исходной строки [from, to) с обрезкой хвостовых пробелов. */
  private slice(from: number, to: number): string {
    return this.raw.slice(from, to).replace(/\s+$/u, '');
  }

  /**
   * Текст листа [from, to): сплющивает многострочный лист в одну строку (конструктор
   * печатает листовые подвыражения на одной строке), затем нормализует регистр и
   * пробелы. Однострочные листья проходят только нормализацию (поведение принятых
   * запросов не меняется).
   */
  private leafText(from: number, to: number): string {
    const raw = this.raw.slice(from, to).replace(/\s+$/u, '');
    // Сплющиваем многострочный лист в одну строку ТОЛЬКО если это действительно
    // листовое подвыражение: без вложенного подзапроса (`В (ВЫБРАТЬ …)` —
    // раскладывается конструктором как запрос) и без верхнеуровневого булева
    // оператора И/ИЛИ (значение-слот вида `a ИЛИ b` конструктор переотрисовывает с
    // переносом по оператору — не сплющиваем, сохраняя структуру исходника).
    const flat =
      this.flattenLeaves &&
      raw.includes('\n') &&
      !leafHasSubquery(raw) &&
      !leafHasTopBoolean(raw) &&
      !leafHasCase(raw)
        ? flattenLeafText(raw)
        : raw;
    return normalizeLeafCase(flat);
  }

  parse(): Node {
    const node = this.parseOr();
    return node;
  }

  /**
   * Дословный хвост: всё от КОНЦА последнего потреблённого токена до конца строки
   * (включая исходные пробелы/переносы перед хвостом). '' если хвоста нет.
   * Сохраняет, например, ошибочно захваченные парсером SDBL `\n\nУПОРЯДОЧИТЬ ПО …`.
   */
  tail(): string {
    if (this.peek().type === 'eof') return '';
    // конец последнего потреблённого токена
    const prev = this.i > 0 ? this.toks[this.i - 1] : undefined;
    const from = prev ? prev.pos + prev.text.length : this.peek().pos;
    return this.raw.slice(from);
  }

  // ИЛИ — низший приоритет
  private parseOr(): Node {
    const first = this.parseAnd();
    const operands: Node[] = [];
    pushOrOperand(operands, first);
    while (!this.atEof() && isOr(this.peek())) {
      this.i++; // съесть ИЛИ
      pushOrOperand(operands, this.parseAnd());
    }
    return operands.length === 1 ? operands[0] : { kind: 'or', operands };
  }

  private parseAnd(): Node {
    const first = this.parseNot();
    const operands = [first];
    while (!this.atEof() && isAnd(this.peek())) {
      this.i++; // съесть И
      operands.push(this.parseNot());
    }
    return operands.length === 1 ? first : { kind: 'and', operands };
  }

  private parseNot(): Node {
    if (!this.atEof() && isNot(this.peek())) {
      // НЕ как булев префикс ТОЛЬКО если за ним идёт структурный примитив
      // (ВЫБОР, скобочная группа или булево подвыражение). Иначе НЕ — часть листа
      // (НЕ поле, НЕ &Параметр), и лист поглотит его дословно.
      if (this.notIsStructural()) {
        this.i++; // съесть НЕ
        return { kind: 'not', child: this.parseNot() };
      }
    }
    return this.parsePrimary();
  }

  /**
   * Является ли текущее `НЕ` структурным булевым отрицанием. Структурно — если
   * за ним ВЫБОР или открывающая скобка, чьё содержимое содержит верхнеуровневый
   * И/ИЛИ (булева группа). Иначе `НЕ` — унарный оператор внутри листа (`НЕ a.Флаг`,
   * `НЕ a.X В (…)`), и обрабатывается листом дословно.
   */
  private notIsStructural(): boolean {
    const next = this.toks[this.i + 1];
    if (!next) return false;
    if (isCase(next)) return true;
    if (next.type === 'punct' && next.value === '(') {
      return this.parenHasTopBoolean(this.i + 1);
    }
    return false;
  }

  /** Содержит ли скобочная группа, открытая на индексе `open`, верхнеур. И/ИЛИ. */
  private parenHasTopBoolean(open: number): boolean {
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'eof') break;
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 1 && (isAnd(t) || isOr(t))) return true;
    }
    return false;
  }

  private parsePrimary(): Node {
    const t = this.peek();
    // ВЫБОР … КОНЕЦ
    if (isCase(t)) {
      return this.parseCase();
    }
    // скобочная группа верхнего уровня — раскрываем в под-дерево ТОЛЬКО если
    // содержит верхнеуровневый булев И/ИЛИ или ВЫБОР; иначе это листовая скобка
    // (вызов/группировка арифметики) — поглощается листом дословно.
    if (t.type === 'punct' && t.value === '(' && this.parenIsStructuralGroup(this.i)) {
      this.i++; // съесть (
      const inner = this.parseOr();
      // закрывающая )
      if (!this.atEof() && this.peek().type === 'punct' && this.peek().value === ')') {
        this.i++;
      }
      return { kind: 'group', child: inner };
    }
    return this.parseLeaf();
  }

  /** Скобка структурна, если содержит верхнеур. И/ИЛИ или ВЫБОР. */
  private parenIsStructuralGroup(open: number): boolean {
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'eof') break;
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 1 && (isAnd(t) || isOr(t) || isCase(t))) return true;
    }
    return false;
  }

  /**
   * Лист: диапазон токенов до следующего верхнеуровневого булева И/ИЛИ, конца,
   * закрывающей скобки или КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ. Поглощает внутренние скобки,
   * вызовы, МЕЖДУ a И b (И после МЕЖДУ — не разделитель), ЕСТЬ [НЕ] NULL, ПОДОБНО.
   */
  private parseLeaf(): Node {
    const startTok = this.peek();
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    let betweenPending = 0; // сколько И ждём «съесть» внутри МЕЖДУ

    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break; // закрывающая чужой группы — стоп
        depth--;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (depth === 0) {
        // границы листа на верхнем уровне
        if (isOr(t)) break;
        if (isAnd(t)) {
          if (betweenPending > 0) {
            betweenPending--; // это И из МЕЖДУ a И b
          } else {
            break;
          }
        }
        if (isThen(t) || isElse(t) || isEnd(t) || isWhen(t)) break;
        if (isWord(t, 'МЕЖДУ')) betweenPending++;
      }
      to = t.pos + t.value.length;
      this.i++;
    }
    return { kind: 'leaf', text: this.leafText(from, to) };
  }

  private parseCase(): Node {
    this.i++; // съесть ВЫБОР
    // Селекторная форма: ВЫБОР <выражение> КОГДА <значение> ТОГДА … Если сразу за
    // ВЫБОР идёт не КОГДА — это селектор (выражение-лист до первого верхнеуровневого
    // КОГДА), который конструктор печатает инлайн на строке `ВЫБОР <селектор>`.
    let selector: string | undefined;
    if (!this.atEof() && !isWhen(this.peek())) {
      selector = this.parseCaseSelector();
    }
    const clauses: CaseClause[] = [];
    let elseNode: Node | null = null;
    while (!this.atEof()) {
      const t = this.peek();
      if (isWhen(t)) {
        this.i++; // КОГДА
        const whenNode = this.parseOr(); // булев слот
        // ТОГДА
        if (!this.atEof() && isThen(this.peek())) this.i++;
        const thenNode = this.parseValue(); // value-слот
        clauses.push({ whenNode, thenNode });
        continue;
      }
      if (isElse(t)) {
        this.i++; // ИНАЧЕ
        elseNode = this.parseValue();
        continue;
      }
      if (isEnd(t)) {
        this.i++; // КОНЕЦ
        break;
      }
      break;
    }
    return { kind: 'case', clauses, elseExpr: elseNode, selector };
  }

  /**
   * Хвост после `КОНЕЦ` value-слотового ВЫБОР: `<op> value` (`КОНЕЦ <> &П`).
   * Возвращает нормализованный текст хвоста (`<> &П`) ТОЛЬКО для узкой формы —
   * ровно один верхнеуровневый оператор сравнения, листовой операнд, без вложенного
   * ВЫБОР и без верхнеуровневых И/ИЛИ. Иначе undefined (позицию НЕ двигает).
   * Эта форма позволяет CASE идти структурным путём с приклеенным хвостом к КОНЕЦ.
   */
  private tryParseSimpleCaseTrailing(): string | undefined {
    const save = this.i;
    const startTok = this.peek();
    // Хвост обязан начинаться с оператора сравнения.
    if (!(startTok.type === 'punct' && COMPARE_OPS.has(startTok.value))) return undefined;
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    let cmpCount = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') { depth++; to = t.pos + t.value.length; this.i++; continue; }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break; // граница чужой группы
        depth--; to = t.pos + t.value.length; this.i++; continue;
      }
      if (depth === 0) {
        // Границы value-слота / структурные ключевые слова — стоп.
        if (isWhen(t) || isElse(t) || isEnd(t)) break;
        // Вложенный ВЫБОР или верхнеуровневый булев оператор → форма не простая.
        if (isCase(t) || isOr(t) || isAnd(t)) { this.i = save; return undefined; }
        if (t.type === 'punct' && COMPARE_OPS.has(t.value)) cmpCount++;
      }
      to = t.pos + t.value.length;
      this.i++;
    }
    // Ровно один верхнеуровневый оператор сравнения (тот, с которого начали).
    if (cmpCount !== 1) { this.i = save; return undefined; }
    return normalizeLeafWhitespace(this.leafText(from, to));
  }

  /**
   * Селектор формы `ВЫБОР <выражение> КОГДА …` — листовое выражение между ВЫБОР и
   * первым верхнеуровневым КОГДА. Печатается инлайн; нормализуется как лист.
   */
  private parseCaseSelector(): string {
    const startTok = this.peek();
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break;
        depth--;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (depth === 0 && isWhen(t)) break;
      to = t.pos + t.value.length;
      this.i++;
    }
    return this.leafText(from, to);
  }

  /**
   * Value-слот (после ТОГДА/ИНАЧЕ или поле выборки): либо вложенный ВЫБОР, либо
   * дословный текст до следующего КОГДА/ИНАЧЕ/КОНЕЦ верхнего уровня.
   */
  private parseValue(): Node {
    if (!this.atEof() && isCase(this.peek())) {
      // Значение-слот, начинающийся с ВЫБОР, — вложенный CASE-узел ТОЛЬКО если ВЫБОР
      // занимает весь слот (за его КОНЕЦ сразу граница слота: КОГДА/ИНАЧЕ/КОНЕЦ/`)`/
      // eof). Если за КОНЕЦ идёт оператор (`КОНЕЦ <> &П`), значение — это выражение
      // `ВЫБОР… <op> …`, и его нужно держать листом (КОНЕЦ несёт хвост; фаза 6.15.21,
      // MCP). Пробуем разобрать CASE; если за ним не граница — откатываемся к листу.
      const save = this.i;
      const caseNode = this.parseCase();
      if (this.atEof()) return caseNode;
      const t = this.peek();
      const boundary =
        isWhen(t) || isElse(t) || isEnd(t) || (t.type === 'punct' && t.value === ')');
      if (boundary) return caseNode;
      // За КОНЕЦ идёт оператор (`КОНЕЦ <> &П`). Если хвост — ПРОСТОЕ сравнение
      // (один верхнеуровневый оператор сравнения и листовой операнд, без вложенного
      // ВЫБОР и без верхнеуровневых И/ИЛИ), конструктор переотрисовывает CASE
      // структурно и приклеивает хвост к КОНЕЦ (`КОНЕЦ <> &П`). Берём этот путь
      // ТОЛЬКО для такой узкой формы; всё прочее (CASE внутри функции, булев хвост)
      // оставляем листом (фаза 6.15.21).
      const trailing = this.tryParseSimpleCaseTrailing();
      if (trailing !== undefined && caseNode.kind === 'case') {
        caseNode.trailing = trailing;
        return caseNode;
      }
      this.i = save; // откат: значение — лист `ВЫБОР… <op> …`
    }
    const startTok = this.peek();
    const from = startTok.pos;
    let to = from;
    let depth = 0;
    // Глубина вложенных ВЫБОР…КОНЕЦ внутри значения-листа (`ВЫБОР… КОНЕЦ <op> …`):
    // их КОГДА/ИНАЧЕ/КОНЕЦ — НЕ границы внешнего слота (фаза 6.15.21).
    let caseDepth = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (t.type === 'punct' && t.value === '(') {
        depth++;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (t.type === 'punct' && t.value === ')') {
        if (depth === 0) break;
        depth--;
        to = t.pos + t.value.length;
        this.i++;
        continue;
      }
      if (depth === 0 && isCase(t)) {
        caseDepth++;
      } else if (depth === 0 && isEnd(t)) {
        if (caseDepth === 0) break;
        caseDepth--;
      } else if (depth === 0 && caseDepth === 0 && (isWhen(t) || isElse(t))) {
        break;
      }
      to = t.pos + t.value.length;
      this.i++;
    }
    return { kind: 'leaf', text: this.leafText(from, to) };
  }
}

// --- needsFormatting --------------------------------------------------------

/** Содержит ли дерево узел OR или CASE (структуру, требующую переотрисовки). */
function treeHasStructure(node: Node): boolean {
  switch (node.kind) {
    case 'or':
      return true;
    case 'case':
      return true;
    case 'and':
      return node.operands.some(treeHasStructure);
    case 'not':
      return treeHasStructure(node.child);
    case 'group':
      return treeHasStructure(node.child);
    case 'leaf':
      return false;
  }
}

/**
 * Требует ли выражение форматирования. Консервативно: true ТОЛЬКО если в
 * структурном дереве есть OR или CASE. Чистый лист, простая И-цепочка без OR/CASE,
 * простые скобки без ИЛИ/ВЫБОР → false (чтобы принятые запросы остались байт-в-байт).
 */
export function needsFormatting(raw: string): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  let tree: Node;
  try {
    tree = new Parser(trimmed).parse();
  } catch {
    return false;
  }
  return treeHasStructure(tree);
}

// --- Printer (boolean) ------------------------------------------------------

/**
 * Рендер булева дерева. Возвращает массив строк; первая строка БЕЗ ведущего
 * отступа (отступ первой строки добавляет родитель/вызывающий через `firstPrefix`
 * и базовый отступ). Остальные строки — с абсолютными табами.
 *
 * `ind` — число табов первой строки узла; `andCont` — табы строк «И x»; `orLvl` —
 * глубина вложения OR. `cont` — контентный отступ секции (для CASE E).
 */
interface RenderCtx {
  cont: number; // C — контентный отступ секции
  caseBoolean: boolean; // CASE в этой позиции — булев слот (E=C+1) или value (E=C)
  stripNotParens?: boolean; // ГДЕ/ИМЕЮЩИЕ: `(НЕ поле)` → `НЕ поле` (конструктор снимает скобки)
  // Дельта отступа подзапроса `В (ВЫБРАТЬ …)` для листа на orLvl=0 (фаза 6.15.9):
  // корневое ГДЕ — 2 (`(ВЫБРАТЬ` на ind+2), условия ВНУТРИ В-подзапроса — 1.
  subDelta0?: number;
}

/** Дельта отступа подзапроса листа по глубине ИЛИ (см. orDelta в renderBool). */
function subDelta(orLvl: number, ctx: RenderCtx): number {
  return orLvl === 0 ? ctx.subDelta0 ?? 2 : 1;
}

function tabs(n: number): string {
  return TAB.repeat(n);
}

/**
 * В ГДЕ/ИМЕЮЩИЕ конструктор снимает скобки вокруг отрицания одиночной ссылки на
 * поле: `(НЕ Алиас.Путь[.Путь…])` → `НЕ Алиас.Путь`. Скобки сохраняются, если под
 * `НЕ` стоит что-то сложнее ссылки (сравнение, ЕСТЬ NULL, В(…), вложенные скобки,
 * вызов функции и т. п.). Лист уже включает внешние скобки дословно.
 */
// Группа `(НЕ Алиас.Путь)` в начале строки; за ней допускается дословный хвост
// (например, ошибочно захваченный парсерном `\n\nУПОРЯДОЧИТЬ ПО …`), который
// обязан начинаться с пробельного символа или конца строки — это гарантирует, что
// мы сняли скобки именно вокруг отрицания одиночного поля, а не вокруг чего-то,
// что продолжается без разрыва (`(НЕ a.X) И …` сюда не попадёт: `И` следует за
// пробелом, но это уже верхнеуровневый булев оператор, который формируется отдельной
// веткой needsFormatting и в stripNegatedFieldParens не приходит).
const NEGATED_FIELD_RE = /^\(\s*НЕ\s+([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*\)(\s[\s\S]*)?$/u;
export function stripNegatedFieldParens(text: string): string {
  const m = NEGATED_FIELD_RE.exec(text);
  if (!m) return text;
  return `НЕ ${m[1]}${m[2] ?? ''}`;
}

/**
 * `НЕ(Алиас.Путь)` → `НЕ Алиас.Путь` (фаза 6.15.11b, MCP): конструктор 1С снимает
 * скобки вокруг отрицания ОДИНОЧНОЙ ссылки на поле, когда `НЕ` стоит вплотную к
 * скобке-операнду (`НЕ(поле)`, в отличие от `(НЕ поле)` — это stripNegatedFieldParens).
 * Скобки сохраняются, если внутри что-то сложнее ссылки (сравнение, функция,
 * запятая, вложенные скобки) — консервативно, чтобы не задеть правила 6.14.
 * Применяется глобально по тексту листа (несколько `НЕ(поле)` в И/ИЛИ-цепочке).
 */
const NOT_FIELD_PARENS_RE =
  /(^|[^\p{L}\p{N}_])НЕ\(\s*([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*\)/gu;
export function stripNotFieldParens(text: string): string {
  return text.replace(NOT_FIELD_PARENS_RE, (_m, pre: string, path: string) => `${pre}НЕ ${path}`);
}

function renderBool(
  node: Node,
  ind: number,
  andCont: number,
  orLvl: number,
  ctx: RenderCtx,
  caseE: number = ind + 1,
  subInd?: number
): string[] {
  switch (node.kind) {
    case 'or': {
      const orDelta = orLvl === 0 ? 2 : 1;
      const iliInd = ind + orDelta;
      const childAnd = iliInd + 1;
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          // operand0 печатается на отступе ind; CASE-операнд → E=ind.
          // Подзапрос листа-операнда — на childAnd (выравнен с операндами ИЛИ).
          const sub = renderBool(op, ind, childAnd, orLvl + 1, ctx, ind, childAnd);
          sub[0] = '(' + sub[0];
          lines.push(...sub);
        } else {
          // operandK на отступе iliInd; CASE-операнд → E=iliInd.
          const sub = renderBool(op, iliInd, childAnd, orLvl + 1, ctx, iliInd, childAnd);
          sub[0] = tabs(iliInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      lines[lines.length - 1] += ')';
      return lines;
    }
    case 'and': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, ind, andCont, orLvl, ctx, caseE, subInd));
        } else {
          // operandK на отступе andCont; CASE-операнд → E=andCont+1.
          const sub = renderBool(op, andCont, andCont + 1, orLvl, ctx, andCont + 1);
          sub[0] = tabs(andCont) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'not': {
      // ГДЕ/ИМЕЮЩИЕ (stripNotParens): НЕ-блок над скобочной группой печатается
      // `НЕ(` слитно, продолжения на ind + orDelta + 1 (фаза 6.14, MCP). В других
      // слотах (ПО/КОГДА) — прежняя раскладка `НЕ <группа>`.
      if (ctx.stripNotParens && node.child.kind === 'group') {
        return renderNotGroup(node.child.child, ind, orLvl, ctx);
      }
      // Структурное НЕ сдвигает подзапрос листа на +1 (как ведущее НЕ в листе).
      const si = (subInd ?? ind + subDelta(orLvl, ctx)) + 1;
      const sub = renderBool(node.child, ind, andCont, orLvl, ctx, caseE, si);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const child = node.child;
      if (child.kind === 'or') {
        return renderBool(child, ind, andCont, orLvl, ctx, caseE, subInd);
      }
      const sub = renderBool(child, ind, andCont, orLvl, ctx, caseE, subInd);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case': {
      // E задаётся вызывающим (caseE); печатаем с явным E.
      return renderCaseE(node, caseE, ctx);
    }
    case 'leaf': {
      let t = ctx.stripNotParens ? stripNotFieldParens(stripNegatedFieldParens(node.text)) : node.text;
      // Голый операнд-приведение ВЫРАЗИТЬ(…) в сравнении — в скобках (фаза 6.15.12).
      t = wrapBareCastOperand(t);
      // Подзапрос внутри листа — перебазировка на контекстный отступ (фаза 6.15.9).
      const rebased = reindentLeafSubquery(t, subInd ?? ind + subDelta(orLvl, ctx));
      // Вложенный в лист ВЫБОР (`(ВЫБОР …)`, `СУММА(ВЫБОР …)`) — КОНЕЦ на ind +
      // число обрамляющих скобок перед ВЫБОР (фаза 6.15.9b).
      return [appendIsNotNullTrailingSpace(reindentLeafCase(rebased, ind))];
    }
  }
}

// --- Printer (КОГДА-condition) ----------------------------------------------

/**
 * Условие после КОГДА (булев слот). Особенности конструктора:
 *   - верхняя OR/группа НЕ оборачивается в скобки (границы задаёт КОГДА…ТОГДА);
 *   - продолжения (`ИЛИ x` / `И x`) — на отступе whenInd + 2;
 *   - первый операнд печатается инлайн после `КОГДА ` (первая строка без отступа).
 */
function renderWhenCondition(node: Node, whenInd: number, ctx: RenderCtx): string[] {
  const contInd = whenInd + 2;
  // Условие КОГДА вида `НЕ(группа)` конструктор печатает как НЕ-блок: `НЕ(` слитно,
  // продолжения на whenInd+3 (на один глубже обычного contInd=whenInd+2),
  // ИЛИ внутри — ещё +1 (фаза 6.15.20, MCP). Иначе вышло бы `НЕ (` с пробелом.
  if (node.kind === 'not' && node.child.kind === 'group') {
    return renderNotGroup(node.child.child, whenInd, 0, ctx);
  }
  switch (node.kind) {
    case 'group':
      return renderWhenCondition(node.child, whenInd, ctx);
    case 'or': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          // Подзапрос операнда0 выравнивается с операндами ИЛИ: contInd+1 (MCP, 6.15.9).
          // ВЫБОР как операнд0 верхнеуровневого ИЛИ КОГДА-условия: его КОНЕЦ конструктор
          // выравнивает со строками ИЛИ (E = contInd = whenInd+2), а НЕ на whenInd+1, как
          // у ВЫБОР, целиком составляющего условие (фаза 6.15.28, MCP).
          const op0CaseE = op.kind === 'case' ? contInd : whenInd + 1;
          lines.push(...renderBool(op, whenInd, contInd + 1, 1, ctx, op0CaseE, contInd + 1));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx, contInd + 1, contInd + 1);
          sub[0] = tabs(contInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'and': {
      // OR-конъюнкты внутри КОГДА-условия используют orDelta=1 (orLvl=1), КРОМЕ
      // ВЕДУЩЕГО операнда-группы `(… ИЛИ …)`: его ИЛИ конструктор выравнивает с
      // И-конъюнктами на contInd (orDelta=2, orLvl=0) — `КОГДА (НЕ A\n\t\tИЛИ НЕ B)
      // \n\t\tИ C` (фаза 6.15.20, MCP).
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, whenInd, contInd, 0, ctx, whenInd + 1, contInd + 1));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx, contInd + 1, contInd + 1);
          sub[0] = tabs(contInd) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    default:
      // Одиночный лист условия КОГДА: подзапрос на whenInd+2 (MCP, 6.15.9).
      return renderBool(node, whenInd, contInd, 1, ctx, whenInd + 1, whenInd + 2);
  }
}

// --- Printer (CASE) ---------------------------------------------------------

/**
 * Рендер ВЫБОР. `cursorInd` — табы строки `ВЫБОР` (она печатается инлайн родителем,
 * поэтому возвращаемая первая строка = 'ВЫБОР' без отступа). `boolean` — слот
 * (true → E=C+1, false → E=C). Возвращает строки; первая — 'ВЫБОР'.
 */
function renderCase(node: Node & { kind: 'case' }, cursorInd: number, ctx: RenderCtx, boolean: boolean): string[] {
  // E — отступ КОНЕЦ. В value-слоте E=cursorInd, в булевом E=cursorInd+1.
  return renderCaseE(node, boolean ? cursorInd + 1 : cursorInd, ctx);
}

/**
 * Рендер ВЫБОР с явным отступом КОНЕЦ = E. Раскладка:
 *   КОГДА=E+1, ТОГДА=E+2, ИНАЧЕ=E+1, КОНЕЦ=E. Первая строка = 'ВЫБОР' (инлайн).
 * Вложенный ВЫБОР после ТОГДА@t/ИНАЧЕ@t → его E = t+1 (value-слот).
 */
/** Текст value-узла (после ТОГДА/ИНАЧЕ). parseValue даёт только leaf или case. */
function valueText(node: Node): string {
  return node.kind === 'leaf' ? node.text : '';
}

/**
 * Строки значения ветки ТОГДА/ИНАЧЕ листового value-узла. Базовый случай —
 * `<keyword> <значение>` одной строкой (подзапрос/В-список переотступаются
 * reindentLeafSubquery). Особый случай — листовой вызов функции с ВЛОЖЕННЫМ
 * СЕЛЕКТОРНЫМ ВЫБОР (`ЕСТЬNULL(…, ЕСТЬNULL(ВЫБОР sel КОГДА … КОНЕЦ, …))`):
 * конструктор сплющивает аргументы и рефлоит встроенный CASE построчно
 * (reflowLeafSelectorCase, фаза 6.15.26). Первая строка рефлоу приклеивается к
 * ключевому слову ветки, остальные — как есть.
 */
/**
 * Однострочное значение ветки ТОГДА/ИНАЧЕ с ВЕРХНЕУРОВНЕВЫМ ИЛИ конструктор 1С
 * раскладывает многострочно: операнд0 инлайн после ключевого слова, каждый
 * следующий — `ИЛИ <операнд>` на отступе kwInd+2; ОХВАТЫВАЮЩИЕ скобки операнда
 * (`(НЕ ЕСТЬNULL(…))`, `(Поле)`) снимаются как избыточная группировка (фаза
 * 6.15.28, MCP). Возвращает null, если значение НЕ является однострочной
 * верхнеуровневой ИЛИ-цепочкой (узкий триггер — иначе раскладку даёт fallback).
 */
/**
 * Снимает ровно одну ОХВАТЫВАЮЩУЮ пару скобок, если она оборачивает ВСЁ выражение
 * (`(НЕ ЕСТЬNULL(…))` → `НЕ ЕСТЬNULL(…)`, `(Поле)` → `Поле`). Если первая `(` не
 * парна последней `)` (скобки лишь частичные, напр. `(a) + (b)`) — текст без
 * изменений.
 */
function stripEnclosingParens(text: string): string {
  const t = text.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      // Закрылась стартовая скобка не на последнем символе — она не охватывающая.
      if (depth === 0 && i !== t.length - 1) return t;
    }
  }
  return depth === 0 ? t.slice(1, -1).trim() : t;
}

function renderOrValueLines(keyword: 'ТОГДА' | 'ИНАЧЕ', value: string, kwInd: number): string[] | null {
  if (value.includes('\n')) return null;
  let tree: Node;
  try {
    tree = new Parser(value.trim(), false).parse();
  } catch {
    return null;
  }
  if (tree.kind !== 'or') return null;
  const ctx: RenderCtx = { cont: 1, caseBoolean: false };
  const iliInd = kwInd + 2;
  const lines: string[] = [];
  tree.operands.forEach((op, k) => {
    // Снять охватывающие скобки операнда (избыточная группировка). Структурную
    // группу (`(a ИЛИ b)`) разворачиваем через child; листовой операнд, целиком
    // обёрнутый в скобки (`(НЕ ЕСТЬNULL(…))`, `(Поле)`) — снимаем строкой.
    const bare = op.kind === 'group' ? op.child
      : op.kind === 'leaf' ? ({ kind: 'leaf', text: stripEnclosingParens(op.text) } as Node)
      : op;
    const sub = renderSelectBool(bare, k === 0 ? kwInd : iliInd, iliInd + 1, 1, ctx, iliInd + 1);
    sub[0] = k === 0 ? `${tabs(kwInd)}${keyword} ${sub[0]}` : `${tabs(iliInd)}ИЛИ ${sub[0]}`;
    lines.push(...sub);
  });
  return lines;
}

function renderBranchValueLines(keyword: 'ТОГДА' | 'ИНАЧЕ', value: string, kwInd: number): string[] {
  const orLines = renderOrValueLines(keyword, value, kwInd);
  if (orLines !== null) return orLines;
  const reflowed = reflowLeafSelectorCase(value, kwInd + 2);
  if (reflowed !== null) {
    const parts = reflowed.split('\n');
    return [tabs(kwInd) + keyword + ' ' + parts[0], ...parts.slice(1)];
  }
  return [tabs(kwInd) + keyword + ' ' + reindentLeafSubquery(flattenMultilineLeaf(value), kwInd + 2)];
}

function renderCaseE(node: Node & { kind: 'case' }, E: number, ctx: RenderCtx): string[] {
  const lines: string[] = [node.selector ? 'ВЫБОР ' + node.selector : 'ВЫБОР'];
  for (const cl of node.clauses) {
    const whenInd = E + 1;
    const whenLines = renderWhenCondition(cl.whenNode, whenInd, ctx);
    whenLines[0] = tabs(whenInd) + 'КОГДА ' + whenLines[0];
    lines.push(...whenLines);
    const thenInd = E + 2;
    if (cl.thenNode.kind === 'case') {
      const sub = renderCaseE(cl.thenNode, thenInd + 1, ctx);
      sub[0] = tabs(thenInd) + 'ТОГДА ' + sub[0];
      lines.push(...sub);
    } else {
      // Подзапрос значения ТОГДА — на thenInd+2 (MCP, 6.15.9). Многострочный
      // не-подзапросный операнд `В`/`В ИЕРАРХИИ` (одиночный параметр, список
      // значений, `ЗНАЧЕНИЕ(…)`-список) конструктор печатает ИНЛАЙН — сплющиваем
      // (фаза 6.15.11c); подзапрос flattenMultilineLeaf не трогает (стоп-слово ВЫБРАТЬ).
      lines.push(...renderBranchValueLines('ТОГДА', valueText(cl.thenNode), thenInd));
    }
  }
  if (node.elseExpr) {
    const elseInd = E + 1;
    if (node.elseExpr.kind === 'case') {
      const sub = renderCaseE(node.elseExpr, elseInd + 1, ctx);
      sub[0] = tabs(elseInd) + 'ИНАЧЕ ' + sub[0];
      lines.push(...sub);
    } else {
      // Подзапрос значения ИНАЧЕ — на elseInd+2 (MCP, 6.15.9). Не-подзапросный
      // многострочный операнд `В` — ИНЛАЙН (фаза 6.15.11c, см. ТОГДА выше).
      lines.push(...renderBranchValueLines('ИНАЧЕ', valueText(node.elseExpr), elseInd));
    }
  }
  lines.push(tabs(E) + 'КОНЕЦ' + (node.trailing ? ' ' + node.trailing : ''));
  return lines;
}

// --- public formatExpression ------------------------------------------------

/**
 * Печатает выражение в каноническом виде конструктора для указанного слота.
 * Первая строка БЕЗ ведущего отступа (его добавляет вызывающий, прибавляя базовый
 * таб слота); продолжения — с абсолютными табами.
 */
export function formatExpression(raw: string, slot: ExprSlot, rootSubDelta?: number): string {
  const trimmed = raw.trim();
  // Сплющивание многострочных листьев в одну строку — только для полей выборки
  // (слот select); в ГДЕ/ИМЕЮЩИЕ/ПО структура исходника сохраняется дословно
  // (там конструктор переотрисовывает булевы операторы и внутри скобок листа —
  // отдельный механизм; сплющивание дало бы регрессии).
  const parser = new Parser(trimmed, slot === 'select');
  const tree = parser.parse();

  // Дословный хвост: то, что парсер не потребил (например, ошибочно захваченные
  // парсером SDBL `\n\nУПОРЯДОЧИТЬ ПО …` / `\nИТОГИ ПО …` после КОНЕЦ/скобки).
  // Сохраняем как есть (с исходными пробелами), чтобы не терять текст.
  const tail = parser.tail();

  let body: string;
  if (slot === 'where' || slot === 'having') {
    const ctx: RenderCtx = { cont: 1, caseBoolean: true, stripNotParens: true, subDelta0: rootSubDelta };
    // ИМЕЮЩИЕ: верхний OR использует orDelta=1 (ИЛИ на отступе 2), в отличие от
    // ГДЕ (orDelta=2, ИЛИ на 3) — эмулируем стартовым orLvl=1.
    const startOrLvl = slot === 'having' ? 1 : 0;
    if (tree.kind === 'case') {
      // Отдельный ВЫБОР-конъюнкт ИМЕЮЩИЕ (парсер дробит `A <> X И ВЫБОР…КОНЕЦ` на два
      // условия; второе — голый ВЫБОР, конъюнкты склеивает renderHaving хвостовым ` И`)
      // конструктор печатает на отступе условия: КОНЕЦ = cont, КОГДА = cont+1 (а НЕ
      // в булевом слоте cont+1/КОНЕЦ). В ГДЕ конъюнкты склеиваются префиксом `И ВЫБОР`,
      // и там ВЫБОР остаётся в булевом слоте (E = cont+1) — фаза 6.15.19, MCP.
      body = renderCase(tree, ctx.cont, ctx, slot === 'where').join('\n');
    } else if (tree.kind === 'not' && tree.child.kind === 'group') {
      // НЕ-блок целиком (`НЕ (…)`): конструктор печатает `НЕ(` слитно и держит
      // скобки независимо от наличия ИЛИ внутри (фаза 6.14, MCP).
      body = renderNotGroup(tree.child.child, 1, startOrLvl, ctx).join('\n');
    } else {
      body = renderBool(tree, 1, 1, startOrLvl, ctx).join('\n');
    }
  } else if (slot === 'select') {
    const ctx: RenderCtx = { cont: 1, caseBoolean: false };
    if (tree.kind === 'case' && tail.trim() !== '') {
      // ВЫБОР — часть арифметики поля (`ВЫБОР…КОНЕЦ + ВЫБОР…КОНЕЦ`): булев парсер
      // забирает только первый ВЫБОР, остаток уходит в tail дословно. Несколько
      // соседних ВЫБОР раскладывает построчный reindentLeafCase (фаза 6.15.19);
      // он переотбивает все КОНЕЦ/КОГДА на E=cont. Если он не справился (вернул
      // вход без изменений) — откатываемся на старую склейку первого ВЫБОР + tail.
      const flat = flattenMultilineLeaf(trimmed);
      const reindented = reindentLeafCase(flat, ctx.cont);
      body =
        reindented !== flat
          ? reindented
          : renderCase(tree, ctx.cont, ctx, false).join('\n') + tail;
      return body;
    }
    if (tree.kind === 'case') {
      body = renderCase(tree, ctx.cont, ctx, false).join('\n');
    } else {
      // Поле выборки = булево выражение (OR/AND/НЕ): value-слот, orDelta=1, без
      // оборачивающих скобок. operand0 @ base 1, ИЛИ @ base+1. Продолжения
      // верхнеуровневой И-цепочки поля — на base+1 (andCont=2), как у плоской
      // цепочки reindentLeafBool (фаза 6.15.19) и по MCP (фаза 6.15.20).
      body = renderSelectBool(tree, 1, 2, 0, ctx).join('\n');
    }
  } else {
    // join
    const ctx: RenderCtx = { cont: 2, caseBoolean: true };
    body = renderJoin(tree, ctx);
  }

  return body + tail;
}

/**
 * НЕ-блок в условии ГДЕ/ИМЕЮЩИЕ: `НЕ (…)` (фаза 6.14, MCP). Раскладка:
 *   - первая строка `НЕ(` слитно с первым операндом;
 *   - продолжения (`И x` / `ИЛИ x`) — на отступе cont = ind + orDelta + 1
 *     (корень ГДЕ: 4 таба, корень ИМЕЮЩИЕ: 3, вложенный НЕ: ind + 2 — на один
 *     глубже строк ИЛИ обычного ИЛИ-блока на той же глубине);
 *   - вложенные скобочные ИЛИ-группы и НЕ-блоки внутри операндов — рекурсивно
 *     (ИЛИ на cont+1);
 *   - внешние скобки сохраняются всегда (НЕ синтаксически требует скобок),
 *     даже когда внутри нет ИЛИ.
 * `ind` — отступ строки, на которой начинается `НЕ(` (первая строка без отступа,
 * его добавляет вызывающий).
 */
function renderNotGroup(child: Node, ind: number, orLvl: number, ctx: RenderCtx): string[] {
  const cont = ind + (orLvl === 0 ? 2 : 1) + 1;
  let lines: string[];
  if (child.kind === 'or' || child.kind === 'and') {
    const word = child.kind === 'or' ? 'ИЛИ ' : 'И ';
    lines = [];
    // Когда НЕ(-блок — это OR-цепочка с И-конъюнктами в операндах, конъюнкты `И`
    // ВЕДУЩЕГО операнда конструктор кладёт на тот же отступ, что и `И` прочих
    // операндов — cont+1, на +1 глубже строк `ИЛИ` (приоритет И>ИЛИ; фаза 6.15.21,
    // MCP). Для одиночного операнда (нет верхнеур. ИЛИ) сдвига нет — andCont=cont.
    const op0And = child.kind === 'or' ? cont + 1 : cont;
    child.operands.forEach((op, k) => {
      if (k === 0) {
        // Подзапрос операнда НЕ(-блока — на cont+1 (выравнен по операндам, 6.15.9).
        lines.push(...renderBool(op, ind, op0And, orLvl + 1, ctx, ind + 1, cont + 1));
      } else {
        const sub = renderBool(op, cont, cont + 1, orLvl + 1, ctx, cont + 1, cont + 1);
        sub[0] = tabs(cont) + word + sub[0];
        lines.push(...sub);
      }
    });
  } else {
    lines = renderBool(child, ind, cont, orLvl + 1, ctx, ind + 1, cont + 1);
  }
  lines[0] = 'НЕ(' + lines[0];
  lines[lines.length - 1] += ')';
  return lines;
}

/**
 * Корень выражения — НЕ над скобочной группой (`НЕ (a И b)`)? Такое условие
 * конструктор переотрисовывает (`НЕ(` слитно, продолжения на фикс. отступе),
 * даже когда внутри нет ИЛИ/ВЫБОР и needsFormatting возвращает false (фаза 6.14).
 */
export function isRootNotGroup(raw: string): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  let tree: Node;
  try {
    tree = new Parser(trimmed).parse();
  } catch {
    return false;
  }
  return tree.kind === 'not' && tree.child.kind === 'group';
}

/**
 * Рендер булева выражения в value-слоте поля выборки. Отличия от ГДЕ:
 *   - OR не оборачивается в скобки;
 *   - orDelta = 1 (а не 2): operand0 @ ind, строки `ИЛИ x` @ ind+1.
 * Листья и НЕ — как обычно (НЕ инлайн).
 */
function renderSelectBool(node: Node, ind: number, andCont: number, orLvl: number, ctx: RenderCtx, subInd?: number): string[] {
  switch (node.kind) {
    case 'or': {
      const iliInd = ind + 1;
      const childAnd = iliInd + 1;
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          // Подзапрос операнда0 выравнен с операндами ИЛИ: childAnd (MCP, 6.15.9).
          lines.push(...renderSelectBool(op, ind, childAnd, orLvl + 1, ctx, childAnd));
        } else {
          const sub = renderSelectBool(op, iliInd, childAnd, orLvl + 1, ctx, childAnd);
          sub[0] = tabs(iliInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'and': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderSelectBool(op, ind, andCont, orLvl, ctx, subInd));
        } else {
          const sub = renderSelectBool(op, andCont, andCont + 1, orLvl, ctx);
          sub[0] = tabs(andCont) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'not': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx, (subInd ?? ind + 1) + 1);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx, subInd);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case':
      return renderCase(node, ind, ctx, false);
    case 'leaf':
      // Подзапрос поля выборки — на ind+1 (MCP, 6.15.9).
      return [reindentLeafSubquery(node.text, subInd ?? ind + 1)];
  }
}

// --- Printer (join ПО) ------------------------------------------------------

/**
 * Условие соединения ПО (составное / со структурой). База — контентный отступ 2.
 * Конструктор трактует условие как И-цепочку конъюнктов и переотрисовывает только
 * отступы/переносы; текст каждого конъюнкта (в т.ч. наличие/отсутствие скобок)
 * сохраняется ДОСЛОВНО из исходника. Первый конъюнкт — на строке `ПО ` (вызывающий
 * уже напечатал `ПО `); каждый следующий — `И <конъюнкт>` на отступе base+1.
 *   - конъюнкт-лист → дословный текст (скобки из исходника НЕ добавляются и НЕ
 *     снимаются);
 *   - конъюнкт с OR/CASE → структурная переотрисовка (ИЛИ на отступе +1).
 */
function renderJoin(tree: Node, ctx: RenderCtx): string {
  const base = ctx.cont; // 2
  const conjuncts: Node[] = tree.kind === 'and' ? tree.operands : [tree];
  const lines: string[] = [];
  conjuncts.forEach((c, k) => {
    const ind = k === 0 ? base : base + 1;
    // Первый конъюнкт сидит на base — его OR использует orDelta=2 (ИЛИ на base+2);
    // OR внутри последующего И-конъюнкта — orDelta=1 (ИЛИ на ind+1).
    const orLvl = k === 0 ? 0 : 1;
    const sub = renderJoinConjunct(c, ind, ctx, orLvl);
    if (k > 0) sub[0] = tabs(ind) + 'И ' + sub[0];
    lines.push(...sub);
  });
  return lines.join('\n');
}

/**
 * Печатает ОДИН конъюнкт условия `ПО` (фаза 6.15.5: поконъюнктный рендер сложных
 * конъюнктов вместо отката на legacy-путь всего условия). Геометрия идентична
 * `renderJoin`: первый конъюнкт — ind=2/orLvl=0 (его ИЛИ на отступе 4), последующий
 * И-конъюнкт — ind=3/orLvl=1 (ИЛИ на 4). Первая строка без ведущего отступа (как у
 * `formatExpression`); префикс `И ` добавляет вызывающий.
 */
export function formatJoinConjunct(raw: string, first: boolean, base = 2): string {
  // flattenLeaves: многострочные листья внутри конъюнкта (`В (\n a,\n b)` в
  // ИЛИ-операнде) конструктор сплющивает в одну строку (корпус: ВариантыОтчетов
  // bsl_27/28); листья с подзапросом/булевыми операторами не трогаются.
  // `base` — отступ строки ПО (2 + глубина вложенного дерева, фаза 6.15.8).
  const parser = new Parser(raw.trim(), true);
  const tree = parser.parse();
  const tail = parser.tail();
  const ctx: RenderCtx = { cont: base, caseBoolean: true };
  const ind = first ? base : base + 1;
  const orLvl = first ? 0 : 1;
  // Произвольный ВЫБОР-конъюнкт конструктор печатает в скобках (корпус: 6/6 в
  // скобках, голых нет) — скобки исходника сняты классификатором, восстанавливаем
  // раскладкой скобочной группы (`renderCaseE` + внешние скобки).
  if (tree.kind === 'case') {
    // Хвост после КОНЕЦ (`ВЫБОР…КОНЕЦ + ВЫБОР…КОНЕЦ = X`) — это арифметическое/
    // сравнительное выражение из нескольких ВЫБОР, а не одиночный CASE: рендерим
    // весь текст листом (reindentLeafCase раскладывает `КОНЕЦ + ВЫБОР` и хвост на
    // последнем КОНЕЦ), оборачивая в скобки. КОНЕЦ — на base+1 (фаза 6.15.21, MCP).
    if (tail.trim() !== '') {
      const leaf = reindentLeafCase(
        reindentLeafSubquery(raw.trim(), base + 2),
        base + 1
      );
      return '(' + leaf + ')';
    }
    // Восстановленная внешняя скобка `(ВЫБОР … КОНЕЦ)` фиксирует КОНЕЦ на base+1
    // (КОГДА=base+2) НЕЗАВИСИМО от позиции конъюнкта: первый конъюнкт стоит на
    // base, последующий `И …` — на base+1, но скобка выравнивает КОНЕЦ обоих на
    // base+1 (фаза 6.15.9b, MCP/корпус: bsl_14 первый, bsl_195 второй).
    const sub = renderCaseE(tree, base + 1, ctx);
    sub[0] = '(' + sub[0];
    sub[sub.length - 1] += ')';
    return sub.join('\n') + tail;
  }
  return renderJoinConjunct(tree, ind, ctx, orLvl).join('\n') + tail;
}

/**
 * Один конъюнкт условия ПО. Лист — дословно (скобки как в исходнике). Структурная
 * скобочная группа с OR — раскрывается с сохранением внешних скобок и отступом
 * ИЛИ = ind+1. CASE — раскладка булева слота.
 */
function renderJoinConjunct(node: Node, ind: number, ctx: RenderCtx, orLvl: number): string[] {
  switch (node.kind) {
    case 'leaf':
      // Подзапрос конъюнкта ПО — на base+2 для любого конъюнкта: первый (ind=base,
      // orLvl=0 → +2) и И-конъюнкт (ind=base+1, orLvl=1 → +1) дают один отступ (MCP).
      // Вложенный в лист ВЫБОР (`(ВЫБОР …)`) — КОНЕЦ на ind + число обрамляющих
      // скобок перед ВЫБОР (фаза 6.15.9b).
      return reindentLeafCase(reindentLeafSubquery(node.text, ind + subDelta(orLvl, ctx)), ind).split('\n');
    case 'case':
      return renderCase(node, ind, ctx, true);
    case 'not': {
      const sub = renderJoinConjunct(node.child, ind, ctx, orLvl);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      // Скобочная группа в исходнике (например `(a ИЛИ b)`). Если содержимое — OR,
      // оно само оборачивается в (…) — не дублируем скобки.
      const child = node.child;
      if (child.kind === 'or') {
        return renderBool(child, ind, ind + 1, orLvl, ctx);
      }
      if (child.kind === 'case') {
        // `(ВЫБОР … КОНЕЦ)` в ПО: внешняя скобка фиксирует КОНЕЦ на base+1 независимо
        // от позиции конъюнкта. Здесь base восстанавливается из ind: первый конъюнкт
        // (orLvl=0) ind=base → КОНЕЦ=ind+1; последующий `И …` (orLvl=1) ind=base+1 →
        // КОНЕЦ=ind (фаза 6.15.9b; корпус: bsl_14 первый, bsl_195 второй).
        const caseEnd = orLvl === 0 ? ind + 1 : ind;
        const sub = renderCaseE(child, caseEnd, ctx);
        sub[0] = '(' + sub[0];
        sub[sub.length - 1] += ')';
        return sub;
      }
      const sub = renderBool(child, ind, ind + 1, orLvl, ctx);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'or':
      return renderBool(node, ind, ind + 1, orLvl, ctx);
    case 'and':
      return renderBool(node, ind, ind + 1, orLvl, ctx);
    default:
      return [''];
  }
}
