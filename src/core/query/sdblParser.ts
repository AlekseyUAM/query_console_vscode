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
  SelectedTabSectionField,
  AggregateFunction,
  SummableField,
  Selection,
  Grouping,
  Condition,
  ConditionOperator,
  Join,
  FieldRef,
  VirtualParams,
  Order,
  OrderField,
  SortDirection,
  Totals,
  TotalGroupField,
  TotalField,
  TotalKind,
  Indexing,
  QueryIndex,
  ReportBuilder,
  BuilderField,
} from './queryModel';

import { defaultTableAlias } from './queryModel';
import { tokenize } from './sdblLexer';
import type { Token } from './sdblLexer';
import { fieldAlias } from './unionModel';
import type { QueryDocument, UnionMember } from './unionModel';
import type { BatchDocument } from './batchModel';

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

  /** Проверяет, что дальше блок построителя `{<keyword>` (punct `{` + ключевое слово). */
  isBuilderBlock(keyword: string): boolean {
    return this.isPunct('{') && this.isKeyword(keyword, 1);
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

/** Сырая табличная часть `<alias>.<tsName>.( … ) КАК <tsName>`. */
interface RawTabSection {
  tableAlias: string;
  tsName: string;
  fields: string[];
}

/** Один элемент списка выборки: обычное поле или табличная часть. */
type RawSelectItem =
  | { kind: 'field'; field: RawField }
  | { kind: 'tabSection'; ts: RawTabSection };

const AUTO_ALIAS = /^Поле\d+$/;
/** Голый параметр выборки `&Имя` (захватывает имя без `&`). */
const BARE_PARAM_ALIAS = /^&([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)$/u;

export function parseQuery(text: string): QueryModel {
  const tokens = tokenize(text);
  const cur = new Cursor(tokens, text);
  return parseSingleQuery(cur);
}

/**
 * Разбирает ОДИН запрос-участник из курсора (без объединений). Выделено в
 * отдельный помощник, чтобы `parseDocument` мог разбирать срезы токенов участников
 * без повторной токенизации (см. 6.2.D). Курсор должен стоять в начале блока
 * запроса; разбор останавливается на eof среза.
 */
function parseSingleQuery(cur: Cursor): QueryModel {
  // УНИЧТОЖИТЬ <name> — самостоятельный запрос (без ВЫБРАТЬ).
  if (cur.isKeyword('УНИЧТОЖИТЬ')) {
    cur.next();
    const name = parseDottedName(cur);
    return { tables: [], fields: [], queryType: 'dropTemp', tempTableName: name };
  }

  // Аккумулятор блоков построителя {…}: заполняется в точках интерливинга.
  const builder: ReportBuilder = { fields: [], conditions: [], order: [], totals: [] };

  cur.expectKeyword('ВЫБРАТЬ');
  const selection = parseSelectionModifiers(cur);
  const items = parseFieldList(cur);

  // {ВЫБРАТЬ …} после списка полей, перед ПОМЕСТИТЬ/ИЗ.
  if (cur.isBuilderBlock('ВЫБРАТЬ')) {
    builder.fields = parseBuilderBlock(cur, 'ВЫБРАТЬ');
  }

  // ПОМЕСТИТЬ/ДОБАВИТЬ <ВТ> между списком полей и ИЗ.
  let queryType: QueryModel['queryType'] | undefined;
  let tempTableName: string | undefined;
  if (cur.matchKeyword('ПОМЕСТИТЬ')) {
    queryType = 'createTemp';
    tempTableName = parseDottedName(cur);
  } else if (cur.matchKeyword('ДОБАВИТЬ')) {
    queryType = 'appendTemp';
    tempTableName = parseDottedName(cur);
  }

  // `ИЗ` опционально: 1С допускает выборку без источника
  // (`ВЫБРАТЬ &Параметр КАК Поле [ПОМЕСТИТЬ ВТ] [ГДЕ …]`) — частый приём для
  // создания временной таблицы из констант/параметров. При отсутствии `ИЗ`
  // секция-источник пуста (нет таблиц/соединений), генератор не выводит `ИЗ`.
  const from: FromResult = cur.matchKeyword('ИЗ')
    ? parseFrom(cur)
    : { tables: [], joins: [] };
  const tables = from.tables;
  const joins = from.joins;

  // Карта псевдоним → tableId (по правилам resolveAliases, но псевдонимы уже
  // явно прочитаны из `КАК` каждой таблицы).
  const aliasToId = new Map<string, string>();
  for (const t of tables) {
    if (t.alias) aliasToId.set(t.alias, t.id);
  }

  // Интерпретация элементов выборки: обычные поля, табличные части и хвостовые
  // поля (после первой табличной части). Карта псевдонимов уже известна.
  const fields: SelectedField[] = [];
  const aggregates: SummableField[] = [];
  const tabSectionFields: SelectedTabSectionField[] = [];
  const trailingFields: SelectedField[] = [];
  // Единственный источник → можно квалифицировать голые поля без метаинформации.
  const soleSource = soleSourceOf(tables, joins);
  let sawTabSection = false;
  for (const item of items) {
    if (item.kind === 'tabSection') {
      sawTabSection = true;
      tabSectionFields.push(resolveTabSection(item.ts, aliasToId, tables));
      continue;
    }
    if (sawTabSection) {
      // Поле после табличной части → trailingFields (порядок генератора).
      interpretField(item.field, aliasToId, trailingFields, aggregates, soleSource);
    } else {
      interpretField(item.field, aliasToId, fields, aggregates, soleSource);
    }
  }

  // Соединения: достроить ссылки на таблицы по псевдонимам.
  const resolvedJoins = joins.map(j => resolveJoin(j, aliasToId));

  // Секции после ИЗ — в каноническом порядке генератора:
  //   ГДЕ → {ГДЕ} → СГРУППИРОВАТЬ ПО → {УПОРЯДОЧИТЬ ПО} → {ИТОГИ ПО}
  //   → УПОРЯДОЧИТЬ ПО → ИТОГИ → ИНДЕКСИРОВАТЬ ПО → ДЛЯ ИЗМЕНЕНИЯ.
  let conditions: Condition[] | undefined;
  if (cur.isKeyword('ГДЕ')) {
    conditions = parseWhere(cur, aliasToId, soleSource);
  }

  if (cur.isBuilderBlock('ГДЕ')) {
    builder.conditions = parseBuilderBlock(cur, 'ГДЕ');
  }

  let groupingFromClause: { multiple: boolean; groupFields: FieldRef[]; groupSets: FieldRef[][] } | undefined;
  if (cur.isKeyword('СГРУППИРОВАТЬ')) {
    groupingFromClause = parseGroupBy(cur, aliasToId);
  }

  // ИМЕЮЩИЕ — фильтр по агрегатам, сразу за СГРУППИРОВАТЬ ПО.
  let having: Condition[] | undefined;
  if (cur.isKeyword('ИМЕЮЩИЕ')) {
    having = parseHaving(cur, aliasToId);
  }

  if (cur.isBuilderBlock('УПОРЯДОЧИТЬ')) {
    builder.order = parseBuilderBlock(cur, 'УПОРЯДОЧИТЬ');
  }
  if (cur.isBuilderBlock('ИТОГИ')) {
    builder.totals = parseBuilderBlock(cur, 'ИТОГИ');
  }

  // ДЛЯ ИЗМЕНЕНИЯ — часть основного блока (до секций порядка/итогов/индекса).
  let lockForUpdate: string[] | undefined;
  if (cur.isKeyword('ДЛЯ')) {
    lockForUpdate = parseLockForUpdate(cur);
  }

  const model: QueryModel = { tables, fields };
  if (selection) model.selection = selection;
  if (queryType) {
    model.queryType = queryType;
    if (tempTableName) model.tempTableName = tempTableName;
  }
  if (tabSectionFields.length > 0) model.tabSectionFields = tabSectionFields;
  if (trailingFields.length > 0) model.trailingFields = trailingFields;
  if (resolvedJoins.length > 0) model.joins = resolvedJoins;
  if (conditions && conditions.length > 0) model.conditions = conditions;
  if (having && having.length > 0) model.having = having;
  if (lockForUpdate && lockForUpdate.length > 0) model.lockForUpdate = lockForUpdate;

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

  // Карта псевдоним выборки → (tableId, path) для секций УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКС.
  const selectAliasMap = buildSelectAliasMap(model);

  if (cur.isKeyword('УПОРЯДОЧИТЬ') || cur.isKeyword('АВТОУПОРЯДОЧИВАНИЕ')) {
    model.order = parseOrder(cur, selectAliasMap, aliasToId);
  }
  if (cur.isKeyword('ИТОГИ')) {
    model.totals = parseTotals(cur, selectAliasMap, aliasToId);
  }
  if (cur.isKeyword('ИНДЕКСИРОВАТЬ')) {
    model.indexing = parseIndex(cur, selectAliasMap, aliasToId);
  }

  if (builder.fields.length || builder.conditions.length || builder.order.length || builder.totals.length) {
    model.builder = builder;
  }

  return model;
}

/**
 * Карта псевдоним выборки → (tableId, path). Инвертирует `selectAliasFor`: ключ —
 * `field.alias` если задан, иначе последний сегмент пути. Только для обычных полей
 * с реальным (tableId, path) (без expression). Первое вхождение псевдонима
 * выигрывает (как `model.fields.find`).
 */
function buildSelectAliasMap(model: QueryModel): Map<string, FieldRef> {
  const map = new Map<string, FieldRef>();
  for (const f of model.fields) {
    if (f.expression) continue;
    /* v8 ignore next -- защитный пропуск: у поля без expression path всегда задан парсером */
    if (!f.path) continue;
    /* v8 ignore next -- pop() на непустом path всегда строка (правая ветвь ?? f.path недостижима) */
    const key = f.alias ?? (f.path.split('.').pop() ?? f.path);
    if (!map.has(key)) map.set(key, { tableId: f.tableId, path: f.path });
  }
  return map;
}

/**
 * Резолвит псевдоним выборки в (tableId, path). Если псевдоним известен — берётся
 * из карты (воспроизводит `selectAliasFor`). Иначе поле не из выборки: tableId='',
 * path=псевдоним, что даёт `selectAliasFor('', alias) → alias`.
 */
function resolveSelectAlias(alias: string, map: Map<string, FieldRef>): FieldRef {
  const hit = map.get(alias);
  if (hit) return { tableId: hit.tableId, path: hit.path };
  return { tableId: '', path: alias };
}

/**
 * Модификаторы выборки сразу после `ВЫБРАТЬ`. Конструктор пишет их в порядке
 * РАЗРЕШЕННЫЕ → РАЗЛИЧНЫЕ → ПЕРВЫЕ N, но разработчик может указать в любом
 * порядке (`ПЕРВЫЕ 1 РАЗРЕШЕННЫЕ`, `РАЗЛИЧНЫЕ РАЗРЕШЕННЫЕ` и т. п.). Парсим в
 * любом порядке, каждый модификатор не более одного раза; генератор сам выдаёт
 * их в каноническом порядке.
 */
function parseSelectionModifiers(cur: Cursor): Selection | undefined {
  const selection: Selection = {};
  let any = false;
  for (;;) {
    if (selection.allowed === undefined && cur.matchKeyword('РАЗРЕШЕННЫЕ')) {
      selection.allowed = true;
      any = true;
      continue;
    }
    if (selection.distinct === undefined && cur.matchKeyword('РАЗЛИЧНЫЕ')) {
      selection.distinct = true;
      any = true;
      continue;
    }
    if (selection.top === undefined && cur.matchKeyword('ПЕРВЫЕ')) {
      const t = cur.peek();
      if (t.type !== 'number') throw cur.error('ожидалось число после ПЕРВЫЕ', t);
      cur.next();
      selection.top = Number(t.value);
      any = true;
      continue;
    }
    break;
  }
  return any ? selection : undefined;
}

/**
 * Сбор «сырых» полей: тело поля = все токены до ` КАК <alias>` (если есть) или до
 * запятой верхнего уровня / `ИЗ`. Скобки учитываются для определения верхнего
 * уровня запятой и для `КАК` внутри выражения (`ВЫРАЗИТЬ(… КАК ТИП)`).
 */
function parseFieldList(cur: Cursor): RawSelectItem[] {
  const items: RawSelectItem[] = [];
  for (;;) {
    // Граница списка полей: `{ВЫБРАТЬ`, ПОМЕСТИТЬ/ДОБАВИТЬ, ИЗ.
    if (cur.isPunct('{') || cur.isKeyword('ПОМЕСТИТЬ') || cur.isKeyword('ДОБАВИТЬ') || cur.isKeyword('ИЗ')) {
      break;
    }
    const ts = tryParseTabSection(cur);
    if (ts) {
      items.push({ kind: 'tabSection', ts });
    } else {
      items.push({ kind: 'field', field: parseOneField(cur) });
    }
    if (cur.matchPunct(',')) continue;
    break;
  }
  if (items.length === 0) throw cur.error('пустой список выборки', cur.peek());
  return items;
}

/**
 * Пытается разобрать табличную часть `<alias>.<tsName>.( <f> КАК <f>, … ) КАК <tsName>`.
 * Распознаётся по образцу `ident . ident . (` в начале элемента. Возвращает undefined,
 * если образца нет (тогда элемент — обычное поле), не сдвигая курсор.
 */
function tryParseTabSection(cur: Cursor): RawTabSection | undefined {
  // Образец: ident '.' ident '.' '(' .
  if (cur.peek(0).type !== 'ident' && cur.peek(0).type !== 'keyword') return undefined;
  if (!cur.isPunct('.', 1)) return undefined;
  if (cur.peek(2).type !== 'ident' && cur.peek(2).type !== 'keyword') return undefined;
  if (!cur.isPunct('.', 3)) return undefined;
  if (!cur.isPunct('(', 4)) return undefined;

  const tableAlias = cur.next().text; // ident
  cur.expectPunct('.');
  const tsName = cur.next().text; // ident
  cur.expectPunct('.');
  cur.expectPunct('(');

  // Внутри: список полей через запятую. `КАК <псевдоним>` после имени поля
  // необязателен — 1С допускает голые имена `Идентификатор, ВариантЗапуска`,
  // которым конструктор сам подставляет псевдоним = имя поля.
  const fields: string[] = [];
  for (;;) {
    const f = cur.peek();
    if (f.type !== 'ident' && f.type !== 'keyword') throw cur.error('ожидалось поле табличной части', f);
    cur.next();
    if (cur.matchKeyword('КАК')) {
      cur.next(); // псевдоним поля (= имя поля)
    }
    // Исходный текст имени поля (для keyword-токенов value в верхнем регистре).
    fields.push(f.text);
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct(')');
  // `КАК <псевдоним табличной части>` также необязателен.
  if (cur.matchKeyword('КАК')) {
    cur.next(); // псевдоним табличной части (= tsName)
  }
  return { tableAlias, tsName, fields };
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
      if (t.type === 'punct' && t.value === '{') break;
      if (t.type === 'keyword' && (t.value === 'ИЗ' || t.value === 'ПОМЕСТИТЬ' || t.value === 'ДОБАВИТЬ')) break;
      if (t.type === 'keyword' && t.value === 'КАК') {
        cur.next();
        const a = cur.peek();
        if (a.type !== 'ident' && a.type !== 'keyword') {
          throw cur.error('ожидался псевдоним после КАК', a);
        }
        cur.next();
        alias = a.text;
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

/** Резолвит сырую табличную часть в SelectedTabSectionField. */
function resolveTabSection(
  ts: RawTabSection,
  aliasToId: Map<string, string>,
  tables: SelectedTable[]
): SelectedTabSectionField {
  const tableId = aliasToId.get(ts.tableAlias) ?? '';
  const table = tables.find(t => t.id === tableId);
  // tsFullName косметический (генератор использует только tsName и fields).
  const tsFullName = table ? `${table.fullName}.${ts.tsName}` : ts.tsName;
  return { tableId, tsName: ts.tsName, tsFullName, fields: ts.fields };
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

  /**
   * Разбор join-выражения: источник, за которым следует цепочка соединений.
   * 1С допускает две формы вложенности:
   *  - плоская/левоассоциативная: `A СОЕД B ПО c1 СОЕД C ПО c2` — каждое `ПО`
   *    идёт сразу за своим источником;
   *  - правовложенная (конструктор пишет именно её для вложенных соединений):
   *    `A СОЕД B СОЕД C ПО c_BC ПО c_AB` — присоединяемая таблица сама несёт
   *    вложенную цепочку, а `ПО` внешнего соединения идёт ПОСЛЕ внутренних.
   * Обе разбираются единообразно: после `СОЕДИНЕНИЕ <источник>` либо сразу `ПО`
   * (тогда условие принадлежит этому соединению), либо ещё одно `СОЕДИНЕНИЕ`
   * (тогда сначала рекурсивно дочитываем вложенную цепочку с её `ПО`, и только
   * потом ждём `ПО` текущего соединения). Возвращает псевдоним головной таблицы
   * выражения. `RawJoin` накапливаются в `joins` в порядке «затравка раньше
   * использования», совместимом с плоским рендером генератора.
   */
  /**
   * Дочитывает цепочку соединений с левой затравкой `seedAlias`. Каждое
   * соединение: `<вид> СОЕДИНЕНИЕ <источник> [вложенная цепочка] ПО <условие>`.
   * Поддерживает две формы вложенности, которые допускает 1С:
   *  - плоская/левоассоциативная: `A СОЕД B ПО c1 СОЕД C ПО c2` — каждое `ПО`
   *    идёт сразу за своим источником, C присоединяется к B;
   *  - правовложенная (так пишет конструктор): `A СОЕД B СОЕД C ПО c_BC ПО c_AB`
   *    — присоединяемый источник сам несёт вложенную цепочку, чьи `ПО` идут
   *    раньше `ПО` внешнего соединения. Дочитываем её рекурсивно до нашего `ПО`.
   * `RawJoin` накапливаются в порядке «затравка раньше использования»,
   * совместимом с плоским рендером генератора.
   */
  const parseJoinChainFrom = (seedAlias: string): void => {
    let lastAlias = seedAlias;
    while (isJoinKeyword(cur)) {
      const kind = cur.next().value as RawJoin['kind'];
      cur.expectKeyword('СОЕДИНЕНИЕ');
      const joinedSource = readSource();
      tables.push(joinedSource);
      const joinedHead = joinedSource.alias!;
      // Вложенная цепочка присоединяемого источника (её `ПО` раньше нашего).
      if (isJoinKeyword(cur)) parseJoinChainFrom(joinedHead);
      cur.expectKeyword('ПО');
      const { tokens, text } = readJoinCondition(cur);
      joins.push({
        kind,
        seedAlias: lastAlias,
        joinedAlias: joinedHead,
        condTokens: tokens,
        condText: text,
      });
      // Левоассоциативность плоской цепочки: следующее `СОЕД` к последней таблице.
      lastAlias = joinedHead;
    }
  };

  for (;;) {
    const seed = readSource();
    tables.push(seed);
    parseJoinChainFrom(seed.alias!);
    if (cur.matchPunct(',')) continue;
    break;
  }
  return { tables, joins };
}

/** Один источник таблицы: `<fullName> [(<params>)] КАК <alias>`. */
function parseTableSource(cur: Cursor, index: number): SelectedTable {
  // Подзапрос в источнике `ИЗ (<подзапрос>) КАК Т` — полноценный узел модели
  // (фаза 6.11). Поглощаем сбалансированную скобку, рекурсивно разбираем
  // содержимое через parseDocument (поддержка ОБЪЕДИНИТЬ), затем обязательный
  // `КАК <псевдоним>`.
  if (cur.isPunct('(')) {
    const open = cur.expectPunct('(');
    let depth = 1;
    let close: Token | undefined;
    for (;;) {
      const t = cur.next();
      if (t.type === 'eof') throw cur.error('незакрытый подзапрос в источнике ИЗ', t);
      if (t.type === 'punct' && t.value === '(') depth++;
      else if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) { close = t; break; } }
    }
    const innerText = cur.source.slice(open.pos + 1, close.pos);
    const subquery = parseDocument(innerText);
    if (!cur.matchKeyword('КАК')) {
      throw cur.error('ожидалось КАК <псевдоним> после подзапроса в источнике ИЗ', cur.peek());
    }
    const aliasTok = cur.peek();
    if (aliasTok.type !== 'ident' && aliasTok.type !== 'keyword') {
      throw cur.error('ожидался псевдоним подзапроса после КАК', aliasTok);
    }
    cur.next();
    return { id: 't' + index, fullName: '', alias: aliasTok.text, subquery };
  }
  const fullName = parseDottedName(cur);

  let virtual: VirtualParams | undefined;
  if (cur.isPunct('(')) {
    virtual = parseVirtualParams(cur, fullName);
  }

  // `КАК` опционально: 1С допускает источник без явного псевдонима
  // (`ИЗ Справочник.Валюты` или `ИЗ Справочник.Валюты Валюты`). Если `КАК`
  // отсутствует, но дальше идёт голый идентификатор-псевдоним — берём его;
  // иначе синтезируем псевдоним по умолчанию (как генератор/resolveAliases).
  let alias: string | undefined;
  if (cur.matchKeyword('КАК')) {
    const aliasTok = cur.peek();
    if (aliasTok.type !== 'ident' && aliasTok.type !== 'keyword') {
      throw cur.error('ожидался псевдоним таблицы после КАК', aliasTok);
    }
    cur.next();
    alias = aliasTok.text;
  } else if (canBeBareAlias(cur)) {
    alias = cur.next().text;
  } else {
    alias = defaultTableAlias({ id: '', fullName });
  }

  const table: SelectedTable = {
    id: 't' + index,
    fullName,
    alias,
  };
  if (virtual) table.virtual = virtual;
  return table;
}

/**
 * Может ли следующий токен быть голым псевдонимом источника (без `КАК`).
 * Консервативно: только обычный идентификатор (не ключевое слово), чтобы не
 * перепутать со структурным ключевым словом (СОЕДИНЕНИЕ/ГДЕ/…) или join-видом.
 */
function canBeBareAlias(cur: Cursor): boolean {
  return cur.peek().type === 'ident';
}

const JOIN_KEYWORDS = new Set(['ВНУТРЕННЕЕ', 'ЛЕВОЕ', 'ПРАВОЕ', 'ПОЛНОЕ']);
function isJoinKeyword(cur: Cursor): boolean {
  const t = cur.peek();
  return t.type === 'keyword' && JOIN_KEYWORDS.has(t.value);
}

/**
 * Ключевые слова верхнего уровня, завершающие условие соединения `ПО`. Помимо
 * ГДЕ/СГРУППИРОВАТЬ это секции, идущие после ИЗ, когда фильтра/группировки нет
 * (УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКСИРОВАТЬ/…) и `ОБЪЕДИНИТЬ`/`ВЫБРАТЬ` следующего запроса.
 * Без них условие «съедало» хвост запроса при отсутствии ГДЕ (фаза 6.12).
 */
const JOIN_COND_STOP = new Set<string>([
  'ГДЕ', 'СГРУППИРОВАТЬ', 'ИМЕЮЩИЕ', 'УПОРЯДОЧИТЬ', 'АВТОУПОРЯДОЧИВАНИЕ',
  'ИТОГИ', 'ИНДЕКСИРОВАТЬ', 'ДЛЯ', 'ОБЪЕДИНИТЬ', 'ВЫБРАТЬ',
  // `ПО` верхнего уровня завершает условие текущего соединения: это `ПО`
  // внешнего соединения в правовложенной цепочке (`A СОЕД B СОЕД C ПО c1 ПО c2`).
  'ПО',
]);

/**
 * Сырые токены и текст условия `ПО` до следующего соединения / запятой верхнего
 * уровня / конца секции ИЗ (ГДЕ/СГРУППИРОВАТЬ/секция/«;»/eof). Скобки учитываются,
 * чтобы запятые и ключевые слова внутри не обрывали условие.
 */
function readJoinCondition(cur: Cursor): { tokens: Token[]; text: string } {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && t.value === ',') break;
      if (t.type === 'punct' && t.value === ';') break;
      if (isJoinKeyword(cur)) break;
      if (t.type === 'keyword' && JOIN_COND_STOP.has(t.value)) break;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    tokens.push(cur.next());
  }
  if (tokens.length === 0) throw cur.error('пустое условие соединения после ПО');
  return { tokens, text: sliceSource(cur.source, tokens) };
}

/**
 * Точечно-разделённое имя: <head> (. ident)*. Возвращает исходную строку.
 * `head` может быть идентификатором, ключевым словом (используется как имя) или
 * параметром `&Имя` / подстановкой `#Имя` (источник `ИЗ` в реальных запросах 1С).
 * Для ключевых слов берётся ИСХОДНОЕ написание (`text`), а не канонический верхний
 * регистр, чтобы не искажать имена вроде `Дата`, `Количество`, `Сумма`.
 */
function parseDottedName(cur: Cursor): string {
  const first = cur.peek();
  if (first.type !== 'ident' && first.type !== 'keyword' && first.type !== 'param') {
    throw cur.error('ожидалось имя', first);
  }
  let name = cur.next().text;
  while (cur.isPunct('.')) {
    cur.next();
    const seg = cur.peek();
    if (seg.type !== 'ident' && seg.type !== 'keyword') {
      throw cur.error('ожидался сегмент имени после «.»', seg);
    }
    name += '.' + cur.next().text;
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
/** Аргумент позиции n (пустая строка, если позиция отсутствует). */
function arg(args: string[], n: number): string {
  return args[n] ?? '';
}

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
    set('startPeriod', arg(args, 0));
    set('endPeriod', arg(args, 1));
    set('periodicity', arg(args, 2));
    set('condition', arg(args, 3));
    return v;
  }
  if (slice === 'ОстаткиИОбороты') {
    // [startPeriod, endPeriod, periodicity, fillMethod, condition] — арность 5.
    set('startPeriod', arg(args, 0));
    set('endPeriod', arg(args, 1));
    set('periodicity', arg(args, 2));
    set('fillMethod', arg(args, 3));
    set('condition', arg(args, 4));
    return v;
  }

  // РС срезы / РН Остатки: [period, condition], хвостовые пустые отброшены.
  set('period', arg(args, 0));
  set('condition', arg(args, 1));
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
      set('period', arg(args, 0));
      set('accountCondition', arg(args, 1));
      set('condition', arg(args, 3));
      return;
    case 'Обороты':
      // non-corr: [startPeriod, endPeriod, periodicity, accountCondition, '', condition]
      // corr (8): + [corrAccountCondition, ''] и correspondence=true
      set('startPeriod', arg(args, 0));
      set('endPeriod', arg(args, 1));
      set('periodicity', arg(args, 2));
      set('accountCondition', arg(args, 3));
      set('condition', arg(args, 5));
      if (args.length >= 8) {
        set('corrAccountCondition', arg(args, 6));
        v.correspondence = true;
      }
      return;
    case 'ОборотыДтКт':
      // [startPeriod, endPeriod, periodicity, accountDtCondition, '', accountKtCondition, '', condition]
      set('startPeriod', arg(args, 0));
      set('endPeriod', arg(args, 1));
      set('periodicity', arg(args, 2));
      set('accountDtCondition', arg(args, 3));
      set('accountKtCondition', arg(args, 5));
      set('condition', arg(args, 7));
      return;
    case 'ОстаткиИОбороты':
      // [startPeriod, endPeriod, periodicity, fillMethod, accountCondition, '', condition]
      set('startPeriod', arg(args, 0));
      set('endPeriod', arg(args, 1));
      set('periodicity', arg(args, 2));
      set('fillMethod', arg(args, 3));
      set('accountCondition', arg(args, 4));
      set('condition', arg(args, 6));
      return;
    case 'ДвиженияССубконто':
      // [startPeriod, endPeriod, condition, order, top]
      set('startPeriod', arg(args, 0));
      set('endPeriod', arg(args, 1));
      set('condition', arg(args, 2));
      set('order', arg(args, 3));
      set('top', arg(args, 4));
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
  aggregates: SummableField[],
  soleSource?: SoleSource
): void {
  // Голое поле при единственном источнике (фаза 6.12): разработчик не
  // квалифицировал поле псевдонимом таблицы (`ВЫБРАТЬ Ссылка ИЗ … КАК Т`).
  // Конструктор 1С квалифицирует его псевдонимом единственного источника и
  // автоалиасит последним сегментом пути (`Т.Ссылка КАК Ссылка`). Делаем это
  // ДО короткого замыкания на `Поле{n}`, т.к. конструктор переалиасит даже
  // явно написанный разработчиком `КАК Поле1` (`Код КАК Поле1` → `Т.Код КАК Код`).
  // Безопасно: bare-проверка требует чистый точечный путь без скобок, поэтому
  // агрегато-образные выражения `СУММА(Алиас.Поле) КАК Поле1` сюда не попадают.
  if (soleSource) {
    const bare = tryBareField(rf.bodyTokens, aliasToId, soleSource.alias);
    if (bare) {
      const field: SelectedField = { tableId: soleSource.id, path: bare.path };
      if (rf.alias !== undefined && !AUTO_ALIAS.test(rf.alias)) field.alias = rf.alias;
      fields.push(field);
      return;
    }
  }

  // Автопсевдоним `Поле{n}` → поле было произвольным выражением; сохраняем сырой
  // LHS как expression, alias оставляем undefined (генератор воспроизведёт
  // `КАК Поле{n}` сам). Это решает неоднозначность между настоящим агрегатом
  // (с явным псевдонимом) и выражением вида `СУММА(Алиас.Поле)` без псевдонима.
  if (rf.alias !== undefined && AUTO_ALIAS.test(rf.alias)) {
    const field: SelectedField = { tableId: '', path: '', expression: rf.rawBody };
    // Голый параметр `&Имя КАК Поле{n}`: разработчик задал явный `Поле{n}`, и
    // конструктор его сохраняет (НЕ переалиасит в имя параметра). Фиксируем
    // alias явно, иначе авто-правило `&Имя → Имя` сломает воспроизведение.
    if (BARE_PARAM_ALIAS.test(rf.rawBody.trim())) field.alias = rf.alias;
    fields.push(field);
    return;
  }

  // 1) Попытка агрегата.
  const agg = tryAggregate(rf.bodyTokens, aliasToId, soleSource);
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
function tryAggregate(
  body: Token[],
  aliasToId: Map<string, string>,
  soleSource?: SoleSource
): AggHit | undefined {
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
  if (ref) return { tableId: ref.tableId, path: ref.path, func };
  // Голое поле внутри агрегата при единственном источнике (`МИНИМУМ(ДатаЗаписи)` →
  // `МИНИМУМ(Т.ДатаЗаписи)`): аргумент — чистый точечный путь без квалификации.
  // Конструктор 1С квалифицирует его псевдонимом единственного источника.
  if (soleSource) {
    const bare = tryBareField(inner, aliasToId, soleSource.alias);
    if (bare) return { tableId: soleSource.id, path: bare.path, func };
  }
  return undefined;
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
      segs.push(t.text);
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
  /* v8 ignore next -- недостижимо: tokens.length>=3 и нечётно ⇒ segs>=2 ⇒ path непуст */
  if (!path) return undefined;
  return { tableId, path };
}

/** Единственный источник запроса (для квалификации голых полей, фаза 6.12). */
interface SoleSource {
  id: string;
  alias: string;
}

/**
 * Единственный ли это источник, к которому можно безопасно (без метаинформации
 * схемы) привязать голое поле: ровно одна таблица в `ИЗ`, без соединений, без
 * подзапроса-источника и с непустым псевдонимом. Многоисточниковые запросы
 * требуют реальной схемы — здесь не трогаются.
 */
function soleSourceOf(tables: SelectedTable[], joins: RawJoin[]): SoleSource | undefined {
  if (joins.length > 0) return undefined;
  if (tables.length !== 1) return undefined;
  const t = tables[0];
  if (t.subquery) return undefined;
  if (!t.alias) return undefined;
  return { id: t.id, alias: t.alias };
}

/** Литералы-значения, которые НЕ являются голыми полями (одиночный токен). */
const LITERAL_VALUES = new Set(['НЕОПРЕДЕЛЕНО', 'ИСТИНА', 'ЛОЖЬ', 'NULL']);

/**
 * Голое поле = чистый точечный путь идентификаторов (`Ссылка`, `Владелец.Код`),
 * который разработчик НЕ квалифицировал псевдонимом источника. Возвращает path,
 * если тело — такой путь, его голова не совпадает с псевдонимом источника и не
 * является известным псевдонимом таблицы, и это не литерал-значение. Иначе
 * undefined (тогда поле трактуется как раньше: простое/агрегат/выражение).
 */
function tryBareField(
  tokens: Token[],
  aliasToId: Map<string, string>,
  soleAlias: string
): { path: string } | undefined {
  if (tokens.length === 0) return undefined;
  const segs: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (k % 2 === 0) {
      const t = tokens[k];
      if (t.type !== 'ident' && t.type !== 'keyword') return undefined;
      segs.push(t.text);
    } else {
      const t = tokens[k];
      if (!(t.type === 'punct' && t.value === '.')) return undefined;
    }
  }
  if (tokens.length % 2 === 0) return undefined; // путь оканчивается сегментом
  const head = segs[0];
  // Уже квалифицировано псевдонимом источника или известной таблицей — не голое.
  if (head === soleAlias) return undefined;
  if (aliasToId.has(head)) return undefined;
  // Литерал-значение из одного сегмента (НЕОПРЕДЕЛЕНО/ИСТИНА/ЛОЖЬ/NULL).
  if (segs.length === 1 && LITERAL_VALUES.has(head.toUpperCase())) return undefined;
  return { path: segs.join('.') };
}

/**
 * Ссылка на поле для голого LHS условия при единственном источнике: если `lhs` —
 * чистый точечный путь, не квалифицированный псевдонимом источника, возвращает
 * `(soleSource.id, path)`. Иначе undefined.
 */
function bareLhsRef(
  lhs: Token[],
  aliasToId: Map<string, string>,
  soleSource: SoleSource
): { tableId: string; path: string } | undefined {
  const bare = tryBareField(lhs, aliasToId, soleSource.alias);
  if (!bare) return undefined;
  return { tableId: soleSource.id, path: bare.path };
}

// ───────────────────────────── ГДЕ (WHERE) ─────────────────────────────

/** Множество токенов-операторов сравнения для условий. */
const COND_OPERATORS = new Set<string>(['=', '<>', '>', '>=', '<', '<=', 'В', 'МЕЖДУ', 'ПОДОБНО']);

/**
 * Секция ГДЕ. Инвертирует `renderConditions`: первое условие, затем каждое
 * последующее после `И` верхнего уровня. Каждый сегмент пытается распознаться как
 * простое условие `<alias>.<path> <op> <param>`; иначе — произвольное (`custom`).
 */
function parseWhere(cur: Cursor, aliasToId: Map<string, string>, soleSource?: SoleSource): Condition[] {
  cur.expectKeyword('ГДЕ');
  const source = cur.source;
  const segments = splitConditionSegments(cur, WHERE_STOP);
  return segments.map(seg => interpretCondition(seg, source, aliasToId, soleSource));
}

/**
 * Ключевые слова, завершающие секцию ГДЕ. Только `СГРУППИРОВАТЬ` — как было до 6.9
 * (ИМЕЮЩИЕ идёт лишь после группировки, поэтому ГДЕ до него не доходит). Расширять это
 * множество нельзя без регрессий: меняет разбор `ГДЕ` у запросов без группировки.
 */
const WHERE_STOP = new Set<string>([
  'СГРУППИРОВАТЬ',
  // Секция УПОРЯДОЧИТЬ ПО, идущая после ГДЕ в запросе без группировки. Без неё
  // parseWhere дословно затягивал хвост (`…\nУПОРЯДОЧИТЬ ПО …`) в param последнего
  // условия, и УПОРЯДОЧИТЬ воспроизводилось как сырой текст (теряя нормализацию
  // отступов конструктора). Остановка здесь передаёт управление штатному parseOrder.
  'УПОРЯДОЧИТЬ',
  'АВТОУПОРЯДОЧИВАНИЕ',
  'ИТОГИ',
  'ИНДЕКСИРОВАТЬ',
  'ДЛЯ',
  // ИМЕЮЩИЕ может идти сразу за ГДЕ без СГРУППИРОВАТЬ, когда в выборке есть
  // агрегат (`ВЫБРАТЬ МАКСИМУМ(…) … ГДЕ … ИМЕЮЩИЕ МАКСИМУМ(…) ЕСТЬ НЕ NULL`).
  // Без остановки хвост затягивался в param последнего условия ГДЕ.
  'ИМЕЮЩИЕ',
]);
/** Ключевые слова, завершающие секцию ИМЕЮЩИЕ. */
const HAVING_STOP = new Set<string>(['УПОРЯДОЧИТЬ', 'ИТОГИ', 'ИНДЕКСИРОВАТЬ', 'АВТОУПОРЯДОЧИВАНИЕ', 'ДЛЯ']);

/**
 * Секция ИМЕЮЩИЕ (фильтр по агрегатам после группировки). Те же сегменты по
 * верхнеуровневому `И`, что и ГДЕ; условия обычно агрегатные → сохраняются как
 * произвольные выражения.
 */
function parseHaving(cur: Cursor, aliasToId: Map<string, string>): Condition[] {
  cur.expectKeyword('ИМЕЮЩИЕ');
  const source = cur.source;
  const segments = splitConditionSegments(cur, HAVING_STOP);
  return segments.map(seg => interpretCondition(seg, source, aliasToId));
}

/**
 * Разбивает поток токенов условий на сегменты по `И` верхнего уровня (вне скобок),
 * до конца секции ГДЕ (СГРУППИРОВАТЬ / eof / соединение не встречается здесь, т.к.
 * ГДЕ идёт после ИЗ). Каждый сегмент — массив токенов одного условия.
 */
function splitConditionSegments(cur: Cursor, stop: Set<string>): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  // Глубина ВЫБОР … КОНЕЦ: верхнеуровневый `И` внутри значения ТОГДА/ИНАЧЕ
  // оператора ВЫБОР не является разделителем условий ГДЕ/ИМЕЮЩИЕ (всё выражение
  // ВЫБОР — одно условие). Без этого `ТОГДА a И b` разрывал бы оператор ВЫБОР.
  let caseDepth = 0;
  // Сколько `И` из конструкции `МЕЖДУ a И b` ожидаем «съесть» на верхнем уровне:
  // такой `И` принадлежит диапазону МЕЖДУ, а не является разделителем условий.
  let betweenPending = 0;
  const isIdentWord = (t: Token, w: string): boolean =>
    (t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === w;
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0 && caseDepth === 0) {
      if (t.type === 'keyword' && stop.has(t.value)) break;
      if (t.type === 'keyword' && t.value === 'И') {
        if (betweenPending > 0) {
          // `И` из диапазона `МЕЖДУ a И b` — часть текущего условия, не разделитель.
          betweenPending--;
        } else {
          cur.next();
          flush();
          continue;
        }
      }
      if (isIdentWord(t, 'МЕЖДУ')) betweenPending++;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (isIdentWord(t, 'ВЫБОР')) caseDepth++;
    else if (isIdentWord(t, 'КОНЕЦ') && caseDepth > 0) caseDepth--;
    current.push(cur.next());
  }
  flush();
  return segments;
}

