/**
 * Парсер SDBL (язык запросов 1С) — фаза 6, слой 6.2.A: рекурсивный спуск над
 * массивом токенов. На этом слое разбирается ОДИН запрос `ВЫБРАТЬ … ИЗ …` без
 * WHERE/JOIN/GROUP/ORDER/TOTALS/UNION. Чистое ядро: без vscode/React/fs.
 *
 * Свойство корректности (оракул круговой идентичности):
 *   generate(parseQuery(generate(model))) === generate(model)
 * для канонического вывода генератора `sdblGenerator.generate`.
 *
 * Архитектура для расширения (следующие подзадачи — WHERE/JOIN/GROUP/…):
 *   - Курсор `Cursor` инкапсулирует позицию в массиве токенов и хранит исходный
 *     текст (`source`) для извлечения сырых срезов (произвольные выражения).
 *   - `parseQuery` парсит секции по порядку: ВЫБРАТЬ → (поля) → ИЗ → (источники).
 *     Точки подключения новых секций — после разбора источников `ИЗ`: добавляйте
 *     `parseWhere`, `parseGroupBy`, `parseOrderBy`, `parseTotals` как отдельные
 *     методы, вызываемые из `parseQuery` после `parseFrom`, проверяя `peek()`.
 *   - Поля собираются как «сырые» диапазоны токенов между запятыми верхнего
 *     уровня и `ИЗ`; их интерпретация (простое/агрегат/выражение) выполняется
 *     ПОСЛЕ разбора `ИЗ`, когда известна карта псевдонимов таблиц.
 */

import type {
  QueryModel,
  SelectedTable,
  SelectedField,
  AggregateFunction,
  SummableField,
  Selection,
  Grouping,
  Condition,
  ConditionOperator,
  Join,
  FieldRef,
  VirtualParams,
} from './queryModel';

import { tokenize } from './sdblLexer';
import type { Token } from './sdblLexer';

/** Обратная карта SDBL-функции агрегирования (инверсия `wrapAggregate`). */
const AGG_KEYWORD_TO_FUNC: Record<string, AggregateFunction> = {
  СУММА: 'Сумма',
  КОЛИЧЕСТВО: 'Количество',
  МАКСИМУМ: 'Максимум',
  МИНИМУМ: 'Минимум',
  СРЕДНЕЕ: 'Среднее',
};

/** Курсор по токенам с доступом к исходному тексту (для сырых срезов). */
class Cursor {
  private idx = 0;
  constructor(
    private readonly tokens: Token[],
    readonly source: string
  ) {}

  peek(offset = 0): Token {
    const j = this.idx + offset;
    return this.tokens[Math.min(j, this.tokens.length - 1)];
  }

  next(): Token {
    const t = this.tokens[this.idx];
    if (this.idx < this.tokens.length - 1) this.idx++;
    return t;
  }

  atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  /** Проверяет, что следующий токен — keyword с данным значением, и поглощает его. */
  expectKeyword(value: string): Token {
    const t = this.peek();
    if (t.type !== 'keyword' || t.value !== value) {
      throw this.error(`ожидалось ключевое слово «${value}»`, t);
    }
    return this.next();
  }

