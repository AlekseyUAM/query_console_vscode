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
  TabSectionColumn,
  AggregateFunction,
  SummableField,
  Selection,
  Grouping,
  Condition,
  ConditionOperator,
  Join,
  JoinCondition,
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

import { defaultTableAlias, accountingPositionKeys } from './queryModel';
import { renderOperatorRhs, needsFormatting, isRootNotGroup, normalizeLeafCase } from './exprFormatter';
import { tokenize } from './sdblLexer';
import type { Token } from './sdblLexer';
import { fieldAlias } from './unionModel';
import { extractComments } from './commentBinder';
import type { QueryDocument, UnionMember } from './unionModel';
import type { BatchDocument } from './batchModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaTable, MetaField } from '../metadata/types';
import { expandStarFields } from './expandStarFields';
import { expandTabSectionFields } from './expandTabSectionFields';
import { wrapTabSectionAggregates } from './wrapTabSectionAggregates';
import { dropUserIBConditions } from './dropUserIBConditions';
import { dropUnlimitedStringConditions } from './dropUnlimitedStringConditions';
import { qualifyBareFields, qualifyBareSectionFields, setSubqueryParser } from './qualifyBareFields';
import { resolveBuilderStar } from './resolveBuilderStar';
import { dropRedundantGroupDerefs, moveLeadingMovementCaseToEnd, moveBeforePrefixGroupDerefToEnd, substituteGroupFieldWithSelectExpr, dropFunctionallyDeterminedMovementCase, relocateKeptMovementCase } from './dropRedundantGroupDerefs';
import { canonicalizeFieldCasing } from './canonicalizeFieldCasing';

// Инжектируем разборщик подзапросов в пасс квалификации голых полей (для подзапросов,
// встроенных в СЫРЫЕ выражения условий/полей), избегая циклического импорта.
setSubqueryParser((text, r) => parseDocument(text, r));

/**
 * Резолвер метаданных активного разбора `parseDocument` — пробрасывается в
 * подзапросы-источники (`ИЗ (ВЫБРАТЬ …) КАК Т`), чтобы метаданные применялись и к
 * вложенным виртуальным таблицам (раскладка субконто/корр регистра бухгалтерии).
 * Сохраняется/восстанавливается стеково на время `parseDocument` (фаза 6.16.70).
 */
let sourceResolver: MetadataResolver | undefined;
// Глубина вложенности подзапроса-источника `ИЗ (ВЫБРАТЬ …)`. >0 при разборе тела
// такого подзапроса — конструктор 1С реконструирует его СГРУППИРОВАТЬ ПО из схемы
// (подстановка листа выражением, фаза 6.19), тогда как ВЕРХНЕУРОВНЕВУЮ группировку
// сохраняет дословно. Используется substituteGroupFieldWithSelectExpr.
let subquerySourceDepth = 0;

/** Обратная карта SDBL-функции агрегирования (инверсия `wrapAggregate`). */
const AGG_KEYWORD_TO_FUNC: Record<string, AggregateFunction> = {
  СУММА: 'Сумма',
  КОЛИЧЕСТВО: 'Количество',
  МАКСИМУМ: 'Максимум',
  МИНИМУМ: 'Минимум',
  СРЕДНЕЕ: 'Среднее',
};

/**
 * Виды метаданных, образующие полное имя таблицы (`Тип.Объект`). Голова такого
 * вида в полном пути поля (`Справочник.Валюты.Код`) при ОТСУТСТВИИ секции `ИЗ`
 * сигнализирует конструктору 1С синтезировать источник `ИЗ Тип.Объект КАК Объект`
 * и переписать префикс поля на псевдоним (фаза 6.16.17, см. synthesizeImplicitFrom).
 * Список синхронизирован с SUPPORTED_KINDS из metadata/yamlLoader.
 */
const METADATA_KINDS: ReadonlySet<string> = new Set([
  'СПРАВОЧНИК', 'ДОКУМЕНТ', 'КОНСТАНТА', 'ПЕРЕЧИСЛЕНИЕ',
  'ПЛАНОБМЕНА', 'ПЛАНВИДОВХАРАКТЕРИСТИК', 'ПЛАНСЧЕТОВ', 'ПЛАНВИДОВРАСЧЕТА',
  'БИЗНЕСПРОЦЕСС', 'ЗАДАЧА',
  'РЕГИСТРСВЕДЕНИЙ', 'РЕГИСТРНАКОПЛЕНИЯ', 'РЕГИСТРБУХГАЛТЕРИИ', 'РЕГИСТРРАСЧЕТА',
  'ПОСЛЕДОВАТЕЛЬНОСТЬ', 'ЖУРНАЛДОКУМЕНТОВ', 'КРИТЕРИЙОТБОРА',
]);

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

  /**
   * Все токены среза (включая уже поглощённые). Используется для построения
   * карты «поле → таблица-владелец» по квалифицированным вхождениям (фаза 6.15.4).
   */
  get allTokens(): readonly Token[] {
    return this.tokens;
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

  /**
   * Дальше начинается РАСПОЗНАВАЕМЫЙ блок построителя (`{ГДЕ`/`{УПОРЯДОЧИТЬ`/
   * `{ИТОГИ`/`{ВЫБРАТЬ`). Читалки условий (ПО/ГДЕ/ИМЕЮЩИЕ) останавливаются перед
   * ним (фаза 6.15.7); прочие `{…}` (например `{ЛЕВОЕ СОЕДИНЕНИЕ …}`) пока
   * заглатываются как раньше — их разбор не реализован.
   */
  isBuilderStart(): boolean {
    return (
      this.isBuilderBlock('ГДЕ') || this.isBuilderBlock('УПОРЯДОЧИТЬ') ||
      this.isBuilderBlock('ИТОГИ') || this.isBuilderBlock('ВЫБРАТЬ')
    );
  }

  /**
   * Дальше начинается ОПЦИОНАЛЬНОЕ соединение построителя `{<вид> СОЕДИНЕНИЕ …}`
   * (фаза 6.15.13): punct `{` + ключевое слово вида соединения
   * (ВНУТРЕННЕЕ/ЛЕВОЕ/ПРАВОЕ/ПОЛНОЕ).
   */
  isBuilderJoinStart(): boolean {
    if (!this.isPunct('{')) return false;
    const t = this.peek(1);
    return t.type === 'keyword' && JOIN_KEYWORDS.has(t.value);
  }

  error(message: string, t: Token = this.peek()): Error {
    return new Error(`Ошибка разбора ${t.line}:${t.col} — ${message} (получено «${t.value || '<конец>'}»)`);
  }

  /** Снимок позиции для отката (спекулятивный разбор). */
  mark(): number {
    return this.idx;
  }

  /** Откат позиции к снимку, снятому `mark()`. */
  reset(m: number): void {
    this.idx = m;
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

/** Одна сырая колонка проекции ТЧ: простое поле или произвольное выражение. */
type RawTabColumn =
  // `aliasExplicit` — колонка имела явный `КАК` в исходнике (даже если псевдоним
  // совпал с именем поля и был отброшен из `alias`). Нужен генератору, чтобы НЕ
  // навешивать позиционный `Поле{n}` на колонки, у которых автор написал `КАК`.
  | { kind: 'field'; field: string; alias?: string; aliasExplicit?: boolean }
  | { kind: 'expr'; rawBody: string; alias?: string };

/** Сырая табличная часть `<alias>.<tsName>.( … ) КАК <tsName>`. */
interface RawTabSection {
  tableAlias: string;
  tsName: string;
  /** Колонки проекции в исходном порядке (смесь полей и выражений). */
  columns: RawTabColumn[];
  /** Явный псевдоним `… КАК <alias>` (если задан), иначе undefined. */
  alias?: string;
  /**
   * Голова проекции — выражение приведения `ВЫРАЗИТЬ(… КАК Тип)` (а не псевдоним
   * таблицы): `ВЫРАЗИТЬ(Алиас.Источник КАК Документ.Событие).ДокументыОснования.(…)`.
   * Хранит ТЕКСТ приведения дословно; генератор печатает его как префикс проекции
   * (`<castPrefix>.<tsName>.(`), а колонки выводятся голыми (без переквалификации
   * псевдонимом — приведение не даёт псевдонима источника). Фаза 6.16.
   */
  castPrefix?: string;
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
  const model = parseSingleQuery(cur);
  // accountingArgs — транзиентное поле пост-разбора (parseDocument); прямой parseQuery
  // его не использует, поэтому снимаем, чтобы не светить в финальной модели.
  for (const t of model.tables) {
    if (t.virtual?.accountingArgs) delete t.virtual.accountingArgs;
  }
  return model;
}

/**
 * Разбирает ОДИН запрос-участник из курсора (без объединений). Выделено в
 * отдельный помощник, чтобы `parseDocument` мог разбирать срезы токенов участников
 * без повторной токенизации (см. 6.2.D). Курсор должен стоять в начале блока
 * запроса; разбор останавливается на eof среза.
 *
 * `inheritedSectionCtx` — контекст резолвинга секций УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКС
 * ПЕРВОГО участника объединения: конструктор 1С резолвит голые имена этих секций
 * по колонкам и источникам участника 0 (MCP, фаза 6.15.4), хотя текстуально
 * секции стоят после ПОСЛЕДНЕГО участника. `ctxOut.ctx` — собственный контекст
 * разобранного участника (для передачи последующим участникам объединения).
 */
/**
 * Токен `tokens[i]` — голова полного пути поля `Тип.Объект.<поле|*>` (вид метаданных
 * + имя объекта + минимум один сегмент поля или звезда). Используется обоими
 * проходами synthesizeImplicitFrom (сбор имён таблиц и переписывание префиксов),
 * чтобы критерий совпадал. НЕ учитывает зоны ЗНАЧЕНИЕ(…)/ТИП(…): их пропускает
 * вызывающий цикл через skipUntilDepth.
 */
function isImplicitSourceHead(tokens: readonly Token[], i: number): boolean {
  const t = tokens[i];
  if (!isNameToken(t)) return false;
  if (!METADATA_KINDS.has(t.text.toUpperCase())) return false;
  // Голова цепочки: перед ней нет `.` (иначе — продолжение чужого пути).
  const prev = tokens[i - 1];
  if (prev && prev.type === 'punct' && prev.value === '.') return false;
  // Тип-цепочка после КАК/ССЫЛКА (уточнение типа в ВЫРАЗИТЬ/ЕСТЬ) — не источник.
  const prevUp = prev && (prev.type === 'ident' || prev.type === 'keyword')
    ? prev.text.toUpperCase() : undefined;
  if (prevUp === 'КАК' || prevUp === 'ССЫЛКА') return false;
  // Форма `Тип.Объект.` + (имя поля | `*`).
  if (!(tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.' && isNameToken(tokens[i + 2]) &&
        tokens[i + 3]?.type === 'punct' && tokens[i + 3].value === '.')) {
    return false;
  }
  const after = tokens[i + 4];
  return isNameToken(after) || (after?.type === 'punct' && after.value === '*');
}

/**
 * Синтез секции `ИЗ` из полных путей полей при её отсутствии (фаза 6.16.17, MCP).
 *
 * Когда участник запроса НЕ содержит секции `ИЗ` верхнего уровня, а поля записаны
 * полными путями `Тип.Объект.поле` (голова — вид метаданных, см. METADATA_KINDS),
 * конструктор 1С синтезирует источники `ИЗ Тип.Объект КАК Объект` (по одному на
 * каждое различное полное имя `Тип.Объект`, СОРТИРОВАННЫЕ по псевдониму) и
 * переписывает каждый префикс `Тип.Объект.` в тексте участника на псевдоним
 * `Объект.`. После этого штатный разбор видит обычный запрос с явным `ИЗ` —
 * подхватываются автопсевдонимы (§6.16.13), квалификация голых полей единственного
 * источника (soleSource) и сортировка списка `ИЗ` генератором уже отлажены.
 *
 * Реализовано как переписывание ТЕКСТА участника + ретокенизация: возвращает новый
 * курсор поверх синтезированного текста либо исходный курсор без изменений (нет
 * подходящих путей, либо `ИЗ` уже присутствует, либо это не `ВЫБРАТЬ`).
 *
 * Скип зон, где `Тип.Объект.*` НЕ является ссылкой на поле-источник: внутренности
 * `ЗНАЧЕНИЕ(…)`/`ТИП(…)` (пути-литералы метаданных) и цепочка-тип после
 * `КАК`/`ССЫЛКА` (уточнение типа в ВЫРАЗИТЬ/ЕСТЬ) — те же зоны, что пропускает
 * qualifyBareFieldsInExpression.
 */
function synthesizeImplicitFrom(cur: Cursor): Cursor {
  const tokens = cur.allTokens;
  // Только запросы ВЫБРАТЬ (УНИЧТОЖИТЬ/прочее не трогаем).
  if (!(tokens[0]?.type === 'keyword' && tokens[0].value === 'ВЫБРАТЬ')) return cur;

  // Уже есть секция `ИЗ` верхнего уровня (вне скобок/блоков построителя) — выходим.
  // Заодно находим позицию первого ключевого слова СЕКЦИИ после списка полей
  // (ГДЕ/СГРУППИРОВАТЬ/УПОРЯДОЧИТЬ/…) для вставки синтезированного `ИЗ` перед ней.
  let depth = 0;
  let insertBeforePos: number | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) { depth++; continue; }
    if (t.type === 'punct' && (t.value === ')' || t.value === '}')) { depth--; continue; }
    if (depth !== 0) continue;
    if (t.type === 'keyword' && t.value === 'ИЗ') return cur;
    if (insertBeforePos === undefined && t.type === 'keyword' && SECTION_AFTER_FIELDS.has(t.value)) {
      insertBeforePos = t.pos;
    }
  }

  // Сбор различных полных имён `Тип.Объект` из путей полей `Тип.Объект.поле…`.
  // tableNames: ключ ВЕРХНИЙ регистр fullName → исходное написание fullName.
  const tableNames = new Map<string, string>();
  let skipUntilDepth: number | undefined;
  depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) {
      depth++;
      continue;
    }
    if (t.type === 'punct' && (t.value === ')' || t.value === '}')) {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined) continue;
    if (!isNameToken(t)) continue;
    const up = t.text.toUpperCase();
    // ЗНАЧЕНИЕ(/ТИП( — путь-литерал метаданных, не источник.
    if ((up === 'ЗНАЧЕНИЕ' || up === 'ТИП') &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      skipUntilDepth = depth + 1;
      continue;
    }
    if (!isImplicitSourceHead(tokens, i)) continue;
    const fullName = `${t.text}.${tokens[i + 2].text}`;
    tableNames.set(fullName.toUpperCase(), fullName);
  }
  if (tableNames.size === 0) return cur;

  // Источники: псевдоним = последний сегмент (Объект). Если два разных fullName дают
  // одинаковый псевдоним — синтез неоднозначен, не трогаем (редкость, безопасный откат).
  const sources = [...tableNames.values()].map(fullName => ({
    fullName,
    alias: fullName.slice(fullName.indexOf('.') + 1),
  }));
  const aliasSeen = new Set<string>();
  for (const s of sources) {
    const a = s.alias.toUpperCase();
    if (aliasSeen.has(a)) return cur;
    aliasSeen.add(a);
  }
  // Список `ИЗ` сортируется по псевдониму (канон конструктора при синтезе).
  sources.sort((a, b) => a.alias.localeCompare(b.alias, 'ru'));

  // Переписать префиксы `Тип.Объект.` → `Объект.` по всему тексту участника, КРОМЕ
  // зон ЗНАЧЕНИЕ(…)/ТИП(…) и цепочек-типов после КАК/ССЫЛКА (как при сборе).
  const start = tokens[0].pos;
  const lastReal = tokens[tokens.length - 1].type === 'eof'
    ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
  const end = lastReal.pos + lastReal.value.length;
  const edits: { pos: number; len: number }[] = [];
  depth = 0;
  skipUntilDepth = undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) { depth++; continue; }
    if (t.type === 'punct' && (t.value === ')' || t.value === '}')) {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined) continue;
    if (!isNameToken(t)) continue;
    const up = t.text.toUpperCase();
    if ((up === 'ЗНАЧЕНИЕ' || up === 'ТИП') &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      skipUntilDepth = depth + 1;
      continue;
    }
    if (!isImplicitSourceHead(tokens, i)) continue;
    if (!tableNames.has(`${t.text}.${tokens[i + 2].text}`.toUpperCase())) continue;
    // Снять `Тип.` (от головы до точки перед Объектом включительно): диапазон
    // [t.pos, начало токена Объекта).
    edits.push({ pos: t.pos, len: tokens[i + 2].pos - t.pos });
  }

  // Текст синтезированной секции `ИЗ`.
  const fromText = '\nИЗ\n' +
    sources.map(s => `\t${s.fullName} КАК ${s.alias}`).join(',\n') + '\n';

  // Сборка нового текста участника: применяем edits (удаление `Тип.`), затем
  // вставляем секцию `ИЗ` перед первой секцией после списка полей (или в конце).
  // edits отсортированы по позиции (порядок обхода токенов).
  const insertAt = insertBeforePos ?? end;
  let out = '';
  let p = start;
  let inserted = false;
  const maybeInsert = (upto: number): void => {
    if (!inserted && insertAt <= upto) {
      out += cur.source.slice(p, insertAt) + fromText;
      p = insertAt;
      inserted = true;
    }
  };
  for (const e of edits) {
    maybeInsert(e.pos);
    out += cur.source.slice(p, e.pos);
    p = e.pos + e.len;
  }
  maybeInsert(end);
  out += cur.source.slice(p, end);
  if (!inserted) out += fromText;

  return new Cursor(tokenize(out), out);
}

/**
 * Синтез секции `ИЗ` из ЕДИНСТВЕННОГО префикса-ВТ при её отсутствии (фаза 6.16.77,
 * MCP-проба).
 *
 * Когда участник запроса НЕ содержит секции `ИЗ` верхнего уровня, а ВСЕ поля
 * квалифицированы ОДНИМ И ТЕМ ЖЕ ведущим сегментом `<имя>.`, причём `<имя>` —
 * известная временная таблица (создана ранним `ПОМЕСТИТЬ <имя>`, видна через
 * `sourceResolver.tableByFullName`), конструктор 1С синтезирует источник
 * `ИЗ <имя> КАК <имя>` (приём «выборка из ВТ без явного ИЗ»; MCP подтверждает
 * `ВЫБРАТЬ ВТ.Поле` → дописывается `ИЗ\n\tВТ КАК ВТ`). Псевдоним = само имя ВТ,
 * поэтому переписывание префиксов полей НЕ требуется — достаточно вставить секцию.
 *
 * Отличие от synthesizeImplicitFrom: там голова — двусегментный вид метаданных
 * `Тип.Объект`, здесь — односегментное имя ВТ, и резолвиться оно должно как ВТ.
 */
function synthesizeTempTableFrom(cur: Cursor): Cursor {
  const tokens = cur.allTokens;
  if (!(tokens[0]?.type === 'keyword' && tokens[0].value === 'ВЫБРАТЬ')) return cur;
  const resolver = sourceResolver;
  if (!resolver) return cur;

  // Точка вставки + проверка отсутствия `ИЗ` верхнего уровня (как в synthesizeImplicitFrom).
  let depth = 0;
  let insertBeforePos: number | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) { depth++; continue; }
    if (t.type === 'punct' && (t.value === ')' || t.value === '}')) { depth--; continue; }
    if (depth !== 0) continue;
    if (t.type === 'keyword' && t.value === 'ИЗ') return cur;
    if (insertBeforePos === undefined && t.type === 'keyword' && SECTION_AFTER_FIELDS.has(t.value)) {
      insertBeforePos = t.pos;
    }
  }

  // Собрать ведущие сегменты квалифицированных путей `<имя>.<поле>` на ВЕРХНЕМ
  // уровне. Голова цепочки: имя-токен, перед которым нет `.`, за которым идёт `.`
  // + имя/звезда. Любое голое поле/выражение-голова (имя без последующей `.`,
  // функция, параметр) делает синтез неоднозначным — выходим без изменений.
  const heads = new Set<string>();
  depth = 0;
  let skipUntilDepth: number | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) { depth++; continue; }
    if (t.type === 'punct' && (t.value === ')' || t.value === '}')) {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined) continue;
    // Достигли первой секции после списка полей (ПОМЕСТИТЬ/УПОРЯДОЧИТЬ/ГДЕ/…) —
    // дальше не сканируем (поля сортировки/группировки могут быть голыми).
    if (depth === 0 && t.type === 'keyword' && SECTION_AFTER_FIELDS.has(t.value)) break;
    if (!isNameToken(t)) continue;
    const up = t.text.toUpperCase();
    if ((up === 'ЗНАЧЕНИЕ' || up === 'ТИП') &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      skipUntilDepth = depth + 1;
      continue;
    }
    // Структурные ключевые слова списка полей (`КАК`, `ССЫЛКА`, направление
    // сортировки) — не головы путей. `КАК <псевдоним>`/`<поле> ССЫЛКА <тип>`
    // вводят имя, которое НЕ должно считаться головой; пропускаем и его, и
    // следующий токен (псевдоним/тип-голову).
    if (t.type === 'keyword' && (up === 'КАК' || up === 'ССЫЛКА')) { i++; continue; }
    if (t.type === 'keyword') continue; // прочие ключевые слова (ВОЗР/УБЫВ/И/ИЛИ/…)
    // Голова цепочки только на верхнем уровне.
    if (depth !== 0) continue;
    const prev = tokens[i - 1];
    if (prev && prev.type === 'punct' && prev.value === '.') continue; // продолжение чужого пути
    // Вызов функции (`Имя(`) — не путь поля; синтез неоднозначен.
    if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') return cur;
    // Голова пути: имя + `.` + имя.
    if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.' && isNameToken(tokens[i + 2])) {
      heads.add(t.text);
      continue;
    }
    // Имя-голова без последующей `.` (голое поле/идентификатор) — неоднозначно.
    return cur;
  }

  if (heads.size !== 1) return cur;
  const name = [...heads][0];
  // Имя должно резолвиться как ВТ: односегментное (без точки) и известно резолверу.
  if (name.includes('.')) return cur;
  if (!resolver.tableByFullName(name)) return cur;
  const canonical = resolver.canonicalFullName?.(name) ?? name;

  const start = tokens[0].pos;
  const lastReal = tokens[tokens.length - 1].type === 'eof'
    ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
  const end = lastReal.pos + lastReal.value.length;
  const fromText = `\nИЗ\n\t${canonical} КАК ${canonical}\n`;
  const insertAt = insertBeforePos ?? end;
  const out = cur.source.slice(start, insertAt) + fromText + cur.source.slice(insertAt, end);
  return new Cursor(tokenize(out), out);
}

/**
 * Ключевые слова секций, идущих ПОСЛЕ списка полей (и после `ИЗ`). Точка вставки
 * синтезированной секции `ИЗ` — перед первым из них (synthesizeImplicitFrom).
 */
const SECTION_AFTER_FIELDS: ReadonlySet<string> = new Set([
  'ГДЕ', 'СГРУППИРОВАТЬ', 'ИМЕЮЩИЕ', 'УПОРЯДОЧИТЬ', 'АВТОУПОРЯДОЧИВАНИЕ',
  'ИТОГИ', 'ИНДЕКСИРОВАТЬ', 'ДЛЯ', 'ПОМЕСТИТЬ', 'ДОБАВИТЬ',
]);