/** Интерпретирует один сегмент условия: простое или произвольное. */
function interpretCondition(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>,
  soleSource?: SoleSource
): Condition {
  // Голое поле-условие при единственном источнике (`ГДЕ Предопределенный` →
  // `ГДЕ Т.Предопределенный`): весь сегмент — чистый точечный путь без оператора,
  // голова не псевдоним источника. Квалифицируем как произвольное выражение
  // `<псевдоним>.<path>` (генератор рендерит произвольные условия дословно).
  if (soleSource) {
    const bare = tryBareField(tokens, aliasToId, soleSource.alias);
    if (bare) {
      return { custom: true, expression: `${soleSource.alias}.${bare.path}` };
    }
    // Отрицание голого поля при единственном источнике (`ГДЕ НЕ ПометкаУдаления` →
    // `ГДЕ НЕ Т.ПометкаУдаления`): первый токен — `НЕ`, остаток — чистый точечный
    // путь без квалификации. Конструктор 1С квалифицирует поле под `НЕ`.
    if (tokens.length > 1 && isNotToken(tokens[0])) {
      const negBare = tryBareField(tokens.slice(1), aliasToId, soleSource.alias);
      if (negBare) {
        return { custom: true, expression: `НЕ ${soleSource.alias}.${negBare.path}` };
      }
    }
  }
  // Скобки вокруг условия-параметра целиком (`И (&ТекстУсловия)` → `И &ТекстУсловия`):
  // конструктор 1С снимает скобки, когда всё условие ГДЕ — единственный голый
  // параметр в скобках. (В условии соединения `ПО` конструктор, наоборот, скобки
  // добавляет — но это другой код-путь, не interpretCondition.)
  if (
    tokens.length === 3 &&
    tokens[0].type === 'punct' && tokens[0].value === '(' &&
    tokens[1].type === 'param' &&
    tokens[2].type === 'punct' && tokens[2].value === ')'
  ) {
    return { custom: true, expression: tokens[1].text };
  }
  const simple = trySimpleCondition(tokens, source, aliasToId, soleSource);
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
  aliasToId: Map<string, string>,
  soleSource?: SoleSource
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
  // Голое поле слева (`Код = &Код` при единственном источнике) → квалифицируем
  // псевдонимом источника, как сделал бы конструктор 1С.
  const ref = parseFieldRef(lhs, aliasToId)
    ?? (soleSource
      ? bareLhsRef(lhs, aliasToId, soleSource)
      : undefined);
  if (!ref) return undefined;

  const op = tokens[opIdx].value as ConditionOperator;
  const paramTokens = tokens.slice(opIdx + 1);
  /* v8 ignore next -- недостижимо: opIdx<tokens.length-1 (см. выше) ⇒ срез непуст */
  if (paramTokens.length === 0) return undefined;
  const param = sliceSource(source, paramTokens);

  // Правый операнд `В` — подзапрос `(ВЫБРАТЬ …)`: ровно одна сбалансированная
  // внешняя пара скобок, начинающаяся с ВЫБРАТЬ, без хвостовых токенов. Разбираем
  // внутренний запрос в модель — генератор разнесёт его по строкам, как конструктор.
  if (op === 'В') {
    const sub = trySubqueryParam(paramTokens, source);
    if (sub) {
      return { custom: false, tableId: ref.tableId, path: ref.path, operator: op, param, subquery: sub };
    }
  }

  return { custom: false, tableId: ref.tableId, path: ref.path, operator: op, param };
}