  /** Поглощает keyword, если он есть; возвращает true при успехе. */
  matchKeyword(value: string): boolean {
    const t = this.peek();
    if (t.type === 'keyword' && t.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  expectPunct(value: string): Token {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== value) {
      throw this.error(`ожидался символ «${value}»`, t);
    }
    return this.next();
  }

  matchPunct(value: string): boolean {
    const t = this.peek();
    if (t.type === 'punct' && t.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'punct' && t.value === value;
  }

  isKeyword(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === value;
  }

  error(message: string, t: Token = this.peek()): Error {
    return new Error(`Ошибка разбора ${t.line}:${t.col} — ${message} (получено «${t.value || '<конец>'}»)`);
  }
}

/** Промежуточное представление «сырого» поля до резолвинга псевдонимов. */
interface RawField {
  /** Токены тела поля (без `КАК <alias>`). */
  bodyTokens: Token[];
  /** Псевдоним из `КАК <alias>`, если задан. */
  alias?: string;
  /** Сырой текст тела поля (срез исходника). */
  rawBody: string;
}

const AUTO_ALIAS = /^Поле\d+$/;

export function parseQuery(text: string): QueryModel {
  const tokens = tokenize(text);
  const cur = new Cursor(tokens, text);

  cur.expectKeyword('ВЫБРАТЬ');
  const selection = parseSelectionModifiers(cur);
  const rawFields = parseFieldList(cur);
  cur.expectKeyword('ИЗ');
  const from = parseFrom(cur);
  const tables = from.tables;
  const joins = from.joins;

  // Карта псевдоним → tableId (по правилам resolveAliases, но псевдонимы уже
  // явно прочитаны из `КАК` каждой таблицы).
  const aliasToId = new Map<string, string>();
  for (const t of tables) {
    if (t.alias) aliasToId.set(t.alias, t.id);
  }

  const fields: SelectedField[] = [];
  const aggregates: SummableField[] = [];
  for (const rf of rawFields) {
    interpretField(rf, aliasToId, fields, aggregates);
  }

  // Соединения: достроить ссылки на таблицы по псевдонимам.
  const resolvedJoins = joins.map(j => resolveJoin(j, aliasToId));

  // Секции после ИЗ — в каноническом порядке генератора: ГДЕ → СГРУППИРОВАТЬ ПО.
  let conditions: Condition[] | undefined;
  if (cur.isKeyword('ГДЕ')) {
    conditions = parseWhere(cur, aliasToId);
  }

  let groupingFromClause: { multiple: boolean; groupFields: FieldRef[]; groupSets: FieldRef[][] } | undefined;
  if (cur.isKeyword('СГРУППИРОВАТЬ')) {
    groupingFromClause = parseGroupBy(cur, aliasToId);
  }

  const model: QueryModel = { tables, fields };
  if (selection) model.selection = selection;
  if (resolvedJoins.length > 0) model.joins = resolvedJoins;
  if (conditions && conditions.length > 0) model.conditions = conditions;

  // Группировка: объединяем агрегаты (из полей выборки) с группировочными полями
  // и наборами из секции СГРУППИРОВАТЬ ПО. Не затираем агрегаты группировкой.
  if (aggregates.length > 0 || groupingFromClause) {
    const grouping: Grouping = {
      multiple: groupingFromClause?.multiple ?? false,
      groupFields: groupingFromClause?.groupFields ?? [],
      groupSets: groupingFromClause?.groupSets ?? [],
      aggregates,
    };
    model.grouping = grouping;
  }
  return model;
}

/** Модификаторы выборки в порядке РАЗРЕШЕННЫЕ → РАЗЛИЧНЫЕ → ПЕРВЫЕ N. */
function parseSelectionModifiers(cur: Cursor): Selection | undefined {
  const selection: Selection = {};
  let any = false;
  if (cur.matchKeyword('РАЗРЕШЕННЫЕ')) {
    selection.allowed = true;
    any = true;
  }
  if (cur.matchKeyword('РАЗЛИЧНЫЕ')) {
    selection.distinct = true;
    any = true;
  }
  if (cur.matchKeyword('ПЕРВЫЕ')) {
    const t = cur.peek();
    if (t.type !== 'number') throw cur.error('ожидалось число после ПЕРВЫЕ', t);
    cur.next();
    selection.top = Number(t.value);
    any = true;
  }
  return any ? selection : undefined;
}

/**
 * Сбор «сырых» полей: тело поля = все токены до ` КАК <alias>` (если есть) или до
 * запятой верхнего уровня / `ИЗ`. Скобки учитываются для определения верхнего
 * уровня запятой и для `КАК` внутри выражения (`ВЫРАЗИТЬ(… КАК ТИП)`).
 */
function parseFieldList(cur: Cursor): RawField[] {
  const fields: RawField[] = [];
  for (;;) {
    const rf = parseOneField(cur);
    fields.push(rf);
    if (cur.matchPunct(',')) continue;
    break;
  }
  return fields;
}

function parseOneField(cur: Cursor): RawField {
  const bodyTokens: Token[] = [];
  let alias: string | undefined;
  let depth = 0;

  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      // Граница поля на верхнем уровне.
      if (t.type === 'punct' && t.value === ',') break;
      if (t.type === 'keyword' && t.value === 'ИЗ') break;
      if (t.type === 'keyword' && t.value === 'КАК') {
        cur.next();
        const a = cur.peek();
        if (a.type !== 'ident' && a.type !== 'keyword') {
          throw cur.error('ожидался псевдоним после КАК', a);
        }
        cur.next();
        alias = a.value;
        break;
      }
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    bodyTokens.push(cur.next());
  }

  if (bodyTokens.length === 0) {
    throw cur.error('пустой элемент выборки', cur.peek());
  }
  const rawBody = sliceSource(cur.source, bodyTokens);
  return { bodyTokens, alias, rawBody };
}

/** Сырой срез исходника по диапазону токенов тела. */
function sliceSource(source: string, bodyTokens: Token[]): string {
  const first = bodyTokens[0];
  const last = bodyTokens[bodyTokens.length - 1];
  const end = last.pos + last.value.length;
  return source.slice(first.pos, end);
}

/** Псевдоним соединения до резолвинга (хранит псевдонимы вместо tableId). */
interface RawJoin {
  kind: 'ВНУТРЕННЕЕ' | 'ЛЕВОЕ' | 'ПРАВОЕ' | 'ПОЛНОЕ';
  /** Псевдоним затравочной (левой по тексту) таблицы. */
  seedAlias: string;
  /** Псевдоним присоединяемой (правой по тексту) таблицы. */
  joinedAlias: string;
  /** Сырые токены условия после `ПО` (до следующего соединения/запятой/секции). */
  condTokens: Token[];
  condText: string;
}

interface FromResult {
  tables: SelectedTable[];
  joins: RawJoin[];
}

/**
 * Список источников `ИЗ`. Каждый источник:
 * `<fullName> [(<params>)] КАК <alias>`. После затравочной таблицы может идти цепочка
 * соединений `[ВНУТРЕННЕЕ|ЛЕВОЕ|ПОЛНОЕ] СОЕДИНЕНИЕ <источник> ПО <условие>`.
 * Параметры виртуальных таблиц разбираются в `virtual` (6.2.B).
 */
function parseFrom(cur: Cursor): FromResult {
  const tables: SelectedTable[] = [];
  const joins: RawJoin[] = [];
  let index = 0;

  const readSource = (): SelectedTable => {
    const table = parseTableSource(cur, index);
    index++;
    return table;
  };

  for (;;) {
    const seed = readSource();
    tables.push(seed);
    let lastAlias = seed.alias!;

    // Цепочка соединений с этой затравкой.
    while (isJoinKeyword(cur)) {
      const kind = cur.next().value as RawJoin['kind'];
      cur.expectKeyword('СОЕДИНЕНИЕ');
      const joined = readSource();
      tables.push(joined);
      cur.expectKeyword('ПО');
      const { tokens, text } = readJoinCondition(cur);
      joins.push({
        kind,
        seedAlias: lastAlias,
        joinedAlias: joined.alias!,
        condTokens: tokens,
        condText: text,
      });
      // Левоассоциативная цепочка: следующее соединение присоединяется к последней.
      lastAlias = joined.alias!;
    }

    if (cur.matchPunct(',')) continue;
    break;
  }
  return { tables, joins };
}

/** Один источник таблицы: `<fullName> [(<params>)] КАК <alias>`. */
function parseTableSource(cur: Cursor, index: number): SelectedTable {
  const fullName = parseDottedName(cur);

  let virtual: VirtualParams | undefined;
  if (cur.isPunct('(')) {
    virtual = parseVirtualParams(cur, fullName);
  }

  cur.expectKeyword('КАК');
  const aliasTok = cur.peek();
  if (aliasTok.type !== 'ident' && aliasTok.type !== 'keyword') {
    throw cur.error('ожидался псевдоним таблицы после КАК', aliasTok);
  }
  cur.next();

  const table: SelectedTable = {
    id: 't' + index,
    fullName,
    alias: aliasTok.value,
  };
  if (virtual) table.virtual = virtual;
  return table;
}

const JOIN_KEYWORDS = new Set(['ВНУТРЕННЕЕ', 'ЛЕВОЕ', 'ПРАВОЕ', 'ПОЛНОЕ']);
function isJoinKeyword(cur: Cursor): boolean {
  const t = cur.peek();
  return t.type === 'keyword' && JOIN_KEYWORDS.has(t.value);
}

/**
 * Сырые токены и текст условия `ПО` до следующего соединения / запятой верхнего
 * уровня / конца секции ИЗ (ГДЕ/СГРУППИРОВАТЬ/eof). Скобки учитываются, чтобы
 * запятые и ключевые слова внутри не обрывали условие.
 */
function readJoinCondition(cur: Cursor): { tokens: Token[]; text: string } {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && t.value === ',') break;
      if (isJoinKeyword(cur)) break;
      if (t.type === 'keyword' && (t.value === 'ГДЕ' || t.value === 'СГРУППИРОВАТЬ')) break;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    tokens.push(cur.next());
  }
  if (tokens.length === 0) throw cur.error('пустое условие соединения после ПО');
  return { tokens, text: sliceSource(cur.source, tokens) };
}