function parseSingleQuery(
  cur: Cursor,
  inheritedSectionCtx?: SectionResolveContext,
  ctxOut?: { ctx?: SectionResolveContext }
): QueryModel {
  // Синтез источника `ИЗ` из полных путей полей `Тип.Объект.поле` при отсутствии
  // секции `ИЗ` (фаза 6.16.17): возвращает переписанный курсор либо исходный.
  cur = synthesizeImplicitFrom(cur);
  // Синтез источника `ИЗ <ВТ> КАК <ВТ>` при отсутствии секции `ИЗ` и едином
  // префиксе-ВТ у всех полей (фаза 6.16.77).
  cur = synthesizeTempTableFrom(cur);

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

  // {ВЫБРАТЬ …} может также стоять ПОСЛЕ ПОМЕСТИТЬ/ДОБАВИТЬ, перед ИЗ — конструктор
  // печатает его именно там (фаза 6.16.50). Проверяем обе позиции: если блок
  // уже захвачен до ПОМЕСТИТЬ, второй проверки не происходит (builder.fields пуст).
  if (builder.fields.length === 0 && cur.isBuilderBlock('ВЫБРАТЬ')) {
    builder.fields = parseBuilderBlock(cur, 'ВЫБРАТЬ');
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
  // явно прочитаны из `КАК` каждой таблицы). Идентификаторы 1С регистронезависимы,
  // поэтому ключи хранятся в ВЕРХНЕМ регистре (фаза 6.15.4: `Таб` ↔ `ТАБ`);
  // объявленное написание для рендера хранит aliasSpelling.
  const aliasToId = new Map<string, string>();
  const aliasSpelling = new Map<string, string>();
  for (const t of tables) {
    if (t.alias) {
      aliasToId.set(t.alias.toUpperCase(), t.id);
      aliasSpelling.set(t.alias.toUpperCase(), t.alias);
    }
  }

  // Интерпретация элементов выборки: обычные поля, табличные части и хвостовые
  // поля (после первой табличной части). Карта псевдонимов уже известна.
  const fields: SelectedField[] = [];
  const aggregates: SummableField[] = [];
  const tabSectionFields: SelectedTabSectionField[] = [];
  const trailingFields: SelectedField[] = [];
  // Единственный источник → можно квалифицировать голые поля без метаинформации.
  const soleSource = soleSourceOf(tables, joins);
  // Резолвер владельца голого поля (фаза 6.15.4, MCP): при единственном источнике —
  // он; при нескольких — таблица, у которой это поле встречается в запросе
  // квалифицированным (`<псевдоним>.<поле>`) РОВНО у одного псевдонима. Конструктор
  // 1С резолвит по схеме метаданных (недоступна здесь); эвристика по вхождениям
  // совпадает с эталоном на всём корпусе.
  const fieldOwners = buildFieldOwnerScan(cur.allTokens, aliasToId);
  // id таблицы → её полное имя: для снятия префикса полного имени из голого пути
  // поля (`Справочник.Валюты.Ссылка` при источнике `Справочник.Валюты` → `Ссылка`).
  const tableFullNames = new Map(tables.map(t => [t.id, t.fullName] as const));
  const resolveOwner = (head: string): string | undefined => {
    if (soleSource) return soleSource.id;
    const owners = fieldOwners.get(head.toUpperCase());
    if (owners && owners.size === 1) return owners.values().next().value;
    // Текстовый скан не дал владельца (поле НИГДЕ во вводе не квалифицировано —
    // встречается только голым). Падаем на МЕТАДАННЫЕ: голое поле принадлежит
    // источнику, в схеме которого есть реквизит с этим именем, и таких источников
    // РОВНО один (иначе неоднозначно — оставляем как раньше). Конструктор 1С
    // резолвит по схеме, поэтому такое голое поле он печатает квалифицированно с
    // автопсевдонимом-именем поля (`КлючСвязи` → `Запасы.КлючСвязи КАК КлючСвязи`),
    // а не как выражение `Поле{n}`. Узко: только при пустом текстовом скане. (6.17)
    if (sourceResolver && (!owners || owners.size === 0)) {
      const up = head.toUpperCase();
      let hit: string | undefined;
      let count = 0;
      for (const t of tables) {
        if (t.subquery || !t.fullName || t.fullName.startsWith('&')) continue;
        const meta = sourceResolver.tableByFullName(t.fullName);
        if (meta && meta.fields.some(f => f.name.toUpperCase() === up)) {
          count++;
          hit = t.id;
        }
      }
      if (count === 1) return hit;
    }
    return undefined;
  };
  // Явные псевдонимы выборки из ВВОДА (`… КАК <имя>`): голое имя в секциях
  // УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКСИРОВАТЬ, совпадающее с таким псевдонимом, конструктор
  // оставляет голым; не совпадающее — квалифицирует таблицей (MCP, фаза 6.15.4).
  // Автопсевдонимы (КАК добавлен конструктором) НЕ защищают от квалификации.
  const explicitAliases = new Set<string>();
  for (const item of items) {
    if (item.kind === 'field' && item.field.alias !== undefined) {
      explicitAliases.add(item.field.alias.toUpperCase());
    } else if (item.kind === 'tabSection') {
      if (item.ts.alias) explicitAliases.add(item.ts.alias.toUpperCase());
      // Псевдонимы КОЛОНОК проекции ТЧ (`Алиас.ТЧ.(Поле КАК Кол, …)`) — тоже
      // псевдонимы выборки: голое имя колонки в УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКСИРОВАТЬ,
      // совпадающее с ними, конструктор оставляет голым (НЕ квалифицирует ТЧ-
      // владельцем). Эффективный псевдоним простой колонки = `alias ?? field`
      // (генератор печатает `<поле> КАК <поле>` без явного КАК); у выражения —
      // только явный `alias` (сверено с живым оракулом, фаза 6.16.12).
      for (const col of item.ts.columns) {
        const colAlias = col.kind === 'field' ? (col.alias ?? col.field) : col.alias;
        if (colAlias !== undefined) explicitAliases.add(colAlias.toUpperCase());
      }
    }
  }
  let sawTabSection = false;
  // selectOrder проставляем ТОЛЬКО когда в выборке есть проекция ТЧ — генератор по
  // нему восстанавливает исходное перемежение скалярных полей и проекций ТЧ, чтобы
  // проекция ТЧ после скалярных полей не «всплывала» в общий блок ТЧ (фаза 6.15.20).
  // В отсутствие ТЧ модель остаётся без лишнего поля (round-trip/UI-инварианты).
  const tagOrder = items.some(it => it.kind === 'tabSection');
  let selectOrder = 0;
  for (const item of items) {
    if (item.kind === 'tabSection') {
      const ts = resolveTabSection(item.ts, aliasToId, tables, aliasSpelling);
      if (tagOrder) ts.selectOrder = selectOrder;
      selectOrder++;
      sawTabSection = true;
      tabSectionFields.push(ts);
      continue;
    }
    const target = sawTabSection ? trailingFields : fields;
    const before = target.length;
    interpretField(item.field, aliasToId, target, aggregates, resolveOwner, tableFullNames);
    if (tagOrder) for (let k = before; k < target.length; k++) target[k].selectOrder = selectOrder;
    selectOrder++;
  }

  // Соединения: достроить ссылки на таблицы по псевдонимам.
  const resolvedJoins = joins.map(j => resolveJoin(j, aliasToId, cur.source));

  // Секции после ИЗ — в каноническом порядке генератора:
  //   ГДЕ → {ГДЕ} → СГРУППИРОВАТЬ ПО → {УПОРЯДОЧИТЬ ПО} → {ИТОГИ ПО}
  //   → УПОРЯДОЧИТЬ ПО → ИТОГИ → ИНДЕКСИРОВАТЬ ПО → ДЛЯ ИЗМЕНЕНИЯ.
  let conditions: Condition[] | undefined;
  if (cur.isKeyword('ГДЕ')) {
    conditions = parseWhere(cur, aliasToId, soleSource, aliasSpelling);
  }

  // Чтение блока построителя `{ГДЕ …}` с синтезом автопсевдонимов условий-выражений.
  // Условие-выражение без явного КАК получает автопсевдоним `Поле<2·k>`, где
  // k — порядковый номер ИМЕНУЕМОГО условия-выражения в блоке (1-based). Каждое
  // выражение СКД занимает два слота полей доступных данных, поэтому оракул
  // нумерует их чётными: 1-е → Поле2, 2-е → Поле4, … (сверено живым оракулом
  // `validate_query`; не зависит от числа статических условий ГДЕ и числа полей
  // выборки). Простые поля (`Т.Код`) и одиночный параметр (`&Отбор` — вставка
  // целого блока отбора) псевдонима не получают и счётчик k не двигают.
  // НЕСКОЛЬКО соседних `{ГДЕ …}` блоков подряд конструктор 1С СКЛЕИВАЕТ в ОДИН блок
  // построителя (корпус СобытияМониторингаСПАРКРиски: четыре `{ГДЕ …}` → единый `{ГДЕ}`
  // с четырьмя условиями). Автопсевдоним `Поле<2k>` нумеруется ПО КАЖДОМУ исходному
  // блоку отдельно (k сбрасывается на границе блоков): четыре одиночных блока дают
  // `Поле2` каждому. Накапливаем условия из всех подряд идущих блоков.
  const readBuilderWhere = (): void => {
    while (cur.isBuilderBlock('ГДЕ')) {
      const block = parseBuilderBlock(cur, 'ГДЕ');
      let exprNo = 0;
      for (const f of block) {
        if (!f.condition) continue;
        if (f.alias || /^&[\p{L}\p{N}_]+$/u.test(f.ref)) continue;
        exprNo += 1;
        f.alias = `Поле${2 * exprNo}`;
      }
      builder.conditions.push(...block);
    }
  };
  if (cur.isBuilderBlock('ГДЕ')) {
    readBuilderWhere();
  }

  let groupingFromClause: { multiple: boolean; groupFields: FieldRef[]; groupSets: FieldRef[][] } | undefined;
  if (cur.isKeyword('СГРУППИРОВАТЬ')) {
    groupingFromClause = parseGroupBy(cur, aliasToId, resolveOwner);
  }

  // ИМЕЮЩИЕ — фильтр по агрегатам, сразу за СГРУППИРОВАТЬ ПО.
  let having: Condition[] | undefined;
  if (cur.isKeyword('ИМЕЮЩИЕ')) {
    having = parseHaving(cur, aliasToId);
  }

  // `{ГДЕ …}` может стоять и ПОСЛЕ СГРУППИРОВАТЬ ПО/ИМЕЮЩИЕ (разработчик дописал
  // условие построителя в конце текста). Конструктор 1С печатает его в каноне —
  // перед СГРУППИРОВАТЬ ПО (см. порядок секций генератора). Если до группировки
  // блок не встретился — читаем его здесь.
  if (builder.conditions.length === 0 && cur.isBuilderBlock('ГДЕ')) {
    readBuilderWhere();
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
  // `ДЛЯ ИЗМЕНЕНИЯ` сохраняется даже без перечня таблиц (`ДЛЯ ИЗМЕНЕНИЯ` без имён —
  // блокировка всех источников запроса; оракул печатает голую секцию). `undefined`
  // → секции не было; перечень → `lockForUpdate`; пустой перечень при наличии секции
  // → флаг `lockForUpdateBare` (пустой массив сам по себе значит «секции нет»).
  if (lockForUpdate && lockForUpdate.length > 0) model.lockForUpdate = lockForUpdate;
  else if (lockForUpdate !== undefined) model.lockForUpdateBare = true;

  // Группировка: объединяем агрегаты (из полей выборки) с группировочными полями
  // и наборами из секции СГРУППИРОВАТЬ ПО. Не затираем агрегаты группировкой.
  if (aggregates.length > 0 || groupingFromClause) {
    const grouping: Grouping = {
      multiple: groupingFromClause?.multiple ?? false,
      groupFields: groupingFromClause?.groupFields ?? [],
      groupSets: groupingFromClause?.groupSets ?? [],
      aggregates,
      // Граница ЯВНОЙ части группировки — до автодописанных ниже расширений выборки.
      explicitGroupCount: groupingFromClause?.groupFields.length ?? 0,
    };
    // Авторасширение СГРУППИРОВАТЬ ПО (сверено с живым оракулом, фаза 6.16):
    // конструктор 1С дописывает в группировку каждое НЕагрегатное поле выборки —
    // простую ссылку `Псевдоним.Путь` (без func/expression), которая является
    // строгим дот-расширением уже сгруппированного поля: при группировке по
    // `Т.Ссылка` дописываются `Т.Ссылка.Код`, `Т.Ссылка.Наименование` (это
    // разыменования сгруппированной ссылки, функционально зависимые от неё),
    // в порядке следования в ВЫБРАТЬ. Поле, НЕ являющееся расширением (`Т.Код`
    // при группировке только по `Т.Ссылка`), оракул считает ошибкой группы —
    // не дописываем. Литералы, параметры (`&Имя`), вызовы функций, ВЫРАЗИТЬ/ВЫБОР
    // тоже не дописываются. Только одиночная группировка с явной секцией
    // СГРУППИРОВАТЬ ПО (не агрегатные запросы без секции и не наборы).
    if (!grouping.multiple && groupingFromClause && !groupingFromClause.multiple) {
      const baseRefs = grouping.groupFields.filter(g => g.expression === undefined);
      const present = new Set(baseRefs.map(g => `${g.tableId} ${g.path}`));
      // Таблицы, чья ССЫЛКА (ключ) в группировке: все их простые поля выборки
      // функционально зависимы от ключа и тоже дописываются (сверено живым оракулом:
      // `СГРУППИРОВАТЬ ПО Т.Ссылка` + выбор `Т.Наименование`, `Т.Код` → дописываются).
      const keyedTables = new Set(baseRefs.filter(g => g.path === 'Ссылка').map(g => g.tableId));
      // Кандидаты — НЕагрегатные простые поля выборки в порядке ВЫБРАТЬ (головные +
      // хвостовые после ТЧ).
      const candidates = [...fields, ...(model.trailingFields ?? [])];
      for (const f of candidates) {
        if (f.func !== undefined || f.expression !== undefined) continue;
        if (f.tableId === '' || f.path === '') continue;
        const key = `${f.tableId} ${f.path}`;
        if (present.has(key)) continue;
        const isExtension = baseRefs.some(
          g => g.tableId === f.tableId && f.path.startsWith(`${g.path}.`)
        );
        // Поле таблицы со сгруппированной ссылкой (без точки — реквизит/измерение
        // этой таблицы) тоже функционально зависимо.
        const isKeyDependent = keyedTables.has(f.tableId);
        if (!isExtension && !isKeyDependent) continue;
        present.add(key);
        grouping.groupFields.push({ tableId: f.tableId, path: f.path });
      }
    }
    model.grouping = grouping;
  }

  // Карта псевдоним выборки → (tableId, path) для секций УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКС.
  const selectAliasMap = buildSelectAliasMap(model);
  const ownSectionCtx: SectionResolveContext = {
    aliasMap: selectAliasMap,
    aliasToId,
    explicitAliases,
    fields: model.fields,
    resolveOwner,
  };
  if (ctxOut) ctxOut.ctx = ownSectionCtx;
  // Секции объединённого запроса резолвятся по контексту ПЕРВОГО участника.
  const sectionCtx = inheritedSectionCtx ?? ownSectionCtx;

  if (cur.isKeyword('УПОРЯДОЧИТЬ') || cur.isKeyword('АВТОУПОРЯДОЧИВАНИЕ')) {
    model.order = parseOrder(cur, sectionCtx);
  }
  if (cur.isKeyword('ИТОГИ')) {
    model.totals = parseTotals(cur, sectionCtx);
  }
  // АВТОУПОРЯДОЧИВАНИЕ может стоять В САМОМ КОНЦЕ запроса — ПОСЛЕ ИТОГИ (1С печатает
  // его последней строкой). Если осталось — выставляем флаг auto на секции порядка
  // (создаём её при необходимости). Фаза 6.16.9.
  if (cur.isKeyword('АВТОУПОРЯДОЧИВАНИЕ')) {
    cur.next();
    if (model.order) model.order.auto = true;
    else model.order = { fields: [], auto: true };
  }
  if (cur.isKeyword('ИНДЕКСИРОВАТЬ')) {
    model.indexing = parseIndex(cur, sectionCtx);
  }

  // Блок характеристик СКД `{ХАРАКТЕРИСТИКИ … }` в конце запроса. Конструктор
  // сохраняет его ДОСЛОВНО — захватываем сырой срез исходника от `{` до парной `}`
  // (учитывая вложенные скобки/фигурные скобки) и кладём в model.characteristics.
  // `ХАРАКТЕРИСТИКИ` не входит в KEYWORDS → токен-идентификатор.
  if (cur.isPunct('{') && cur.peek(1).type === 'ident' && cur.peek(1).value.toUpperCase() === 'ХАРАКТЕРИСТИКИ') {
    const open = cur.peek();
    let depth = 0;
    let end = open.pos;
    for (;;) {
      const t = cur.peek();
      if (t.type === 'eof') break;
      if (t.type === 'punct' && t.value === '{') depth++;
      else if (t.type === 'punct' && t.value === '}') {
        depth--;
        cur.next();
        if (depth === 0) { end = t.pos + t.value.length; break; }
        continue;
      }
      cur.next();
    }
    model.characteristics = cur.source.slice(open.pos, end);
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
 * Пытается разобрать проекцию ТЧ с головой-приведением:
 *   `ВЫРАЗИТЬ(<выраж> КАК <Тип>).<ТЧ>.( <колонки> ) КАК <alias>`
 * (сверено по оракулу: КонтактЦентр_5). Голова — выражение `ВЫРАЗИТЬ(…)` (с
 * балансом скобок), затем `.<ТЧ>(.<ТЧ>)*.(`. Колонки печатаются ГОЛЫМИ (приведение
 * не даёт псевдонима источника, переквалифицировать нечем). Возвращает undefined без
 * сдвига курсора, если образца нет.
 */
function tryParseCastTabSection(cur: Cursor): RawTabSection | undefined {
  const head = cur.peek(0);
  // `ВЫРАЗИТЬ` — идентификатор-функция (не ключевое слово), сравниваем регистронезависимо.
  if (head.type !== 'ident' || head.text.toUpperCase() !== 'ВЫРАЗИТЬ') return undefined;
  if (!cur.isPunct('(', 1)) return undefined;
  // Сканируем без сдвига: пропускаем сбалансированные скобки приведения, затем ждём
  // `.` имя ( `.` имя )* `.` `(`.
  let off = 1; // на `(`
  let depth = 0;
  for (;;) {
    const t = cur.peek(off);
    if (t.type === 'eof') return undefined;
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) break; }
    off++;
  }
  // off — индекс закрывающей `)` приведения. Дальше обязателен `.` имя … `.` `(`.
  const castEndOff = off;
  off++; // за `)`
  if (!(cur.peek(off).type === 'punct' && cur.peek(off).value === '.')) return undefined;
  off++;
  let segCount = 0;
  for (;;) {
    const nameTok = cur.peek(off);
    if (nameTok.type !== 'ident' && nameTok.type !== 'keyword') return undefined;
    if (!(cur.peek(off + 1).type === 'punct' && cur.peek(off + 1).value === '.')) return undefined;
    segCount++;
    if (cur.peek(off + 2).type === 'punct' && cur.peek(off + 2).value === '(') break;
    off += 2;
  }
  if (segCount < 1) return undefined;

  // Образец подтверждён — поглощаем токены и строим текст приведения дословно.
  const castStartTok = cur.peek(0);
  const castEndTok = cur.peek(castEndOff);
  const castPrefix = cur.source.slice(castStartTok.pos, castEndTok.pos + castEndTok.value.length);
  // Поглощаем приведение целиком (до и включая закрывающую `)`).
  for (let k = 0; k <= castEndOff; k++) cur.next();
  cur.expectPunct('.');
  const tsSegs: string[] = [];
  for (;;) {
    tsSegs.push(cur.next().text);
    cur.expectPunct('.');
    if (cur.isPunct('(')) break;
  }
  const tsName = tsSegs.join('.');
  cur.expectPunct('(');
  const columns: RawTabColumn[] = [];
  for (;;) {
    columns.push(parseTabColumn(cur, tsName, ''));
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct(')');
  let alias: string | undefined;
  if (cur.matchKeyword('КАК')) {
    const a = cur.peek();
    if (a.type === 'ident' || a.type === 'keyword') { alias = a.text; cur.next(); }
  }
  return { tableAlias: '', tsName, columns, alias, castPrefix };
}

/**
 * Пытается разобрать табличную часть `<alias>.<tsName>.( <f> КАК <f>, … ) КАК <tsName>`.
 * Распознаётся по образцу `ident (. ident)+ . (` в начале элемента: голова —
 * `<alias>`, путь до проекции — `<seg>(.<seg>)*` (один сегмент = обычная ТЧ
 * `alias.ТЧ.(…)`, два и более — НАВИГИРОВАННАЯ голова `alias.refField.….ТЧ.(…)`,
 * проходящая через ссылочные колонки; фаза 6.16). `tsName` хранит ВЕСЬ путь до
 * проекции (генератор печатает `<alias>.<tsName>.(`), а переквалификация колонок
 * идёт по полному префиксу `<alias>.<tsName>`. Возвращает undefined, если образца
 * нет (тогда элемент — обычное поле), не сдвигая курсор.
 */
function tryParseTabSection(cur: Cursor): RawTabSection | undefined {
  // Голова-приведение `ВЫРАЗИТЬ(… КАК Тип).<ТЧ>.(…)` — отдельная ветка.
  const cast = tryParseCastTabSection(cur);
  if (cast) return cast;
  // Образец: ident '.' ident ('.' ident)* '.' '(' . Сканируем без сдвига курсора:
  // нужна цепочка из ≥2 имён через точки, после которой идёт `.(`.
  if (cur.peek(0).type !== 'ident' && cur.peek(0).type !== 'keyword') return undefined;
  if (!cur.isPunct('.', 1)) return undefined;
  // Идём по `name . name . …`, пока за именем стоит `.`. Голова проекции — когда
  // ПОСЛЕ имени стоит `.` и затем `(`.
  let off = 0; // позиция текущего имени
  let segCount = 0;
  for (;;) {
    const nameTok = cur.peek(off);
    if (nameTok.type !== 'ident' && nameTok.type !== 'keyword') return undefined;
    if (!cur.isPunct('.', off + 1)) return undefined; // за именем обязана идти `.`
    segCount++;
    // `name . (` → нашли проекцию (нужно ≥2 имён: alias + хотя бы 1 сегмент ТЧ).
    if (cur.isPunct('(', off + 2)) {
      if (segCount < 2) return undefined;
      break;
    }
    off += 2; // к следующему имени
  }

  const tableAlias = cur.next().text; // ident
  cur.expectPunct('.');
  // Путь до проекции: все сегменты между головой и `.(`.
  const tsSegs: string[] = [];
  for (;;) {
    tsSegs.push(cur.next().text);
    cur.expectPunct('.');
    if (cur.isPunct('(')) break;
  }
  const tsName = tsSegs.join('.');
  cur.expectPunct('(');

  // Внутри: список колонок через запятую. Колонка — либо ПРОСТОЕ поле (голое имя или
  // точечный путь: `НомерСтроки`, `Номенклатура.Артикул`), которому `КАК <псевдоним>`
  // необязателен (1С подставляет псевдоним = имя), либо ПРОИЗВОЛЬНОЕ ВЫРАЖЕНИЕ
  // (`ВЫБОР … КОНЕЦ`, литерал `""`/`0`, вызов функции, арифметика). Выражения читаются
  // сырым срезом и переквалифицируются генератором.
  const columns: RawTabColumn[] = [];
  for (;;) {
    const col = parseTabColumn(cur, tsName, tableAlias);
    columns.push(col);
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct(')');
  // `КАК <псевдоним табличной части>` также необязателен. Если задан явно —
  // конструктор печатает именно его (а не имя табличной части).
  let alias: string | undefined;
  if (cur.matchKeyword('КАК')) {
    const a = cur.peek();
    if (a.type === 'ident' || a.type === 'keyword') {
      alias = a.text;
      cur.next();
    }
  }
  return { tableAlias, tsName, columns, alias };
}

/**
 * Разбирает ОДНУ колонку проекции ТЧ. Распознаёт простое поле (голый идентификатор или
 * точечный путь) от произвольного выражения, считывая тело до верхнеуровневой `,`/`)`/`КАК`.
 * Простое поле — путь из имён через `.`, без операторов/скобок/литералов; ведущий сегмент,
 * совпадающий с именем ТЧ, отбрасывается (самоссылка). Всё прочее — выражение (сырой срез).
 */
function parseTabColumn(cur: Cursor, tsName: string, tableAlias: string): RawTabColumn {
  const start = cur.peek();
  if (start.type === 'eof') throw cur.error('ожидалось поле табличной части', start);

  // Попытка распознать ПРОСТОЕ поле: цепочка `имя (. имя)*`, после которой идёт
  // граница колонки (`,` / `)` / `КАК`). Если после пути встретилось что-то иное
  // (оператор, `(` вызова, литерал) — это выражение; откатываемся и читаем сырьём.
  const mark = cur.mark();
  if (start.type === 'ident' || start.type === 'keyword') {
    const segs: string[] = [start.text];
    cur.next();
    let ok = true;
    while (cur.isPunct('.')) {
      cur.next();
      const seg = cur.peek();
      if (seg.type !== 'ident' && seg.type !== 'keyword') { ok = false; break; }
      cur.next();
      segs.push(seg.text);
    }
    const after = cur.peek();
    const atBoundary = after.type === 'eof'
      || (after.type === 'punct' && (after.value === ',' || after.value === ')'))
      || (after.type === 'keyword' && after.value === 'КАК');
    if (ok && atBoundary) {
      // Простая колонка печатается ГОЛОЙ относительно ТЧ: отбрасываем ведущие сегменты,
      // совпадающие с псевдонимом таблицы и/или именем ТЧ (`ОтчетКомиссионера.Поле`,
      // `Запасы.Поле`, `ОтчетКомиссионера.Запасы.Поле` → `Поле`). Сверено с оракулом.
      let body = segs;
      if (body.length > 1 && body[0].toUpperCase() === tableAlias.toUpperCase()) body = body.slice(1);
      if (body.length > 1 && body[0].toUpperCase() === tsName.toUpperCase()) body = body.slice(1);
      const fieldText = body.join('.');
      let colAlias: string | undefined;
      if (cur.matchKeyword('КАК')) {
        const a = cur.peek();
        if (a.type !== 'ident' && a.type !== 'keyword') throw cur.error('ожидался псевдоним поля после КАК', a);
        cur.next();
        colAlias = a.text;
      }
      // Совпадающий с именем псевдоним не сохраняем (авто `Поле КАК Поле`), но
      // ФАКТ явного `КАК` запоминаем (`aliasExplicit`) — генератор по нему отличает
      // автопсевдоним от явного при позиционной нумерации `Поле{n}` глубоких ТЧ.
      return {
        kind: 'field',
        field: fieldText,
        alias: colAlias !== undefined && colAlias !== fieldText ? colAlias : undefined,
        aliasExplicit: colAlias !== undefined,
      };
    }
  }

  // Произвольное выражение: откатываемся к началу и читаем тело сырьём до границы.
  cur.reset(mark);
  const bodyTokens: Token[] = [];
  let alias: string | undefined;
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && (t.value === ',' || t.value === ')')) break;
      if (t.type === 'keyword' && t.value === 'КАК') {
        cur.next();
        const a = cur.peek();
        if (a.type !== 'ident' && a.type !== 'keyword') throw cur.error('ожидался псевдоним после КАК', a);
        cur.next();
        alias = a.text;
        break;
      }
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    bodyTokens.push(cur.next());
  }
  if (bodyTokens.length === 0) throw cur.error('ожидалось поле табличной части', cur.peek());
  return { kind: 'expr', rawBody: sliceSource(cur.source, bodyTokens), alias };
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
      // Секции, идущие ПОСЛЕ списка полей (и обычно после `ИЗ`). При отсутствии
      // секции `ИЗ` (`ВЫБРАТЬ <константы> ГДЕ …`, частая форма union-ветки из
      // констант/параметров) читалка поля иначе проглотила бы `ГДЕ`/группировку/
      // порядок в выражение последнего поля. Эти ключевые слова не могут стоять на
      // верхнем уровне выражения элемента выборки — поэтому они граница (фаза 6.15.23).
      // Исключение: ключевое слово, используемое как ИМЯ ТАБЛИЦЫ/псевдонима в
      // точечной ссылке поля (`Итоги.Поле`, где `Итоги` совпадает с keyword `ИТОГИ`
      // регистронезависимо). Если за ним идёт `.`, это голова ссылки поля, а не
      // секция — границей не считаем (фаза 6.16).
      if (t.type === 'keyword' && (
        t.value === 'ГДЕ' || t.value === 'СГРУППИРОВАТЬ' || t.value === 'ИМЕЮЩИЕ' ||
        t.value === 'УПОРЯДОЧИТЬ' || t.value === 'ИТОГИ' || t.value === 'ИНДЕКСИРОВАТЬ' ||
        t.value === 'ОБЪЕДИНИТЬ' || t.value === 'ДЛЯ'
      ) && !cur.isPunct('.', 1)) break;
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

  // Неявный псевдоним (фаза 6.15.10): поле без `КАК`, тело которого оканчивается
  // голым идентификатором ПОСЛЕ завершённого первичного выражения
  // (`"" АльтернативныйПуть`, `Т.Поле Алиас`, `СУММА(Т.Поле) Итог`). В SDBL такой
  // хвостовой идентификатор — это псевдоним без `КАК`; конструктор печатает его как
  // `<выражение> КАК <Алиас>`. Снимаем хвостовой токен в `alias`, чтобы дальнейшая
  // интерпретация и рендер совпали с каноном. Подтверждено MCP-пробами validate_query.
  if (alias === undefined && bodyTokens.length >= 2 && depth === 0) {
    const last = bodyTokens[bodyTokens.length - 1];
    const prev = bodyTokens[bodyTokens.length - 2];
    // Хвостовой токен — голый идентификатор и НЕ зарезервированное слово
    // (`КОНЕЦ`, литералы, операторы, гранулярности периода), которое может быть
    // законным окончанием самого выражения (`ВЫБОР … КОНЕЦ`, `… ЕСТЬ NULL`).
    const lastIsBareName =
      last.type === 'ident' &&
      !last.value.startsWith('#') &&
      !EXPR_STOP_WORDS.has(last.value.toUpperCase());
    // Предыдущий токен должен ЗАВЕРШАТЬ первичное выражение: не `.` (тогда last —
    // сегмент пути) и не оператор/открывающая скобка/запятая (тогда выражение
    // неполно и last — его часть). Допустимые завершители: `)`, строковый/числовой/
    // датовый литерал, параметр &X, либо идентификатор/конец пути.
    const prevEndsPrimary =
      prev.type === 'string' ||
      prev.type === 'number' ||
      prev.type === 'date' ||
      prev.type === 'param' ||
      prev.type === 'ident' ||
      (prev.type === 'punct' && prev.value === ')');
    if (lastIsBareName && prevEndsPrimary) {
      alias = last.text;
      bodyTokens.pop();
    }
  }

  // Валидация: два ПРОСТЫХ идентификатора подряд в теле поля (`аа а.asdfa` — пробел
  // вместо точки/оператора) — некорректный SDBL. Сырой сбор тела (нужный для re-emit
  // сложных выражений) иначе молча принимал это и квалифицировал как путь. Ключевые
  // слова-операторы лексер отдаёт как ident (`ВЫБОР`/`КОГДА`/`И`/`ИЛИ`/`ЕСТЬ`/`NULL`…),
  // но они перечислены в EXPR_STOP_WORDS — пару с любым из них НЕ считаем ошибкой;
  // функция `СУММА(` — ident затем `(`; хвостовой псевдоним без КАК уже снят выше.
  for (let i = 0; i + 1 < bodyTokens.length; i++) {
    const a = bodyTokens[i];
    const b = bodyTokens[i + 1];
    if (
      a.type === 'ident' && b.type === 'ident' &&
      !EXPR_STOP_WORDS.has(a.value.toUpperCase()) &&
      !EXPR_STOP_WORDS.has(b.value.toUpperCase())
    ) {
      throw cur.error('два идентификатора подряд в элементе выборки (пропущены оператор или точка?)', b);
    }
  }

  // Хвостовой зарезервированный идентификатор-связка (`ССЫЛКА`/`ЕСТЬ`/`И`/`КАК`…),
  // стоящий самостоятельным токеном после завершённого первичного выражения, —
  // некорректное/незавершённое выражение: `Банки.Ссылка Ссылка` (где `Ссылка`=ССЫЛКА —
  // не может быть неявным псевдонимом), `Поле ЕСТЬ`, `Поле И`. Не путать с сегментом
  // пути (`Банки.Ссылка` — `Ссылка` идёт после `.`) и с допустимыми терминаторами
  // (`… КОНЕЦ`, `… ЕСТЬ NULL`). Проверено реальным 1С (validate_query).
  if (bodyTokens.length >= 2) {
    const last = bodyTokens[bodyTokens.length - 1];
    const prev = bodyTokens[bodyTokens.length - 2];
    const lastUp = last.type === 'ident' ? last.value.toUpperCase() : '';
    const lastIsConnector =
      last.type === 'ident' && EXPR_STOP_WORDS.has(lastUp) && !EXPR_TERMINATOR_WORDS.has(lastUp);
    const prevEndsPrimary =
      prev.type === 'string' || prev.type === 'number' || prev.type === 'date' ||
      prev.type === 'param' || prev.type === 'ident' ||
      (prev.type === 'punct' && prev.value === ')');
    if (lastIsConnector && prevEndsPrimary) {
      throw cur.error('некорректный элемент выборки: лишний идентификатор или незавершённое выражение', last);
    }
  }

  const rawBody = sliceSource(cur.source, bodyTokens);
  return { bodyTokens, alias, rawBody };
}

/** Резолвит сырую табличную часть в SelectedTabSectionField. */
function resolveTabSection(
  ts: RawTabSection,
  aliasToId: Map<string, string>,
  tables: SelectedTable[],
  aliasSpelling: Map<string, string>
): SelectedTabSectionField {
  const tableId = aliasToId.get(ts.tableAlias.toUpperCase()) ?? '';
  const table = tables.find(t => t.id === tableId);
  // tsFullName косметический (генератор использует только tsName и fields).
  const tsFullName = table ? `${table.fullName}.${ts.tsName}` : ts.tsName;

  // Проекция с головой-приведением (`ВЫРАЗИТЬ(…).<ТЧ>.(…)`): псевдонима таблицы нет,
  // колонки печатаются голыми (как разобраны), переквалификация не применяется.
  if (ts.castPrefix !== undefined) {
    const fields = ts.columns.map(c => (c.kind === 'field' ? c.field : c.rawBody));
    const fieldAliases = ts.columns.map(c => c.alias);
    const fieldAliasExplicit = ts.columns.map(c => (c.kind === 'field' ? c.aliasExplicit === true : false));
    return {
      tableId, tsName: ts.tsName, tsFullName, fields, alias: ts.alias, castPrefix: ts.castPrefix,
      ...(fieldAliases.some(a => a !== undefined) ? { fieldAliases } : {}),
      ...(fieldAliasExplicit.some(Boolean) ? { fieldAliasExplicit } : {}),
    };
  }

  const hasExpr = ts.columns.some(c => c.kind === 'expr');

  // Все объявленные псевдонимы таблиц — голову, совпадающую с ними, НЕ префиксуем
  // (это ссылка на саму таблицу/другой источник, а не на колонку ТЧ).
  const tableAliasUp = ts.tableAlias.toUpperCase();
  // Префикс переквалификации выражений: `<псевдонимТаблицы>.<ТЧ>`.
  const prefix = `${ts.tableAlias}.${ts.tsName}`;

  const columns: TabSectionColumn[] = ts.columns.map(c => {
    if (c.kind === 'field') return { kind: 'field', field: c.field, alias: c.alias, aliasExplicit: c.aliasExplicit };
    // Внутри выражения: голые ссылки на колонки ТЧ получают полный префикс
    // `<таблица>.<ТЧ>.`, уже квалифицированные/литералы/вызовы — без изменений.
    const expression = requalifyTabSectionExpr(c.rawBody, prefix, aliasSpelling, tableAliasUp, ts.tsName);
    return { kind: 'expr', expression, alias: c.alias };
  });

  // Обратная совместимость: `fields`/`fieldAliases` заполняем из ПРОСТЫХ колонок
  // (downstream-потребители без поддержки `columns`). Генератор предпочитает `columns`.
  const fields = ts.columns.filter(c => c.kind === 'field').map(c => (c as { field: string }).field);
  const fieldAliases = ts.columns.filter(c => c.kind === 'field').map(c => (c as { alias?: string }).alias);
  const fieldAliasExplicit = ts.columns
    .filter(c => c.kind === 'field')
    .map(c => (c as { aliasExplicit?: boolean }).aliasExplicit === true);
  const hasColAlias = fieldAliases.some(a => a !== undefined);
  const hasExplicit = fieldAliasExplicit.some(Boolean);

  return {
    tableId, tsName: ts.tsName, tsFullName, fields, alias: ts.alias,
    ...(hasColAlias ? { fieldAliases } : {}),
    ...(hasExplicit ? { fieldAliasExplicit } : {}),
    ...(hasExpr ? { columns } : {}),
  };
}

/**
 * Переквалификация голых ссылок внутри выражения-колонки проекции ТЧ. Каждая точечная
 * цепочка имён, голова которой НЕ объявленный псевдоним таблицы и НЕ голова текущей
 * ТЧ-проекции, получает префикс `<префикс>.` (= `<псевдонимТаблицы>.<ТЧ>.`). В отличие
 * от квалификации в подзапросе, префиксуются и многосегментные цепочки (`ЕдиницаИзмерения.
 * Коэффициент` → `<префикс>.ЕдиницаИзмерения.Коэффициент`): внутри проекции бесхозная
 * голова — это навигация по колонке ТЧ, не коррелированная ссылка. НЕ трогаются:
 * продолжения путей, вызовы функций, типы после `КАК`/`ССЫЛКА`, аргументы
 * `ЗНАЧЕНИЕ(…)`/`ТИП(…)`, подзапросы, стоп-слова и литералы (сверено с оракулом).
 */
function requalifyTabSectionExpr(
  rawBody: string,
  prefix: string,
  aliasSpelling: Map<string, string>,
  tableAliasUp: string,
  tsName: string
): string {
  const tokens = tokenize(rawBody).filter(t => t.type !== 'eof');
  if (tokens.length === 0) return rawBody;
  const edits: { pos: number; len: number; text: string }[] = [];
  let depth = 0;
  let skipUntilDepth: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') {
      depth++;
      if (skipUntilDepth === undefined &&
          tokens[i + 1]?.type === 'keyword' && tokens[i + 1].value === 'ВЫБРАТЬ') {
        skipUntilDepth = depth;
      }
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined) continue;
    if (!isNameToken(t)) continue;
    const up = t.text.toUpperCase();
    // ЗНАЧЕНИЕ(/ТИП( — путь метаданных, не поле.
    if ((up === 'ЗНАЧЕНИЕ' || up === 'ТИП') &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      skipUntilDepth = depth + 1;
      continue;
    }
    if (t.type !== 'ident') continue; // ключевые слова полями не бывают
    const prev = tokens[i - 1];
    if (prev && prev.type === 'punct' && prev.value === '.') continue; // продолжение пути
    const prevUp = prev && (prev.type === 'ident' || prev.type === 'keyword')
      ? prev.text.toUpperCase() : undefined;
    const skipChain = prevUp === 'КАК' || prevUp === 'ССЫЛКА' || EXPR_STOP_WORDS.has(up);
    // Конец точечной цепочки.
    let j = i;
    while (tokens[j + 1]?.type === 'punct' && tokens[j + 1].value === '.' && isNameToken(tokens[j + 2])) {
      j += 2;
    }
    const next = tokens[j + 1];
    const isCall = next !== undefined && next.type === 'punct' && next.value === '(';
    if (!skipChain && !isCall) {
      const declared = aliasSpelling.get(up);
      if (declared !== undefined || up === tableAliasUp) {
        // Уже квалифицировано псевдонимом таблицы — нормализуем написание, не префиксуем.
        const sp = declared ?? (up === tableAliasUp ? prefix.slice(0, prefix.indexOf('.')) : t.text);
        if (sp !== undefined && t.text !== sp) edits.push({ pos: t.pos, len: t.text.length, text: sp });
      } else if (up === tsName.toUpperCase()) {
        // Голова = имя ТЧ (самоссылка `<ТЧ>.поле`) — это уже путь от ТЧ; не префиксуем.
      } else {
        // Бесхозная голова — колонка ТЧ; префиксуем всю цепочку.
        edits.push({ pos: t.pos, len: 0, text: `${prefix}.` });
      }
    }
    i = j;
  }
  let out = '';
  let p = tokens[0].pos;
  for (const e of edits) {
    out += rawBody.slice(p, e.pos) + e.text;
    p = e.pos + e.len;
  }
  const last = tokens[tokens.length - 1];
  return out + rawBody.slice(p, last.pos + last.value.length);
}