/** Токен логического отрицания `НЕ` (лексер выдаёт его как ident, не keyword). */
function isNotToken(t: Token): boolean {
  return (t.type === 'ident' || t.type === 'keyword') && t.text.toUpperCase() === 'НЕ';
}

function isCondOperatorToken(t: Token): boolean {
  if (t.type === 'punct') return COND_OPERATORS.has(t.value);
  if (t.type === 'keyword') return COND_OPERATORS.has(t.value);
  return false;
}

/**
 * Правый операнд `В` как подзапрос: токены должны быть ровно одной сбалансированной
 * внешней парой `( … )`, содержимое которой начинается ключевым словом `ВЫБРАТЬ`, без
 * хвостовых токенов после закрывающей скобки. Тогда возвращает разобранную модель
 * внутреннего запроса (поддержка ОБЪЕДИНИТЬ через parseDocument). Иначе — undefined
 * (список значений `(&Список)` / `(a, b)` остаётся как простой param).
 */
function trySubqueryParam(paramTokens: Token[], source: string): QueryDocument | undefined {
  const first = paramTokens[0];
  if (!first || first.type !== 'punct' || first.value !== '(') return undefined;
  // Найти парную закрывающую скобку для внешней пары.
  let depth = 0;
  let closeIdx = -1;
  for (let k = 0; k < paramTokens.length; k++) {
    const t = paramTokens[k];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (depth === 0) { closeIdx = k; break; }
    }
  }
  // Внешняя пара должна закрываться последним токеном (без хвоста после `)`).
  if (closeIdx !== paramTokens.length - 1) return undefined;
  // Содержимое начинается с ВЫБРАТЬ — это подзапрос, а не список значений.
  const inner = paramTokens[1];
  if (!inner || !(inner.type === 'keyword' && inner.value === 'ВЫБРАТЬ')) return undefined;
  const open = paramTokens[0];
  const close = paramTokens[closeIdx];
  const innerText = source.slice(open.pos + 1, close.pos);
  try {
    return parseDocument(innerText);
  } catch {
    return undefined;
  }
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
  /* v8 ignore next 2 -- псевдонимы затравки/присоединяемой всегда в aliasToId (правая ветвь ?? недостижима) */
  const seedId = aliasToId.get(raw.seedAlias) ?? raw.seedAlias;
  const joinedId = aliasToId.get(raw.joinedAlias) ?? raw.joinedAlias;

  // Обернул ли разработчик всё условие в одну сбалансированную внешнюю пару скобок
  // (`ПО (a = b)`). Только это решение конструктор 1С сохраняет; скобки вокруг
  // подконъюнктов составного условия (`(a) И (b)`) сюда не относятся (фаза 6.12).
  const parenthesized = hasBalancedOuterParens(raw.condTokens);

  // Простое условие (`a = b`) резолвим как раньше — обе таблицы из ссылок полей,
  // что задаёт порядок таблиц в цепочке ИЗ. Обёрнутую форму (`(a = b)`) НЕ
  // переводим в простой путь: иначе менялся бы порядок таблиц (затравка из ссылки,
  // а не из текста). Голое простое условие рендерится без скобок — как ввёл
  // разработчик; флаг здесь всегда false, скобок во вводе не было.
  const simple = trySimpleJoinCondition(raw.condTokens, aliasToId);
  if (simple) {
    // leftTableId/rightTableId берём из операндов условия (порядок рендера `ПО`),
    // НО порядок сцепления `ИЗ` задаём из текста (seedTableId/joinedTableId): иначе
    // затравка цепочки бралась бы из левого операнда условия, а конструктор 1С
    // сохраняет порядок источников разработчика (`ИЗ B ВНУТРЕННЕЕ СОЕДИНЕНИЕ A ПО
    // a.x = b.y` остаётся B → A). Если порядок совпадает — поля избыточны, но
    // безвредны (фаза 6.12).
    return {
      leftTableId: simple.leftTableId,
      rightTableId: simple.rightTableId,
      leftAll, rightAll, custom: false,
      leftPath: simple.leftPath,
      operator: simple.operator,
      rightPath: simple.rightPath,
      seedTableId: seedId,
      joinedTableId: joinedId,
    };
  }

  // Произвольное условие: снять внешние скобки, добавленные генератором/вводом.
  // parenthesized сохраняет, были ли скобки во вводе, чтобы генератор воспроизвёл
  // решение разработчика для одиночного условия (фаза 6.12).
  return {
    leftTableId: seedId,
    rightTableId: joinedId,
    leftAll, rightAll, custom: true,
    expression: stripOuterParens(raw.condText),
    parenthesized,
    seedTableId: seedId,
    joinedTableId: joinedId,
  };
}

