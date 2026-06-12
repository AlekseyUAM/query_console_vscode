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
 * Содержит ли лист верхнеуровневый булев оператор И/ИЛИ (вне скобок и вне `МЕЖДУ a
 * И b`). Такой «лист» — на самом деле булево значение-выражение, которое конструктор
 * раскладывает по строкам с переносом по оператору; сплющивать его нельзя.
 */
export function leafHasTopBoolean(raw: string): boolean {
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
    if (depth !== 0) continue;
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
 * Правая часть простого условия `<op> <param>`. Конструктор 1С не ставит пробел перед
 * скобкой списка значений у оператора `В` (и `В ИЕРАРХИИ`): `В (&Список)` → `В(&Список)`,
 * `В ИЕРАРХИИ (&Род)` → `В ИЕРАРХИИ(&Род)`. Перед подзапросом (`В (ВЫБРАТЬ …)`) конструктор
 * переносит на новую строку — это вне модели простых условий (фаза 6.11), здесь не трогаем.
 * Общая точка генератора и парсера (фаза 6.14.4): парсер строит этим же рендером
 * текст произвольного условия с не-параметром справа — байт-в-байт со старым выводом.
 */
export function renderOperatorRhs(op: string, param: string): string {
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
      return `В${valueListIsMulti(list) ? ' ' : ''}${list}`;
    }
    if (param.startsWith('ИЕРАРХИИ (')) return 'В ИЕРАРХИИ' + param.slice('ИЕРАРХИИ'.length).replace(/^ \(/, '(');
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

export function normalizeLeafCase(raw: string): string {
  if (!raw) return raw;
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
  | { kind: 'case'; clauses: CaseClause[]; elseExpr?: Node | null; elseText?: string; selector?: string }
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
      this.flattenLeaves && raw.includes('\n') && !leafHasSubquery(raw) && !leafHasTopBoolean(raw)
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
      return this.parseCase();
    }
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
      if (depth === 0 && (isWhen(t) || isElse(t) || isEnd(t))) break;
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

function renderBool(
  node: Node,
  ind: number,
  andCont: number,
  orLvl: number,
  ctx: RenderCtx,
  caseE: number = ind + 1
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
          const sub = renderBool(op, ind, childAnd, orLvl + 1, ctx, ind);
          sub[0] = '(' + sub[0];
          lines.push(...sub);
        } else {
          // operandK на отступе iliInd; CASE-операнд → E=iliInd.
          const sub = renderBool(op, iliInd, childAnd, orLvl + 1, ctx, iliInd);
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
          lines.push(...renderBool(op, ind, andCont, orLvl, ctx, caseE));
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
      const sub = renderBool(node.child, ind, andCont, orLvl, ctx, caseE);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const child = node.child;
      if (child.kind === 'or') {
        return renderBool(child, ind, andCont, orLvl, ctx, caseE);
      }
      const sub = renderBool(child, ind, andCont, orLvl, ctx, caseE);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case': {
      // E задаётся вызывающим (caseE); печатаем с явным E.
      return renderCaseE(node, caseE, ctx);
    }
    case 'leaf': {
      const t = ctx.stripNotParens ? stripNegatedFieldParens(node.text) : node.text;
      return [appendIsNotNullTrailingSpace(t)];
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
  switch (node.kind) {
    case 'group':
      return renderWhenCondition(node.child, whenInd, ctx);
    case 'or': {
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, whenInd, contInd + 1, 1, ctx));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx);
          sub[0] = tabs(contInd) + 'ИЛИ ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'and': {
      // OR-конъюнкты внутри КОГДА-условия используют orDelta=1 (orLvl=1).
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderBool(op, whenInd, contInd, 1, ctx));
        } else {
          const sub = renderBool(op, contInd, contInd + 1, 1, ctx);
          sub[0] = tabs(contInd) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    default:
      return renderBool(node, whenInd, contInd, 1, ctx);
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
      lines.push(tabs(thenInd) + 'ТОГДА ' + valueText(cl.thenNode));
    }
  }
  if (node.elseExpr) {
    const elseInd = E + 1;
    if (node.elseExpr.kind === 'case') {
      const sub = renderCaseE(node.elseExpr, elseInd + 1, ctx);
      sub[0] = tabs(elseInd) + 'ИНАЧЕ ' + sub[0];
      lines.push(...sub);
    } else {
      lines.push(tabs(elseInd) + 'ИНАЧЕ ' + valueText(node.elseExpr));
    }
  }
  lines.push(tabs(E) + 'КОНЕЦ');
  return lines;
}