/** Точечно-разделённое имя: ident (. ident)*. Возвращает исходную строку. */
function parseDottedName(cur: Cursor): string {
  const first = cur.peek();
  if (first.type !== 'ident' && first.type !== 'keyword') {
    throw cur.error('ожидалось имя', first);
  }
  let name = cur.next().value;
  while (cur.isPunct('.')) {
    cur.next();
    const seg = cur.peek();
    if (seg.type !== 'ident' && seg.type !== 'keyword') {
      throw cur.error('ожидался сегмент имени после «.»', seg);
    }
    name += '.' + cur.next().value;
  }
  return name;
}

/**
 * Разбор параметров виртуальной таблицы `( arg0, arg1, … )` в `VirtualParams`.
 * Аргументы разделяются запятыми ВЕРХНЕГО уровня (скобки внутри игнорируются),
 * каждый аргумент — сырой срез исходника (может быть пустым для пропущенной
 * позиции). Раскладка позиций инвертирует `renderSource`/`accountingPositions`
 * из sdblGenerator по виду регистра и срезу (3-й сегмент `fullName`).
 */
function parseVirtualParams(cur: Cursor, fullName: string): VirtualParams {
  const args = parsePositionalArgs(cur);
  const parts = fullName.split('.');
  const kind = parts[0];
  const slice = parts[2];
  const v: VirtualParams = {};
  const set = (key: keyof VirtualParams, value: string): void => {
    if (value !== '') (v as Record<string, unknown>)[key] = value;
  };

  if (kind === 'РегистрБухгалтерии') {
    fillAccounting(v, slice, args, set);
    return v;
  }

  if (slice === 'Обороты') {
    // [startPeriod, endPeriod, periodicity, condition] — фиксированная арность 4.
    set('startPeriod', args[0] ?? '');
    set('endPeriod', args[1] ?? '');
    set('periodicity', args[2] ?? '');
    set('condition', args[3] ?? '');
    return v;
  }
  if (slice === 'ОстаткиИОбороты') {
    // [startPeriod, endPeriod, periodicity, fillMethod, condition] — арность 5.
    set('startPeriod', args[0] ?? '');
    set('endPeriod', args[1] ?? '');
    set('periodicity', args[2] ?? '');
    set('fillMethod', args[3] ?? '');
    set('condition', args[4] ?? '');
    return v;
  }

  // РС срезы / РН Остатки: [period, condition], хвостовые пустые отброшены.
  set('period', args[0] ?? '');
  set('condition', args[1] ?? '');
  return v;
}