/**
 * Удаляет однострочные комментарии `//…` из сырого текста, учитывая строковые
 * (`"…"` с экранированием `""`) и датовые (`'…'`) литералы — `//` внутри литерала
 * комментарием НЕ считается. Геометрию повторяем за оракулом 1С (который
 * вычищает ВСЕ комментарии из канонического текста):
 *  - строка-комментарий целиком (необязательные пробелы + `//…`) удаляется ВМЕСТЕ
 *    со своим переводом строки (соседние строки кода смыкаются);
 *  - хвостовой комментарий после кода (`код // …`) вырезается от `//` до конца
 *    строки, после чего обрезаются ставшие висячими пробелы перед ним.
 * Комментарии в 1С только однострочные.
 */
function stripLineComments(text: string): string {
  if (text.indexOf('//') === -1) return text;
  let inString = false;
  let inDate = false;
  let out = '';
  // Признак того, что в текущей (накапливаемой в `out`) строке был вырезан
  // комментарий — нужен, чтобы НЕ трогать исходно-пустые/пробельные строки.
  let strippedOnLine = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '"') {
        if (text[i + 1] === '"') { out += '"'; i++; } else { inString = false; }
      }
      continue;
    }
    if (inDate) {
      out += ch;
      if (ch === "'") inDate = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "'") { inDate = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      // Пропускаем до конца строки (не включая перевод строки).
      while (i < text.length && text[i] !== '\n') i++;
      i--; // компенсируем i++ в цикле; на следующей итерации обработаем `\n`/конец.
      strippedOnLine = true;
      continue;
    }
    if (ch === '\n') {
      if (strippedOnLine) {
        // Откатываем хвостовые пробелы строки перед вырезанным комментарием.
        const lineStart = out.lastIndexOf('\n') + 1;
        const line = out.slice(lineStart);
        if (line.trim() === '') {
          // Строка-комментарий целиком: удаляем её вместе с переводом строки.
          out = out.slice(0, lineStart);
        } else {
          // Хвостовой комментарий: обрезаем висячие пробелы перед `//`.
          out = out.slice(0, lineStart) + line.replace(/[ \t\r]+$/u, '') + '\n';
        }
      } else {
        out += ch;
      }
      strippedOnLine = false;
      continue;
    }
    out += ch;
  }
  // Последняя строка без завершающего перевода строки.
  if (strippedOnLine) {
    const lineStart = out.lastIndexOf('\n') + 1;
    const line = out.slice(lineStart);
    out = out.slice(0, lineStart) + line.replace(/[ \t\r]+$/u, '');
  }
  return out;
}

/** Сырой срез исходника по диапазону токенов тела. */
function sliceSource(source: string, bodyTokens: Token[]): string {
  const first = bodyTokens[0];
  const last = bodyTokens[bodyTokens.length - 1];
  const end = last.pos + last.value.length;
  return stripLineComments(source.slice(first.pos, end));
}

/** Псевдоним соединения до резолвинга (хранит псевдонимы вместо tableId). */
interface RawJoin {
  kind: 'ВНУТРЕННЕЕ' | 'ЛЕВОЕ' | 'ПРАВОЕ' | 'ПОЛНОЕ';
  /** Псевдоним затравочной (левой по тексту) таблицы. */
  seedAlias: string;
  /** Псевдоним присоединяемой (правой по тексту) таблицы. */
  joinedAlias: string;
  /** Псевдоним КОРНЯ цепочки соединений (для классификации стандарт/произвольное). */
  chainSeedAlias: string;
  /** Сырые токены условия после `ПО` (до следующего соединения/запятой/секции). */
  condTokens: Token[];
  condText: string;
  /** Глубина правовложенного дерева (0 — верхняя цепочка); см. Join.depth. */
  depth: number;
  /** Опциональное соединение построителя: всё соединение обёрнуто в `{…}`. */
  optional?: boolean;
  /**
   * Последнее опциональное соединение в своём блоке `{…}`. Один блок построителя
   * может содержать НЕСКОЛЬКО соединений (`{J1 ПО … J2 ПО …}`): `{` ставится перед
   * первым, `}` — после условия ПОСЛЕДНЕГО (фаза 6.16). Флаг помечает соединение,
   * на котором закрывается блок.
   */
  optionalLast?: boolean;
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
  // Предобъявление для взаимной рекурсии: соединение построителя `{…}` может
  // нести вложенную ПЛОСКУЮ цепочку обычных соединений, а обычное соединение —
  // блоки построителя ПЕРЕД своим `ПО` (корпус БЗК, фаза 6.16).
  let parseBuilderJoins: (rootSeedAlias: string, depth?: number) => void;

  const parseJoinChainFrom = (seedAlias: string, depth: number): void => {
    let lastAlias = seedAlias;
    while (isJoinKeyword(cur)) {
      const kind = consumeJoinKind(cur);
      const joinedSource = readSource();
      tables.push(joinedSource);
      const joinedHead = joinedSource.alias!;
      // ТЕКСТОВЫЙ порядок (преордер дерева, фаза 6.15.8): соединение пушится ДО
      // разбора вложенной подцепочки, условие дозаполняется после её дочитки.
      const raw: RawJoin = {
        kind,
        seedAlias: lastAlias,
        joinedAlias: joinedHead,
        // КОРЕНЬ цепочки (первая по тексту таблица): конструктор 1С при левоассоциа-
        // тивной цепочке считает СТАНДАРТНЫМ условие `<корень>.поле cmp <присоединяемая>.поле`,
        // а не `<предыдущая>.поле …`. Для классификации `ПО` (фаза 6.13) нужен корень,
        // тогда как порядок СЦЕПЛЕНИЯ (seedAlias) — предыдущая таблица. У вложенной
        // подцепочки корень — её собственная затравка (joinedHead).
        chainSeedAlias: seedAlias,
        condTokens: [],
        condText: '',
        depth,
      };
      joins.push(raw);
      // Вложенная цепочка присоединяемого источника (её `ПО` раньше нашего).
      if (isJoinKeyword(cur)) parseJoinChainFrom(joinedHead, depth + 1);
      // Блоки построителя (`{<вид> СОЕД … ПО …}`), привязанные к присоединяемому
      // источнику, идут ПЕРЕД его собственным `ПО` (динамические соединения
      // отчёта). Дочитываем их, затравка — присоединённая таблица; вложены на
      // уровень глубже текущего соединения, чтобы их `ПО` печатались до нашего.
      if (cur.isBuilderJoinStart()) parseBuilderJoins(joinedHead, depth + 1);
      cur.expectKeyword('ПО');
      const { tokens, text } = readJoinCondition(cur);
      raw.condTokens = tokens;
      raw.condText = text;
      // Левоассоциативность плоской цепочки: следующее `СОЕД` к последней таблице.
      lastAlias = joinedHead;
    }
  };

  /**
   * Опциональные соединения построителя отчётов (фаза 6.15.13): после основной
   * цепочки соединений конструктор пишет ДИНАМИЧЕСКИЕ соединения целиком в
   * фигурных скобках — `{<вид> СОЕДИНЕНИЕ <источник> ПО <условие>}`. Каждое такое
   * соединение самостоятельно (не левоассоциативно цепляется к предыдущему):
   * затравка/корень для классификации условия — КОРЕНЬ всей цепочки `ИЗ`
   * (`rootSeedAlias`), что соответствует стандартной форме `<корень>.поле cmp
   * <присоединяемая>.поле` без скобок (MCP-пробы).
   */
  parseBuilderJoins = (rootSeedAlias: string, depth = 0): void => {
    while (cur.isBuilderJoinStart()) {
      cur.expectPunct('{');
      // Один блок построителя `{…}` может нести НЕСКОЛЬКО соединений подряд
      // (`{<вид> СОЕД A ПО … <вид> СОЕД B ПО …}`): `{` уже снят, читаем соединения
      // до закрывающей `}`. Последнее помечаем `optionalLast` (фаза 6.16).
      do {
        const kind = consumeJoinKind(cur);
        const joinedSource = readSource();
        tables.push(joinedSource);
        const joinedHead = joinedSource.alias!;
        const raw: RawJoin = {
          kind,
          seedAlias: rootSeedAlias,
          joinedAlias: joinedHead,
          chainSeedAlias: rootSeedAlias,
          condTokens: [],
          condText: '',
          depth,
          optional: true,
        };
        joins.push(raw);
        // Присоединяемый источник блока построителя сам может нести вложенную
        // ПЛОСКУЮ цепочку обычных соединений (`{… СОЕД A СОЕД B ПО c_AB ПО c_root}`):
        // её `ПО` идут раньше нашего. Дочитываем рекурсивно до закрывающей `}`.
        if (isJoinKeyword(cur)) parseJoinChainFrom(joinedHead, depth + 1);
        cur.expectKeyword('ПО');
        const { tokens, text } = readJoinCondition(cur, /* stopOnBrace */ true);
        raw.condTokens = tokens;
        raw.condText = text;
      } while (isJoinKeyword(cur));
      cur.expectPunct('}');
      joins[joins.length - 1].optionalLast = true;
    }
  };

  // Обычные и построительные (`{…}`) соединения могут ЧЕРЕДОВАТЬСЯ за одним
  // источником: `A {ВНУТР СОЕД #X ПО …} ЛЕВОЕ СОЕД #Y ПО …` (корпус БЗК). Поэтому
  // дочитываем оба вида до стабилизации — пока хоть один потребляет токены, —
  // а не один раз каждый. Затравка обоих — КОРЕНЬ цепочки `ИЗ`.
  const parseAllJoinsFrom = (rootSeed: string): void => {
    while (isJoinKeyword(cur) || cur.isBuilderJoinStart()) {
      parseJoinChainFrom(rootSeed, 0);
      parseBuilderJoins(rootSeed);
    }
  };

  for (;;) {
    const seed = readSource();
    tables.push(seed);
    parseAllJoinsFrom(seed.alias!);
    if (cur.matchPunct(',')) {
      // Лишняя запятая ПЕРЕД соединением (`A, ЛЕВОЕ СОЕДИНЕНИЕ B`): оракул её
      // отбрасывает и трактует как соединение того же источника, а не отдельный
      // источник через запятую. Дочитываем цепочку соединений того же seed.
      if (isJoinKeyword(cur) || cur.isBuilderJoinStart()) {
        parseAllJoinsFrom(seed.alias!);
        if (cur.matchPunct(',')) continue;
        break;
      }
      continue;
    }
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
    // Резолвер пробрасываем внутрь подзапроса-источника, чтобы метаданные
    // (субконто/корр регистра бухгалтерии и т. п.) применялись и к виртуальным
    // таблицам, вложенным в `ИЗ (ВЫБРАТЬ … ИЗ РегистрБухгалтерии.X.Обороты(…))`.
    // Без этого раскладка позиций РБ оставалась с захардкоженным субконто, и
    // условие могло потеряться/сместиться (фаза 6.16.70).
    subquerySourceDepth++;
    let subquery: QueryDocument;
    try { subquery = parseDocument(innerText, sourceResolver); }
    finally { subquerySourceDepth--; }
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
  let aliasSynthesized = false;
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
    aliasSynthesized = true;
  }