/**
 * Заключены ли все токены в одну сбалансированную внешнюю пару скобок
 * (`( … )`, где первая открывающая закрывается последней). Используется для
 * восстановления решения разработчика о внешних скобках условия `ПО`.
 */
function hasBalancedOuterParens(tokens: Token[]): boolean {
  if (tokens.length < 2) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!(first.type === 'punct' && first.value === '(')) return false;
  if (!(last.type === 'punct' && last.value === ')')) return false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') {
      depth--;
      // Первая внешняя скобка закрылась раньше последнего токена → не общая пара.
      if (depth === 0) return i === tokens.length - 1;
    }
  }
  /* v8 ignore next -- несбалансированные скобки отсеёт лексер/курсор раньше */
  return false;
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

/**
 * Один элемент группировки. Чаще всего это простая ссылка `<alias>.<path>`,
 * но конструктор 1С допускает произвольные выражения (вызов функции
 * `ГОД(Т.Дата)`, `ВЫБОР … КОНЕЦ`, арифметика). Собираем токены до запятой
 * верхнего уровня / секционного ключевого слова, учитывая баланс скобок.
 * Если выражение — чистая точечная ссылка, возвращаем FieldRef; иначе сохраняем
 * сырой срез как `expression` (генератор переотрисует его как поле выборки).
 */