/** Раскладка позиций регистра бухгалтерии — инверсия `accountingPositions`. */
function fillAccounting(
  v: VirtualParams,
  slice: string,
  args: string[],
  set: (key: keyof VirtualParams, value: string) => void
): void {
  switch (slice) {
    case 'Остатки':
      // [period, accountCondition, '', condition]
      set('period', args[0] ?? '');
      set('accountCondition', args[1] ?? '');
      set('condition', args[3] ?? '');
      return;
    case 'Обороты':
      // non-corr: [startPeriod, endPeriod, periodicity, accountCondition, '', condition]
      // corr (8): + [corrAccountCondition, ''] и correspondence=true
      set('startPeriod', args[0] ?? '');
      set('endPeriod', args[1] ?? '');
      set('periodicity', args[2] ?? '');
      set('accountCondition', args[3] ?? '');
      set('condition', args[5] ?? '');
      if (args.length >= 8) {
        set('corrAccountCondition', args[6] ?? '');
        v.correspondence = true;
      }
      return;
    case 'ОборотыДтКт':
      // [startPeriod, endPeriod, periodicity, accountDtCondition, '', accountKtCondition, '', condition]
      set('startPeriod', args[0] ?? '');
      set('endPeriod', args[1] ?? '');
      set('periodicity', args[2] ?? '');
      set('accountDtCondition', args[3] ?? '');
      set('accountKtCondition', args[5] ?? '');
      set('condition', args[7] ?? '');
      return;
    case 'ОстаткиИОбороты':
      // [startPeriod, endPeriod, periodicity, fillMethod, accountCondition, '', condition]
      set('startPeriod', args[0] ?? '');
      set('endPeriod', args[1] ?? '');
      set('periodicity', args[2] ?? '');
      set('fillMethod', args[3] ?? '');
      set('accountCondition', args[4] ?? '');
      set('condition', args[6] ?? '');
      return;
    case 'ДвиженияССубконто':
      // [startPeriod, endPeriod, condition, order, top]
      set('startPeriod', args[0] ?? '');
      set('endPeriod', args[1] ?? '');
      set('condition', args[2] ?? '');
      set('order', args[3] ?? '');
      set('top', args[4] ?? '');
      return;
  }
}