  const table: SelectedTable = {
    id: 't' + index,
    fullName,
    alias,
  };
  if (aliasSynthesized) table.aliasSynthesized = true;
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
  // Голое `СОЕДИНЕНИЕ` без вида — 1С трактует как ВНУТРЕННЕЕ (inner join);
  // оракул рендерит его как `ВНУТРЕННЕЕ СОЕДИНЕНИЕ` (фаза 6.16).
  return t.type === 'keyword' && (JOIN_KEYWORDS.has(t.value) || t.value === 'СОЕДИНЕНИЕ');
}

/**
 * Снимает вид соединения (`ВНУТРЕННЕЕ`/`ЛЕВОЕ`/`ПРАВОЕ`/`ПОЛНОЕ`), опциональное
 * шумовое слово `ВНЕШНЕЕ` (1С допускает `ЛЕВОЕ ВНЕШНЕЕ СОЕДИНЕНИЕ`; конструктор его
 * отбрасывает — фаза 6.16) и обязательное `СОЕДИНЕНИЕ`. Возвращает вид соединения.
 * Голое `СОЕДИНЕНИЕ` без префикса вида — ВНУТРЕННЕЕ (inner join).
 */
function consumeJoinKind(cur: Cursor): RawJoin['kind'] {
  // Голое `СОЕДИНЕНИЕ` без вида: вид по умолчанию — ВНУТРЕННЕЕ, сам токен
  // `СОЕДИНЕНИЕ` снимется общим `expectKeyword` ниже.
  let kind: RawJoin['kind'];
  if (cur.peek().value === 'СОЕДИНЕНИЕ') {
    kind = 'ВНУТРЕННЕЕ';
  } else {
    kind = cur.next().value as RawJoin['kind'];
    // `ВНЕШНЕЕ` лексится как идентификатор (не ключевое слово) — снимаем, если стоит
    // перед `СОЕДИНЕНИЕ`.
    const t = cur.peek();
    if (t.type === 'ident' && t.value.toUpperCase() === 'ВНЕШНЕЕ') cur.next();
  }
  cur.expectKeyword('СОЕДИНЕНИЕ');
  return kind;
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
function readJoinCondition(cur: Cursor, stopOnBrace = false): { tokens: Token[]; text: string } {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && t.value === ',') break;
      if (t.type === 'punct' && t.value === ';') break;
      // Закрывающая `}` опционального соединения построителя завершает условие.
      if (stopOnBrace && t.type === 'punct' && t.value === '}') break;
      if (isJoinKeyword(cur)) break;
      // Ключевое слово-секция, использованное как ИМЯ ТАБЛИЦЫ/псевдонима в точечной
      // ссылке поля (`ИТОГИ.Ссылка`, где `ИТОГИ` совпадает с keyword `ИТОГИ`): если
      // за ним идёт `.`, это голова ссылки поля правого операнда сравнения, а не
      // начало секции — границей условия соединения не считаем (фаза 6.17).
      if (t.type === 'keyword' && JOIN_COND_STOP.has(t.value) && !cur.isPunct('.', 1)) break;
      // Блок построителя (`{ГДЕ …}` или `{<вид> СОЕДИНЕНИЕ …}` сразу после условия
      // ПО) — не часть условия.
      if (cur.isBuilderStart() || cur.isBuilderJoinStart()) break;
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
  // parseVirtualParams вызывается ТОЛЬКО когда во вводе была открывающая скобка —
  // значит скобки параметров присутствовали (даже пустые `(, )`). Конструктор 1С
  // сохраняет такие пустые скобки (фаза 6.16.8), поэтому фиксируем факт.
  v.hadParens = true;
  const set = (key: keyof VirtualParams, value: string): void => {
    if (value !== '') (v as Record<string, unknown>)[key] = value;
  };

  if (kind === 'РегистрБухгалтерии') {
    // Сырые аргументы сохраняем для пост-разбора по метаданным (субконто/корр):
    // на этом этапе резолвера нет, раскладку уточняем в parseDocument.
    v.accountingArgs = args;
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

/**
 * Раскладка позиций регистра бухгалтерии — инверсия `accountingPositions` через
 * единый `accountingPositionKeys`. На этапе разбора метаданных нет, поэтому
 * `hasSubconto=true` (прежняя захардкоженная арность); корреспонденцию для Обороты
 * выводим из числа аргументов (>=8). Точную раскладку по субконто/корр уточняет
 * пост-разбор `applyAccountingMeta` в `parseDocument` (фаза 6.16.11).
 */
function fillAccounting(
  v: VirtualParams,
  slice: string,
  args: string[],
  set: (key: keyof VirtualParams, value: string) => void
): void {
  const corr = slice === 'Обороты' && args.length >= 8;
  const keys = accountingPositionKeys(slice, true, corr);
  keys.forEach((k, i) => { if (k) set(k, arg(args, i)); });
  if (corr) v.correspondence = true;
}

/**
 * Разбор `( arg0, arg1, … )` в массив сырых строк-аргументов (по срезам
 * исходника). Аргумент может быть пустым (`''`) для пропущенной позиции.
 * Запятые верхнего уровня — разделители; вложенные группы `(…)` И `{…}` (СКД-блок
 * построителя с собственными запятыми и псевдонимами `КАК`) считаются
 * сбалансированными — запятые внутри них НЕ дробят аргумент (фаза 6.16).
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
    if (t.type === 'punct' && (t.value === '(' || t.value === '{')) depth++;
    else if (t.type === 'punct' && (t.value === ')' || t.value === '}')) depth--;
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
  resolveOwner: OwnerResolver,
  tableFullNames: Map<string, string>
): void {
  // Голое поле (фаза 6.12, расширено 6.15.4): разработчик не квалифицировал поле
  // псевдонимом таблицы (`ВЫБРАТЬ Ссылка ИЗ … КАК Т`, `ВЫБРАТЬ Валюта.Код` при
  // голове-НЕпсевдониме). Конструктор 1С квалифицирует его таблицей-владельцем
  // (единственный источник либо таблица с квалифицированным вхождением поля) и
  // автоалиасит последним сегментом пути (`Т.Ссылка КАК Ссылка`). Делаем это
  // ДО короткого замыкания на `Поле{n}`, т.к. конструктор переалиасит даже
  // явно написанный разработчиком `КАК Поле1` (`Код КАК Поле1` → `Т.Код КАК Код`).
  // Безопасно: bare-проверка требует чистый точечный путь без скобок, поэтому
  // агрегато-образные выражения `СУММА(Алиас.Поле) КАК Поле1` сюда не попадают.
  {
    const bare = tryBareField(rf.bodyTokens, aliasToId);
    const owner = bare ? resolveOwner(bare.head) : undefined;
    if (bare && owner !== undefined) {
      const path = stripOwnerFullName(bare.path, tableFullNames.get(owner));
      const field: SelectedField = { tableId: owner, path };
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
    else {
      // Явно написанный `Поле{n}` конструктор СОХРАНЯЕТ ДОСЛОВНО (MCP-проба:
      // `… КАК Поле5` остаётся `Поле5`, а синтезируемый позиционный счётчик его
      // НЕ занимает). Кладём в alias (тогда счётчик `Поле{n}` его пропускает —
      // assignExpressionFieldAliases трогает только поля без alias) и помечаем
      // `exprAliasExplicit`, чтобы в suppress-контексте `В (ВЫБРАТЬ …)` он сохранялся
      // (в отличие от синтезированного, который под подавлением снимается).
      field.alias = rf.alias;
      field.exprAliasExplicit = rf.alias;
    }
    fields.push(field);
    return;
  }

  // 1) Попытка агрегата.
  const agg = tryAggregate(rf.bodyTokens, aliasToId, resolveOwner, tableFullNames);
  if (agg) {
    const field: SelectedField = { tableId: agg.tableId, path: agg.path, func: agg.func };
    if (agg.operandQualified) field.funcOperandQualified = true;
    if (rf.alias !== undefined) field.alias = rf.alias;
    fields.push(field);
    aggregates.push({ tableId: agg.tableId, path: agg.path, func: agg.func });
    return;
  }

  // 2) Попытка простого поля <alias>.<path>.
  const simple = trySimpleField(rf.bodyTokens, aliasToId);
  if (simple) {
    // Поле явно квалифицировано псевдонимом таблицы — помечаем для синтеза
    // автопсевдонима склейкой сегментов пути (см. SelectedField.qualified).
    const field: SelectedField = { tableId: simple.tableId, path: simple.path, qualified: true };
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
  /** Операнд агрегата был ЯВНО квалифицирован псевдонимом (`СУММА(Алиас.Путь)`). */
  operandQualified?: boolean;
}

/** Разбор `<ФУНК>( [РАЗЛИЧНЫЕ] <alias>.<path> )`. */
function tryAggregate(
  body: Token[],
  aliasToId: Map<string, string>,
  resolveOwner: OwnerResolver,
  tableFullNames: Map<string, string>
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
  if (ref) return { tableId: ref.tableId, path: ref.path, func, operandQualified: true };
  // Голое поле внутри агрегата (`МИНИМУМ(ДатаЗаписи)` → `МИНИМУМ(Т.ДатаЗаписи)`,
  // `МАКСИМУМ(Валюта.Наименование)` при голове-НЕпсевдониме): аргумент — чистый
  // точечный путь без квалификации. Конструктор 1С квалифицирует его таблицей-
  // владельцем (фаза 6.15.4).
  const bare = tryBareField(inner, aliasToId);
  if (bare) {
    const owner = resolveOwner(bare.head);
    if (owner !== undefined) return { tableId: owner, path: stripOwnerFullName(bare.path, tableFullNames.get(owner)), func };
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
  const tableId = aliasToId.get(aliasName.toUpperCase());
  if (tableId === undefined) return undefined;
  const path = segs.slice(1).join('.');
  /* v8 ignore next -- недостижимо: tokens.length>=3 и нечётно ⇒ segs>=2 ⇒ path непуст */
  if (!path) return undefined;
  return { tableId, path };
}

/** Токен-имя: идентификатор или ключевое слово (сегмент пути / голова цепочки). */
function isNameToken(t: Token | undefined): boolean {
  return t !== undefined && (t.type === 'ident' || t.type === 'keyword');
}

/** Единственный источник запроса (для квалификации голых полей, фаза 6.12). */
interface SoleSource {
  id: string;
  alias: string;
  /** Полное имя источника-таблицы (`Документ.ДокументЭДОБЗК`) — для снятия его
   * ведущего префикса из голого пути поля (`Документ.ДокументЭДОБЗК.Поле` → `Поле`). */
  fullName?: string;
}

/**
 * Резолвер владельца голого поля по его голове (первому сегменту пути):
 * tableId таблицы-владельца либо undefined (квалифицировать нельзя).
 */
type OwnerResolver = (head: string) => string | undefined;

/**
 * Карта «поле (ВЕРХНИЙ регистр) → таблицы, у которых оно встречается в тексте
 * запроса квалифицированным» (`<псевдоним>.<поле>`). Голова цепочки — токен-имя,
 * НЕ являющийся продолжением пути (перед ним нет `.`). Зоны подзапросов
 * `(ВЫБРАТЬ …)` пропускаются: у них свой контекст псевдонимов, и внутренний
 * псевдоним, совпадающий по имени с внешним, иначе ошибочно зачислял бы поле
 * внешней таблице. Фаза 6.15.4 (MCP): по этой карте резолвится таблица-владелец
 * голого поля в многоисточниковом запросе.
 */
function buildFieldOwnerScan(
  tokens: readonly Token[],
  aliasToId: Map<string, string>
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  let depth = 0;
  // Глубина, ниже которой заканчивается зона пропуска подзапроса `(ВЫБРАТЬ …)`.
  let skipUntilDepth: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') {
      depth++;
      if (skipUntilDepth === undefined &&
          tokens[i + 1]?.type === 'keyword' && tokens[i + 1].value === 'ВЫБРАТЬ') {
        skipUntilDepth = depth;
      }
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined) continue;
    if (!isNameToken(t)) continue;
    const prev = tokens[i - 1];
    if (prev && prev.type === 'punct' && prev.value === '.') continue; // продолжение пути
    const dot = tokens[i + 1];
    const field = tokens[i + 2];
    if (!dot || !field) continue;
    if (!(dot.type === 'punct' && dot.value === '.') || !isNameToken(field)) continue;
    const tableId = aliasToId.get(t.text.toUpperCase());
    if (tableId === undefined) continue;
    const key = field.text.toUpperCase();
    const set = map.get(key) ?? new Set<string>();
    set.add(tableId);
    map.set(key, set);
  }
  return map;
}

/**
 * Единственный ли это источник, к которому можно безопасно (без метаинформации
 * схемы) привязать голое поле: ровно одна таблица в `ИЗ`, без соединений и с
 * непустым псевдонимом. Многоисточниковые запросы требуют реальной схемы — здесь
 * не трогаются.
 *
 * Источник-подзапрос (`ИЗ (ВЫБРАТЬ …) КАК Выборка`) тоже годится (фаза 6.15.NN,
 * MCP): конструктор 1С квалифицирует внешние голые поля псевдонимом подзапроса
 * (`ВариантДампа` → `Выборка.ВариантДампа КАК ВариантДампа`) — выходные колонки
 * подзапроса видны как поля его псевдонима.
 */
function soleSourceOf(tables: SelectedTable[], joins: RawJoin[]): SoleSource | undefined {
  if (joins.length > 0) return undefined;
  if (tables.length !== 1) return undefined;
  const t = tables[0];
  if (!t.alias) return undefined;
  return { id: t.id, alias: t.alias, fullName: t.fullName };
}

/** Литералы-значения, которые НЕ являются голыми полями (одиночный токен). */
const LITERAL_VALUES = new Set(['НЕОПРЕДЕЛЕНО', 'ИСТИНА', 'ЛОЖЬ', 'NULL']);

/**
 * Голое поле = чистый точечный путь идентификаторов (`Ссылка`, `Владелец.Код`),
 * который разработчик НЕ квалифицировал псевдонимом источника. Возвращает path и
 * голову (первый сегмент), если тело — такой путь, его голова не является известным
 * псевдонимом таблицы (регистронезависимо) и это не литерал-значение. Иначе
 * undefined (тогда поле трактуется как раньше: простое/агрегат/выражение).
 */
function tryBareField(
  tokens: Token[],
  aliasToId: Map<string, string>
): { path: string; head: string } | undefined {
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
  // Уже квалифицировано псевдонимом известной таблицы — не голое.
  if (aliasToId.has(head.toUpperCase())) return undefined;
  // Литерал-значение из одного сегмента (НЕОПРЕДЕЛЕНО/ИСТИНА/ЛОЖЬ/NULL).
  if (segs.length === 1 && LITERAL_VALUES.has(head.toUpperCase())) return undefined;
  return { path: segs.join('.'), head };
}

/**
 * Снять ведущий префикс полного имени таблицы-владельца из голого пути поля:
 * `Справочник.Валюты.Ссылка` при владельце `Справочник.Валюты` → `Ссылка`.
 * Конструктор 1С трактует ведущие сегменты, дословно равные полному имени таблицы
 * источника, как ссылку НА таблицу, а не часть пути поля, и печатает её через
 * псевдоним (`Валюты.Ссылка КАК Ссылка`). Срабатывает только на точном совпадении
 * `<fullName>.` (две и более частей), поэтому вложенные ссылки `Алиас.Владелец.Код`
 * не затрагиваются. Регистронезависимо.
 */
function stripOwnerFullName(path: string, fullName: string | undefined): string {
  if (!fullName || !fullName.includes('.')) return path;
  const prefix = fullName + '.';
  return path.toUpperCase().startsWith(prefix.toUpperCase()) ? path.slice(prefix.length) : path;
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
  const bare = tryBareField(lhs, aliasToId);
  if (!bare) return undefined;
  // Ведущие сегменты, дословно равные полному имени источника-таблицы
  // (`Документ.ДокументЭДОБЗК.Поле`), — это ссылка НА таблицу, а не часть пути поля:
  // снимаем их (генератор печатает `<псевдоним>.<остаток>`, иначе была бы двойная
  // квалификация `Документ.ДокументЭДОБЗК.Документ.ДокументЭДОБЗК.Поле`).
  return { tableId: soleSource.id, path: stripOwnerFullName(bare.path, soleSource.fullName) };
}

// ───────────────────────────── ГДЕ (WHERE) ─────────────────────────────

/**
 * Слова, которые в выражении условия НЕ являются головой голого поля:
 * операторы/структура (И/ИЛИ/НЕ/В/ВЫБОР…), литералы-значения, интервалы дат
 * (аргументы РАЗНОСТЬДАТ/ДОБАВИТЬКДАТЕ/НАЧАЛОПЕРИОДА), модификаторы.
 */
const EXPR_STOP_WORDS = new Set<string>([
  'И', 'ИЛИ', 'НЕ', 'В', 'МЕЖДУ', 'ПОДОБНО', 'ЕСТЬ', 'СПЕЦСИМВОЛ',
  'NULL', 'ИСТИНА', 'ЛОЖЬ', 'НЕОПРЕДЕЛЕНО',
  'ИЕРАРХИИ', 'ИЕРАРХИЯ', 'УБЫВ', 'ВОЗР', 'РАЗЛИЧНЫЕ', 'КАК', 'ССЫЛКА',
  'ВЫБОР', 'КОГДА', 'ТОГДА', 'ИНАЧЕ', 'КОНЕЦ',
  'ГОД', 'КВАРТАЛ', 'МЕСЯЦ', 'ДЕКАДА', 'НЕДЕЛЯ', 'ДЕНЬ', 'ЧАС', 'МИНУТА', 'СЕКУНДА',
]);

/**
 * Подмножество EXPR_STOP_WORDS, которым ВЫРАЖЕНИЕ может законно ОКАНЧИВАТЬСЯ
 * (литералы и `КОНЕЦ` блока `ВЫБОР`). Остальные стоп-слова — связки/операторы
 * (`ССЫЛКА`, `ЕСТЬ`, `И`, `КАК`, гранулярности периода…), которые НЕ могут стоять
 * самостоятельным хвостовым токеном после завершённого первичного выражения.
 */
const EXPR_TERMINATOR_WORDS = new Set<string>([
  'NULL', 'ИСТИНА', 'ЛОЖЬ', 'НЕОПРЕДЕЛЕНО', 'КОНЕЦ',
]);

/**
 * Квалификация голых полей внутри произвольного выражения условия при
 * единственном источнике (фаза 6.15.4, MCP): каждая точечная цепочка имён,
 * голова которой не псевдоним таблицы, получает префикс `<псевдоним>.`;
 * написание уже квалифицированных голов нормализуется к объявленному
 * (`Таб.Ссылка` → `ТАБ.Ссылка`). При `soleAlias === undefined` (несколько
 * источников) выполняется ТОЛЬКО нормализация написания псевдонимов.
 * НЕ трогаются: продолжения путей, вызовы функций (`ИМЯ(`), типы после
 * `КАК`/`ССЫЛКА` (ВЫРАЗИТЬ/уточнение типа), аргументы `ЗНАЧЕНИЕ(…)`/`ТИП(…)`
 * (пути метаданных), стоп-слова и литералы.
 */
function qualifyBareFieldsInExpression(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>,
  aliasSpelling: Map<string, string>,
  soleAlias: string | undefined
): string {
  const edits: { pos: number; len: number; text: string }[] = [];
  let depth = 0;
  // Глубина, ниже которой заканчивается зона пропуска ЗНАЧЕНИЕ(…)/ТИП(…)/подзапроса.
  let skipUntilDepth: number | undefined;
  // Глубина фигурных скобок блоков построителя `{…}` — внутри не квалифицируем.
  let braceDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '{') { braceDepth++; continue; }
    if (t.type === 'punct' && t.value === '}') { braceDepth--; continue; }
    if (t.type === 'punct' && t.value === '(') {
      depth++;
      // Подзапрос `(ВЫБРАТЬ …)` — свой контекст псевдонимов, не трогаем.
      if (skipUntilDepth === undefined &&
          tokens[i + 1]?.type === 'keyword' && tokens[i + 1].value === 'ВЫБРАТЬ') {
        skipUntilDepth = depth;
      }
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (skipUntilDepth !== undefined && depth < skipUntilDepth) skipUntilDepth = undefined;
      continue;
    }
    if (skipUntilDepth !== undefined || braceDepth > 0) continue;
    if (!isNameToken(t)) continue;
    const up = t.text.toUpperCase();
    // ЗНАЧЕНИЕ(/ТИП( — внутри пути метаданных, не поля.
    if ((up === 'ЗНАЧЕНИЕ' || up === 'ТИП') &&
        tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
      skipUntilDepth = depth + 1;
      continue;
    }
    // Кандидат — только ident: ключевые слова (ВЫБРАТЬ/ИЗ/ГДЕ/…) полями не бывают.
    if (t.type !== 'ident') continue;
    const prev = tokens[i - 1];
    if (prev && prev.type === 'punct' && prev.value === '.') continue; // продолжение пути
    // Тип после КАК (ВЫРАЗИТЬ … КАК Справочник.X) или ССЫЛКА — пропустить цепочку.
    const prevUp = prev && (prev.type === 'ident' || prev.type === 'keyword')
      ? prev.text.toUpperCase()
      : undefined;
    const skipChain = prevUp === 'КАК' || prevUp === 'ССЫЛКА' || EXPR_STOP_WORDS.has(up);
    // Конец точечной цепочки от текущего имени.
    let j = i;
    while (tokens[j + 1]?.type === 'punct' && tokens[j + 1].value === '.' && isNameToken(tokens[j + 2])) {
      j += 2;
    }
    const next = tokens[j + 1];
    const isCall = next !== undefined && next.type === 'punct' && next.value === '(';
    if (!skipChain && !isCall) {
      const declared = aliasSpelling.get(up);
      if (declared !== undefined) {
        // Уже квалифицировано — нормализуем написание псевдонима.
        if (t.text !== declared) edits.push({ pos: t.pos, len: t.text.length, text: declared });
      } else if (soleAlias !== undefined && j === i) {
        // Квалифицируем псевдонимом источника ТОЛЬКО ОДНОСЕГМЕНТНОЕ голое имя
        // (`Код` → `Алиас.Код`). Многосегментная цепочка с НЕобъявленной головой
        // (`Регионы.КодСубъектаРФ`) — коррелированная ссылка на внешнюю таблицу:
        // оставляем как есть, иначе сломали бы коррелированный подзапрос (фаза 6.15.27).
        edits.push({ pos: t.pos, len: 0, text: `${soleAlias}.` });
      }
    }
    i = j;
  }
  const start = tokens[0].pos;
  const last = tokens[tokens.length - 1];
  const end = last.pos + last.value.length;
  let out = '';
  let p = start;
  for (const e of edits) {
    out += source.slice(p, e.pos) + e.text;
    p = e.pos + e.len;
  }
  return out + source.slice(p, end);
}

/** Множество токенов-операторов сравнения для условий. */
const COND_OPERATORS = new Set<string>(['=', '<>', '>', '>=', '<', '<=', 'В', 'МЕЖДУ', 'ПОДОБНО']);

/**
 * Секция ГДЕ. Инвертирует `renderConditions`: первое условие, затем каждое
 * последующее после `И` верхнего уровня. Каждый сегмент пытается распознаться как
 * простое условие `<alias>.<path> <op> <param>`; иначе — произвольное (`custom`).
 */
function parseWhere(
  cur: Cursor,
  aliasToId: Map<string, string>,
  soleSource?: SoleSource,
  aliasSpelling?: Map<string, string>
): Condition[] {
  cur.expectKeyword('ГДЕ');
  const source = cur.source;
  const segments = splitConditionSegments(cur, WHERE_STOP);
  return segments.map(seg => interpretCondition(seg, source, aliasToId, soleSource, aliasSpelling));
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
 * Разбивает поток токенов условий на сегменты-условия списка ГДЕ/ИМЕЮЩИЕ (фаза 6.14).
 * Конструктор 1С моделирует секцию как СПИСОК условий, соединённых `И`:
 *   - голое верхнеуровневое `ИЛИ` (вне скобок) объединяет ВСЮ секцию в одно условие
 *     (`И` связывает сильнее `ИЛИ`, поэтому `a ИЛИ b И c` — одно ИЛИ-выражение);
 *   - иначе поток бьётся по верхнеуровневым `И`, и каждая скобочная группа БЕЗ
 *     внутреннего верхнеуровневого `ИЛИ` сплющивается в список рекурсивно
 *     (скобки сохраняются только у блока, содержащего `ИЛИ`).
 */
function splitConditionSegments(cur: Cursor, stop: Set<string>): Token[][] {
  const tokens = collectConditionTokens(cur, stop);
  return segmentConditionTokens(tokens);
}

/**
 * Собирает все токены секции условий до стоп-слова верхнего уровня (вне скобок и
 * вне `ВЫБОР … КОНЕЦ`) или конца текста. Разделители `И` остаются в потоке —
 * сегментация выполняется отдельно (`segmentConditionTokens`).
 */
function collectConditionTokens(cur: Cursor, stop: Set<string>): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  // Глубина ВЫБОР … КОНЕЦ: стоп-слово внутри значения ТОГДА/ИНАЧЕ оператора ВЫБОР
  // не завершает секцию (всё выражение ВЫБОР — часть условия).
  let caseDepth = 0;
  const isIdentWord = (t: Token, w: string): boolean =>
    (t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === w;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0 && caseDepth === 0 && t.type === 'keyword' && stop.has(t.value)) break;
    // Блок построителя (`{ГДЕ …}` после статического ГДЕ) — не часть условия
    // (фаза 6.15.7; раньше заглатывался в текст последнего условия дословно).
    if (depth === 0 && caseDepth === 0 && cur.isBuilderStart()) break;
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (isIdentWord(t, 'ВЫБОР')) caseDepth++;
    else if (isIdentWord(t, 'КОНЕЦ') && caseDepth > 0) caseDepth--;
    tokens.push(cur.next());
  }
  return tokens;
}