function parseGroupFieldRef(cur: Cursor, aliasToId: Map<string, string>): FieldRef {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (depth === 0) {
      // Стоп на секционных ключевых словах (ДЛЯ ИЗМЕНЕНИЯ / порядок / итоги /
      // индекс) и на запятой/конце — границах элемента группировки.
      if (t.type === 'keyword' && isSectionKeyword(t.value)) break;
      if (t.type === 'punct' && (t.value === ',' || t.value === ';' || t.value === '{' || t.value === '}')) break;
      if (t.type === 'eof') break;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') {
      if (depth === 0) break; // закрывающая скобка набора группировки
      depth--;
    }
    tokens.push(cur.next());
  }
  if (tokens.length === 0) {
    throw cur.error('ожидалась ссылка на поле группировки', cur.peek());
  }
  // Простая точечная ссылка → FieldRef; произвольное выражение → expression.
  const ref = parseFieldRef(tokens, aliasToId);
  if (ref) return { tableId: ref.tableId, path: ref.path };
  return { tableId: '', path: '', expression: sliceSource(cur.source, tokens) };
}

// ────────────────────── УПОРЯДОЧИТЬ ПО (ORDER BY) ───────────────────────

/**
 * Модификаторы поля упорядочивания после самого поля: направление
 * (`УБЫВ` → desc; `ВОЗР` — явное возрастание, лексер выдаёт его как ident) и
 * `ИЕРАРХИЯ` (иерархический порядок). Порядок токенов: направление, затем
 * ИЕРАРХИЯ. Возвращает выбранное направление и флаг иерархии.
 */