/**
 * Разбор `( arg0, arg1, … )` в массив сырых строк-аргументов (по срезам
 * исходника). Аргумент может быть пустым (`''`) для пропущенной позиции.
 * Запятые верхнего уровня — разделители; скобки внутри учитываются.
 */
function parsePositionalArgs(cur: Cursor): string[] {
  cur.expectPunct('(');
  const args: string[] = [];
  let curTokens: Token[] = [];
  let depth = 0;
  const flush = (): void => {
    args.push(curTokens.length > 0 ? sliceSource(cur.source, curTokens) : '');
    curTokens = [];
  };
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') throw cur.error('незакрытая скобка параметров', t);
    if (depth === 0 && t.type === 'punct' && t.value === ')') {
      cur.next();
      break;
    }
    if (depth === 0 && t.type === 'punct' && t.value === ',') {
      cur.next();
      flush();
      continue;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    curTokens.push(cur.next());
  }
  flush();
  return args;
}

/**
 * Интерпретация «сырого» поля по карте псевдонимов:
 *   1) агрегат `<ФУНК>(<alias>.<path>)` или `КОЛИЧЕСТВО(РАЗЛИЧНЫЕ <alias>.<path>)`;
 *   2) простое поле `<alias>.<path>`;
 *   3) иначе — произвольное выражение (сырой текст).
 * Для (1) и (2) первый сегмент должен быть известным псевдонимом таблицы; иначе
 * поле трактуется как выражение.
 */
function interpretField(
  rf: RawField,
  aliasToId: Map<string, string>,
  fields: SelectedField[],
  aggregates: SummableField[]
): void {
  // Автопсевдоним `Поле{n}` → поле было произвольным выражением; сохраняем сырой
  // LHS как expression, alias оставляем undefined (генератор воспроизведёт
  // `КАК Поле{n}` сам). Это решает неоднозначность между настоящим агрегатом
  // (с явным псевдонимом) и выражением вида `СУММА(Алиас.Поле)` без псевдонима.
  if (rf.alias !== undefined && AUTO_ALIAS.test(rf.alias)) {
    fields.push({ tableId: '', path: '', expression: rf.rawBody });
    return;
  }

  // 1) Попытка агрегата.
  const agg = tryAggregate(rf.bodyTokens, aliasToId);
  if (agg) {
    const field: SelectedField = { tableId: agg.tableId, path: agg.path };
    if (rf.alias !== undefined) field.alias = rf.alias;
    fields.push(field);
    aggregates.push({ tableId: agg.tableId, path: agg.path, func: agg.func });
    return;
  }

  // 2) Попытка простого поля <alias>.<path>.
  const simple = trySimpleField(rf.bodyTokens, aliasToId);
  if (simple) {
    const field: SelectedField = { tableId: simple.tableId, path: simple.path };
    if (rf.alias !== undefined) field.alias = rf.alias;
    fields.push(field);
    return;
  }

  // 3) Произвольное выражение.
  const field: SelectedField = { tableId: '', path: '', expression: rf.rawBody };
  if (rf.alias !== undefined && !AUTO_ALIAS.test(rf.alias)) {
    field.alias = rf.alias;
  }
  fields.push(field);
}