/** Есть ли в потоке верхнеуровневое `ИЛИ` (вне скобок и вне `ВЫБОР … КОНЕЦ`). */
function hasTopLevelOr(tokens: Token[]): boolean {
  let depth = 0;
  let caseDepth = 0;
  const isIdentWord = (t: Token, w: string): boolean =>
    (t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === w;
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (isIdentWord(t, 'ВЫБОР')) caseDepth++;
    else if (isIdentWord(t, 'КОНЕЦ') && caseDepth > 0) caseDepth--;
    else if (depth === 0 && caseDepth === 0 && isIdentWord(t, 'ИЛИ')) return true;
  }
  return false;
}

/**
 * Сегментация потока токенов условий по правилам конструктора (фаза 6.14, MCP):
 *   1. голое верхнеуровневое `ИЛИ` → весь поток ОДНО условие (произвольный блок,
 *      генератор обернёт его в скобки);
 *   2. иначе деление по верхнеуровневым `И` (`splitJoinConjuncts`: учёт скобок,
 *      `ВЫБОР … КОНЕЦ`, `МЕЖДУ a И b`);
 *   3. сегмент — сбалансированная скобочная группа БЕЗ внутреннего верхнеуровневого
 *      `ИЛИ` → скобки снимаются, содержимое сегментируется рекурсивно (И-сплющивание;
 *      работает и для одиночного условия в скобках: `(a = &П)` → `a = &П`).
 * Группа С внутренним `ИЛИ` сохраняется целиком (скобки — признак ИЛИ-блока).
 * НЕ-блок (`НЕ (…)`) не начинается со скобки и потому не сплющивается.
 */
function segmentConditionTokens(tokens: Token[]): Token[][] {
  if (hasTopLevelOr(tokens)) return tokens.length > 0 ? [tokens] : [];
  const out: Token[][] = [];
  for (const seg of splitJoinConjuncts(tokens)) {
    if (hasBalancedOuterParens(seg)) {
      const inner = seg.slice(1, -1);
      if (inner.length > 0 && !hasTopLevelOr(inner)) {
        out.push(...segmentConditionTokens(inner));
        continue;
      }
    }
    out.push(seg);
  }
  return out;
}

/** Интерпретирует один сегмент условия: простое или произвольное. */
function interpretCondition(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>,
  soleSource?: SoleSource,
  aliasSpelling?: Map<string, string>
): Condition {
  // Голое поле-условие при единственном источнике (`ГДЕ Предопределенный` →
  // `ГДЕ Т.Предопределенный`): весь сегмент — чистый точечный путь без оператора,
  // голова не псевдоним источника. Квалифицируем как произвольное выражение
  // `<псевдоним>.<path>` (генератор рендерит произвольные условия дословно).
  if (soleSource) {
    const bare = tryBareField(tokens, aliasToId);
    if (bare) {
      return { custom: true, expression: `${soleSource.alias}.${bare.path}` };
    }
    // Отрицание голого поля при единственном источнике (`ГДЕ НЕ ПометкаУдаления` →
    // `ГДЕ НЕ Т.ПометкаУдаления`): первый токен — `НЕ`, остаток — чистый точечный
    // путь без квалификации. Конструктор 1С квалифицирует поле под `НЕ`.
    if (tokens.length > 1 && isNotToken(tokens[0])) {
      const negBare = tryBareField(tokens.slice(1), aliasToId);
      if (negBare) {
        return { custom: true, expression: `НЕ ${soleSource.alias}.${negBare.path}` };
      }
    }
  }
  // Произвольный текст условия: при единственном источнике голые поля внутри
  // выражения квалифицируются его псевдонимом (фаза 6.15.4, MCP: `(Код = &Код
  // ИЛИ …)` → `(Т.Код = &Код ИЛИ …)`), написание псевдонимов нормализуется
  // к объявленному. Без единственного источника — дословный срез, как раньше.
  const customText = (): string =>
    soleSource && aliasSpelling
      ? qualifyBareFieldsInExpression(tokens, source, aliasToId, aliasSpelling, soleSource.alias)
      : sliceSource(source, tokens);
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
  // Объединённый ИЛИ-блок (фаза 6.14): сегмент с верхнеуровневым `ИЛИ` — всегда
  // произвольное условие целиком. Без этой проверки trySimpleCondition «съедал» бы
  // хвост `… ИЛИ …` в param простого условия (`a = ЛОЖЬ ИЛИ &П` → param `ЛОЖЬ ИЛИ &П`).
  if (hasTopLevelOr(tokens)) {
    return { custom: true, expression: customText() };
  }
  // Отрицание условия-подзапроса (`НЕ <поле> В [ИЕРАРХИИ] (ВЫБРАТЬ …)`): снимаем
  // ведущее `НЕ`, разбираем остаток как условие-подзапрос, помечаем negated —
  // генератор печатает `НЕ ` и сдвигает блок подзапроса (фаза 6.15.NN). Только
  // для подзапросного результата; обычные негативы остаются произвольным текстом.
  if (tokens.length > 1 && isNotToken(tokens[0])) {
    const inner = trySimpleCondition(tokens.slice(1), source, aliasToId, soleSource, aliasSpelling);
    if (inner && inner.subquery) return { ...inner, negated: true };
  }
  const simple = trySimpleCondition(tokens, source, aliasToId, soleSource, aliasSpelling);
  if (simple) return simple;
  return { custom: true, expression: customText() };
}

/**
 * Простое условие `<alias>.<path> <op> <param>`: ссылка на поле, оператор сравнения,
 * затем остаток. СТАНДАРТНЫМ (галочка «Произвольное» снята) условие остаётся только
 * когда справа ПАРАМЕТР — то, что задаётся мышкой в редакторе условия (фаза 6.14.4):
 * `= &П` · `В(&П)` / `В ИЕРАРХИИ(&П)` · `МЕЖДУ &а И &б` · `ПОДОБНО &Ш`. Литерал,
 * ЗНАЧЕНИЕ(…), список, поле или подзапрос справа мышкой не задать — условие помечается
 * custom; его expression строится ТЕМ ЖЕ рендером, что у стандартного пути генератора
 * (`renderOperatorRhs`), поэтому текст запроса не меняется ни на байт. Возвращает
 * undefined, если структура не подходит (тогда сегмент — произвольное выражение).
 */
function trySimpleCondition(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>,
  soleSource?: SoleSource,
  aliasSpelling?: Map<string, string>
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
  const direct = parseFieldRef(lhs, aliasToId);
  const ref = direct
    ?? (soleSource
      ? bareLhsRef(lhs, aliasToId, soleSource)
      : undefined);

  // УЗКИЙ случай (фаза 6.15.27): нессылочный левый операнд `В`-подзапроса
  // (`1 В (ВЫБРАТЬ …)`, литерал/выражение) при КОМПАКТНОМ МНОГОВЕТОЧНОМ подзапросе.
  // Конструктор 1С разворачивает такой подзапрос канонически (структурный путь
  // `renderConditionSubquery`), тогда как текстовый ре-флоу не может его
  // канонизировать (не квалифицирует голые поля источника). Триггер намеренно узок:
  //   • LHS не ссылка на поле (ref отсутствует) — `ИСТИНА В`/`ЛОЖЬ В`/`&П В` сюда
  //     тоже попадают, поэтому …
  //   • подзапрос задан КОМПАКТНО (строка с `ВЫБРАТЬ … ИЗ` вместе) — уже принятые
  //     `ИСТИНА В`/`ЛОЖЬ В` написаны канонически (по строкам) и сюда НЕ попадают;
  //   • подзапрос МНОГОВЕТОЧНЫЙ (`ОБЪЕДИНИТЬ`, members > 1).
  // Подтверждено по корпусу: единственный файл с компактным В-подзапросом —
  // АдресныйКлассификатор; принятые формы остаются на прежнем (текстовом) пути.
  if (!ref) {
    const opTok = tokens[opIdx].value;
    if (opTok === 'В') {
      const subTokens = tokens.slice(opIdx + 1);
      const inner = subqueryInnerText(subTokens, source);
      // Канонически набранный (НЕ компактный) подзапрос-операнд с нессылочным LHS
      // обычно уже байт-в-байт на текстовом пути (равномерный сдвиг) — НЕ трогаем.
      // ИСКЛЮЧЕНИЕ (фаза 6.16): тело содержит ИМЕЮЩИЕ, чья корневая ИЛИ-цепочка обёрнута
      // в ИЗБЫТОЧНЫЕ внешние скобки (`ИМЕЮЩИЕ\n\t(A И B)\n\tИЛИ (C И D)`). Текстовый
      // путь скобки СОХРАНЯЕТ, а конструктор 1С их снимает (внутри подзапроса-операнда,
      // в отличие от ИМЕЮЩИЕ верхнего уровня) — расхождение. Разворачиваем структурно
      // (renderConditionSubquery), где formatExpression снимает обёртку байт-в-байт.
      if (inner !== undefined && (isCompactSubquerySource(inner) || hasRedundantHavingOrParens(inner))) {
        const sub = trySubqueryParam(subTokens, source);
        // Компактный подзапрос (`ВЫБРАТЬ … ИЗ` на одной строке) с нессылочным LHS
        // конструктор разворачивает структурно по строкам. Одноветочный подзапрос
        // тоже (фаза 6.16.71): прежний гейт `members > 1` оставлял одноветочные на
        // текстовом пути (плоский `1 В (ВЫБРАТЬ …)`). Канонические `ИСТИНА В`/`ЛОЖЬ В`
        // записаны НЕ компактно и сюда по-прежнему не попадают.
        if (sub) {
          return { custom: true, leftExpr: sliceSource(source, lhs), subquery: sub };
        }
      }
    }
    return undefined;
  }

  const op = tokens[opIdx].value as ConditionOperator;
  const paramTokens = tokens.slice(opIdx + 1);
  /* v8 ignore next -- недостижимо: opIdx<tokens.length-1 (см. выше) ⇒ срез непуст */
  if (paramTokens.length === 0) return undefined;
  const param = sliceSource(source, paramTokens);
  const base = { tableId: ref.tableId, path: ref.path, operator: op, param };

  // Правый операнд `В` — подзапрос `(ВЫБРАТЬ …)`: ровно одна сбалансированная
  // внешняя пара скобок, начинающаяся с ВЫБРАТЬ, без хвостовых токенов. Разбираем
  // внутренний запрос в модель — генератор разнесёт его по строкам, как конструктор.
  // Мышкой подзапрос не задать ⇒ custom (галочка «Произвольное»); expression НЕ
  // задаём — рендер остаётся структурным (многострочный перенос подзапроса).
  if (op === 'В') {
    // Модификатор `ИЕРАРХИИ` перед подзапросом (`В ИЕРАРХИИ (ВЫБРАТЬ …)`):
    // отделяем его, разбираем подзапрос, помечаем флагом hierarchy (фаза 6.15.NN).
    let subTokens = paramTokens;
    let hierarchy = false;
    const head = subTokens[0];
    if (head && (head.type === 'ident' || head.type === 'keyword') &&
        head.text.toUpperCase() === 'ИЕРАРХИИ') {
      subTokens = subTokens.slice(1);
      hierarchy = true;
    }
    const sub = trySubqueryParam(subTokens, source);
    if (sub) {
      return { custom: true, ...base, subquery: sub, ...(hierarchy ? { hierarchy: true } : {}) };
    }
  }

  if (isParamRhs(op, paramTokens)) {
    return { custom: false, ...base };
  }

  // Не-параметр справа → «Произвольное». Псевдоним LHS: при прямом совпадении —
  // ОБЪЯВЛЕННОЕ написание (`Таб` → `ТАБ`, идентификаторы регистронезависимы, как
  // отдал бы `aliases.get(tableId)` в генераторе); при голом поле — псевдоним
  // единственного источника. RHS проходит ту же обработку, что произвольное
  // выражение: нормализация написания псевдонимов + квалификация голых полей
  // при единственном источнике (`Вал.Код > Наименование` → `… > Вал.Наименование`).
  // Голый МНОГОСЕГМЕНТНЫЙ LHS (`X.Y …`, голова `X` не объявленный псевдоним) при
  // НЕ-параметрическом RHS — это либо путь поля источника (`Ссылка.Владелец`), либо
  // КОРРЕЛИРОВАННАЯ ссылка на объемлющий запрос (`ВнешнийПсевдоним.Поле`) во
  // вложенном подзапросе. Различить можно только метаданными + областью видимости
  // объемлющих запросов — это умеет пост-разбор-пасс `qualifyBareFields`. Поэтому НЕ
  // навешиваем здесь жадно псевдоним единственного источника (иначе двойная
  // квалификация `Алиас.ВнешнийПсевдоним.Поле`); отдаём сегмент как произвольное
  // выражение, которое пост-пасс квалифицирует с полным контекстом (фаза 6.17.x).
  if (!direct && ref.path.includes('.')) return undefined;
  const lhsAlias = direct
    ? (aliasSpelling?.get(lhs[0].text.toUpperCase()) ?? lhs[0].text)
    : soleSource!.alias;
  const rhsText = aliasSpelling
    ? qualifyBareFieldsInExpression(paramTokens, source, aliasToId, aliasSpelling, soleSource?.alias)
    : param;
  const expr = `${lhsAlias}.${ref.path} ${renderOperatorRhs(op, normalizeLeafCase(rhsText))}`;
  // Консервативный гейт: выражение, заводящее форматер (ВЫБОР/ИЛИ/НЕ-группа),
  // отрисовалось бы иначе, чем стандартный путь — такие оставляем стандартными,
  // чтобы текст гарантированно не изменился (только галочка UI, текст важнее).
  if (needsFormatting(expr) || isRootNotGroup(expr)) {
    return { custom: false, ...base };
  }
  return { custom: true, ...base, expression: expr };
}

/**
 * Правый операнд — параметр(ы), т.е. условие можно задать мышкой (фаза 6.14.4):
 * точечная цепочка от параметра (`&П`, `&П.Поле`), для `В` — также один параметр в
 * скобках (`(&П)`) и форма `ИЕРАРХИИ (&П)`, для `МЕЖДУ` — `&а И &б`.
 */
function isParamRhs(op: string, paramTokens: Token[]): boolean {
  if (op === 'МЕЖДУ') {
    const iIdx = paramTokens.findIndex(
      t => (t.type === 'ident' || t.type === 'keyword') && t.text.toUpperCase() === 'И'
    );
    if (iIdx <= 0) return false;
    return isParamChain(paramTokens.slice(0, iIdx)) && isParamChain(paramTokens.slice(iIdx + 1));
  }
  let toks = paramTokens;
  if (op === 'В') {
    const head = toks[0];
    if (head && (head.type === 'ident' || head.type === 'keyword') && head.text.toUpperCase() === 'ИЕРАРХИИ') {
      toks = toks.slice(1);
    }
    const first = toks[0];
    const last = toks[toks.length - 1];
    if (first && first.type === 'punct' && first.value === '(') {
      if (!(last && last.type === 'punct' && last.value === ')')) return false;
      toks = toks.slice(1, -1);
    }
  }
  return isParamChain(toks);
}

/** Точечная цепочка от параметра: `&П`, `&П.Поле`, `&П.А.Б`. */
function isParamChain(toks: Token[]): boolean {
  if (toks.length === 0 || toks[0].type !== 'param') return false;
  for (let k = 1; k < toks.length; k++) {
    if (k % 2 === 1) {
      if (!(toks[k].type === 'punct' && toks[k].value === '.')) return false;
    } else if (toks[k].type !== 'ident' && toks[k].type !== 'keyword') {
      return false;
    }
  }
  return toks.length % 2 === 1;
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
/**
 * Сырой текст внутреннего запроса В-подзапроса (`(ВЫБРАТЬ …)` → `ВЫБРАТЬ …`), если
 * paramTokens — ровно одна сбалансированная пара скобок, начинающаяся с ВЫБРАТЬ
 * (без хвоста). Иначе undefined. Используется для проверки КОМПАКТНОСТИ исходника
 * (фаза 6.15.27) без повторного парсинга.
 */
function subqueryInnerText(paramTokens: Token[], source: string): string | undefined {
  const first = paramTokens[0];
  if (!first || first.type !== 'punct' || first.value !== '(') return undefined;
  let depth = 0;
  let closeIdx = -1;
  for (let k = 0; k < paramTokens.length; k++) {
    const t = paramTokens[k];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') { depth--; if (depth === 0) { closeIdx = k; break; } }
  }
  if (closeIdx !== paramTokens.length - 1) return undefined;
  const inner = paramTokens[1];
  if (!inner || !(inner.type === 'keyword' && inner.value === 'ВЫБРАТЬ')) return undefined;
  return source.slice(paramTokens[0].pos + 1, paramTokens[closeIdx].pos);
}

/**
 * КОМПАКТНА ли запись подзапроса: есть строка, где ключевые слова `ВЫБРАТЬ` и `ИЗ`
 * стоят ВМЕСТЕ (`ВЫБРАТЬ … ИЗ …`). Канонический ввод конструктора держит `ВЫБРАТЬ`,
 * `ИЗ`, `ГДЕ` на отдельных строках — такой ввод НЕ компактен (фаза 6.15.27).
 */
function isCompactSubquerySource(inner: string): boolean {
  const re = /(?:^|[^\p{L}\p{N}_])ВЫБРАТЬ(?:[^\p{L}\p{N}_].*?)(?:^|[^\p{L}\p{N}_])ИЗ(?:[^\p{L}\p{N}_]|$)/u;
  return inner.split('\n').some((l) => re.test(l));
}

/**
 * Содержит ли тело подзапроса-операнда секцию `ИМЕЮЩИЕ` с ВЕРХНЕУРОВНЕВЫМ `ИЛИ`
 * (`ИМЕЮЩИЕ (A И B) ИЛИ (C И D)` или `ИМЕЮЩИЕ A И B ИЛИ C И D`)? На ВЕРХНЕМ уровне
 * запроса конструктор 1С оборачивает такую цепочку во внешние скобки, а ВНУТРИ
 * подзапроса-операнда условия — НЕТ (проверено MCP-оракулом), плюс снимает избыточные
 * скобки И-групп-операндов. Текстовый (равномерный сдвиг) путь сохраняет исходную
 * скобочную геометрию — расхождение. Разворачиваем такое тело структурно
 * (renderConditionSubquery → formatExpression), где обе нормализации делаются
 * байт-в-байт. Узкий гейт (фаза 6.16): берём текст ОТ `ИМЕЮЩИЕ` до конца тела (либо
 * до следующей секции) и требуем верхнеуровневый (depth==0, вне строк) `ИЛИ`.
 */
function hasRedundantHavingOrParens(inner: string): boolean {
  const m = /(?:^|[^\p{L}\p{N}_])ИМЕЮЩИЕ(?![\p{L}\p{N}_])/u.exec(inner);
  if (!m) return false;
  let rest = inner.slice(m.index + m[0].length);
  const tailKw = /(?:^|[^\p{L}\p{N}_])(?:ИНДЕКСИРОВАТЬ|УПОРЯДОЧИТЬ|ОБЪЕДИНИТЬ|ИТОГИ)(?![\p{L}\p{N}_])/u.exec(rest);
  if (tailKw) rest = rest.slice(0, tailKw.index);
  let depth = 0, inStr = false;
  const isW = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && (ch === 'И' || ch === 'и') && !isW(rest[i - 1]) && /^ИЛИ(?![\p{L}\p{N}_])/iu.test(rest.slice(i))) {
      return true;
    }
  }
  return false;
}

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
 * Бинарные операторы СРАВНЕНИЯ, при которых конъюнкт `ПО` может быть стандартным
 * (галочка «Произвольное» снята). `В`/`МЕЖДУ`/`ПОДОБНО` сюда НЕ входят — такие
 * конъюнкты всегда произвольные (фаза 6.13).
 */
const STD_JOIN_OPERATORS = new Set<string>(['=', '<>', '>', '>=', '<', '<=']);

/**
 * Разбивает токены условия `ПО` по ВЕРХНЕУРОВНЕВЫМ `И` (вне скобок и вне `ВЫБОР …
 * КОНЕЦ`; `И` диапазона `МЕЖДУ a И b` не разделитель). Возвращает список сегментов-
 * конъюнктов. Аналог `splitConditionSegments`, но работает над готовым массивом
 * токенов условия соединения (фаза 6.13).
 */