function parseOrderModifiers(cur: Cursor): { direction: SortDirection; hierarchy: boolean } {
  let direction: SortDirection = 'asc';
  if (cur.matchKeyword('УБЫВ')) {
    direction = 'desc';
  } else {
    // `ВОЗР` — явное возрастание (не keyword в лексере); поглощаем как ident.
    const t = cur.peek();
    if ((t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === 'ВОЗР') {
      cur.next();
    }
  }
  const hierarchy = cur.matchKeyword('ИЕРАРХИЯ');
  return { direction, hierarchy };
}

/**
 * Секция УПОРЯДОЧИТЬ ПО / АВТОУПОРЯДОЧИВАНИЕ. Инвертирует `renderOrder`:
 *  - `УПОРЯДОЧИТЬ ПО <псевдоним>[ УБЫВ][ ИЕРАРХИЯ], …` → order.fields (резолв псевдонима выборки).
 *  - последняя строка `АВТОУПОРЯДОЧИВАНИЕ` (с полями или без) → order.auto=true.
 */
function parseOrder(
  cur: Cursor,
  aliasMap: Map<string, FieldRef>,
  aliasToId: Map<string, string>
): Order {
  const fields: OrderField[] = [];
  let auto = false;

  if (cur.matchKeyword('УПОРЯДОЧИТЬ')) {
    cur.expectKeyword('ПО');
    for (;;) {
      const headTok = cur.peek();
      // `УПОРЯДОЧИТЬ ПО &Параметр` — параметр запроса вместо псевдонима поля.
      // Сохраняем дословно через expression; направление (УБЫВ) после него допустимо.
      if (headTok.type === 'param') {
        cur.next();
        const { direction: dir, hierarchy } = parseOrderModifiers(cur);
        fields.push({ tableId: '', path: '', direction: dir, expression: headTok.text, ...(hierarchy ? { hierarchy } : {}) });
        if (cur.matchPunct(',')) continue;
        break;
      }
      if (headTok.type !== 'ident' && headTok.type !== 'keyword') {
        throw cur.error('ожидался псевдоним поля упорядочивания', headTok);
      }
      cur.next();
      // Точечно-разделённый путь: `<голова>(.<сегмент>)*`.
      const segs = [headTok.text];
      while (cur.isPunct('.')) {
        cur.next();
        const seg = cur.peek();
        if (seg.type !== 'ident' && seg.type !== 'keyword') {
          throw cur.error('ожидался сегмент имени после «.»', seg);
        }
        segs.push(cur.next().text);
      }
      const { direction, hierarchy } = parseOrderModifiers(cur);
      const hier = hierarchy ? { hierarchy } : {};

      if (segs.length > 1 && aliasToId.has(segs[0])) {
        // Квалифицированная ссылка `<псевдонимТаблицы>.<path>` — сохраняем как есть.
        fields.push({
          tableId: aliasToId.get(segs[0])!,
          path: segs.slice(1).join('.'),
          direction,
          qualified: true,
          ...hier,
        });
      } else {
        // Бара́я ссылка — псевдоним выборки (или нерезолвимое имя). Квалификацию бара́го
        // поля по таблице конструктор делает по схеме метаданных — здесь недоступно
        // (см. ROADMAP 6.8, R3, многотабличный остаток).
        const ref = resolveSelectAlias(segs.join('.'), aliasMap);
        fields.push({ tableId: ref.tableId, path: ref.path, direction, ...hier });
      }

      if (cur.matchPunct(',')) continue;
      break;
    }
  }

  if (cur.matchKeyword('АВТОУПОРЯДОЧИВАНИЕ')) auto = true;

  return { fields, auto };
}

// ───────────────────────────── ИТОГИ (TOTALS) ──────────────────────────

/**
 * Секция ИТОГИ. Инвертирует `renderTotals`. Два формата:
 *  - `ИТОГИ <агрегаты> ПО <группы>` — есть агрегаты;
 *  - `ИТОГИ ПО <группы>` — без агрегатов.
 * Агрегаты: каждое выражение по запятым верхнего уровня; если оно вида
 * `СУММА(<псевдоним>)` — резолвится в (tableId, path), иначе tableId='' и
 * expression = сырой текст. Группы: `ОБЩИЕ` (первый) → grand; остальные —
 * `<псевдоним>[ ИЕРАРХИЯ| ТОЛЬКО ИЕРАРХИЯ][ КАК <alias>]`.
 */
function parseTotals(cur: Cursor, aliasMap: Map<string, FieldRef>, aliasToId: Map<string, string>): Totals {
  cur.expectKeyword('ИТОГИ');
  const totalFields: TotalField[] = [];

  if (!cur.isKeyword('ПО')) {
    // Список агрегатов до ключевого слова ПО.
    for (;;) {
      totalFields.push(parseTotalAggregate(cur, aliasMap));
      if (cur.matchPunct(',')) continue;
      break;
    }
  }

  cur.expectKeyword('ПО');

  const groupFields: TotalGroupField[] = [];
  let grand = false;
  for (;;) {
    if (cur.matchKeyword('ОБЩИЕ')) {
      grand = true;
    } else {
      groupFields.push(parseTotalGroupField(cur, aliasMap, aliasToId));
    }
    if (cur.matchPunct(',')) continue;
    break;
  }

  return { groupFields, totalFields, grand };
}

/** Один агрегат итогов: сырое выражение до запятой/ПО верхнего уровня. */
function parseTotalAggregate(cur: Cursor, aliasMap: Map<string, FieldRef>): TotalField {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && t.value === ',') break;
      if (t.type === 'keyword' && t.value === 'ПО') break;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    tokens.push(cur.next());
  }
  if (tokens.length === 0) throw cur.error('ожидалось выражение агрегата итогов', cur.peek());
  const expression = sliceSource(cur.source, tokens);

  // Попытка распознать `СУММА(<псевдоним>)` → (tableId, path) по карте.
  const inner = matchSumAlias(tokens);
  if (inner) {
    const ref = aliasMap.get(inner);
    if (ref) return { tableId: ref.tableId, path: ref.path, expression };
  }
  return { tableId: '', path: '', expression };
}