interface AggHit {
  tableId: string;
  path: string;
  func: AggregateFunction;
}

/** Разбор `<ФУНК>( [РАЗЛИЧНЫЕ] <alias>.<path> )`. */
function tryAggregate(body: Token[], aliasToId: Map<string, string>): AggHit | undefined {
  if (body.length < 4) return undefined;
  const head = body[0];
  if (head.type !== 'keyword') return undefined;

  // Тело должно быть ровно ФУНК ( … ) — открывающая скобка вторым токеном,
  // закрывающая — последним.
  if (!(body[1].type === 'punct' && body[1].value === '(')) return undefined;
  const lastTok = body[body.length - 1];
  if (!(lastTok.type === 'punct' && lastTok.value === ')')) return undefined;

  let inner = body.slice(2, body.length - 1);
  let func: AggregateFunction | undefined;

  if (head.value === 'КОЛИЧЕСТВО' && inner[0]?.type === 'keyword' && inner[0].value === 'РАЗЛИЧНЫЕ') {
    func = 'КоличествоРазличных';
    inner = inner.slice(1);
  } else {
    func = AGG_KEYWORD_TO_FUNC[head.value];
  }
  if (!func) return undefined;

  const ref = parseFieldRef(inner, aliasToId);
  if (!ref) return undefined;
  return { tableId: ref.tableId, path: ref.path, func };
}

/** Разбор простого поля `<alias>.<path>` (всё тело — одна ссылка). */
function trySimpleField(
  body: Token[],
  aliasToId: Map<string, string>
): { tableId: string; path: string } | undefined {
  return parseFieldRef(body, aliasToId);
}

/**
 * Ссылка на поле: последовательность ident, разделённых точками; первый сегмент —
 * известный псевдоним таблицы. Возвращает undefined, если структура не такая или
 * псевдоним неизвестен.
 */
function parseFieldRef(
  tokens: Token[],
  aliasToId: Map<string, string>
): { tableId: string; path: string } | undefined {
  if (tokens.length < 3) return undefined; // минимум alias . segment
  // Чередование ident, '.', ident, '.', ...
  const segs: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (k % 2 === 0) {
      const t = tokens[k];
      if (t.type !== 'ident' && t.type !== 'keyword') return undefined;
      segs.push(t.value);
    } else {
      const t = tokens[k];
      if (!(t.type === 'punct' && t.value === '.')) return undefined;
    }
  }
  if (tokens.length % 2 === 0) return undefined; // должно быть нечётное число токенов
  const aliasName = segs[0];
  const tableId = aliasToId.get(aliasName);
  if (tableId === undefined) return undefined;
  const path = segs.slice(1).join('.');
  if (!path) return undefined;
  return { tableId, path };
}

// ───────────────────────────── ГДЕ (WHERE) ─────────────────────────────

/** Множество токенов-операторов сравнения для условий. */
const COND_OPERATORS = new Set<string>(['=', '<>', '>', '>=', '<', '<=', 'В', 'МЕЖДУ', 'ПОДОБНО']);

/**
 * Секция ГДЕ. Инвертирует `renderConditions`: первое условие, затем каждое
 * последующее после `И` верхнего уровня. Каждый сегмент пытается распознаться как
 * простое условие `<alias>.<path> <op> <param>`; иначе — произвольное (`custom`).
 */
function parseWhere(cur: Cursor, aliasToId: Map<string, string>): Condition[] {
  cur.expectKeyword('ГДЕ');
  const source = cur.source;
  const segments = splitConditionSegments(cur);
  return segments.map(seg => interpretCondition(seg, source, aliasToId));
}