function splitJoinConjuncts(tokens: Token[]): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  let caseDepth = 0;
  let betweenPending = 0;
  const isIdentWord = (t: Token, w: string): boolean =>
    (t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === w;
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const t of tokens) {
    if (depth === 0 && caseDepth === 0) {
      if (t.type === 'keyword' && t.value === 'И') {
        if (betweenPending > 0) {
          betweenPending--;
        } else {
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
    current.push(t);
  }
  flush();
  return segments;
}

/**
 * Классифицирует один конъюнкт условия `ПО` как СТАНДАРТНЫЙ или ПРОИЗВОЛЬНЫЙ
 * (фаза 6.13). Стандартный (`custom=false`, без скобок) — бинарное сравнение
 * `<seed>.<путь> <cmp> <joined>.<путь>`, где оба операнда — чистые точечные поля,
 * левый принадлежит затравке (`seedId`), правый присоединяемой (`joinedId`),
 * `cmp ∈ {=,<>,<,>,<=,>=}`. Всё прочее — произвольный конъюнкт (`custom=true`),
 * хранится дословным текстом (со снятой одной внешней парой скобок).
 *
 * Скобки исходника в классификации НЕ участвуют (фаза 6.15.5): конструктор 1С
 * решает по структуре — стандартное условие связи (задаваемое мышкой: Таблица1,
 * Таблица2, оператор) печатается без скобок, даже если разработчик обернул его
 * во вводе; произвольное (галочка «Произвольное») — всегда в скобках. В золотом
 * корпусе исключений нет: 575 голых конъюнктов все стандартные, 679 скобочных
 * все произвольные.
 */
function classifyJoinConjunct(
  tokens: Token[],
  source: string,
  aliasToId: Map<string, string>,
  seedId: string,
  joinedId: string
): JoinCondition {
  const arbitrary = (): JoinCondition => {
    // Все внешние пары скобок снимаются (двойные `((НЕ x))` не накапливаются —
    // генератор восстановит одну пару; фаза 6.15.8).
    let text = sliceSource(source, tokens);
    for (let s = stripOuterParens(text); s !== text; s = stripOuterParens(text)) text = s;
    return { custom: true, expression: text };
  };
  // Снять внешние сбалансированные пары скобок перед структурным разбором.
  let inner = tokens;
  while (hasBalancedOuterParens(inner)) inner = inner.slice(1, -1);
  // Найти верхнеуровневый оператор сравнения.
  let opIdx = -1;
  let depth = 0;
  for (let k = 0; k < inner.length; k++) {
    const t = inner[k];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    else if (depth === 0 && isCondOperatorToken(t)) { opIdx = k; break; }
  }
  if (opIdx <= 0 || opIdx >= inner.length - 1) return arbitrary();
  const op = inner[opIdx].value;
  if (!STD_JOIN_OPERATORS.has(op)) return arbitrary();
  const left = parseFieldRef(inner.slice(0, opIdx), aliasToId);
  const right = parseFieldRef(inner.slice(opIdx + 1), aliasToId);
  if (!left || !right) return arbitrary();
  // Стандартное: ЛЕВЫЙ операнд — поле КОРНЯ цепочки (затравки), ПРАВЫЙ — поле
  // присоединяемой таблицы. Конструктор 1С НЕ нормализует порядок операндов:
  // перестановка (`joined.x = seed.y`) переводит условие в произвольное (в скобках),
  // как и операнд из третьей (предыдущей в цепочке) таблицы. Это правило совпадает
  // с эталоном конструктора в 95.6% конъюнктов корпуса (фаза 6.13).
  if (left.tableId !== seedId || right.tableId !== joinedId) return arbitrary();
  return {
    custom: false,
    leftTableId: left.tableId,
    leftPath: left.path,
    operator: op as ConditionOperator,
    rightTableId: right.tableId,
    rightPath: right.path,
  };
}

/**
 * Достраивает соединение из сырого вида: резолвит псевдонимы затравки/присоединяемой
 * в tableId и разбирает условие `ПО`. Простое: `<aliasL>.<pathL> <op> <aliasR>.<pathR>`;
 * иначе — произвольное (`custom`), причём генератор оборачивает произвольное в
 * скобки, которые здесь снимаются.
 */
function resolveJoin(raw: RawJoin, aliasToId: Map<string, string>, source: string): Join {
  const { leftAll, rightAll } = joinFlags(raw.kind);
  /* v8 ignore next 2 -- псевдонимы затравки/присоединяемой всегда в aliasToId (правая ветвь ?? недостижима) */
  const seedId = aliasToId.get(raw.seedAlias.toUpperCase()) ?? raw.seedAlias;
  const joinedId = aliasToId.get(raw.joinedAlias.toUpperCase()) ?? raw.joinedAlias;

  // Обернул ли разработчик всё условие в одну сбалансированную внешнюю пару скобок
  // (`ПО (a = b)`). Только это решение конструктор 1С сохраняет; скобки вокруг
  // подконъюнктов составного условия (`(a) И (b)`) сюда не относятся (фаза 6.12).
  const parenthesized = hasBalancedOuterParens(raw.condTokens);

  // Поконъюнктная классификация (фаза 6.13): условие `ПО` бьётся по верхнеуровневым
  // `И`, каждый конъюнкт — стандартный (`seed.поле cmp joined.поле`, без скобок) или
  // произвольный (в скобках). Генератор рендерит из этого списка. Скобки исходника
  // вокруг ВСЕГО условия раскрываются ДО деления (фаза 6.15.5): `ПО (a И b)`
  // конструктор распределяет по конъюнктам и классифицирует каждый заново.
  /* v8 ignore next -- chainSeedAlias всегда резолвится (он же источник в aliasToId) */
  const chainSeedId = aliasToId.get(raw.chainSeedAlias.toUpperCase()) ?? raw.chainSeedAlias;
  let condInner = raw.condTokens;
  while (hasBalancedOuterParens(condInner)) condInner = condInner.slice(1, -1);
  // Верхнеуровневое `ИЛИ` (вне скобок/ВЫБОР) — делить по `И` нельзя (И связывает
  // сильнее): всё условие — ОДИН произвольный конъюнкт, который конструктор
  // оборачивает в скобки (то же правило, что у ГДЕ в 6.14).
  const conjunctTokens = hasTopLevelOr(condInner) ? [condInner] : splitJoinConjuncts(condInner);
  const conditions: JoinCondition[] = conjunctTokens.map(seg =>
    classifyJoinConjunct(seg, source, aliasToId, chainSeedId, joinedId)
  );

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
      conditions,
      // depth добавляется только у вложенных — плоские модели не меняются.
      ...(raw.depth > 0 ? { depth: raw.depth } : {}),
      ...(raw.optional ? { optional: true } : {}),
      ...(raw.optionalLast ? { optionalLast: true } : {}),
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
    conditions,
    ...(raw.depth > 0 ? { depth: raw.depth } : {}),
    ...(raw.optional ? { optional: true } : {}),
    ...(raw.optionalLast ? { optionalLast: true } : {}),
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
  aliasToId: Map<string, string>,
  resolveOwner: OwnerResolver
): { multiple: boolean; groupFields: FieldRef[]; groupSets: FieldRef[][] } {
  cur.expectKeyword('СГРУППИРОВАТЬ');
  cur.expectKeyword('ПО');

  if (cur.matchKeyword('ГРУППИРУЮЩИМ')) {
    cur.expectKeyword('НАБОРАМ');
    const groupSets = parseGroupingSets(cur, aliasToId, resolveOwner);
    return { multiple: true, groupFields: [], groupSets };
  }

  // Одна группировка: список ссылок через запятую.
  const groupFields: FieldRef[] = [];
  for (;;) {
    const ref = parseGroupFieldRef(cur, aliasToId, resolveOwner);
    groupFields.push(ref);
    if (cur.matchPunct(',')) continue;
    break;
  }
  return { multiple: false, groupFields, groupSets: [] };
}

/** Наборы группировки: `( (a, b), (c) )`. */
function parseGroupingSets(
  cur: Cursor,
  aliasToId: Map<string, string>,
  resolveOwner: OwnerResolver
): FieldRef[][] {
  cur.expectPunct('(');
  const sets: FieldRef[][] = [];
  for (;;) {
    cur.expectPunct('(');
    const set: FieldRef[] = [];
    for (;;) {
      set.push(parseGroupFieldRef(cur, aliasToId, resolveOwner));
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
function parseGroupFieldRef(
  cur: Cursor,
  aliasToId: Map<string, string>,
  resolveOwner: OwnerResolver
): FieldRef {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (depth === 0) {
      // Стоп на секционных ключевых словах (ДЛЯ ИЗМЕНЕНИЯ / порядок / итоги /
      // индекс) и на запятой/конце — границах элемента группировки. Исключение:
      // ключевое слово как ГОЛОВА точечной ссылки поля (`Итоги.Поле`, keyword
      // регистронезависим) — за ним `.`, значит это ссылка, а не секция (фаза 6.16).
      if (t.type === 'keyword' && isSectionKeyword(t.value) && !cur.isPunct('.', 1)) break;
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
  // Голый точечный путь с головой-НЕпсевдонимом (`Пользователь.Ссылка`):
  // конструктор 1С квалифицирует его таблицей-владельцем (фаза 6.15.4, MCP).
  const bare = tryBareField(tokens, aliasToId);
  if (bare) {
    const owner = resolveOwner(bare.head);
    if (owner !== undefined) return { tableId: owner, path: bare.path };
  }
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

/** Контекст резолвинга полей секций УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКСИРОВАТЬ (фаза 6.15.4). */
interface SectionResolveContext {
  /** Карта псевдоним выборки → (tableId, path). */
  aliasMap: Map<string, FieldRef>;
  /** Псевдоним таблицы (ВЕРХНИЙ регистр) → tableId. */
  aliasToId: Map<string, string>;
  /** Явные псевдонимы выборки из ввода (ВЕРХНИЙ регистр). */
  explicitAliases: Set<string>;
  /** Поля выборки (колонки) — для резолвинга ИТОГИ ПО по полю колонки. */
  fields: SelectedField[];
  /** Резолвер владельца голого поля. */
  resolveOwner: OwnerResolver;
}

/**
 * Владелец голого имени поля секции (фаза 6.15.4, MCP): конструктор 1С оставляет
 * имя голым ТОЛЬКО когда оно совпадает с ЯВНЫМ псевдонимом выборки из ввода;
 * иначе квалифицирует таблицей-владельцем. Возвращает tableId или undefined
 * (совпало с явным псевдонимом / не резолвится — прежнее поведение).
 */
function sectionBareOwner(segs: string[], ctx: SectionResolveContext): string | undefined {
  const headUp = segs[0].toUpperCase();
  if (ctx.aliasToId.has(headUp)) return undefined; // голова — псевдоним таблицы
  if (ctx.explicitAliases.has(headUp)) return undefined;
  if (segs.length === 1 && LITERAL_VALUES.has(headUp)) return undefined;
  return ctx.resolveOwner(segs[0]);
}

/**
 * Секция УПОРЯДОЧИТЬ ПО / АВТОУПОРЯДОЧИВАНИЕ. Инвертирует `renderOrder`:
 *  - `УПОРЯДОЧИТЬ ПО <псевдоним>[ УБЫВ][ ИЕРАРХИЯ], …` → order.fields (резолв псевдонима выборки).
 *  - последняя строка `АВТОУПОРЯДОЧИВАНИЕ` (с полями или без) → order.auto=true.
 */
function parseOrder(cur: Cursor, ctx: SectionResolveContext): Order {
  const { aliasMap, aliasToId } = ctx;
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
      // Выражение ВЫБОР…КОНЕЦ как поле упорядочивания: поглощаем весь CASE
      // (баланс ВЫБОР/КОНЕЦ + скобки) до запятой/секции/модификатора и сохраняем
      // сырой срез как expression — генератор печатает его через formatSelectExpression
      // (многострочная раскладка КОГДА/ТОГДА/ИНАЧЕ/КОНЕЦ). Без этого parseOrder
      // распознавал ВЫБОР как голую ссылку и терял тело CASE.
      if (headTok.value.toUpperCase() === 'ВЫБОР') {
        const exprTokens: Token[] = [cur.next()];
        let depth = 0;
        let caseDepth = 1;
        for (;;) {
          const t = cur.peek();
          if (t.type === 'eof') break;
          if (depth === 0 && caseDepth === 0) {
            if (t.type === 'keyword' && (isSectionKeyword(t.value) || t.value === 'УБЫВ' || t.value === 'ВОЗР' || t.value === 'ИЕРАРХИЯ')) break;
            if (t.type === 'ident' && t.text.toUpperCase() === 'ВОЗР') break;
            if (t.type === 'punct' && (t.value === ',' || t.value === ';' || t.value === '{' || t.value === '}')) break;
          }
          if (t.type === 'punct' && t.value === '(') depth++;
          else if (t.type === 'punct' && t.value === ')') depth--;
          else if ((t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === 'ВЫБОР') caseDepth++;
          else if ((t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === 'КОНЕЦ' && caseDepth > 0) caseDepth--;
          exprTokens.push(cur.next());
        }
        const { direction: caseDir, hierarchy: caseHier } = parseOrderModifiers(cur);
        fields.push({
          tableId: '', path: '', direction: caseDir,
          expression: sliceSource(cur.source, exprTokens),
          ...(caseHier ? { hierarchy: true } : {}),
        });
        if (cur.matchPunct(',')) continue;
        break;
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
      // Вызов функции (`ДОБАВИТЬКДАТЕ(…`) или произвольное выражение — не голое поле.
      // Поглощаем выражение целиком (баланс скобок) до запятой/секции и сохраняем
      // сырой срез как expression: конструктор 1С печатает его дословно (норм. в
      // генераторе). Без этого parseOrder терял хвост `(…)` и поле усекалось до
      // имени функции (фаза 6.15.11a, MCP).
      if (cur.isPunct('(')) {
        const exprTokens: Token[] = [headTok];
        let depth = 0;
        for (;;) {
          const t = cur.peek();
          if (depth === 0) {
            if (t.type === 'keyword' && (isSectionKeyword(t.value) || t.value === 'УБЫВ' || t.value === 'ВОЗР' || t.value === 'ИЕРАРХИЯ')) break;
            if (t.type === 'ident' && (t.text.toUpperCase() === 'ВОЗР')) break;
            if (t.type === 'punct' && (t.value === ',' || t.value === ';' || t.value === '{' || t.value === '}')) break;
            if (t.type === 'eof') break;
          }
          if (t.type === 'punct' && t.value === '(') depth++;
          else if (t.type === 'punct' && t.value === ')') {
            if (depth === 0) break;
            depth--;
          }
          exprTokens.push(cur.next());
        }
        const { direction: exprDir, hierarchy: exprHier } = parseOrderModifiers(cur);
        fields.push({
          tableId: '', path: '', direction: exprDir,
          expression: sliceSource(cur.source, exprTokens),
          ...(exprHier ? { hierarchy: true } : {}),
        });
        if (cur.matchPunct(',')) continue;
        break;
      }
      // Предикат `<путь> ЕСТЬ [НЕ] NULL` как ключ упорядочивания (сортирует ЛОЖЬ/
      // ИСТИНА): поглощаем `ЕСТЬ [НЕ] NULL` в expression — иначе parseOrder терял
      // хвост и следующее поле. Путь квалифицируем владельцем (как голую ссылку).
      // Сравнение `<путь> <оп> <операнд>` как ключ упорядочивания (сортирует ЛОЖЬ/
      // ИСТИНА результата): поглощаем хвост сравнения в expression до запятой/
      // секции/модификатора (УБЫВ/ВОЗР/ИЕРАРХИЯ). Путь остаётся как есть — голую
      // голову квалифицирует пасс qualifyBareFields над expression. Без этого
      // parseOrder терял правую часть и следующее поле.
      const cmpOp = ((): boolean => {
        const t = cur.peek();
        return t.type === 'punct' && (t.value === '=' || t.value === '<>' || t.value === '>'
          || t.value === '<' || t.value === '>=' || t.value === '<=');
      })();
      if (cmpOp) {
        const pathText = segs.join('.');
        const rhsTokens: Token[] = [];
        let depth = 0;
        for (;;) {
          const t = cur.peek();
          if (depth === 0) {
            if (t.type === 'keyword' && (isSectionKeyword(t.value) || t.value === 'УБЫВ' || t.value === 'ИЕРАРХИЯ')) break;
            if ((t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === 'ВОЗР') break;
            if (t.type === 'punct' && (t.value === ',' || t.value === ';' || t.value === '{' || t.value === '}')) break;
            if (t.type === 'eof') break;
          }
          if (t.type === 'punct' && t.value === '(') depth++;
          else if (t.type === 'punct' && t.value === ')') { if (depth > 0) depth--; }
          rhsTokens.push(cur.next());
        }
        const { direction: cmpDir, hierarchy: cmpHier } = parseOrderModifiers(cur);
        fields.push({
          tableId: '', path: '', direction: cmpDir,
          expression: `${pathText} ${sliceSource(cur.source, rhsTokens)}`,
          ...(cmpHier ? { hierarchy: true } : {}),
        });
        if (cur.matchPunct(',')) continue;
        break;
      }
      const peekIsEst = (): boolean => {
        const t = cur.peek();
        return (t.type === 'ident' || t.type === 'keyword') && t.value.toUpperCase() === 'ЕСТЬ';
      };
      if (peekIsEst()) {
        cur.next(); // ЕСТЬ
        const nt = cur.peek();
        const neg = (nt.type === 'ident' || nt.type === 'keyword') && nt.value.toUpperCase() === 'НЕ';
        if (neg) cur.next();
        const ntn = cur.peek();
        if ((ntn.type === 'ident' || ntn.type === 'keyword') && ntn.value.toUpperCase() === 'NULL') cur.next();
        const { direction: nullDir, hierarchy: nullHier } = parseOrderModifiers(cur);
        // Путь сохраняем голым/как-есть: квалификацию голой головы выполнит пасс
        // qualifyBareFields над expression поля упорядочивания.
        fields.push({
          tableId: '', path: '', direction: nullDir,
          expression: `${segs.join('.')} ЕСТЬ ${neg ? 'НЕ ' : ''}NULL`,
          ...(nullHier ? { hierarchy: true } : {}),
        });
        if (cur.matchPunct(',')) continue;
        break;
      }
      const { direction, hierarchy } = parseOrderModifiers(cur);
      const hier = hierarchy ? { hierarchy } : {};

      // Сюда попадают только голые ссылки (вызовы функций обработаны выше).
      const bareOwner = sectionBareOwner(segs, ctx);
      if (segs.length > 1 && aliasToId.has(segs[0].toUpperCase())) {
        // Квалифицированная ссылка `<псевдонимТаблицы>.<path>` — сохраняем как есть.
        fields.push({
          tableId: aliasToId.get(segs[0].toUpperCase())!,
          path: segs.slice(1).join('.'),
          direction,
          qualified: true,
          ...hier,
        });
      } else if (bareOwner !== undefined) {
        // Голое имя, НЕ совпадающее с явным псевдонимом выборки: конструктор 1С
        // квалифицирует его таблицей-владельцем (фаза 6.15.4, MCP).
        fields.push({ tableId: bareOwner, path: segs.join('.'), direction, qualified: true, ...hier });
      } else {
        // Голая ссылка — псевдоним выборки (или нерезолвимое имя): остаётся как есть.
        const aliasKey = segs.join('.');
        const ref = resolveSelectAlias(aliasKey, aliasMap);
        // Если имя — РЕАЛЬНЫЙ псевдоним выборки, запоминаем его дословно: несколько
        // полей могут делить (tableId, path) при разных псевдонимах (агрегаты
        // МАКСИМУМ/МИНИМУМ над одним полем) — поиск по (tableId, path) в генераторе
        // иначе возьмёт первый и потеряет нужный псевдоним (фаза 6.16.47).
        const isSelectAlias = aliasMap.has(aliasKey);
        fields.push({
          tableId: ref.tableId,
          path: ref.path,
          direction,
          ...(isSelectAlias ? { selectAlias: aliasKey } : {}),
          ...hier,
        });
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
function parseTotals(cur: Cursor, ctx: SectionResolveContext): Totals {
  cur.expectKeyword('ИТОГИ');
  const totalFields: TotalField[] = [];

  if (!cur.isKeyword('ПО')) {
    // Список агрегатов до ключевого слова ПО.
    for (;;) {
      totalFields.push(parseTotalAggregate(cur, ctx));
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
      groupFields.push(parseTotalGroupField(cur, ctx));
    }
    if (cur.matchPunct(',')) continue;
    break;
  }

  return { groupFields, totalFields, grand };
}

/** Один агрегат итогов: сырое выражение до запятой/ПО верхнего уровня. */
function parseTotalAggregate(cur: Cursor, ctx: SectionResolveContext): TotalField {
  const aliasMap = ctx.aliasMap;
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

  // Хвостовой `КАК <псевдоним>` верхнего уровня. Конструктор отбрасывает его ТОЛЬКО
  // у ПРОСТОГО агрегата `ФУНКЦИЯ(<операнд>)` (печатается `ФУНКЦИЯ(<колонка>)` без
  // псевдонима, MCP). У сложного выражения-агрегата (`ВЫБОР … КОНЕЦ КАК X`,
  // `… КАК ЧИСЛО(…)) КАК X`) псевдоним СОХРАНЯЕТСЯ. Поэтому сперва пробуем распознать
  // простой агрегат на теле БЕЗ возможного хвостового `КАК`; если распознан — `КАК`
  // снимаем, иначе печатаем выражение как есть (с псевдонимом).
  const hasTailKak =
    tokens.length >= 2 &&
    tokens[tokens.length - 2].type === 'keyword' &&
    tokens[tokens.length - 2].value === 'КАК' &&
    (tokens[tokens.length - 1].type === 'ident' || tokens[tokens.length - 1].type === 'keyword');
  const tailAlias = hasTailKak ? tokens[tokens.length - 1].text : undefined;
  const stripped = hasTailKak ? tokens.slice(0, tokens.length - 2) : tokens;

  // Простой агрегат `ФУНКЦИЯ([РАЗЛИЧНЫЕ] <операнд>)`, операнд которого РАСПОЗНАН как
  // КОЛОНКА выборки: конструктор печатает его канонически `ФУНКЦИЯ(<псевдонимКолонки>)`
  // (операнд → псевдоним, `МАКСИМУМ(ЕСТЬNULL(…)) КАК Дата` → `МАКСИМУМ(Дата)`),
  // ОТБРАСЫВАЯ хвостовой `КАК`, и сортирует список агрегатов по позиции этой колонки
  // (фаза 6.16). Если операнд НЕ колонка (`МАКСИМУМ(ВЫБОР … КОНЕЦ)`, `МАКСИМУМ(&Парам)`,
  // `МИНИМУМ(НАЧАЛОПЕРИОДА(…))`) — `КАК` СОХРАНЯЕТСЯ (агрегат печатается дословно).
  const simple = matchSimpleAggregate(stripped);
  if (simple) {
    const alias = resolveAggregateOperand(simple.operand, ctx, cur.source);
    if (alias !== undefined) {
      const expr = sliceSource(cur.source, stripped);
      return { tableId: '', path: '', func: simple.func, operandAlias: alias, expression: expr };
    }
  }

  // Не распознанный простой агрегат / агрегат-выражение — печатается дословно (с
  // хвостовым `КАК`, если был). Хвостовой `КАК <псевдоним>` служит ключом сортировки
  // (`sortAlias`): конструктор ставит такой агрегат на позицию колонки с этим
  // псевдонимом (`ВЫБОР … КОНЕЦ КАК ВсегоПокупок` — между НаАванс и СуммаБезНДС).
  const expression = sliceSource(cur.source, tokens);
  // Прежний путь: `СУММА(<псевдоним>)` → (tableId, path) без func (legacy-совместимость
  // вывода `СУММА(<псевдоним>)` через selectAliasFor). Сюда уже не попадает простой
  // `СУММА(ident)` (его перехватил matchSimpleAggregate); резерв для UI-моделей.
  const inner = matchSumAlias(tokens);
  if (inner) {
    const ref = aliasMap.get(inner);
    if (ref) return { tableId: ref.tableId, path: ref.path, expression, sortAlias: tailAlias };
  }
  return { tableId: '', path: '', expression, sortAlias: tailAlias };
}

/**
 * Распознаёт одиночный агрегат `<ФУНК> ( [РАЗЛИЧНЫЕ] <операнд> )`, где ВСЁ выражение
 * — ровно один вызов агрегатной функции (первый токен — ключевое слово функции,
 * парная закрывающая скобка — последний токен). Возвращает функцию и токены
 * операнда (без обёртки `ФУНК(` … `)` и без ведущего `РАЗЛИЧНЫЕ`), иначе undefined.
 */
function matchSimpleAggregate(
  tokens: Token[]
): { func: AggregateFunction; operand: Token[] } | undefined {
  if (tokens.length < 4) return undefined;
  const head = tokens[0];
  if (head.type !== 'keyword') return undefined;
  const func = AGG_KEYWORD_TO_FUNC[head.value];
  if (!func) return undefined;
  if (!(tokens[1].type === 'punct' && tokens[1].value === '(')) return undefined;
  const last = tokens[tokens.length - 1];
  if (!(last.type === 'punct' && last.value === ')')) return undefined;
  // Скобка после функции должна закрываться ИМЕННО последним токеном (иначе это не
  // одиночный вызов, напр. `ФУНК(...) + ФУНК(...)` или `ВЫБОР … КОНЕЦ`).
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') {
      depth--;
      if (depth === 0 && i !== tokens.length - 1) return undefined;
    }
  }
  let operand = tokens.slice(2, tokens.length - 1);
  let resolvedFunc = func;
  if (operand[0]?.type === 'keyword' && operand[0].value === 'РАЗЛИЧНЫЕ') {
    operand = operand.slice(1);
    if (func === 'Количество') resolvedFunc = 'КоличествоРазличных';
  }
  if (operand.length === 0) return undefined;
  return { func: resolvedFunc, operand };
}

/** Нормализация текста для сравнения операнда агрегата с выражением колонки. */
function normTotalsExpr(s: string): string {
  return s.replace(/\s+/gu, ' ').trim().toUpperCase();
}

/**
 * Резолвинг операнда простого агрегата ИТОГИ в ПСЕВДОНИМ КОЛОНКИ выборки (текст,
 * который конструктор печатает внутри `ФУНКЦИЯ(…)`). Операнд может быть:
 *   • голым именем — псевдоним колонки (по `field.alias`, в т. ч. колонки-выражения),
 *     либо по последнему сегменту пути её поля; имя, не являющееся колонкой, не
 *     считается операндом-колонкой;
 *   • `Таблица.Поле` — псевдоним колонки с таким (tableId, path);
 *   • сложным выражением — сопоставляется по нормализованному тексту с
 *     `field.expression` колонки (как `МАКСИМУМ(ЕСТЬNULL(…))` → псевдоним колонки-ЕСТЬNULL).
 * Возвращает псевдоним колонки или undefined.
 */
function resolveAggregateOperand(
  operand: Token[],
  ctx: SectionResolveContext,
  source: string
): string | undefined {
  const aliasOfField = (f: SelectedField): string =>
    f.alias ?? (f.path ? (f.path.split('.').pop() ?? f.path) : '');

  // Голое имя или `Алиас.Путь` (только ident/keyword + точки).
  const isNameLike = operand.every(
    (t, i) =>
      t.type === 'ident' ||
      t.type === 'keyword' ||
      (t.type === 'punct' && t.value === '.' && i > 0 && i < operand.length - 1)
  );
  if (isNameLike) {
    const segs: string[] = [];
    for (const t of operand) {
      if (t.type === 'punct') continue;
      segs.push(t.text);
    }
    if (segs.length === 0) return undefined;
    const nameUp = segs.join('.').toUpperCase();
    // Голое имя = псевдоним колонки (включая колонку-выражение): печатается дословно.
    if (segs.length === 1) {
      const byAlias = ctx.fields.find(f => aliasOfField(f).toUpperCase() === nameUp);
      if (byAlias) return aliasOfField(byAlias);
    }
    // `Алиас.Путь` или имя поля — резолвинг через колонку (tableId, path).
    const ref = resolveTotalsFieldRef(segs, ctx);
    if (!ref.qualified) {
      const col = ctx.fields.find(
        f => !f.expression && f.tableId === ref.tableId && f.path === ref.path
      );
      if (col) return aliasOfField(col);
    }
    return undefined;
  }
  // Сложное выражение — сопоставление по тексту с выражением колонки.
  const exprText = normTotalsExpr(sliceSource(source, operand));
  const col = ctx.fields.find(
    f => f.expression !== undefined && normTotalsExpr(f.expression) === exprText
  );
  if (col) return aliasOfField(col);
  return undefined;
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

/**
 * Резолвинг группировочного поля ИТОГИ ПО (фаза 6.15.4, MCP). В отличие от
 * УПОРЯДОЧИТЬ/ИНДЕКСИРОВАТЬ, итоги адресуют КОЛОНКИ выборки: голое имя
 * резолвится в колонку и по псевдониму (включая неявный), и по последнему
 * сегменту пути её поля — даже если у колонки явный ДРУГОЙ псевдоним
 * (конструктор перепишет имя в псевдоним колонки: `Валюта` → `Валюта2`).
 * Только имя, не являющееся колонкой, квалифицируется таблицей-владельцем.
 */
function resolveTotalsFieldRef(segs: string[], ctx: SectionResolveContext): FieldRef {
  if (segs.length > 1 && ctx.aliasToId.has(segs[0].toUpperCase())) {
    const tableId = ctx.aliasToId.get(segs[0].toUpperCase())!;
    const path = segs.slice(1).join('.');
    // Квалифицированное `Таблица.Поле`, совпадающее с КОЛОНКОЙ выборки, конструктор
    // печатает её псевдонимом (без квалификации) — итоги адресуют колонки (6.16.10,
    // MCP). Не-колонку оставляем квалифицированной (6.15.4).
    const isColumn = ctx.fields.some(f => !f.expression && f.tableId === tableId && f.path === path);
    return isColumn ? { tableId, path } : { tableId, path, qualified: true };
  }
  const name = segs.join('.');
  const hit = ctx.aliasMap.get(name);
  if (hit) return { tableId: hit.tableId, path: hit.path };
  // Колонка по последнему сегменту пути её поля (рендер вернёт псевдоним колонки).
  if (segs.length === 1) {
    const up = segs[0].toUpperCase();
    const col = ctx.fields.find(
      f => !f.expression && !!f.path && (f.path.split('.').pop() ?? '').toUpperCase() === up
    );
    if (col) return { tableId: col.tableId, path: col.path };
  }
  const owner = sectionBareOwner(segs, ctx);
  if (owner !== undefined) {
    return { tableId: owner, path: name, qualified: true };
  }
  return { tableId: '', path: name };
}

/**
 * Модификатор `ПЕРИОДАМИ(<период>, <выражение>, …)` группировочного поля ИТОГИ ПО.
 * `ПЕРИОДАМИ` лексер выдаёт как ident (нет в наборе ключевых слов). Если дальше
 * стоит `ПЕРИОДАМИ(`, поглощает токены `ПЕРИОДАМИ` … `)` и возвращает канонический
 * текст `ПЕРИОДАМИ(<арг>, <арг>, …)` (период — в верхнем регистре, разделитель `, `).
 * Иначе курсор не двигается и возвращается undefined.
 */
function matchPeriodBy(cur: Cursor): string | undefined {
  const head = cur.peek();
  if (head.type !== 'ident' || head.text.toUpperCase() !== 'ПЕРИОДАМИ') return undefined;
  if (!cur.isPunct('(', 1)) return undefined;
  cur.next(); // ПЕРИОДАМИ
  cur.expectPunct('(');
  const args: string[] = [];
  let curArg: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') throw cur.error('ожидался символ «)» в ПЕРИОДАМИ(…)', t);
    if (depth === 0 && t.type === 'punct' && t.value === ')') { cur.next(); break; }
    if (depth === 0 && t.type === 'punct' && t.value === ',') {
      cur.next();
      args.push(sliceSource(cur.source, curArg));
      curArg = [];
      continue;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    curArg.push(cur.next());
  }
  if (curArg.length) args.push(sliceSource(cur.source, curArg));
  // Первый аргумент — период (ГОД/КВАРТАЛ/МЕСЯЦ/…): нормализуем в верхний регистр.
  if (args.length) args[0] = args[0].toUpperCase();
  return `ПЕРИОДАМИ(${args.join(', ')})`;
}

/** Одно группировочное поле итогов: `<поле>[ ИЕРАРХИЯ| ТОЛЬКО ИЕРАРХИЯ][ КАК <alias>]`. */
function parseTotalGroupField(cur: Cursor, ctx: SectionResolveContext): TotalGroupField {
  const aliasTok = cur.peek();
  // Параметр `&Имя` в позиции группировочного поля (`ИТОГИ ПО &ПоляИтогов`):
  // непрозрачная форма, сохраняем дословно (фаза 6.16). Модификаторы ИЕРАРХИЯ/КАК
  // после параметра в этой форме конструктор не печатает.
  if (aliasTok.type === 'param') {
    cur.next();
    return { tableId: '', path: '', kind: 'elements', expression: aliasTok.text };
  }
  const segs = readDottedPath(cur);
  if (!segs) throw cur.error('ожидался псевдоним группировочного поля итогов', aliasTok);
  const ref = resolveTotalsFieldRef(segs, ctx);

  // Модификатор `ПЕРИОДАМИ(<период>, <начало>, <конец>)` сразу после имени поля
  // (фаза 6.16.48): период по интервалу из виртуальной таблицы ОстаткиИОбороты.
  // `ПЕРИОДАМИ` лексер выдаёт как ident; аргументы — ident периода + параметры.
  const periodBy = matchPeriodBy(cur);

  let kind: TotalKind = 'elements';
  if (cur.matchKeyword('ТОЛЬКО')) {
    cur.expectKeyword('ИЕРАРХИЯ');
    kind = 'onlyHierarchy';
  } else if (cur.matchKeyword('ИЕРАРХИЯ')) {
    kind = 'hierarchy';
  }

  const field: TotalGroupField = { tableId: ref.tableId, path: ref.path, kind };
  if (ref.qualified) field.qualified = true;
  // Голое имя, совпавшее с РЕАЛЬНЫМ псевдонимом выборки, запоминаем дословно:
  // несколько колонок могут делить (tableId, path) под разными псевдонимами
  // (`КАК Подразделение`/`КАК СсылкаПодразделение`) — иначе генератор подставит
  // первый совпавший псевдоним вместо записанного (ИТОГИ ПО, аналогично 6.16.47).
  if (segs.length === 1 && ctx.aliasMap.has(segs[0])) field.selectAlias = segs[0];
  if (periodBy) field.periodBy = periodBy;
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
function parseIndex(cur: Cursor, ctx: SectionResolveContext): Indexing {
  cur.expectKeyword('ИНДЕКСИРОВАТЬ');
  cur.expectKeyword('ПО');

  if (cur.matchKeyword('НАБОРАМ')) {
    cur.expectPunct('(');
    const indexes: QueryIndex[] = [];
    for (;;) {
      cur.expectPunct('(');
      const fields: FieldRef[] = [];
      for (;;) {
        fields.push(parseIndexField(cur, ctx));
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
    fields.push(parseIndexField(cur, ctx));
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
 * Поле, адресуемое в секциях ИНДЕКСИРОВАТЬ ПО / ИТОГИ ПО: квалифицированная
 * ссылка `<псевдонимТаблицы>.<path>` (qualified, выводится дословно), псевдоним
 * выборки (голым), либо голое поле, НЕ совпадающее с явным псевдонимом ввода —
 * его конструктор 1С квалифицирует таблицей-владельцем (фаза 6.15.4, MCP).
 */
function resolveSectionFieldRef(segs: string[], ctx: SectionResolveContext): FieldRef {
  if (segs.length > 1 && ctx.aliasToId.has(segs[0].toUpperCase())) {
    return { tableId: ctx.aliasToId.get(segs[0].toUpperCase())!, path: segs.slice(1).join('.'), qualified: true };
  }
  const owner = sectionBareOwner(segs, ctx);
  if (owner !== undefined) {
    return { tableId: owner, path: segs.join('.'), qualified: true };
  }
  const aliasKey = segs.join('.');
  const ref = resolveSelectAlias(aliasKey, ctx.aliasMap);
  // Если адресованный псевдоним РАЗОШЁЛСЯ с псевдонимом первого поля выборки с тем же
  // (tableId, path) — две колонки делят базовый путь под разными псевдонимами
  // (`Т.X КАК A, Т.X КАК B`) — фиксируем именно адресованный псевдоним, иначе генератор
  // (по first-match (tableId,path)) напечатает чужой псевдоним (фаза 6.16.59).
  const firstSame = ctx.fields.find(f => f.tableId === ref.tableId && f.path === ref.path && !f.expression);
  const firstAlias = firstSame?.alias ?? (ref.path.split('.').pop() ?? ref.path);
  if (ctx.aliasMap.has(aliasKey) && aliasKey !== firstAlias) {
    return { tableId: ref.tableId, path: ref.path, selectAlias: aliasKey };
  }
  return { tableId: ref.tableId, path: ref.path };
}

/** Одно поле индекса: квалиф. ссылка/псевдоним выборки → FieldRef, либо `&Параметр`. */
function parseIndexField(cur: Cursor, ctx: SectionResolveContext): FieldRef {
  const t = cur.peek();
  // `ИНДЕКСИРОВАТЬ ПО &Параметр` — параметр запроса вместо псевдонима поля
  // (приём генерации динамических ВТ). Сохраняем дословно через expression.
  if (t.type === 'param') {
    cur.next();
    return { tableId: '', path: '', expression: t.text };
  }
  // Вызов функции (`ЕСТЬNULL(…)`, `ВЫРАЗИТЬ(…)`) как поле индекса — не голое поле.
  // Поглощаем выражение целиком (баланс скобок) до запятой/секции и сохраняем сырой
  // срез как expression (генератор печатает дословно). Без этого readDottedPath
  // останавливался на `(` и поле усекалось до имени функции.
  const head = cur.peek();
  if ((head.type === 'ident' || head.type === 'keyword') && cur.peek(1).type === 'punct' && cur.peek(1).value === '(') {
    const exprTokens: Token[] = [cur.next()];
    let depth = 0;
    for (;;) {
      const tk = cur.peek();
      if (depth === 0) {
        if (tk.type === 'keyword' && isSectionKeyword(tk.value)) break;
        if (tk.type === 'punct' && (tk.value === ',' || tk.value === ';' || tk.value === '{' || tk.value === '}')) break;
        if (tk.type === 'eof') break;
      }
      if (tk.type === 'punct' && tk.value === '(') depth++;
      else if (tk.type === 'punct' && tk.value === ')') {
        if (depth === 0) break;
        depth--;
      }
      exprTokens.push(cur.next());
    }
    return { tableId: '', path: '', expression: sliceSource(cur.source, exprTokens) };
  }
  const segs = readDottedPath(cur);
  if (!segs) throw cur.error('ожидался псевдоним поля индекса', t);
  return resolveSectionFieldRef(segs, ctx);
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
    fields.push(parseBuilderField(cur, keyword === 'ГДЕ'));
    if (cur.matchPunct(',')) continue;
    break;
  }
  cur.expectPunct('}');
  return fields;
}

/**
 * Элемент-условие блока `{ГДЕ}` (фаза 6.15.7): выражение, не являющееся ссылкой
 * поля (`&Отбор`, `"&Имя" В (&Список)`, скобочная форма). Токены собираются до
 * верхнеуровневой `,`, `}` или `КАК`; одна внешняя пара скобок снимается (канон
 * генератора их восстанавливает).
 */
function parseBuilderCondition(cur: Cursor): BuilderField {
  const tokens: Token[] = [];
  let depth = 0;
  for (;;) {
    const t = cur.peek();
    if (t.type === 'eof') break;
    if (depth === 0) {
      if (t.type === 'punct' && (t.value === ',' || t.value === '}')) break;
      if (t.type === 'keyword' && t.value === 'КАК') break;
    }
    if (t.type === 'punct' && t.value === '(') depth++;
    else if (t.type === 'punct' && t.value === ')') depth--;
    tokens.push(cur.next());
  }
  if (tokens.length === 0) throw cur.error('пустое условие построителя');
  // Скобочная форма «использовать дочерние»: `(выражение).*` (корпус:
  // ЕСТЬNULL(...).* КАК КассаККМ, ЗНАЧЕНИЕ(...).* КАК Группа). Снимаем хвостовые
  // токены `.` `*`, помечаем child — генератор допишет `.*` после скобок.
  let child = false;
  if (
    tokens.length >= 2 &&
    tokens[tokens.length - 1].type === 'punct' && tokens[tokens.length - 1].value === '*' &&
    tokens[tokens.length - 2].type === 'punct' && tokens[tokens.length - 2].value === '.'
  ) {
    child = true;
    tokens.length -= 2;
  }
  const field: BuilderField = {
    ref: stripOuterParens(sliceSource(cur.source, tokens)),
    child,
    condition: true,
  };
  if (cur.matchKeyword('КАК')) {
    const a = cur.peek();
    if (a.type !== 'ident' && a.type !== 'keyword') throw cur.error('ожидался псевдоним после КАК', a);
    cur.next();
    field.alias = a.text;
  }
  return field;
}

/** Одно поле построителя: `<ref>[.*][ КАК <alias>]`; в `{ГДЕ}` — также условие. */
function parseBuilderField(cur: Cursor, allowCondition = false): BuilderField {
  // ref = точечное имя; `.*` → child. Собираем сегменты вручную, т.к. возможна
  // финальная `.*`.
  const first = cur.peek();
  // Голова не похожа на ссылку поля (параметр/строка/скобка) → элемент-условие
  // блока `{ГДЕ}` (фаза 6.15.7). Ключевое слово `НЕ` — логическое отрицание, тоже
  // начало условия, а не ссылки поля (фаза 6.16).
  if (allowCondition && ((first.type !== 'ident' && first.type !== 'keyword') || first.value === 'НЕ')) {
    return parseBuilderCondition(cur);
  }
  if (first.type !== 'ident' && first.type !== 'keyword') {
    throw cur.error('ожидалась ссылка поля построителя', first);
  }
  // Спекулятивно разбираем как ссылку поля; если после неё (и опц. `.*`) идёт не
  // `,`/`}`/`КАК`, то это условие (`Алиас.Поле <оператор> …`) — откатываемся и
  // разбираем элемент-условие целиком (фаза 6.16).
  const mark = cur.mark();
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
  if (allowCondition && !child) {
    const after = cur.peek();
    const refComplete =
      (after.type === 'punct' && (after.value === ',' || after.value === '}')) ||
      (after.type === 'keyword' && after.value === 'КАК');
    if (!refComplete) {
      cur.reset(mark);
      return parseBuilderCondition(cur);
    }
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
/**
 * Фаза 8.1 — опции разбора. `preserveComments` включает сбор комментариев `//…` и их
 * привязку к смысловым якорям модели (см. commentBinder). По умолчанию выключено →
 * поведение и канонический вывод (золотой оракул, регрессия корпуса) не меняются.
 */
export interface ParseOptions {
  preserveComments?: boolean;
}

/**
 * Фаза 8.1 — режет текст документа на тексты участников ОБЪЕДИНЕНИЯ, инвертируя
 * `splitUnionMembers`: границы — ключевые слова `ОБЪЕДИНИТЬ [ВСЕ]` ВЕРХНЕГО уровня
 * (вне `(…)` и `{…}`). Текст участника = от конца предыдущего разделителя до начала
 * следующего `ОБЪЕДИНИТЬ` (или до конца). Срез участника СОДЕРЖИТ ведущие комментарии
 * перед его `ВЫБРАТЬ` (вид 3) — комментарии не входят в поток токенов лексера, поэтому
 * старт среза берётся по позиции ПОСЛЕ разделителя, а не по первому реальному токену.
 * Возвращает срезы в том же порядке и количестве, что и `splitUnionMembers`.
 */
function splitUnionMemberTexts(text: string): string[] {
  const tokens = tokenize(text);
  const slices: string[] = [];
  let segStart = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'eof') break;
    if (t.type === 'punct') {
      if (t.value === '(') parenDepth++;
      else if (t.value === ')') parenDepth--;
      else if (t.value === '{') braceDepth++;
      else if (t.value === '}') braceDepth--;
    }
    if (t.type === 'keyword' && t.value === 'ОБЪЕДИНИТЬ' && parenDepth === 0 && braceDepth === 0) {
      slices.push(text.slice(segStart, t.pos));
      let sepEnd = t.pos + t.text.length;
      let j = i + 1;
      const nxt = tokens[j];
      if (nxt && nxt.type === 'keyword' && nxt.value === 'ВСЕ') {
        sepEnd = nxt.pos + nxt.text.length;
        j++;
      }
      segStart = sepEnd;
      i = j;
      continue;
    }
    i++;
  }
  slices.push(text.slice(segStart));
  return slices;
}

/**
 * Фаза 8.1 — привязать комментарии к моделям документа (одиночный запрос ИЛИ
 * ОБЪЕДИНЕНИЕ). Для ОБЪЕДИНЕНИЯ комментарии каждого участника привязываются к его
 * QueryModel (= к номеру участника, по позиции в `doc.members`). Никогда не роняет
 * разбор: каждое извлечение в try/catch, при рассинхроне числа срезов — пропуск.
 */
function extractDocComments(text: string, doc: QueryDocument): void {
  if (doc.members.length === 0) return;
  if (doc.members.length === 1) {
    try {
      extractComments(text, doc.members[0].model);
    } catch {
      /* лучшее усилие */
    }
    return;
  }
  const slices = splitUnionMemberTexts(text);
  if (slices.length !== doc.members.length) return;
  doc.members.forEach((m, i) => {
    try {
      extractComments(slices[i], m.model);
    } catch {
      /* лучшее усилие */
    }
  });
}

export function parseDocument(
  text: string,
  resolver?: MetadataResolver,
  opts?: ParseOptions,
): QueryDocument {
  const prevSourceResolver = sourceResolver;
  sourceResolver = resolver;
  try {
    const doc = parseDocumentInner(text, resolver);
    // 8.1: связывание комментариев для одиночного запроса И для ОБЪЕДИНЕНИЯ
    // (по участникам); никогда не роняем разбор из-за извлечения комментариев.
    if (opts?.preserveComments) {
      extractDocComments(text, doc);
    }
    return doc;
  } finally {
    sourceResolver = prevSourceResolver;
  }
}

function parseDocumentInner(text: string, resolver?: MetadataResolver): QueryDocument {
  const tokens = tokenize(text);
  const raw = splitUnionMembers(tokens, text);

  // Контекст секций (УПОРЯДОЧИТЬ/ИТОГИ/ИНДЕКС) первого участника: секции стоят
  // после последнего участника, но конструктор 1С резолвит их по участнику 0.
  let firstCtx: SectionResolveContext | undefined;
  const models = raw.map((r, i) => {
    const ctxOut: { ctx?: SectionResolveContext } = {};
    const model = parseSingleQuery(new Cursor(r.tokens, text), i > 0 ? firstCtx : undefined, ctxOut);
    if (i === 0) firstCtx = ctxOut.ctx;
    // Канонизация регистра ИМЕНИ источника метаданных (фаза 6.16.49): конструктор
    // 1С печатает `Тип.ОбъектИмя[.ТЧ]` в каноническом написании метаданных, тогда
    // как источник может нести произвольный регистр. Псевдоним (правее `КАК`) —
    // пользовательский, его НЕ трогаем. Подзапросы-источники канонизируются своим
    // вызовом parseDocument, виртуальные срезы в индекс не входят — для них no-op.
    if (resolver?.canonicalFullName) {
      for (const t of model.tables) {
        if (t.subquery || !t.fullName) continue;
        const canon = resolver.canonicalFullName(t.fullName);
        if (canon && canon !== t.fullName) t.fullName = canon;
      }
    }
    // Канонизация РЕГИСТРА сегментов пути поля по метаданным (фаза 6.16.66):
    // `ДоНачислено`→`Доначислено`, `ШтрихКод`→`Штрихкод`. После канонизации имени
    // источника, до автопсевдонимов (склейка сегментов берёт канонический регистр).
    canonicalizeFieldCasing(model, resolver);
    // Развёртка `*` по метаданным (фаза 6.15.15): до назначения автопсевдонимов
    // `ПолеN`, чтобы развёрнутые/удалённые звёзды не получали лишний `Поле1`.
    expandStarFields(model, resolver);
    // Развёртка простого поля-ссылки на табличную часть в проекцию её колонок
    // (фаза 6.15.23). После звёздной развёртки, до назначения автопсевдонимов.
    expandTabSectionFields(model, resolver);
    // Обёртка поля выборки с агрегатом над колонкой ТЧ в проекцию этой ТЧ
    // (фаза 6.15.26, по метаданным). После звёздной/ТЧ-развёртки, до автопсевдонимов.
    wrapTabSectionAggregates(model, resolver);
    // Тихий дроп конъюнкта ГДЕ, навигирующего к идентификационным реквизитам ИБ
    // через ссылку на пользователя (фаза 6.15.23, по типам метаданных).
    dropUserIBConditions(model, resolver);
    // Тихий дроп конъюнкта ГДЕ, сравнивающего поле неограниченной длины оператором,
    // недопустимым платформой на таких полях (фаза 6.17, по типам метаданных).
    dropUnlimitedStringConditions(model, resolver);
    // Суффикс `.*` поля построителя сохраняется только для ссылочного поля
    // (по типам метаданных); у нессылочного/нерезолвимого — снимается.
    resolveBuilderStar(model, resolver);
    // Квалификация голых ссылок на поля псевдонимом источника-владельца (фаза 6.17):
    // конструктор 1С печатает каждую ссылку на колонку квалифицированно. Единственный
    // источник — им и квалифицируем; несколько — только при однозначном владельце по
    // метаданным. После прочих пассов, до назначения автопсевдонимов.
    qualifyBareFields(model, resolver);
    // Дотированный автопсевдоним квалифицированного поля с НЕРЕЗОЛВИМОЙ навигацией
    // по источнику-ВТ (фаза 6.18). После квалификации, до автопсевдонимов.
    markDottedAutoAlias(model, resolver);
    // Тихий дроп избыточной многосегментной ссылки `Алиас.A.B` из СГРУППИРОВАТЬ ПО
    // (фаза 6.18, по метаданным): когда префикс `Алиас.A` (ссылочное поле) тоже в
    // группировке и `Алиас.A.B` не выбрано отдельной колонкой — оракул его отбрасывает.
    dropRedundantGroupDerefs(model, resolver);
    // Перенос ссылки `Алиас.A.B` (стоящей ПЕРЕД сгруппированным префиксом `Алиас.A`,
    // потребляемой агрегатным выражением выборки) в конец явной группировки (фаза
    // 6.18, корпус ФормированиеПартийЗЕРНО bsl_5). После прямого дропа.
    moveBeforePrefixGroupDerefToEnd(model, resolver);
    // Перенос ведущего `ВЫБОР` с результатом-видом движения регистра в конец
    // СГРУППИРОВАТЬ ПО (фаза 6.18): конструктор 1С ставит такой элемент последним.
    moveLeadingMovementCaseToEnd(model);
    // FD-минимизация GROUP BY: дроп/сохранение+перенос CASE-вида-движения (фаза 6.19,
    // Взаимозачет). Только вид-движения; различитель keep/drop — сгруппирована ли голая ссылка.
    dropFunctionallyDeterminedMovementCase(model, resolver);
    relocateKeptMovementCase(model, resolver);
    // Замена простого поля группировки `Алиас.Имя` НЕагрегатным выражением-CASE выборки
    // `… КАК Имя`, ещё не присутствующим в группировке (фаза 6.19, ЗависшиеЗадачи).
    substituteGroupFieldWithSelectExpr(model, resolver, subquerySourceDepth > 0);
    // Пометка иерархических источников (для суффикса ИЕРАРХИЯ в УПОРЯДОЧИТЬ ПО,
    // фаза 6.16.6). По метаданным; без резолвера флаг не ставится.
    if (resolver) {
      for (const t of model.tables) {
        if (t.subquery || !t.fullName) continue;
        if (resolver.tableByFullName(t.fullName)?.hierarchical) t.hierarchical = true;
      }
      applyAccountingMeta(model, resolver);
    }
    // accountingArgs — транзиентное поле для пост-разбора; в финальной модели его нет
    // (без резолвера остаётся разложенное на этапе разбора значение).
    for (const t of model.tables) {
      if (t.virtual?.accountingArgs) delete t.virtual.accountingArgs;
    }
    return model;
  });

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
  const columnAliases = models.length > 0 ? models[0].fields.map(f => fieldAlias(f, models[0])) : [];

  const members: UnionMember[] = models.map((model, i) => {
    if (i > 0) rewriteMemberAliases(model, columnAliases);
    return { name: `Запрос ${i + 1}`, distinct: raw[i].distinct, model };
  });

  const doc: QueryDocument = { members };
  // Квалификация простых голых полей секций УПОРЯДОЧИТЬ/ИТОГИ — после назначения
  // автопсевдонимов и выравнивания колонок объединения (фаза 6.17).
  qualifyBareSectionFields(doc, resolver);
  return doc;
}

/**
 * Помечает квалифицированные поля выборки, чей автопсевдоним конструктор 1С
 * оставляет ПОЛНЫМ точечным путём (а не склейкой сегментов), — навигация по
 * НЕРЕЗОЛВИМОМУ полю источника-ВРЕМЕННОЙ таблицы (фаза 6.18). Сверено с golden:
 * во ВСЕХ случаях оракул печатает `<ВТ>.СтавкаНДС.Перечисление КАК СтавкаНДС.Перечисление`
 * (дотированный псевдоним), когда:
 *  - источник — односегментный `fullName` (имя ВТ, а не `Тип.Объект` метаданных),
 *    не подзапрос и не виртуальная таблица;
 *  - путь навигированный (≥2 сегмента, есть точка);
 *  - ВЕДУЩИЙ сегмент пути НЕ является колонкой ВТ — т.е. ВТ либо неизвестна
 *    резолверу (создана в другом операторе пакета), либо известна, но такой
 *    колонки в ней нет. Тогда конструктор не может развернуть навигацию по
 *    метаданным и сохраняет путь дословно как псевдоним.
 * Если ВЕДУЩИЙ сегмент — реальная колонка ВТ (навигация резолвится), действует
 * обычная склейка (`qualifiedAutoAlias`), флаг не ставится. Без резолвера —
 * консервативно НЕ ставим флаг (поведение прежнее).
 */
function markDottedAutoAlias(model: QueryModel, resolver: MetadataResolver | undefined): void {
  if (!resolver) return;
  for (const f of model.fields) {
    if (!f.qualified || f.alias !== undefined) continue;
    const segs = f.path.split('.');
    if (segs.length < 2) continue;
    const t = model.tables.find(tb => tb.id === f.tableId);
    if (!t || t.subquery || t.virtual || !t.fullName) continue;
    // Источник метаданных всегда многосегментный (`Справочник.X`); односегментное
    // имя — временная таблица (placed `ПОМЕСТИТЬ`).
    if (t.fullName.split('.').length !== 1) continue;
    const meta = resolver.tableByFullName(t.fullName);
    const leadIsColumn = !!meta && meta.fields.some(
      mf => mf.name.toUpperCase() === segs[0].toUpperCase()
    );
    if (!leadIsColumn) f.autoAliasDotted = true;
  }
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

/**
 * Уточняет раскладку параметров регистра бухгалтерии по метаданным (фаза 6.16.11).
 * Парсер на этапе разбора предполагает наличие субконто (прежняя арность). Здесь, имея
 * резолвер, узнаём реальное число субконто (план счетов `maxExtDimensionCount`) и
 * корреспонденцию регистра, перераскладываем сырые позиционные аргументы по
 * `accountingPositionKeys(slice, hasSubconto, corr)` и фиксируем флаги для генератора.
 */
function applyAccountingMeta(model: QueryModel, resolver: MetadataResolver): void {
  const ACC_KEYS: (keyof VirtualParams)[] = [
    'period', 'startPeriod', 'endPeriod', 'periodicity', 'fillMethod', 'condition',
    'accountCondition', 'corrAccountCondition', 'accountDtCondition', 'accountKtCondition', 'order', 'top',
  ];
  for (const t of model.tables) {
    const v = t.virtual;
    if (!v?.accountingArgs || t.subquery || !t.fullName) continue;
    const parts = t.fullName.split('.');
    if (parts[0] !== 'РегистрБухгалтерии') continue;
    const slice = parts[2];
    const base = resolver.tableByFullName(`${parts[0]}.${parts[1]}`);
    const hasSubconto = (base?.subcontoCount ?? 0) > 0;
    const corr = base?.correspondence === true;
    const args = v.accountingArgs;
    // Чистим ранее разложенные позиции и заполняем по корректной раскладке.
    for (const k of ACC_KEYS) delete (v as Record<string, unknown>)[k];
    accountingPositionKeys(slice, hasSubconto, corr).forEach((k, i) => {
      const val = args[i] ?? '';
      if (k && val !== '') (v as Record<string, unknown>)[k] = val;
    });
    v.subconto = hasSubconto;
    if (corr) v.correspondence = true;
    delete v.accountingArgs;
  }
}

/** Признак поля-заглушки `NULL` (ячейка отсутствующей колонки участника). */
function isNullCell(f: SelectedField): boolean {
  return f.expression !== undefined && f.expression.trim().toUpperCase() === 'NULL';
}

/**
 * Переписывает поля участника i>0 по позициям колонок участника 0: i-е поле
 * (в порядке колонок) получает псевдоним i-й колонки. Поля-заглушки `NULL`
 * СОХРАНЯЮТСЯ на своих позициях (позиционное выравнивание `deriveUnionColumns`,
 * 6.15.22): у каждого участника i-я ячейка соответствует i-му столбцу, а
 * `NULL`-заглушка означает «в этом столбце у участника литерал NULL» — её
 * выбрасывание сдвигало бы все последующие столбцы. Псевдоним участникам i>0
 * не печатается (`generateDocument` пишет `КАК` лишь у участника 0), поэтому он
 * нужен лишь для совместимости секций — задаём от колонки, заглушку не трогаем.
 */
function rewriteMemberAliases(model: QueryModel, columnAliases: string[]): void {
  const rewritten: SelectedField[] = [];
  model.fields.forEach((f, k) => {
    if (isNullCell(f)) {
      // Заглушка NULL остаётся как есть на своей позиции столбца.
      rewritten.push(f);
      return;
    }
    const alias = columnAliases[k];
    if (alias === undefined) {
      rewritten.push(f);
      return;
    }
    // Сохраняем все свойства поля (в т.ч. `func` агрегата), задаём лишь явный alias
    // так, чтобы fieldAlias === alias колонки и ячейка (fieldExpr) воспроизводила
    // исходное выражение без `КАК`. Раньше для не-expression поля свойство `func`
    // терялось, и агрегаты разных функций над одним путём (`МИНИМУМ`/`МАКСИМУМ`/
    // `КОЛИЧЕСТВО(Ответ)`) схлопывались на первую функцию (6.15.22).
    rewritten.push({ ...f, alias });
  });
  model.fields = rewritten;
}

// ─────────────────────────── пакет (BATCH) ─────────────────────────────

/**
 * Разделитель пакета запросов 1С (инверсия `generateBatch` с допусками по
 * исходному тексту, фаза 6.15.2): строка из одного `;`, затем ЛЮБОЕ число пустых
 * строк, затем НЕОБЯЗАТЕЛЬНАЯ строка-комментарий из слэшей (4+) с пустыми
 * строками после неё. Канонический вид (`\n;\n\n` + 80 слэшей + `\n`) — частный
 * случай; в реальных исходниках встречаются `;\n////…` без пустой строки,
 * `;\n\n\n////…`, `;////…` (слэши на одной строке с `;`) и голый `;` между
 * запросами — конструктор все их нормализует к каноническому разделителю
 * (подтверждено MCP-пробами и каноном golden-корпуса). Перевод строки после
 * `;` НЕОБЯЗАТЕЛЕН: исходник вида `…Поле\n\n;Выбрать …` (следующий оператор на
 * той же строке, что и `;`) конструктор тоже делит на два запроса (MCP-проба
 * `… ПОМЕСТИТЬ ВТ … ;ВЫБРАТЬ … ИЗ ВТ`). `;` вне строкового литерала/комментария
 * не имеет иного смысла в SDBL, поэтому всегда является разделителем.
 */
const BATCH_SEPARATOR_RE =
  /[ \t]*;[ \t]*(?:\/{4,}[ \t]*)?(?:\n(?:[ \t]*\n)*(?:\/{4,}[ \t]*(?:\n(?:[ \t]*\n)*|$))?)?/gu;

/**
 * Защищённые диапазоны сырого текста `[начало, конец)`, внутри которых `;` НЕ
 * является разделителем пакета: строковые литералы `"…"` (с учётом экранирования
 * `""`, могут содержать переводы строк) И однострочные комментарии `//…` (`;` в
 * комментарии — не разделитель). Нужны `parseBatch`: деление на разделителе
 * выполняется ДО токенизации (фаза 6.16).
 */
function stringLiteralRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2; // экранированная кавычка "" — строка продолжается
            continue;
          }
          i += 1; // закрывающая кавычка
          break;
        }
        i += 1;
      }
      ranges.push([start, i]);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i += 1;
      ranges.push([start, i]);
      continue;
    }
    i += 1;
  }
  return ranges;
}

/**
 * Деление сырого текста пакета по `BATCH_SEPARATOR_RE` с пропуском совпадений,
 * попадающих внутрь строкового литерала (`"абв\n;\nгде"` — НЕ разделитель).
 */
function splitBatchText(text: string): string[] {
  const ranges = stringLiteralRanges(text);
  const insideString = (pos: number): boolean => ranges.some(([s, e]) => pos >= s && pos < e);
  const chunks: string[] = [];
  let last = 0;
  BATCH_SEPARATOR_RE.lastIndex = 0;
  for (let m = BATCH_SEPARATOR_RE.exec(text); m !== null; m = BATCH_SEPARATOR_RE.exec(text)) {
    if (insideString(m.index)) {
      // Ложный кандидат внутри литерала: продолжаем поиск со следующего символа
      // (совпадение могло перекрыть настоящий разделитель сразу после литерала).
      BATCH_SEPARATOR_RE.lastIndex = m.index + 1;
      continue;
    }
    chunks.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  chunks.push(text.slice(last));
  return chunks;
}

/**
 * Разбор пакета запросов в `BatchDocument`. Лексер поглощает строку из 80 `/` как
 * комментарий, поэтому деление по разделителю выполняется на СЫРОМ тексте до
 * токенизации — точно по строке, которую эмитит `generateBatch`. Каждый фрагмент
 * разбирается `parseDocument` (т.е. может быть объединением). Одиночный запрос без
 * разделителя и без объединения корректно даёт пакет из одного документа с одним
 * участником.
 */
/**
 * Фаза 8.1 — привязать комментарии к моделям пакета. Чанк `chunks[i]` — это сырой текст
 * i-го оператора пакета (включая ведущий авто-разделитель `////…`, идущий после `;`).
 * Делегирует `extractDocComments`, который покрывает и одиночный запрос, и ОБЪЕДИНЕНИЕ.
 */
function attachBatchComments(chunks: string[], members: QueryDocument[]): void {
  if (chunks.length !== members.length) return;
  members.forEach((doc, i) => extractDocComments(chunks[i], doc));
}

export function parseBatch(
  text: string,
  resolver?: MetadataResolver,
  opts?: ParseOptions,
): BatchDocument {
  // Хвостовой разделитель пакета `;` (с возможными пробелами/переводами строк)
  // конструктор отбрасывает: `;` — концерн МЕЖДУ операторами, после последнего
  // оператора его нет. Снимаем до разбиения, чтобы он не попал в текст условия.
  const normalized = text.replace(/\s*;\s*$/u, '');
  // Пустые фрагменты после деления (хвостовой разделитель `;\n////…` без
  // следующего запроса) конструктор отбрасывает — канон заканчивается последним
  // запросом без хвостового разделителя.
  const chunks = splitBatchText(normalized).filter((c) => c.trim() !== '');

  // Межоператорная резолвинг временных таблиц (фаза 6.17): временная таблица,
  // созданная ранним `ПОМЕСТИТЬ <ВТ>`, должна быть видна последующим операторам,
  // чтобы `ВЫБРАТЬ * ИЗ <ВТ>` / `<ВТ>.*` развернулись в её колонки. Колонки ВТ =
  // псевдонимы списка выборки оператора-создателя (участник 0 объединения). Парсим
  // операторы ПО ПОРЯДКУ, накапливая реестр ВТ, и передаём расширенный резолвер в
  // `parseDocument` каждого следующего оператора — там `expandStarFields` разворачивает
  // звезду по синтетической таблице ВТ ровно так же, как по реальной (MCP-проба:
  // `* ИЗ ВТ` → `ВТ.Колонка КАК Колонка`).
  const tempTables = new Map<string, MetaTable>();
  const members = chunks.map((c) => {
    const doc = parseDocument(c, augmentResolverWithTempTables(resolver, tempTables));
    registerTempTables(doc, tempTables);
    return doc;
  });

  // Развёртка `*` / `Алиас.*` по НЕОПРЕДЕЛённой временной таблице (фаза 6.19): если
  // источник секции ИЗ — односегментная ВТ, которую пакет НЕ создаёт `ПОМЕСТИТЬ` и
  // которой нет в метаданных, конструктор 1С всё равно разворачивает по ней звезду,
  // ВЫВОДЯ её колонки = множество односегментных ссылок `<алиас>.<кол>` на эту ВТ,
  // собранных ПО ВСЕМУ ПАКЕТУ в порядке первого появления (дедуп). Состав звезды затем
  // получает обычный дедуп-суффикс коллизий (сверено по живому оракулу). Первый проход
  // выше уже определил источники/псевдонимы; собираем выведенные колонки и, если они
  // есть, ПЕРЕразбираем пакет с синтетическими метаданными этих ВТ.
  const inf = inferUndefinedTempTables(chunks, members, resolver);
  if (inf.tables.size === 0) {
    if (opts?.preserveComments) attachBatchComments(chunks, members);
    return { members };
  }

  const tempTables2 = new Map<string, MetaTable>();
  const members2 = chunks.map((c, i) => {
    // Выведенная ВТ доступна оператору ТОЛЬКО если на неё была ссылка в ПРЕДЫДУЩЕМ
    // операторе пакета (сверено по оракулу: звезда в первом операторе, где ВТ ещё ни
    // разу не упоминалась раньше, НЕ разворачивается). Состав колонок при этом —
    // глобальный (по всему пакету); позиционна лишь сама доступность.
    const visible = new Map<string, MetaTable>();
    for (const [up, t] of inf.tables) {
      const first = inf.firstRefChunk.get(up);
      if (first !== undefined && first < i) visible.set(up, t);
    }
    const doc = parseDocument(
      c,
      augmentResolverWithTempTables(resolver, tempTables2, visible.size ? visible : undefined),
    );
    registerTempTables(doc, tempTables2);
    return doc;
  });
  if (opts?.preserveComments) attachBatchComments(chunks, members2);
  return { members: members2 };
}

/**
 * Выводит синтетические метаданные НЕОПРЕДЕЛённых временных таблиц пакета (фаза 6.19).
 * Возвращает карту `ИМЯ_ВТ(upper) → MetaTable` только для ВТ, которые:
 *   - используются как источник секции ИЗ хотя бы одного оператора (односегментный
 *     fullName, без подзапроса/виртуальных параметров);
 *   - НЕ создаются в этом пакете `ПОМЕСТИТЬ` (нет в реестре `definedTemps`);
 *   - НЕ разрешаются базовым резолвером (не реальная/виртуальная таблица метаданных);
 *   - имеют хотя бы одну выведенную колонку (есть ссылки `<алиас>.<кол>`).
 * Колонки = односегментные ссылки `<алиас>.<кол>` на псевдонимы такой ВТ, собранные по
 * ВСЕМУ СЫРОМУ ТЕКСТУ пакета в порядке первого появления, дедуп без учёта регистра.
 */
function inferUndefinedTempTables(
  chunks: string[],
  members: QueryDocument[],
  resolver: MetadataResolver | undefined,
): { tables: Map<string, MetaTable>; firstRefChunk: Map<string, number> } {
  // Индекс оператора `ПОМЕСТИТЬ <ВТ>` (когда ВТ ОПРЕДЕЛЯЕТСЯ). ВТ, ОПРЕДЕЛённая
  // ПОЗЖЕ места использования (или вовсе не определённая в пакете), на момент
  // оператора-источника ещё не существует → её колонки выводятся (фаза 6.19).
  const defineChunk = new Map<string, number>(); // ИМЯ_ВТ(upper) → индекс ПОМЕСТИТЬ
  members.forEach((doc, i) => {
    const m0 = doc.members[0]?.model;
    if (m0?.queryType === 'createTemp' && m0.tempTableName) {
      const up = m0.tempTableName.toUpperCase();
      if (!defineChunk.has(up)) defineChunk.set(up, i);
    }
  });

  // Кандидаты: имена ВТ-источников, неопределённые НА МОМЕНТ использования и
  // нерезолвимые. Собираем заодно карту псевдоним(upper) → ИМЯ_ВТ(upper) ПО
  // ОПЕРАТОРАМ (псевдоним может отличаться).
  const candidates = new Set<string>();
  const aliasToTempPerChunk: Map<string, string>[] = members.map((doc, i) => {
    const map = new Map<string, string>();
    for (const m of doc.members) {
      for (const t of m.model.tables) {
        if (t.subquery || t.virtual || !t.fullName) continue;
        if (t.fullName.includes('.')) continue; // не односегментная — не ВТ-имя
        const up = t.fullName.toUpperCase();
        const def = defineChunk.get(up);
        if (def !== undefined && def <= i) continue; // уже создана ПОМЕСТИТЬ к этому моменту
        if (resolver?.tableByFullName?.(t.fullName)) continue; // реальная таблица
        if (resolver?.virtualTableByFullName?.(t.fullName)) continue; // виртуальная
        const alias = (t.alias ?? t.fullName).toUpperCase();
        map.set(alias, up);
        candidates.add(up);
      }
    }
    return map;
  });
  if (candidates.size === 0) return { tables: new Map(), firstRefChunk: new Map() };

  // Колонки в порядке первого появления `<алиас>.<кол>` по всему пакету.
  const cols = new Map<string, string[]>(); // ИМЯ_ВТ(upper) → колонки (как написаны)
  const seen = new Map<string, Set<string>>(); // ИМЯ_ВТ(upper) → виденные (upper)
  const firstRefChunk = new Map<string, number>(); // ИМЯ_ВТ(upper) → индекс первого оператора-ссылки
  for (const c of candidates) { cols.set(c, []); seen.set(c, new Set()); }

  const ref = /([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\.([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)(\.)?/gu;
  chunks.forEach((chunk, i) => {
    const aliasMap = aliasToTempPerChunk[i];
    if (aliasMap.size === 0) return;
    let mt: RegExpExecArray | null;
    ref.lastIndex = 0;
    while ((mt = ref.exec(chunk)) !== null) {
      const tempName = aliasMap.get(mt[1].toUpperCase());
      if (!tempName) continue;
      if (!firstRefChunk.has(tempName)) firstRefChunk.set(tempName, i);
      if (mt[3]) continue; // `<алиас>.<кол>.<...>` — многосегментная, не колонка ВТ
      const colUp = mt[2].toUpperCase();
      const s = seen.get(tempName)!;
      if (s.has(colUp)) continue;
      s.add(colUp);
      cols.get(tempName)!.push(mt[2]);
    }
  });

  // Звёздные ВТ: только те, по которым в каком-либо операторе есть `*` / `Алиас.*`
  // (иначе выведенные метаданные не нужны и лишь возмущают прочие проходы — агрегаты,
  // канонизацию, квалификацию). `Алиас.*` атрибутируется своему псевдониму;
  // голая `*` — всем ВТ-кандидатам-источникам своего оператора.
  const starred = new Set<string>();
  // Сырой токен звезды: голая `*` (поле выборки) или `<алиас>.*`. Перед `*` —
  // граница (запятая/перенос/«ВЫБРАТЬ»/скобка), чтобы не путать с умножением.
  const dotStar = /([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\.\*/gu;
  const bareStar = /(^|[,(\n\r\t ])\*(?=\s*(?:,|$|\r|\n))/gmu;
  chunks.forEach((chunk, i) => {
    const aliasMap = aliasToTempPerChunk[i];
    if (aliasMap.size === 0) return;
    let m: RegExpExecArray | null;
    dotStar.lastIndex = 0;
    while ((m = dotStar.exec(chunk)) !== null) {
      const t = aliasMap.get(m[1].toUpperCase());
      if (t) starred.add(t);
    }
    if (bareStar.test(chunk)) {
      for (const t of aliasMap.values()) starred.add(t);
    }
  });

  const out = new Map<string, MetaTable>();
  for (const [up, columns] of cols) {
    if (columns.length === 0) continue;
    if (!starred.has(up)) continue; // нет звезды по этой ВТ — метаданные не выводим
    // Каноническое имя ВТ — как написано в первом источнике (любой регистр сохраняем).
    let name = up;
    outer: for (const doc of members) {
      for (const m of doc.members) {
        for (const t of m.model.tables) {
          if (t.fullName && t.fullName.toUpperCase() === up) { name = t.fullName; break outer; }
        }
      }
    }
    const fields: MetaField[] = columns.map((c) => ({ name: c, kind: 'attribute', types: [] }));
    out.set(up, { kind: 'Справочник', name, fullName: name, fields });
  }
  return { tables: out, firstRefChunk };
}

/**
 * Регистрирует временные таблицы, созданные документом-оператором (`ПОМЕСТИТЬ <ВТ>`),
 * в реестре `tempTables` (ключ — имя ВТ в верхнем регистре, ВТ нечувствительны к
 * регистру). Колонки ВТ = эффективные псевдонимы списка выборки участника 0
 * (объединение задаёт колонки первым участником). Реестр служит синтетическими
 * метаданными для развёртки звезды в последующих операторах.
 */
/**
 * Выражение поля create-temp — ЧИСТЫЙ скалярный литерал (строка `"…"`, число,
 * `ИСТИНА`/`ЛОЖЬ`)? Такая колонка ВТ заведомо нессылочная — суффикс `.*` на ней
 * снимается. Любое поле/функция/параметр → false (тип неизвестен, `.*` сохраняем).
 */
function isScalarLiteralExpr(expr: string | undefined): boolean {
  if (expr === undefined) return false;
  const s = expr.trim();
  if (s === '') return false;
  if (/^"(?:[^"]|"")*"$/.test(s)) return true;        // строковый литерал
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return true;      // числовой литерал
  if (/^(?:ИСТИНА|ЛОЖЬ)$/iu.test(s)) return true;       // булев литерал
  return false;
}

function registerTempTables(doc: QueryDocument, tempTables: Map<string, MetaTable>): void {
  const m0 = doc.members[0]?.model;
  if (!m0 || m0.queryType !== 'createTemp' || !m0.tempTableName) return;
  const cols: { alias: string; scalar: boolean }[] = [];
  const seen = new Set<string>();
  for (const f of m0.fields) {
    const a = fieldAlias(f, m0);
    // Звезда, которую не удалось развернуть (нерезолвимый источник самой ВТ),
    // остаётся как поле-выражение `*` — её в реестр колонок не добавляем.
    if (!a || a === '*') continue;
    let alias = a;
    let n = 0;
    while (seen.has(alias.toUpperCase())) alias = `${a}${++n}`;
    seen.add(alias.toUpperCase());
    cols.push({ alias, scalar: isScalarLiteralExpr(f.expression) });
  }
  if (cols.length === 0) return;
  // Колонка из ЧИСТОГО литерала (`"строка"`/число/булево) — ДОКАЗУЕМО нессылочная:
  // даём ей примитивный тип, чтобы `resolveBuilderStar` снял `.*` (`Товары.Ссылка.*`
  // на ВТ, где `Ссылка` — строковый литерал, → `Товары.Ссылка`). Прочие колонки
  // остаются с `types: []` (состав неизвестен — `.*` консервативно сохраняется).
  const fields: MetaField[] = cols.map(({ alias, scalar }) => ({
    name: alias,
    kind: 'attribute',
    types: scalar ? [{ primitive: 'Строка' as const }] : [],
  }));
  tempTables.set(m0.tempTableName.toUpperCase(), {
    kind: 'Справочник', // вид не используется развёрткой ВТ (нет ТЧ/виртуальных полей)
    name: m0.tempTableName,
    fullName: m0.tempTableName,
    fields,
  });
}

/**
 * Возвращает резолвер, который поверх базового (реальные метаданные) знает о
 * временных таблицах из реестра `tempTables`. Если реестр пуст — отдаёт базовый
 * резолвер без обёртки (поведение байт-в-байт прежнее для пакетов без ВТ).
 * Имя источника ВТ во вводе квалифицируется как обычный односегментный `fullName`
 * (`ИЗ ВТ КАК ВТ` → fullName `ВТ`); ВТ нечувствительны к регистру.
 */
function augmentResolverWithTempTables(
  base: MetadataResolver | undefined,
  tempTables: Map<string, MetaTable>,
  // Выведенные метаданные НЕОПРЕДЕЛённых ВТ пакета (фаза 6.19): резолвятся ниже
  // реальных метаданных и ПОМЕСТИТЬ-реестра — только для имён, не определённых иначе.
  inferred?: Map<string, MetaTable>,
): MetadataResolver | undefined {
  if (tempTables.size === 0 && (!inferred || inferred.size === 0)) return base;
  const lookup = (fullName: string): MetaTable | undefined => {
    const up = fullName.toUpperCase();
    return (
      tempTables.get(up) ?? base?.tableByFullName(fullName) ?? inferred?.get(up)
    );
  };
  return {
    tableByFullName: lookup,
    // Виртуальный слой пробрасываем как есть — ВТ виртуальных таблиц не имеют.
    virtualTableByFullName: (fullName: string): MetaTable | undefined =>
      base?.virtualTableByFullName?.(fullName),
    // Канонизация ИМЕНИ источника-ВТ к написанию её определения `ПОМЕСТИТЬ <имя>`
    // (фаза 6.16.76): `ВтВзносыБезОкругления`→`ВТВзносыБезОкругления`. ВТ
    // нечувствительны к регистру; реестр хранит каноническое имя из определения.
    canonicalFullName: (fullName: string): string | undefined =>
      tempTables.get(fullName.toUpperCase())?.name ?? base?.canonicalFullName?.(fullName),
  };
}