/** Если токены = `СУММА ( <ident> )` — возвращает имя псевдонима, иначе undefined. */
function matchSumAlias(tokens: Token[]): string | undefined {
  if (tokens.length !== 4) return undefined;
  if (!(tokens[0].type === 'keyword' && tokens[0].value === 'СУММА')) return undefined;
  if (!(tokens[1].type === 'punct' && tokens[1].value === '(')) return undefined;
  if (tokens[2].type !== 'ident' && tokens[2].type !== 'keyword') return undefined;
  /* v8 ignore next -- срез агрегата итогов из 4 токенов вида `СУММА ( ident X` не достигает X≠')' (разделитель верхнего уровня исключён) */
  if (!(tokens[3].type === 'punct' && tokens[3].value === ')')) return undefined;
  return tokens[2].text;
}

/** Одно группировочное поле итогов: `<поле>[ ИЕРАРХИЯ| ТОЛЬКО ИЕРАРХИЯ][ КАК <alias>]`. */
function parseTotalGroupField(
  cur: Cursor,
  aliasMap: Map<string, FieldRef>,
  aliasToId: Map<string, string>
): TotalGroupField {
  const aliasTok = cur.peek();
  const segs = readDottedPath(cur);
  if (!segs) throw cur.error('ожидался псевдоним группировочного поля итогов', aliasTok);
  const ref = resolveSectionFieldRef(segs, aliasMap, aliasToId);

  let kind: TotalKind = 'elements';
  if (cur.matchKeyword('ТОЛЬКО')) {
    cur.expectKeyword('ИЕРАРХИЯ');
    kind = 'onlyHierarchy';
  } else if (cur.matchKeyword('ИЕРАРХИЯ')) {
    kind = 'hierarchy';
  }

  const field: TotalGroupField = { tableId: ref.tableId, path: ref.path, kind };
  if (ref.qualified) field.qualified = true;
  if (cur.matchKeyword('КАК')) {
    const a = cur.peek();
    if (a.type !== 'ident' && a.type !== 'keyword') throw cur.error('ожидался псевдоним после КАК', a);
    cur.next();
    field.alias = a.text;
  }
  return field;
}

// ──────────────────── ИНДЕКСИРОВАТЬ ПО (INDEXING) ───────────────────────

/**
 * Секция ИНДЕКСИРОВАТЬ ПО / ИНДЕКСИРОВАТЬ ПО НАБОРАМ. Инвертирует `renderIndex`:
 *  - `ИНДЕКСИРОВАТЬ ПО <a>, <b>` → один индекс {unique:false, fields}.
 *  - `ИНДЕКСИРОВАТЬ ПО НАБОРАМ ( (a, b)[ УНИКАЛЬНО], (c) )` → несколько индексов.
 * Поля адресуются по псевдониму выборки.
 */
function parseIndex(cur: Cursor, aliasMap: Map<string, FieldRef>, aliasToId: Map<string, string>): Indexing {
  cur.expectKeyword('ИНДЕКСИРОВАТЬ');
  cur.expectKeyword('ПО');

  if (cur.matchKeyword('НАБОРАМ')) {
    cur.expectPunct('(');
    const indexes: QueryIndex[] = [];
    for (;;) {
      cur.expectPunct('(');
      const fields: FieldRef[] = [];
      for (;;) {
        fields.push(parseIndexField(cur, aliasMap, aliasToId));
        if (cur.matchPunct(',')) continue;
        break;
      }
      cur.expectPunct(')');
      const unique = cur.matchKeyword('УНИКАЛЬНО');
      indexes.push({ unique, fields });
      if (cur.matchPunct(',')) continue;
      break;
    }
    cur.expectPunct(')');
    return { indexes };
  }

  // Один индекс: список псевдонимов через запятую.
  const fields: FieldRef[] = [];
  for (;;) {
    fields.push(parseIndexField(cur, aliasMap, aliasToId));
    if (cur.matchPunct(',')) continue;
    break;
  }
  return { indexes: [{ unique: false, fields }] };
}

/**
 * Точечный путь `<голова>(.<сегмент>)*`, начиная с уже не потреблённого токена.
 * Возвращает сегменты или undefined, если первый токен не имя.
 */
function readDottedPath(cur: Cursor): string[] | undefined {
  const head = cur.peek();
  if (head.type !== 'ident' && head.type !== 'keyword') return undefined;
  cur.next();
  const segs = [head.text];
  while (cur.isPunct('.')) {
    cur.next();
    const seg = cur.peek();
    if (seg.type !== 'ident' && seg.type !== 'keyword') throw cur.error('ожидался сегмент имени после «.»', seg);
    segs.push(cur.next().text);
  }
  return segs;
}

/**
 * Поле, адресуемое в секциях ИНДЕКСИРОВАТЬ ПО / ИТОГИ ПО: либо квалифицированная
 * ссылка `<псевдонимТаблицы>.<path>` (qualified, выводится дословно), либо
 * псевдоним выборки. Конструктор 1С сохраняет ту форму, что задал пользователь.
 */
function resolveSectionFieldRef(
  segs: string[],
  aliasMap: Map<string, FieldRef>,
  aliasToId: Map<string, string>
): FieldRef {
  if (segs.length > 1 && aliasToId.has(segs[0])) {
    return { tableId: aliasToId.get(segs[0])!, path: segs.slice(1).join('.'), qualified: true };
  }
  const ref = resolveSelectAlias(segs.join('.'), aliasMap);
  return { tableId: ref.tableId, path: ref.path };
}

/** Одно поле индекса: квалиф. ссылка/псевдоним выборки → FieldRef, либо `&Параметр`. */
function parseIndexField(cur: Cursor, aliasMap: Map<string, FieldRef>, aliasToId: Map<string, string>): FieldRef {
  const t = cur.peek();
  // `ИНДЕКСИРОВАТЬ ПО &Параметр` — параметр запроса вместо псевдонима поля
  // (приём генерации динамических ВТ). Сохраняем дословно через expression.
  if (t.type === 'param') {
    cur.next();
    return { tableId: '', path: '', expression: t.text };
  }
  const segs = readDottedPath(cur);
  if (!segs) throw cur.error('ожидался псевдоним поля индекса', t);
  return resolveSectionFieldRef(segs, aliasMap, aliasToId);
}

// ───────────────────── ДЛЯ ИЗМЕНЕНИЯ (FOR UPDATE) ──────────────────────

/** Секция `ДЛЯ ИЗМЕНЕНИЯ` + список полных имён таблиц. */
function parseLockForUpdate(cur: Cursor): string[] {
  cur.expectKeyword('ДЛЯ');
  cur.expectKeyword('ИЗМЕНЕНИЯ');
  const names: string[] = [];
  while (cur.peek().type === 'ident' || (cur.peek().type === 'keyword' && !isSectionKeyword(cur.peek().value))) {
    names.push(parseDottedName(cur));
  }
  return names;
}

const SECTION_KEYWORDS = new Set(['ИМЕЮЩИЕ', 'ИНДЕКСИРОВАТЬ', 'ИТОГИ', 'УПОРЯДОЧИТЬ', 'АВТОУПОРЯДОЧИВАНИЕ', 'ДЛЯ']);
function isSectionKeyword(value: string): boolean {
  return SECTION_KEYWORDS.has(value);
}

// ───────────────────────── построитель {…} ─────────────────────────────

/**
 * Блок построителя `{<keyword> … }`. Инвертирует `builderBlock`: список полей
 * `<ref>[.*][ КАК <alias>]` через запятую; закрывающая `}` примыкает к последнему
 * полю. `ref` — сырой текст (псевдоним выборки или `Алиас.Поле`).
 */