/**
 * Разбивает поток токенов условий на сегменты по `И` верхнего уровня (вне скобок),
 * до конца секции ГДЕ (СГРУППИРОВАТЬ / eof / соединение не встречается здесь, т.к.
 * ГДЕ идёт после ИЗ). Каждый сегмент — массив токенов одного условия.
 */
function splitConditionSegments(cur: Cursor): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'keyword' && t.value === 'СГРУППИРОВАТЬ') break;
      if (t.type === 'keyword' && t.value === 'И') {
        cur.next();
        flush();
        continue;
      }
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    current.push(cur.next());
  }
  flush();
  return segments;
}

/** Интерпретирует один сегмент условия: простое или произвольное. */
function interpretCondition(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>
): Condition {
  const simple = trySimpleCondition(tokens, source, aliasToId);
  if (simple) return simple;
  return { custom: true, expression: sliceSource(source, tokens) };
}

/**
 * Простое условие `<alias>.<path> <op> <param>`: ссылка на поле, оператор сравнения,
 * затем произвольный остаток (параметр). Возвращает undefined, если структура не
 * подходит (тогда сегмент трактуется как произвольное условие).
 */
function trySimpleCondition(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>
): Condition | undefined {
  // Найти первый оператор сравнения верхнего уровня.
  let opIdx = -1;
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && isCondOperatorToken(t)) {
      opIdx = k;
      break;
    }
  }
  if (opIdx <= 0 || opIdx >= tokens.length - 1) return undefined;

  const lhs = tokens.slice(0, opIdx);
  const ref = parseFieldRef(lhs, aliasToId);
  if (!ref) return undefined;

  const op = tokens[opIdx].value as ConditionOperator;
  const paramTokens = tokens.slice(opIdx + 1);
  if (paramTokens.length === 0) return undefined;
  const param = sliceSource(source, paramTokens);

  return { custom: false, tableId: ref.tableId, path: ref.path, operator: op, param };
}

function isCondOperatorToken(t: Token): boolean {
  if (t.type === 'punct') return COND_OPERATORS.has(t.value);
  if (t.type === 'keyword') return COND_OPERATORS.has(t.value);
  return false;
}

// ───────────────────────── соединения (JOINs) ──────────────────────────

/** Раскладка вида соединения → флаги leftAll/rightAll (инверсия joinKeyword). */
function joinFlags(kind: RawJoin['kind']): { leftAll: boolean; rightAll: boolean } {
  switch (kind) {
    case 'ВНУТРЕННЕЕ': return { leftAll: false, rightAll: false };
    case 'ЛЕВОЕ': return { leftAll: true, rightAll: false };
    case 'ПРАВОЕ': return { leftAll: false, rightAll: true };
    case 'ПОЛНОЕ': return { leftAll: true, rightAll: true };
  }
}

/**
 * Достраивает соединение из сырого вида: резолвит псевдонимы затравки/присоединяемой
 * в tableId и разбирает условие `ПО`. Простое: `<aliasL>.<pathL> <op> <aliasR>.<pathR>`;
 * иначе — произвольное (`custom`), причём генератор оборачивает произвольное в
 * скобки, которые здесь снимаются.
 */
function resolveJoin(raw: RawJoin, aliasToId: Map<string, string>): Join {
  const { leftAll, rightAll } = joinFlags(raw.kind);
  const seedId = aliasToId.get(raw.seedAlias) ?? raw.seedAlias;
  const joinedId = aliasToId.get(raw.joinedAlias) ?? raw.joinedAlias;

  const simple = trySimpleJoinCondition(raw.condTokens, aliasToId);
  if (simple) {
    return {
      leftTableId: simple.leftTableId,
      rightTableId: simple.rightTableId,
      leftAll, rightAll, custom: false,
      leftPath: simple.leftPath,
      operator: simple.operator,
      rightPath: simple.rightPath,
    };
  }

  // Произвольное условие: снять внешние скобки, добавленные генератором.
  return {
    leftTableId: seedId,
    rightTableId: joinedId,
    leftAll, rightAll, custom: true,
    expression: stripOuterParens(raw.condText),
  };
}