// --- public formatExpression ------------------------------------------------

/**
 * Печатает выражение в каноническом виде конструктора для указанного слота.
 * Первая строка БЕЗ ведущего отступа (его добавляет вызывающий, прибавляя базовый
 * таб слота); продолжения — с абсолютными табами.
 */
export function formatExpression(raw: string, slot: ExprSlot): string {
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
    const ctx: RenderCtx = { cont: 1, caseBoolean: true, stripNotParens: true };
    // ИМЕЮЩИЕ: верхний OR использует orDelta=1 (ИЛИ на отступе 2), в отличие от
    // ГДЕ (orDelta=2, ИЛИ на 3) — эмулируем стартовым orLvl=1.
    const startOrLvl = slot === 'having' ? 1 : 0;
    if (tree.kind === 'case') {
      body = renderCase(tree, ctx.cont, ctx, true).join('\n');
    } else if (tree.kind === 'not' && tree.child.kind === 'group') {
      // НЕ-блок целиком (`НЕ (…)`): конструктор печатает `НЕ(` слитно и держит
      // скобки независимо от наличия ИЛИ внутри (фаза 6.14, MCP).
      body = renderNotGroup(tree.child.child, 1, startOrLvl, ctx).join('\n');
    } else {
      body = renderBool(tree, 1, 1, startOrLvl, ctx).join('\n');
    }
  } else if (slot === 'select') {
    const ctx: RenderCtx = { cont: 1, caseBoolean: false };
    if (tree.kind === 'case') {
      body = renderCase(tree, ctx.cont, ctx, false).join('\n');
    } else {
      // Поле выборки = булево выражение (OR/AND/НЕ): value-слот, orDelta=1, без
      // оборачивающих скобок. operand0 @ base 1, ИЛИ @ base+1.
      body = renderSelectBool(tree, 1, 1, 0, ctx).join('\n');
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
    child.operands.forEach((op, k) => {
      if (k === 0) {
        lines.push(...renderBool(op, ind, cont, orLvl + 1, ctx));
      } else {
        const sub = renderBool(op, cont, cont + 1, orLvl + 1, ctx);
        sub[0] = tabs(cont) + word + sub[0];
        lines.push(...sub);
      }
    });
  } else {
    lines = renderBool(child, ind, cont, orLvl + 1, ctx);
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
function renderSelectBool(node: Node, ind: number, andCont: number, orLvl: number, ctx: RenderCtx): string[] {
  switch (node.kind) {
    case 'or': {
      const iliInd = ind + 1;
      const childAnd = iliInd + 1;
      const lines: string[] = [];
      node.operands.forEach((op, k) => {
        if (k === 0) {
          lines.push(...renderSelectBool(op, ind, childAnd, orLvl + 1, ctx));
        } else {
          const sub = renderSelectBool(op, iliInd, childAnd, orLvl + 1, ctx);
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
          lines.push(...renderSelectBool(op, ind, andCont, orLvl, ctx));
        } else {
          const sub = renderSelectBool(op, andCont, andCont + 1, orLvl, ctx);
          sub[0] = tabs(andCont) + 'И ' + sub[0];
          lines.push(...sub);
        }
      });
      return lines;
    }
    case 'not': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx);
      sub[0] = 'НЕ ' + sub[0];
      return sub;
    }
    case 'group': {
      const sub = renderSelectBool(node.child, ind, andCont, orLvl, ctx);
      sub[0] = '(' + sub[0];
      sub[sub.length - 1] += ')';
      return sub;
    }
    case 'case':
      return renderCase(node, ind, ctx, false);
    case 'leaf':
      return [node.text];
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
 * Один конъюнкт условия ПО. Лист — дословно (скобки как в исходнике). Структурная
 * скобочная группа с OR — раскрывается с сохранением внешних скобок и отступом
 * ИЛИ = ind+1. CASE — раскладка булева слота.
 */
function renderJoinConjunct(node: Node, ind: number, ctx: RenderCtx, orLvl: number): string[] {
  switch (node.kind) {
    case 'leaf':
      return node.text.split('\n');
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
        // `(ВЫБОР … КОНЕЦ)` в ПО: КОНЕЦ на отступе ind (value-слот), внешние скобки.
        const sub = renderCaseE(child, ind, ctx);
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