function parseBuilderBlock(cur: Cursor, keyword: string): BuilderField[] {
  cur.expectPunct('{');
  cur.expectKeyword(keyword);
  // `УПОРЯДОЧИТЬ ПО` / `ИТОГИ ПО` — после ключевого слова идёт ПО.
  if (keyword === 'УПОРЯДОЧИТЬ' || keyword === 'ИТОГИ') {
    cur.expectKeyword('ПО');
  }

  const fields: BuilderField[] = [];
  for (;;) {
    fields.push(parseBuilderField(cur));
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct('}');
  return fields;
}

/** Одно поле построителя: `<ref>[.*][ КАК <alias>]`. */
function parseBuilderField(cur: Cursor): BuilderField {
  // ref = точечное имя; `.*` → child. Собираем сегменты вручную, т.к. возможна
  // финальная `.*`.
  const first = cur.peek();
  if (first.type !== 'ident' && first.type !== 'keyword') {
    throw cur.error('ожидалась ссылка поля построителя', first);
  }
  let ref = cur.next().text;
  let child = false;
  while (cur.isPunct('.')) {
    cur.next();
    if (cur.isPunct('*')) {
      cur.next();
      child = true;
      break;
    }
    const seg = cur.peek();
    if (seg.type !== 'ident' && seg.type !== 'keyword') {
      throw cur.error('ожидался сегмент ссылки построителя после «.»', seg);
    }
    ref += '.' + cur.next().text;
  }

  const field: BuilderField = { ref, child };
  if (cur.matchKeyword('КАК')) {
    const a = cur.peek();
    if (a.type !== 'ident' && a.type !== 'keyword') throw cur.error('ожидался псевдоним после КАК', a);
    cur.next();
    field.alias = a.text;
  }
  return field;
}

// ───────────────────────── ОБЪЕДИНИТЬ (UNION) ──────────────────────────

/** Сырой срез участника объединения: токены и флаг distinct (по предшествующему разделителю). */
interface RawUnionMember {
  tokens: Token[];
  /** distinct === true → разделитель перед участником был «ОБЪЕДИНИТЬ» (без ВСЕ). */
  distinct: boolean;
}

/**
 * Разбивает поток токенов на участники объединения по ключевым словам
 * `ОБЪЕДИНИТЬ [ВСЕ]` ВЕРХНЕГО уровня — вне скобок подзапросов `(…)` И вне блоков
 * построителя `{…}`. Инвертирует разделитель `generateDocument`: участник после
 * `ОБЪЕДИНИТЬ ВСЕ` → distinct:false; после голого `ОБЪЕДИНИТЬ` → distinct:true.
 * Участник 0 всегда distinct:false (перед ним нет разделителя).
 *
 * Каждый срез завершается синтетическим токеном `eof`, чтобы курсор участника
 * корректно определял конец. Позиции токенов абсолютны относительно исходного
 * текста — сырые срезы (`sliceSource`) работают без модификаций.
 */
function splitUnionMembers(tokens: Token[], source: string): RawUnionMember[] {
  const members: RawUnionMember[] = [];
  let current: Token[] = [];
  let nextDistinct = false; // distinct участника 0 — false по соглашению.
  let parenDepth = 0;
  let braceDepth = 0;

  const flush = (distinct: boolean): void => {
    const last = current[current.length - 1];
    /* v8 ignore next 2 -- пустой участник (last undefined) приводит к ошибке разбора позже; ветви позиций защитные */
    const eofPos = last ? last.pos + last.value.length : 0;
    const eofTok: Token = { type: 'eof', value: '', text: '', pos: eofPos, line: last?.line ?? 1, col: last?.col ?? 1 };
    members.push({ tokens: [...current, eofTok], distinct });
    current = [];
  };

  for (const t of tokens) {
    if (t.type === 'eof') break;
    if (t.type === 'punct') {
      if (t.value === '(') parenDepth++;
      else if (t.value === ')') parenDepth--;
      else if (t.value === '{') braceDepth++;
      else if (t.value === '}') braceDepth--;
    }
    if (
      t.type === 'keyword' &&
      t.value === 'ОБЪЕДИНИТЬ' &&
      parenDepth === 0 &&
      braceDepth === 0
    ) {
      // Граница участника. distinct текущего накопленного участника = nextDistinct.
      flush(nextDistinct);
      // Следующий участник distinct, если разделитель НЕ сопровождается ВСЕ.
      nextDistinct = true;
      continue;
    }
    if (t.type === 'keyword' && t.value === 'ВСЕ' && parenDepth === 0 && braceDepth === 0 && current.length === 0) {
      // «ВСЕ» сразу после `ОБЪЕДИНИТЬ` (текущий участник ещё пуст) → не distinct.
      nextDistinct = false;
      continue;
    }
    current.push(t);
  }
  flush(nextDistinct);
  return members;
}

/**
 * Разбор объединённого запроса (`ОБЪЕДИНИТЬ [ВСЕ]`) в `QueryDocument`. Токенизирует
 * текст один раз, делит на участники по разделителям верхнего уровня и разбирает
 * каждого помощником `parseSingleQuery`.
 *
 * Восстановление псевдонимов колонок (инверсия `deriveUnionColumns`/`generateDocument`):
 * участник 0 несёт `КАК <псевдоним>` у каждой колонки (включая ячейки `NULL`), его
 * разобранные поля по позициям дают полный список псевдонимов колонок. У участников
 * i>0 элементы выборки идут без `КАК`; их поля переписываются по позиции из участника 0
 * (поле i-й колонки получает псевдоним i-й колонки участника 0), а поля-заглушки
 * `NULL` отбрасываются — у такого участника нет поля в этой колонке.
 */
export function parseDocument(text: string): QueryDocument {
  const tokens = tokenize(text);
  const raw = splitUnionMembers(tokens, text);

  const models = raw.map(r => parseSingleQuery(new Cursor(r.tokens, text)));

  // Автопсевдоним произвольного поля без явного `КАК`: конструктор 1С присваивает
  // `Поле{n}` (n — порядковый номер среди произвольных полей участника), а НЕ текст
  // выражения. Назначаем явно ДО вычисления псевдонимов колонок и переписывания
  // участников i>0, чтобы псевдоним колонки был `Поле{n}` (иначе многострочное
  // выражение ВЫБОР утекало бы в позицию псевдонима).
  models.forEach(assignExpressionFieldAliases);

  // Список псевдонимов колонок = псевдонимы полей участника 0 (по позициям).
  // Участник 0 эмитит ровно одну строку поля на колонку, поэтому его поля
  // взаимно-однозначны с колонками объединения.
  /* v8 ignore next -- splitUnionMembers всегда даёт >=1 участника ⇒ ветвь [] недостижима */
  const columnAliases = models.length > 0 ? models[0].fields.map(fieldAlias) : [];

  const members: UnionMember[] = models.map((model, i) => {
    if (i > 0) rewriteMemberAliases(model, columnAliases);
    return { name: `Запрос ${i + 1}`, distinct: raw[i].distinct, model };
  });

  return { members };
}

/**
 * Присваивает автопсевдоним `Поле{n}` каждому произвольному полю выборки участника
 * без явного `КАК`. Нумерация — сквозная по произвольным полям в порядке выборки,
 * как в генераторе (`buildFieldLines`). Простые поля и поля с явным псевдонимом не
 * трогаются. Идемпотентно: уже присвоенный явный псевдоним сохраняется.
 */
function assignExpressionFieldAliases(model: QueryModel): void {
  let exprCounter = 0;
  for (const f of model.fields) {
    if (f.expression === undefined) continue;
    // Нумерация совпадает с `buildFieldLines`: счётчик растёт ТОЛЬКО для полей без
    // явного псевдонима (`f.alias ?? Поле${++exprCounter}`), т.е. произвольное поле
    // с явным `КАК` номер `Поле{n}` не занимает.
    if (f.alias !== undefined) continue;
    // Голый параметр `&Имя` → псевдоним = имя параметра (без `&`), как у
    // конструктора; счётчик `Поле{n}` им не занимается.
    const m = BARE_PARAM_ALIAS.exec(f.expression.trim());
    f.alias = m ? m[1] : `Поле${++exprCounter}`;
  }
}

/** Признак поля-заглушки `NULL` (ячейка отсутствующей колонки участника). */
function isNullCell(f: SelectedField): boolean {
  return f.expression !== undefined && f.expression.trim().toUpperCase() === 'NULL';
}

/**
 * Переписывает поля участника i>0 по позициям колонок участника 0: i-е поле
 * (в порядке колонок) получает псевдоним i-й колонки, поля-заглушки `NULL`
 * отбрасываются. После переписывания `fieldAlias` каждого поля совпадает с
 * псевдонимом своей колонки, что обеспечивает корректное слияние в
 * `deriveUnionColumns` и воспроизведение исходного текста.
 */
function rewriteMemberAliases(model: QueryModel, columnAliases: string[]): void {
  const rewritten: SelectedField[] = [];
  model.fields.forEach((f, k) => {
    if (isNullCell(f)) return; // нет поля участника в этой колонке.
    const alias = columnAliases[k];
    if (alias === undefined) {
      rewritten.push(f);
      return;
    }
    // Простое поле: задаём явный alias так, чтобы fieldAlias === alias колонки и
    // ячейка (fieldExpr) воспроизводила исходное выражение без `КАК`.
    if (f.expression !== undefined) {
      rewritten.push({ ...f, alias });
    } else {
      rewritten.push({ tableId: f.tableId, path: f.path, alias });
    }
  });
  model.fields = rewritten;
}

// ─────────────────────────── пакет (BATCH) ─────────────────────────────

/** Разделитель пакета запросов 1С (инверсия `generateBatch`). */
const BATCH_SEPARATOR = '\n;\n\n' + '/'.repeat(80) + '\n';

/**
 * Разбор пакета запросов в `BatchDocument`. Лексер поглощает строку из 80 `/` как
 * комментарий, поэтому деление по разделителю выполняется на СЫРОМ тексте до
 * токенизации — точно по строке, которую эмитит `generateBatch`. Каждый фрагмент
 * разбирается `parseDocument` (т.е. может быть объединением). Одиночный запрос без
 * разделителя и без объединения корректно даёт пакет из одного документа с одним
 * участником.
 */
export function parseBatch(text: string): BatchDocument {
  // Хвостовой разделитель пакета `;` (с возможными пробелами/переводами строк)
  // конструктор отбрасывает: `;` — концерн МЕЖДУ операторами, после последнего
  // оператора его нет. Снимаем до разбиения, чтобы он не попал в текст условия.
  const normalized = text.replace(/\s*;\s*$/u, '');
  const chunks = normalized.split(BATCH_SEPARATOR);
  const members = chunks.map(parseDocument);
  return { members };
}