/**
 * Простое условие соединения `<aliasL>.<pathL> <op> <aliasR>.<pathR>`. Обе стороны —
 * ссылки на поля известных таблиц. leftTableId/rightTableId берутся из самих ссылок
 * (а не из порядка таблиц — генератор строит условие по псевдонимам, не зависящим от
 * перестановки правого соединения).
 */
function trySimpleJoinCondition(
  tokens: Token[],
  aliasToId: Map<string, string>
): { leftTableId: string; leftPath: string; operator: ConditionOperator; rightTableId: string; rightPath: string } | undefined {
  // Без внешних скобок (произвольное условие генератор заключает в скобки).
  if (tokens.length > 0 && tokens[0].type === 'punct' && tokens[0].value === '(') return undefined;

  let opIdx = -1;
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && isCondOperatorToken(t)) {
      opIdx = k;
      break;
    }
  }
  if (opIdx <= 0 || opIdx >= tokens.length - 1) return undefined;

  const left = parseFieldRef(tokens.slice(0, opIdx), aliasToId);
  const right = parseFieldRef(tokens.slice(opIdx + 1), aliasToId);
  if (!left || !right) return undefined;

  return {
    leftTableId: left.tableId,
    leftPath: left.path,
    operator: tokens[opIdx].value as ConditionOperator,
    rightTableId: right.tableId,
    rightPath: right.path,
  };
}

/** Снимает ровно одну пару внешних скобок, если всё выражение в них заключено. */
function stripOuterParens(text: string): string {
  const s = text.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  // Проверить, что первая открывающая скобка закрывается последней.
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s;
    }
  }
  return s;
}

// ──────────────────── СГРУППИРОВАТЬ ПО (GROUP BY) ───────────────────────

/**
 * Секция СГРУППИРОВАТЬ ПО. Инвертирует `renderGrouping`:
 *  - `СГРУППИРОВАТЬ ПО <a.p>, …` → multiple:false, groupFields.
 *  - `СГРУППИРОВАТЬ ПО ГРУППИРУЮЩИМ НАБОРАМ ( (a, b), (c) )` → multiple:true, groupSets.
 */
function parseGroupBy(
  cur: Cursor,
  aliasToId: Map<string, string>
): { multiple: boolean; groupFields: FieldRef[]; groupSets: FieldRef[][] } {
  cur.expectKeyword('СГРУППИРОВАТЬ');
  cur.expectKeyword('ПО');

  if (cur.matchKeyword('ГРУППИРУЮЩИМ')) {
    cur.expectKeyword('НАБОРАМ');
    const groupSets = parseGroupingSets(cur, aliasToId);
    return { multiple: true, groupFields: [], groupSets };
  }

  // Одна группировка: список ссылок через запятую.
  const groupFields: FieldRef[] = [];
  for (;;) {
    const ref = parseGroupFieldRef(cur, aliasToId);
    groupFields.push(ref);
    if (cur.matchPunct(',')) continue;
    break;
  }
  return { multiple: false, groupFields, groupSets: [] };
}

/** Наборы группировки: `( (a, b), (c) )`. */
function parseGroupingSets(cur: Cursor, aliasToId: Map<string, string>): FieldRef[][] {
  cur.expectPunct('(');
  const sets: FieldRef[][] = [];
  for (;;) {
    cur.expectPunct('(');
    const set: FieldRef[] = [];
    for (;;) {
      set.push(parseGroupFieldRef(cur, aliasToId));
      if (cur.matchPunct(',')) continue;
      break;
    }
    cur.expectPunct(')');
    sets.push(set);
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct(')');
  return sets;
}

/** Одна ссылка группировки `<alias>.<path>` → FieldRef. */
function parseGroupFieldRef(cur: Cursor, aliasToId: Map<string, string>): FieldRef {
  const tokens: Token[] = [];
  for (;;) {
    const t = cur.peek();
    if (t.type !== 'ident' && t.type !== 'keyword' && !(t.type === 'punct' && t.value === '.')) break;
    tokens.push(cur.next());
  }
  const ref = parseFieldRef(tokens, aliasToId);
  if (!ref) throw cur.error('ожидалась ссылка на поле группировки', cur.peek());
  return { tableId: ref.tableId, path: ref.path };
}
