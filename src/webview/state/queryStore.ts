import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField, SelectedTabSectionField, VirtualParams, Grouping, AggregateFunction, Condition, ConditionOperator, Selection, QueryType, QueryModel, QueryComments, Join, JoinCondition, Order, SortDirection, Totals, TotalKind, ReportBuilder, BuilderField, Indexing, QueryIndex, FieldRef } from '../../core/query/queryModel';
import { defaultTableAlias } from '../../core/query/queryModel';
import type { RefId } from '../../shared/messages';
import type { MetaField } from '../../core/metadata/types';
import { fieldAlias, deriveUnionColumns, type UnionMember, type QueryDocument } from '../../core/query/unionModel';
import type { BatchDocument } from '../../core/query/batchModel';

/** Метаданные одного запроса-участника объединения. */
export interface QueryMeta {
  name: string;
  distinct: boolean;
}

/**
 * Сериализуемое состояние одного запроса (working set без общих/транзитных полей).
 * Хранится в `savedQueries` для всех неактивных запросов; активный живёт в плоских полях.
 */
export interface SavedQuery {
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  tabSectionFields: SelectedTabSectionField[];
  grouping: Grouping;
  conditions: Condition[];
  joins: Join[];
  selection: Selection;
  queryType: QueryType;
  tempTableName: string;
  lockForUpdate: string[];
  order: Order;
  totals: Totals;
  builder: ReportBuilder;
  indexing: Indexing;
  /** Фаза 8.1 — комментарии запроса уровня контейнера (beforeSelect/afterFrom). */
  comments?: QueryComments;
}

/** Пустой построитель отчёта: все секции без строк. */
function emptyBuilder(): ReportBuilder {
  return { fields: [], conditions: [], order: [], totals: [] };
}

/** Секция построителя, по которой работают действия ADD/REMOVE/SET_BUILDER_FIELD_*. */
type BuilderSection = 'fields' | 'conditions' | 'order' | 'totals';

/** Иммутабельно обновить одну секцию построителя. */
function updateBuilderSection(
  builder: ReportBuilder,
  section: BuilderSection,
  fn: (rows: BuilderField[]) => BuilderField[]
): ReportBuilder {
  return { ...builder, [section]: fn(builder[section]) };
}

/** Снимок одного запроса пакета = полное состояние его документа объединения. */
export interface BatchSnapshot {
  queryList: QueryMeta[];
  activeQuery: number;
  savedQueries: SavedQuery[]; // без null — активный участник заполнен из плоских полей
}

export interface QueryState {
  tables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  tabSectionFields: SelectedTabSectionField[];
  grouping: Grouping;
  conditions: Condition[];
  joins: Join[];
  selection: Selection;
  queryType: QueryType;
  tempTableName: string;
  lockForUpdate: string[];
  order: Order;
  totals: Totals;
  builder: ReportBuilder;
  indexing: Indexing;
  /** Фаза 8.1 — комментарии активного запроса уровня контейнера (beforeSelect/afterFrom). */
  queryComments?: QueryComments;
  lockEnabled: boolean;
  expandedRefs: Map<string, MetaField[]>;
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedTableId: string | null;
  focusedSelectedFieldIdx: number | null;
  // --- слой документа объединения ---
  /** Метаданные всех запросов-участников (включая активный). */
  queryList: QueryMeta[];
  /** Индекс активного запроса (его working set живёт в плоских полях выше). */
  activeQuery: number;
  /** Снимок working set каждого запроса; слот активного запроса = null (живёт в плоских полях). */
  savedQueries: (SavedQuery | null)[];
  // --- слой пакета запросов ---
  /** Индекс активного запроса пакета. */
  activeBatch: number;
  /** Снимки запросов пакета; слот активного = null (живёт в queryList/savedQueries/плоских полях). */
  batchSaved: (BatchSnapshot | null)[];
}

export type QueryAction =
  | { type: 'SET_METADATA'; tables: MetaTable[] }
  | { type: 'SET_REF_FIELDS'; ref: RefId; fields: MetaField[] }
  | { type: 'FOCUS_DB_TABLE'; fullName: string }
  | { type: 'FOCUS_DB_FIELD'; tableFullName: string; fieldPath: string }
  | { type: 'ADD_TABLE'; table: MetaTable }
  | { type: 'REMOVE_TABLE'; tableId: string }
  | { type: 'ADD_FIELD'; tableId: string; fieldPath: string }
  | { type: 'ADD_FIELD_WITH_TABLE'; tableFullName: string; fieldPath: string }
  // 7.8.6: перетаскивание таблицы в список «Поля» → все поля таблицы.
  | { type: 'ADD_ALL_FIELDS_WITH_TABLE'; tableFullName: string; fieldPaths: string[] }
  // 7.8.16: двойной клик по выбранной таблице → все её поля (дубли разрешены).
  | { type: 'ADD_ALL_FIELDS_DUP'; tableId: string }
  // 7.8.5: двойной клик по полю → правка как произвольного выражения (на месте).
  | { type: 'SET_FIELD_EXPRESSION'; fieldIdx: number; expression: string }
  // 7.8.8 / 7.8.9: источник-подзапрос / описание временной таблицы.
  | { type: 'ADD_SUBQUERY_TABLE'; name: string; subquery: QueryDocument; columns: string[] }
  | { type: 'ADD_TEMP_TABLE'; name: string; fields: { name: string }[] }
  // 7.8.14: двойной клик по синониму ВТ переоткрывает окно; ОК обновляет существующую ВТ.
  | { type: 'UPDATE_TEMP_TABLE'; tableId: string; name: string; fields: { name: string }[] }
  // 7.8.15: двойной клик по синониму подзапроса переоткрывает конструктор; ОК обновляет подзапрос.
  | { type: 'UPDATE_SUBQUERY_TABLE'; tableId: string; subquery: QueryDocument; columns: string[] }
  | { type: 'REMOVE_FIELD'; fieldIdx: number }
  | { type: 'ADD_TAB_SECTION_WITH_TABLE'; parentTableFullName: string; tsName: string; tsFullName: string; tsFields: string[] }
  | { type: 'REMOVE_TAB_SECTION'; tableId: string; tsName: string }
  | { type: 'REMOVE_TAB_SECTION_SUB_FIELD'; tableId: string; tsName: string; fieldName: string }
  | { type: 'FOCUS_SELECTED_TABLE'; id: string }
  | { type: 'FOCUS_SELECTED_FIELD'; idx: number }
  | { type: 'SET_VIRTUAL_PARAMS'; tableId: string; params: VirtualParams }
  | { type: 'ADD_EXPRESSION_FIELD'; tableId: string; expression: string; alias?: string }
  | { type: 'SET_GROUPING_MULTIPLE'; multiple: boolean }
  | { type: 'ADD_GROUP_FIELD'; tableId: string; path: string }
  | { type: 'REMOVE_GROUP_FIELD'; tableId: string; path: string }
  | { type: 'ADD_SUMMABLE_FIELD'; tableId: string; path: string; func: AggregateFunction }
  | { type: 'REMOVE_SUMMABLE_FIELD'; tableId: string; path: string }
  | { type: 'SET_SUMMABLE_FUNC'; tableId: string; path: string; func: AggregateFunction }
  | { type: 'ADD_GROUP_SET' }
  | { type: 'REMOVE_GROUP_SET'; index: number }
  | { type: 'ADD_FIELD_TO_SET'; index: number; tableId: string; path: string }
  | { type: 'REMOVE_FIELD_FROM_SET'; index: number; tableId: string; path: string }
  | { type: 'ADD_CONDITION'; tableId: string; path: string }
  | { type: 'REMOVE_CONDITION'; index: number }
  | { type: 'SET_CONDITION_CUSTOM'; index: number; custom: boolean }
  | { type: 'SET_CONDITION_OPERATOR'; index: number; operator: ConditionOperator }
  | { type: 'SET_CONDITION_PARAM'; index: number; param: string }
  | { type: 'SET_CONDITION_EXPRESSION'; index: number; expression: string }
  | { type: 'ADD_JOIN' }
  | { type: 'REMOVE_JOIN'; index: number }
  | { type: 'ADD_JOIN_CONDITION'; index: number }
  | { type: 'REMOVE_JOIN_CONDITION'; index: number; condIndex: number }
  | { type: 'SET_JOIN_TABLE'; index: number; side: 'left' | 'right'; tableId: string; condIndex?: number }
  | { type: 'SET_JOIN_ALL'; index: number; side: 'left' | 'right'; value: boolean }
  | { type: 'SET_JOIN_CUSTOM'; index: number; custom: boolean; condIndex?: number }
  | { type: 'SET_JOIN_FIELD'; index: number; side: 'left' | 'right'; path: string; condIndex?: number }
  | { type: 'SET_JOIN_OPERATOR'; index: number; operator: ConditionOperator; condIndex?: number }
  | { type: 'SET_JOIN_EXPRESSION'; index: number; expression: string; condIndex?: number }
  | { type: 'SET_SELECTION_TOP'; top: number | undefined }
  | { type: 'SET_SELECTION_DISTINCT'; distinct: boolean }
  | { type: 'SET_SELECTION_ALLOWED'; allowed: boolean }
  | { type: 'SET_QUERY_TYPE'; queryType: QueryType }
  | { type: 'SET_TEMP_TABLE_NAME'; name: string }
  | { type: 'SET_LOCK_ENABLED'; enabled: boolean }
  | { type: 'ADD_LOCK_TABLE'; fullName: string }
  | { type: 'REMOVE_LOCK_TABLE'; fullName: string }
  // --- слой документа объединения ---
  | { type: 'ADD_QUERY' }
  | { type: 'SET_ACTIVE_QUERY'; index: number }
  | { type: 'REMOVE_QUERY'; index: number }
  | { type: 'RENAME_QUERY'; index: number; name: string }
  | { type: 'SET_QUERY_DISTINCT'; index: number; distinct: boolean }
  | { type: 'SET_COLUMN_ALIAS'; alias: string; newAlias: string }
  // 8.3.1: перемещение колонки (поля) объединения вверх/вниз — позиционный своп
  // i-го и соседнего скалярного поля во ВСЕХ участниках объединения.
  | { type: 'MOVE_UNION_COLUMN'; index: number; dir: 'up' | 'down' }
  // --- слой пакета запросов ---
  | { type: 'ADD_BATCH_QUERY' }
  | { type: 'SET_ACTIVE_BATCH'; index: number }
  | { type: 'REMOVE_BATCH_QUERY'; index: number }
  | { type: 'MOVE_BATCH_QUERY'; index: number; dir: 'up' | 'down' }
  | { type: 'LOAD_BATCH'; doc: BatchDocument }
  // --- порядок (УПОРЯДОЧИТЬ ПО) ---
  | { type: 'ADD_ORDER_FIELD'; tableId: string; path: string }
  | { type: 'REMOVE_ORDER_FIELD'; tableId: string; path: string }
  | { type: 'SET_ORDER_DIRECTION'; tableId: string; path: string; direction: SortDirection }
  | { type: 'SET_ORDER_AUTO'; auto: boolean }
  // --- итоги (ИТОГИ … ПО …) ---
  | { type: 'ADD_TOTAL_GROUP_FIELD'; tableId: string; path: string }
  | { type: 'REMOVE_TOTAL_GROUP_FIELD'; tableId: string; path: string }
  | { type: 'SET_TOTAL_GROUP_KIND'; tableId: string; path: string; kind: TotalKind }
  | { type: 'SET_TOTAL_GROUP_ALIAS'; tableId: string; path: string; alias: string }
  | { type: 'ADD_TOTAL_FIELD'; tableId: string; path: string }
  // 8.3.2: удаление/смена функции итогового поля адресуются по ИНДЕКСУ — у
  // распарсенных агрегатов tableId/path пусты, поэтому (tableId,path) не уникален.
  | { type: 'REMOVE_TOTAL_FIELD'; index: number }
  | { type: 'SET_TOTAL_FIELD_FUNC'; index: number; func: AggregateFunction }
  | { type: 'SET_TOTAL_GRAND'; grand: boolean }
  // --- построитель (отчёт) ---
  | { type: 'ADD_BUILDER_FIELD'; section: BuilderSection; field: BuilderField }
  | { type: 'REMOVE_BUILDER_FIELD'; section: BuilderSection; index: number }
  | { type: 'SET_BUILDER_FIELD_CHILD'; section: BuilderSection; index: number; child: boolean }
  | { type: 'SET_BUILDER_FIELD_ALIAS'; section: BuilderSection; index: number; alias: string }
  // --- индексы (ИНДЕКСИРОВАТЬ ПО) ---
  | { type: 'ADD_INDEX' }
  | { type: 'COPY_INDEX'; index: number }
  | { type: 'REMOVE_INDEX'; index: number }
  | { type: 'MOVE_INDEX'; index: number; dir: 'up' | 'down' }
  | { type: 'SET_INDEX_UNIQUE'; index: number; unique: boolean }
  | { type: 'ADD_INDEX_FIELD'; index: number; tableId: string; path: string }
  | { type: 'ADD_ALL_INDEX_FIELDS'; index: number; fields: FieldRef[] }
  | { type: 'REMOVE_INDEX_FIELD'; index: number; tableId: string; path: string }
  | { type: 'CLEAR_INDEX_FIELDS'; index: number }
  | { type: 'MOVE_INDEX_FIELD'; index: number; tableId: string; path: string; dir: 'up' | 'down' };

export function initialState(): QueryState {
  return {
    tables: [],
    selectedTables: [],
    selectedFields: [],
    tabSectionFields: [],
    grouping: { multiple: false, groupFields: [], groupSets: [], aggregates: [] },
    conditions: [],
    joins: [],
    selection: {},
    queryType: 'select',
    tempTableName: '',
    lockForUpdate: [],
    order: { fields: [], auto: false },
    totals: { groupFields: [], totalFields: [], grand: false },
    builder: emptyBuilder(),
    indexing: { indexes: [] },
    queryComments: undefined,
    lockEnabled: false,
    expandedRefs: new Map(),
    focusedDbTableFullName: null,
    focusedDbFieldPath: null,
    focusedSelectedTableId: null,
    focusedSelectedFieldIdx: null,
    queryList: [{ name: 'Запрос 1', distinct: false }],
    activeQuery: 0,
    savedQueries: [null],
    activeBatch: 0,
    batchSaved: [null],
  };
}

let _tableCounter = 0;

/**
 * Синтетическая метатаблица для источника-подзапроса / временной таблицы. Вид
 * `ТабличнаяЧасть` НЕ входит в группы дерева метаданных (`DbTreePanel`), поэтому
 * такая таблица не засоряет левое дерево, но её колонки резолвятся по `fullName`
 * в `TablesPanel`/`fieldsForTable` как у обычного источника.
 */
function syntheticSourceTable(fullName: string, fields: MetaField[]): MetaTable {
  return { kind: 'ТабличнаяЧасть', name: fullName, fullName, fields };
}

/** Уникальное имя источника среди метатаблиц и уже выбранных таблиц (base, base2, …). */
function uniqueSourceName(state: QueryState, base: string): string {
  const taken = new Set<string>([
    ...state.tables.map(t => t.fullName),
    ...state.selectedTables.map(t => t.fullName),
  ]);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

/**
 * 7.8.8-fix3 — колонки источника-ВТ из ссылок на его поля. У ссылки на временную
 * таблицу (`ИЗ ВТ КАК ВТ`, без ПОМЕСТИТЬ в запросе) нет описания колонок — известны
 * лишь поля, на которые ссылаются `ВТ.<поле>` в выборке/условиях/группировке/порядке/
 * итогах. Собираем их различимые первые сегменты как колонки синтетической метатаблицы.
 */
function collectTempColumns(model: QueryModel, tableId: string): string[] {
  const cols: string[] = [];
  const add = (path?: string): void => {
    if (!path) return;
    const col = path.split('.')[0];
    if (col && !cols.includes(col)) cols.push(col);
  };
  for (const f of model.fields) if (f.tableId === tableId) add(f.path);
  for (const c of model.conditions ?? []) if (c.tableId === tableId) add(c.path);
  const g = model.grouping;
  if (g) {
    for (const f of g.groupFields) if (f.tableId === tableId) add(f.path);
    for (const set of g.groupSets) for (const f of set) if (f.tableId === tableId) add(f.path);
    for (const f of g.aggregates) if (f.tableId === tableId) add(f.path);
  }
  for (const f of model.order?.fields ?? []) if (f.tableId === tableId) add(f.path);
  for (const f of model.totals?.groupFields ?? []) if (f.tableId === tableId) add(f.path);
  for (const f of model.totals?.totalFields ?? []) if (f.tableId === tableId) add(f.path);
  return cols;
}

/**
 * 7.8.8-fix3 — пометить источники-ссылки на временные таблицы и синтезировать их
 * метатаблицы при открытии из текста. Парсер отдаёт ссылку `ИЗ ВТ КАК ВТ` обычным
 * `SelectedTable` (односегментное имя, без флага) — конструктор не отличал её от
 * реальной таблицы: двойной клик не открывал окно ВТ, раскрытие не показывало полей.
 * Источник считаем ссылкой на ВТ, если он не подзапрос, не виртуальная таблица, имя
 * односегментное (без точки) и не разрешается в метаданных (`known`). Имя ВТ может
 * начинаться на `&` (передача ТЗ/ВТ параметром: `&ВТ КАК ВТ`) или `#` (подстановка) —
 * это тоже ссылка на ВТ, её поля адресуются по псевдониму. Помечаем `tempTable:true`
 * (ДО `docToSnapshot`) и собираем синтетическую `ТабличнаяЧасть` с
 * колонками из `collectTempColumns` (объединение по всем участникам пакета — одно имя
 * ВТ = одна метатаблица). Генерация не меняется: источник печатается как `ВТ КАК ВТ`.
 */
function synthesizeTempTables(doc: BatchDocument, known: Set<string>): MetaTable[] {
  const byName = new Map<string, string[]>();
  const order: string[] = [];
  for (const query of doc.members) {
    for (const member of query.members) {
      for (const sel of member.model.tables) {
        if (sel.subquery || sel.virtual || !sel.fullName) continue;
        if (sel.fullName.includes('.') || known.has(sel.fullName)) continue;
        sel.tempTable = true;
        if (!byName.has(sel.fullName)) { byName.set(sel.fullName, []); order.push(sel.fullName); }
        const acc = byName.get(sel.fullName)!;
        for (const col of collectTempColumns(member.model, sel.id)) if (!acc.includes(col)) acc.push(col);
      }
    }
  }
  return order.map(fullName => {
    const fields: MetaField[] = byName.get(fullName)!.map(c => ({ name: c, kind: 'attribute', types: [] }));
    return syntheticSourceTable(fullName, fields);
  });
}

/**
 * 7.8.8-fix2 — синхронизация счётчика id таблиц с распарсенным пакетом.
 * Парсер нумерует таблицы позиционно (`t0`, `t1`, … в каждом запросе), а
 * интерактивные добавления (`ADD_TABLE`/`ADD_TEMP_TABLE`/`ADD_SUBQUERY_TABLE`/
 * произвольные поля) берут id из общего `_tableCounter`. После открытия текста
 * счётчик должен стать больше любого загруженного индекса, иначе следующая
 * добавленная таблица получит уже занятый id (например, `t1`) и склеится с
 * загруженной: `resolveAliases` ключует псевдонимы по id — поздняя таблица затрёт
 * псевдоним ранней (подзапрос печатался `КАК ВТ`, поля путались).
 */
function syncTableCounter(doc: BatchDocument): void {
  let max = _tableCounter;
  for (const query of doc.members) {
    for (const member of query.members) {
      for (const sel of member.model.tables) {
        const m = /^t(\d+)$/.exec(sel.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
  }
  _tableCounter = max;
}

/**
 * 7.8.8-fix — синтез метатаблиц для источников-подзапросов при открытии из текста.
 * Парсер (`parseTableSource`) отдаёт источник `(ВЫБРАТЬ …) КАК Т` с пустым `fullName`
 * и без колонок: колонки подзапроса живут только в `subquery.members[].model.fields`.
 * Интерактивная ветка `ADD_SUBQUERY_TABLE` создаёт синтетическую `ТабличнаяЧасть`
 * (колонки резолвятся по `fullName` в `TablesPanel`/`fieldsForTable`); открытие из
 * текста этого не делало — поэтому конструктор не видел полей вложенного запроса.
 * Обходим весь распарсенный пакет (запросы пакета → участники объединения → таблицы),
 * и каждому источнику-подзапросу с пустым `fullName` назначаем уникальное имя и
 * собираем синтетическую метатаблицу с колонками из `deriveUnionColumns`. `fullName`
 * проставляется ДО `docToSnapshot`, который переносит те же объекты `SelectedTable`
 * в снимок (псевдоним `alias` не трогаем — генератор печатает `КАК <alias>`).
 */
function synthesizeSubqueryTables(doc: BatchDocument, taken: Set<string>): MetaTable[] {
  const metas: MetaTable[] = [];
  for (const query of doc.members) {
    for (const member of query.members) {
      for (const sel of member.model.tables) {
        if (!sel.subquery || sel.fullName) continue;
        const base = (sel.alias ?? '').trim() || 'ВложенныйЗапрос';
        let name = base;
        let i = 2;
        while (taken.has(name)) name = `${base}${i++}`;
        taken.add(name);
        sel.fullName = name;
        const fields: MetaField[] = deriveUnionColumns(sel.subquery.members).map(c => ({
          name: c.alias,
          kind: 'attribute',
          types: [],
        }));
        metas.push(syntheticSourceTable(name, fields));
      }
    }
  }
  return metas;
}

// ============================================================================
// Слой документа объединения: снимок/восстановление активного запроса.
// ============================================================================

/**
 * Предзаполнение окна «Временная таблица» для существующего источника-ВТ (двойной
 * клик). Имя — РЕАЛЬНОЕ имя ВТ (`sel.fullName`, напр. `#ВТ`/`&ВТ`), а НЕ
 * `defaultTableAlias` (тот отбрасывает ведущий `#` и подставляет псевдоним): иначе
 * двойной клик по `#ВТ КАК ВТ` показывал «ВТ», и ОК переименовывал источник в `ВТ`,
 * теряя `#`. Поля — из синтетической метатаблицы источника.
 */
export function tempTableDialogInitial(
  state: QueryState,
  editId: string,
): { name: string; fields: { name: string }[] } | undefined {
  const sel = state.selectedTables.find(t => t.id === editId);
  if (!sel) return undefined;
  const meta = state.tables.find(t => t.fullName === sel.fullName);
  if (!meta) return undefined;
  return { name: sel.fullName, fields: meta.fields.map(f => ({ name: f.name })) };
}

/** Извлечь working set активного запроса (плоские поля) в сериализуемый SavedQuery. */
export function snapshotActive(state: QueryState): SavedQuery {
  return {
    selectedTables: state.selectedTables,
    selectedFields: state.selectedFields,
    tabSectionFields: state.tabSectionFields,
    grouping: state.grouping,
    conditions: state.conditions,
    joins: state.joins,
    selection: state.selection,
    queryType: state.queryType,
    tempTableName: state.tempTableName,
    lockForUpdate: state.lockForUpdate,
    order: state.order,
    totals: state.totals,
    builder: state.builder,
    indexing: state.indexing,
    comments: state.queryComments,
  };
}

/**
 * Восстановить плоские поля из снимка (или пустые значения по умолчанию при null).
 * Транзитные поля фокуса всегда сбрасываются.
 */
export function restoreSaved(_state: QueryState, saved: SavedQuery | null): Partial<QueryState> {
  const base = saved ?? {
    selectedTables: [],
    selectedFields: [],
    tabSectionFields: [],
    grouping: { multiple: false, groupFields: [], groupSets: [], aggregates: [] } as Grouping,
    conditions: [],
    joins: [],
    selection: {},
    queryType: 'select' as QueryType,
    tempTableName: '',
    lockForUpdate: [],
    order: { fields: [], auto: false } as Order,
    totals: { groupFields: [], totalFields: [], grand: false } as Totals,
    builder: emptyBuilder(),
    indexing: { indexes: [] } as Indexing,
    comments: undefined,
  };
  return {
    selectedTables: base.selectedTables,
    selectedFields: base.selectedFields,
    tabSectionFields: base.tabSectionFields,
    grouping: base.grouping,
    conditions: base.conditions,
    joins: base.joins,
    selection: base.selection,
    queryType: base.queryType,
    tempTableName: base.tempTableName,
    lockForUpdate: base.lockForUpdate,
    order: base.order,
    totals: base.totals,
    builder: base.builder,
    indexing: base.indexing,
    queryComments: base.comments,
    lockEnabled: base.lockForUpdate.length > 0,
    focusedSelectedTableId: null,
    focusedSelectedFieldIdx: null,
  };
}

/** Собрать QueryModel из снимка (или из плоских полей активного запроса). */
export function buildModelFromFlat(flat: SavedQuery): QueryModel {
  return {
    tables: flat.selectedTables,
    fields: flat.selectedFields,
    tabSectionFields: flat.tabSectionFields,
    grouping: flat.grouping,
    conditions: flat.conditions,
    joins: flat.joins,
    selection: flat.selection,
    queryType: flat.queryType,
    tempTableName: flat.tempTableName,
    lockForUpdate: flat.lockForUpdate,
    order: flat.order,
    totals: flat.totals,
    builder: flat.builder,
    indexing: flat.indexing,
    comments: flat.comments,
  };
}

/**
 * Обратное преобразование `buildModelFromFlat`: модель → плоский SavedQuery.
 * Поля-оптионалы модели, равные `undefined`, заполняются теми же пустыми значениями
 * по умолчанию, что использует `restoreSaved`.
 */
export function modelToFlat(model: QueryModel): SavedQuery {
  return {
    selectedTables: model.tables,
    selectedFields: model.fields,
    tabSectionFields: model.tabSectionFields ?? [],
    grouping: model.grouping ?? { multiple: false, groupFields: [], groupSets: [], aggregates: [] },
    conditions: model.conditions ?? [],
    joins: model.joins ?? [],
    selection: model.selection ?? {},
    queryType: model.queryType ?? 'select',
    tempTableName: model.tempTableName ?? '',
    lockForUpdate: model.lockForUpdate ?? [],
    order: model.order ?? { fields: [], auto: false },
    totals: model.totals ?? { groupFields: [], totalFields: [], grand: false },
    builder: model.builder ?? emptyBuilder(),
    indexing: model.indexing ?? { indexes: [] },
    comments: model.comments,
  };
}

/**
 * Снимок документа объединения из распарсенного `QueryDocument`: имя/distinct из
 * участников, активный запрос — 0, savedQueries — плоские модели всех участников.
 */
export function docToSnapshot(doc: QueryDocument): BatchSnapshot {
  return {
    queryList: doc.members.map(m => ({ name: m.name, distinct: m.distinct })),
    activeQuery: 0,
    savedQueries: doc.members.map(m => modelToFlat(m.model)),
  };
}

/**
 * Собрать участников объединения: модель из (i === activeQuery ? живые плоские поля
 * : savedQueries[i]); имя/distinct из queryList[i].
 */
export function assembleMembers(state: QueryState): UnionMember[] {
  return state.queryList.map((meta, i) => {
    const saved = i === state.activeQuery ? snapshotActive(state) : state.savedQueries[i];
    const flat = saved ?? snapshotActive(state); // savedQueries[i] не должен быть null для неактивного
    return {
      name: meta.name,
      distinct: meta.distinct,
      model: buildModelFromFlat(flat),
    };
  });
}

// ============================================================================
// Слой пакета запросов: снимок/восстановление активного документа объединения.
// ============================================================================

/**
 * Собрать текущий документ объединения в снимок пакета: `savedQueries` со слотом
 * `activeQuery`, заполненным `snapshotActive(state)`; остальные слоты — из
 * `state.savedQueries` (они уже не null для неактивных участников).
 */
export function snapshotActiveBatch(state: QueryState): BatchSnapshot {
  const savedQueries = state.queryList.map((_, i) =>
    i === state.activeQuery ? snapshotActive(state) : (state.savedQueries[i] ?? snapshotActive(state))
  );
  return {
    queryList: state.queryList,
    activeQuery: state.activeQuery,
    savedQueries,
  };
}

/**
 * Восстановить документ объединения из снимка пакета (или пустой при null).
 * Возвращает queryList/activeQuery/savedQueries и плоские поля активного участника.
 */
export function restoreBatch(state: QueryState, snap: BatchSnapshot | null): Partial<QueryState> {
  if (snap === null) {
    return {
      queryList: [{ name: 'Запрос 1', distinct: false }],
      activeQuery: 0,
      savedQueries: [null],
      ...restoreSaved(state, null),
    };
  }
  const savedQueries: (SavedQuery | null)[] = snap.savedQueries.slice();
  savedQueries[snap.activeQuery] = null;
  return {
    queryList: snap.queryList,
    activeQuery: snap.activeQuery,
    savedQueries,
    ...restoreSaved(state, snap.savedQueries[snap.activeQuery]),
  };
}

/**
 * Производное имя запроса пакета по первому участнику объединения его документа.
 * createTemp/appendTemp с непустым tempTableName → имя ВТ; dropTemp → «- ВТ»;
 * иначе — «Запрос пакета N».
 */
export function batchMemberName(state: QueryState, i: number): string {
  let first: SavedQuery;
  if (i === state.activeBatch) {
    first = state.activeQuery === 0 ? snapshotActive(state) : state.savedQueries[0]!;
  } else {
    first = state.batchSaved[i]!.savedQueries[0];
  }
  const model = buildModelFromFlat(first);
  if ((model.queryType === 'createTemp' || model.queryType === 'appendTemp') && model.tempTableName) {
    return model.tempTableName;
  }
  if (model.queryType === 'dropTemp') {
    return `- ${model.tempTableName}`;
  }
  return `Запрос пакета ${i + 1}`;
}

/**
 * 7.8.17 — доступные временные таблицы для активного запроса пакета: ВТ, созданные
 * `ПОМЕСТИТЬ`/`ДОБАВИТЬ` в запросах СТРОГО ДО активного (в 1С ВТ доступна только после
 * создания). Колонки — псевдонимы выборки запроса-создателя (как `registerTempTables`
 * парсера). Дерево метаданных показывает их группой «Временные таблицы»; источник можно
 * перетащить в поздний запрос пакета. Активный (и более поздние) запросы не включаются —
 * сама создаваемая ВТ не доступна себе.
 */
export function availableTempTables(state: QueryState): MetaTable[] {
  const out: MetaTable[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < state.activeBatch; i++) {
    const snap = state.batchSaved[i];
    if (!snap) continue;
    const model = buildModelFromFlat(snap.savedQueries[0]);
    if (model.queryType !== 'createTemp' && model.queryType !== 'appendTemp') continue;
    const name = model.tempTableName;
    if (!name || seenNames.has(name.toUpperCase())) continue;
    seenNames.add(name.toUpperCase());
    const cols: string[] = [];
    const seenCols = new Set<string>();
    for (const f of model.fields) {
      const a = fieldAlias(f, model);
      if (!a || a === '*') continue;
      let alias = a;
      let n = 0;
      while (seenCols.has(alias.toUpperCase())) alias = `${a}${++n}`;
      seenCols.add(alias.toUpperCase());
      cols.push(alias);
    }
    out.push({
      kind: 'ВременнаяТаблица',
      name,
      fullName: name,
      fields: cols.map(c => ({ name: c, kind: 'attribute', types: [] })),
    });
  }
  return out;
}

/** Собрать документ пакета: активный запрос пакета — из live-состояния, остальные — из снимков. */
export function assembleBatch(state: QueryState): BatchDocument {
  return {
    members: state.batchSaved.map((snap, i) => {
      if (i === state.activeBatch) {
        return { members: assembleMembers(state) };
      }
      const b = snap!;
      return {
        members: b.queryList.map((meta, j) => ({
          name: meta.name,
          distinct: meta.distinct,
          model: buildModelFromFlat(b.savedQueries[j]),
        })),
      };
    }),
  };
}

/**
 * Фаза 8.1 — вернуть копию пакета БЕЗ комментариев (для генерации при снятой галочке
 * «Сохранять комментарии»): убираем `comments` у каждого QueryModel и
 * `commentLeading`/`commentTrailing` у каждого поля. Генератор печатает комментарии
 * только при их наличии, поэтому очищенный пакет даёт канонический текст без них.
 */
export function stripBatchComments(batch: BatchDocument): BatchDocument {
  return {
    members: batch.members.map(doc => ({
      members: doc.members.map(m => {
        const { comments: _drop, ...modelRest } = m.model;
        void _drop;
        return {
          ...m,
          model: { ...modelRest, fields: stripFieldComments(modelRest.fields) },
        };
      }),
    })),
  };
}

/**
 * Фаза 8.1 — снять комментарии со ВСЕХ полей запроса (commentLeading/commentTrailing
 * привязаны к синониму поля и контейнеру). Возвращает новые объекты без этих ключей.
 */
/**
 * 8.3.2: псевдоним колонки выборки — операнда простого агрегата ИТОГИ. Ищем
 * скалярную колонку с таким (tableId, path) и берём её явный псевдоним; иначе —
 * последний сегмент пути. Это текст, который конструктор печатает внутри
 * ФУНКЦИЯ(<операнд>).
 */
function totalOperandAlias(state: QueryState, tableId: string, path: string): string {
  const col = state.selectedFields.find(f => !f.expression && f.tableId === tableId && f.path === path);
  return col?.alias ?? (path.split('.').pop() ?? path);
}

function stripFieldComments(fields: SelectedField[]): SelectedField[] {
  return fields.map(f => {
    if (f.commentLeading === undefined && f.commentTrailing === undefined) return f;
    const { commentLeading, commentTrailing, ...rest } = f;
    return rest;
  });
}

/**
 * Применить переименование псевдонима колонки к списку полей одного запроса.
 * Фаза 8.1 — переименование синонима поля разрывает привязку его комментариев,
 * поэтому у переименованного поля комментарии снимаются.
 */
function applyColumnAlias(fields: SelectedField[], alias: string, newAlias: string): SelectedField[] {
  return fields.map(f =>
    fieldAlias(f) === alias
      ? (() => { const { commentLeading, commentTrailing, ...rest } = f; return { ...rest, alias: newAlias }; })()
      : f
  );
}

// ============================================================================
// Связи: адресация конъюнкта (фаза 6.13).
//
// Конструктор 1С показывает каждый конъюнкт условия `ПО` отдельной строкой. В
// модели они хранятся в `Join.conditions[]`, а верхнеуровневые поля
// `custom/leftPath/operator/rightPath/expression` — зеркало `conditions[0]`.
// Соединения, созданные в UI (одиночное условие), не имеют `conditions[]` —
// тогда работаем напрямую с верхнеуровневыми полями (генератор откатывается к
// ним). Хелперы ниже обновляют нужный конъюнкт И поддерживают зеркало
// `conditions[0]` ↔ верхнеуровневых полей, чтобы генератор рендерил одинаково.
// ============================================================================

/** Конъюнкт, эквивалентный верхнеуровневым полям соединения (зеркало conditions[0]). */
function topLevelConjunct(j: Join): JoinCondition {
  return {
    custom: j.custom,
    leftTableId: j.leftTableId,
    leftPath: j.leftPath,
    operator: j.operator,
    rightTableId: j.rightTableId,
    rightPath: j.rightPath,
    expression: j.expression,
  };
}

/** Скопировать поля конъюнкта conditions[0] в верхнеуровневые поля соединения. */
function syncMirror(j: Join): Join {
  const c0 = j.conditions?.[0];
  if (!c0) return j;
  return {
    ...j,
    custom: c0.custom,
    leftPath: c0.leftPath,
    operator: c0.operator,
    rightPath: c0.rightPath,
    expression: c0.expression,
    ...(c0.leftTableId !== undefined ? { leftTableId: c0.leftTableId } : {}),
    ...(c0.rightTableId !== undefined ? { rightTableId: c0.rightTableId } : {}),
  };
}

/**
 * Обновить один конъюнкт соединения `index`/`condIndex` и поддержать зеркало.
 * Если у соединения нет `conditions[]` и `condIndex` равен 0/undefined — правим
 * только верхнеуровневые поля (как раньше, без материализации conditions[]).
 * Иначе материализуем `conditions[]` из верхнеуровневого конъюнкта и правим
 * нужный элемент; conditions[0] синхронизируем обратно в зеркало.
 */
function updateJoinConjunct(
  state: QueryState,
  index: number,
  condIndex: number | undefined,
  patch: Partial<JoinCondition>
): QueryState {
  const joins = state.joins.map((j, i) => {
    if (i !== index) return j;
    const ci = condIndex ?? 0;
    // Соединение без conditions[]: правим верхнеуровневые поля напрямую.
    if (!j.conditions && ci === 0) {
      return { ...j, ...patch };
    }
    const conds = j.conditions ?? [topLevelConjunct(j)];
    if (ci < 0 || ci >= conds.length) return j;
    const nextConds = conds.map((c, k) => (k === ci ? { ...c, ...patch } : c));
    return syncMirror({ ...j, conditions: nextConds });
  });
  return { ...state, joins };
}

export function reducer(state: QueryState, action: QueryAction): QueryState {
  switch (action.type) {
    case 'SET_METADATA':
      return { ...state, tables: action.tables };

    case 'SET_REF_FIELDS': {
      const key = `${action.ref.kind}.${action.ref.name}`;
      const updated = new Map(state.expandedRefs);
      updated.set(key, action.fields);
      return { ...state, expandedRefs: updated };
    }

    case 'FOCUS_DB_TABLE':
      return { ...state, focusedDbTableFullName: action.fullName, focusedDbFieldPath: null };

    case 'FOCUS_DB_FIELD':
      return { ...state, focusedDbTableFullName: action.tableFullName, focusedDbFieldPath: action.fieldPath };

    case 'ADD_TABLE': {
      // 7.8.13: дубли таблиц разрешены — всегда добавляем новую SelectedTable.
      // Базовый псевдоним выводится из fullName; если он уже занят среди выбранных
      // (по эффективному defaultTableAlias), назначаем ordinal-синоним base+k.
      const id = `t${++_tableCounter}`;
      const newTable: SelectedTable = { id, fullName: action.table.fullName };
      const base = defaultTableAlias({ id: '', fullName: action.table.fullName });
      const taken = new Set(state.selectedTables.map(t => defaultTableAlias(t)));
      if (taken.has(base)) {
        let k = 1;
        while (taken.has(base + k)) k++;
        newTable.alias = base + k;
      }
      if (action.table.virtual) {
        newTable.virtual = action.table.virtual.correspondence !== undefined
          ? { correspondence: action.table.virtual.correspondence }
          : {};
      }
      return {
        ...state,
        selectedTables: [...state.selectedTables, newTable],
        focusedSelectedTableId: id,
      };
    }

    case 'REMOVE_TABLE': {
      const removed = state.selectedTables.find(t => t.id === action.tableId);
      const filtered = state.selectedTables.filter(t => t.id !== action.tableId);
      const fields = state.selectedFields.filter(f => f.tableId !== action.tableId);
      const tabSectionFields = state.tabSectionFields.filter(ts => ts.tableId !== action.tableId);
      const grouping: Grouping = {
        ...state.grouping,
        groupFields: state.grouping.groupFields.filter(f => f.tableId !== action.tableId),
        aggregates: state.grouping.aggregates.filter(a => a.tableId !== action.tableId),
        groupSets: state.grouping.groupSets
          .map(set => set.filter(f => f.tableId !== action.tableId))
          .filter(set => set.length > 0),
      };
      const conditions = state.conditions.filter(c => c.custom || c.tableId !== action.tableId);
      const joins = state.joins.filter(
        j => j.leftTableId !== action.tableId && j.rightTableId !== action.tableId
      );
      const lockForUpdate = removed
        ? state.lockForUpdate.filter(n => n !== removed.fullName)
        : state.lockForUpdate;
      const order: Order = {
        ...state.order,
        fields: state.order.fields.filter(f => f.tableId !== action.tableId),
      };
      const totals: Totals = {
        ...state.totals,
        groupFields: state.totals.groupFields.filter(f => f.tableId !== action.tableId),
        totalFields: state.totals.totalFields.filter(f => f.tableId !== action.tableId),
      };
      const indexing: Indexing = {
        ...state.indexing,
        indexes: state.indexing.indexes.map(idx => ({
          ...idx,
          fields: idx.fields.filter(f => f.tableId !== action.tableId),
        })),
      };
      return { ...state, selectedTables: filtered, selectedFields: fields, tabSectionFields, grouping, conditions, joins, lockForUpdate, order, totals, indexing, focusedSelectedTableId: null };
    }

    case 'ADD_FIELD': {
      const alreadyIn = state.selectedFields.some(
        f => f.tableId === action.tableId && f.path === action.fieldPath
      );
      if (alreadyIn) return state;
      return { ...state, selectedFields: [...state.selectedFields, { tableId: action.tableId, path: action.fieldPath }] };
    }

    case 'ADD_FIELD_WITH_TABLE': {
      let tableId: string;
      let newSelectedTables = state.selectedTables;
      let newFocusedTableId = state.focusedSelectedTableId;

      const existing = state.selectedTables.find(t => t.fullName === action.tableFullName);
      if (existing) {
        tableId = existing.id;
      } else {
        tableId = `t${++_tableCounter}`;
        newSelectedTables = [...state.selectedTables, { id: tableId, fullName: action.tableFullName }];
        newFocusedTableId = tableId;
      }

      // 7.8.11: дубли полей через drag разрешены — каждому повтору ordinal-синоним.
      const base = action.fieldPath.split('.').pop()!;
      const n = state.selectedFields.filter(f => f.tableId === tableId && f.path === action.fieldPath).length;
      const newField: SelectedField = { tableId, path: action.fieldPath };
      if (n >= 1) newField.alias = base + n;

      return {
        ...state,
        selectedTables: newSelectedTables,
        focusedSelectedTableId: newFocusedTableId,
        selectedFields: [...state.selectedFields, newField],
      };
    }

    case 'ADD_ALL_FIELDS_WITH_TABLE': {
      const { tableFullName, fieldPaths } = action;
      let tableId: string;
      let newSelectedTables = state.selectedTables;
      let newFocusedTableId = state.focusedSelectedTableId;

      const existing = state.selectedTables.find(t => t.fullName === tableFullName);
      if (existing) {
        tableId = existing.id;
      } else {
        tableId = `t${++_tableCounter}`;
        newSelectedTables = [...state.selectedTables, { id: tableId, fullName: tableFullName }];
        newFocusedTableId = tableId;
      }

      const existingPaths = new Set(
        state.selectedFields.filter(f => f.tableId === tableId).map(f => f.path)
      );
      const toAdd = fieldPaths
        .filter(p => !existingPaths.has(p))
        .map(p => ({ tableId, path: p }));

      if (toAdd.length === 0 && newSelectedTables === state.selectedTables) return state;
      return {
        ...state,
        selectedTables: newSelectedTables,
        focusedSelectedTableId: newFocusedTableId,
        selectedFields: [...state.selectedFields, ...toAdd],
      };
    }

    case 'ADD_ALL_FIELDS_DUP': {
      // 7.8.16: двойной клик по выбранной таблице — добавить ВСЕ её поля в «Поля»,
      // дубли разрешены (ordinal-синонимы по правилу 7.8.11).
      const sel = state.selectedTables.find(t => t.id === action.tableId);
      if (!sel) return state;
      const meta = state.tables.find(m => m.fullName === sel.fullName);
      if (!meta) return state;
      const selectedFields = [...state.selectedFields];
      for (const field of meta.fields) {
        const path = field.name;
        const base = path.split('.').pop()!;
        const n = selectedFields.filter(f => f.tableId === sel.id && f.path === path).length;
        const newField: SelectedField = { tableId: sel.id, path };
        if (n >= 1) newField.alias = base + n;
        selectedFields.push(newField);
      }
      return { ...state, selectedFields };
    }

    case 'SET_FIELD_EXPRESSION': {
      const cur = state.selectedFields[action.fieldIdx];
      if (!cur) return state;
      // Фаза 8.1 — правка поля как выражения меняет его синоним → комментарии поля
      // не переносятся (next собирается заново, без commentLeading/commentTrailing).
      const next: SelectedField = { tableId: cur.tableId, path: '', expression: action.expression };
      if (cur.alias) next.alias = cur.alias;
      const selectedFields = state.selectedFields.map((f, i) => (i === action.fieldIdx ? next : f));
      // Поле перестало быть простой колонкой (path → ''): убираем его ссылки из
      // группировки/порядка/итогов/индексов (как REMOVE_FIELD), иначе генератор
      // отрисовал бы устаревшую ссылку на старый путь.
      if (cur.path === '') {
        return { ...state, selectedFields };
      }
      const { tableId, path } = cur;
      const grouping: Grouping = {
        ...state.grouping,
        groupFields: state.grouping.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        aggregates: state.grouping.aggregates.filter(a => !(a.tableId === tableId && a.path === path)),
        groupSets: state.grouping.groupSets
          .map(set => set.filter(f => !(f.tableId === tableId && f.path === path)))
          .filter(set => set.length > 0),
      };
      const order: Order = {
        ...state.order,
        fields: state.order.fields.filter(f => !(f.tableId === tableId && f.path === path)),
      };
      const totals: Totals = {
        ...state.totals,
        groupFields: state.totals.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        totalFields: state.totals.totalFields.filter(f => !(f.tableId === tableId && f.path === path)),
      };
      const indexing: Indexing = {
        ...state.indexing,
        indexes: state.indexing.indexes.map(idx => ({
          ...idx,
          fields: idx.fields.filter(f => !(f.tableId === tableId && f.path === path)),
        })),
      };
      return { ...state, selectedFields, grouping, order, totals, indexing };
    }

    case 'ADD_SUBQUERY_TABLE': {
      const fullName = uniqueSourceName(state, action.name.trim() || 'ВложенныйЗапрос');
      const fields: MetaField[] = action.columns.map(c => ({ name: c, kind: 'attribute', types: [] }));
      const meta = syntheticSourceTable(fullName, fields);
      const id = `t${++_tableCounter}`;
      const sel: SelectedTable = { id, fullName, subquery: action.subquery };
      return {
        ...state,
        tables: [...state.tables, meta],
        selectedTables: [...state.selectedTables, sel],
        focusedSelectedTableId: id,
      };
    }

    case 'ADD_TEMP_TABLE': {
      const name = action.name.trim();
      if (!name) return state;
      const fullName = uniqueSourceName(state, name);
      const fields: MetaField[] = action.fields
        .filter(f => f.name.trim())
        .map(f => ({ name: f.name.trim(), kind: 'attribute', types: [] }));
      const meta = syntheticSourceTable(fullName, fields);
      const id = `t${++_tableCounter}`;
      return {
        ...state,
        tables: [...state.tables, meta],
        selectedTables: [...state.selectedTables, { id, fullName, tempTable: true }],
        focusedSelectedTableId: id,
      };
    }

    case 'UPDATE_TEMP_TABLE': {
      const sel = state.selectedTables.find(t => t.id === action.tableId);
      if (!sel || !sel.tempTable) return state;
      const oldFullName = sel.fullName;
      const trimmed = action.name.trim();
      // Уникальность нового имени — исключая саму обновляемую таблицу (не сталкиваться с собой).
      let newFullName: string;
      if (trimmed === oldFullName || !trimmed) {
        newFullName = oldFullName;
      } else {
        const taken = new Set<string>([
          ...state.tables.filter(t => t.fullName !== oldFullName).map(t => t.fullName),
          ...state.selectedTables.filter(t => t.id !== action.tableId).map(t => t.fullName),
        ]);
        if (!taken.has(trimmed)) {
          newFullName = trimmed;
        } else {
          let i = 2;
          while (taken.has(`${trimmed}${i}`)) i++;
          newFullName = `${trimmed}${i}`;
        }
      }

      const newFields: MetaField[] = action.fields
        .filter(f => f.name.trim())
        .map(f => ({ name: f.name.trim(), kind: 'attribute', types: [] }));
      const newMeta = syntheticSourceTable(newFullName, newFields);
      const tables = state.tables.map(t => (t.fullName === oldFullName ? newMeta : t));
      const selectedTables = state.selectedTables.map(t =>
        t.id === action.tableId ? { ...t, fullName: newFullName } : t
      );

      // Обрезать выбранные поля этой таблицы, чьи пути исчезли из набора колонок.
      const keep = new Set(newFields.map(f => f.name));
      const removedPaths = new Set(
        state.selectedFields
          .filter(f => f.tableId === action.tableId && f.path !== '' && !keep.has(f.path))
          .map(f => f.path)
      );
      const selectedFields = state.selectedFields.filter(
        f => !(f.tableId === action.tableId && removedPaths.has(f.path))
      );

      const pruned = (tableId: string, path: string) =>
        tableId === action.tableId && removedPaths.has(path);
      const grouping: Grouping = {
        ...state.grouping,
        groupFields: state.grouping.groupFields.filter(f => !pruned(f.tableId, f.path)),
        aggregates: state.grouping.aggregates.filter(a => !pruned(a.tableId, a.path)),
        groupSets: state.grouping.groupSets
          .map(set => set.filter(f => !pruned(f.tableId, f.path)))
          .filter(set => set.length > 0),
      };
      const order: Order = {
        ...state.order,
        fields: state.order.fields.filter(f => !pruned(f.tableId, f.path)),
      };
      const totals: Totals = {
        ...state.totals,
        groupFields: state.totals.groupFields.filter(f => !pruned(f.tableId, f.path)),
        totalFields: state.totals.totalFields.filter(f => !pruned(f.tableId, f.path)),
      };
      const indexing: Indexing = {
        ...state.indexing,
        indexes: state.indexing.indexes.map(idx => ({
          ...idx,
          fields: idx.fields.filter(f => !pruned(f.tableId, f.path)),
        })),
      };

      return { ...state, tables, selectedTables, selectedFields, grouping, order, totals, indexing };
    }

    case 'UPDATE_SUBQUERY_TABLE': {
      // 7.8.15: ОК вложенного конструктора — заменить подзапрос и пересчитать колонки
      // синтетической метатаблицы; имя источника НЕ меняется (адресация по fullName).
      const sel = state.selectedTables.find(t => t.id === action.tableId);
      if (!sel || !sel.subquery) return state;
      const fullName = sel.fullName;
      const newFields: MetaField[] = action.columns.map(c => ({ name: c, kind: 'attribute', types: [] }));
      const newMeta = syntheticSourceTable(fullName, newFields);
      const tables = state.tables.map(t => (t.fullName === fullName ? newMeta : t));
      const selectedTables = state.selectedTables.map(t =>
        t.id === action.tableId ? { ...t, subquery: action.subquery } : t
      );

      // Обрезать выбранные поля этой таблицы, чьи пути исчезли из набора колонок.
      const keep = new Set(action.columns);
      const removedPaths = new Set(
        state.selectedFields
          .filter(f => f.tableId === action.tableId && f.path !== '' && !keep.has(f.path))
          .map(f => f.path)
      );
      const selectedFields = state.selectedFields.filter(
        f => !(f.tableId === action.tableId && removedPaths.has(f.path))
      );

      const pruned = (tableId: string, path: string) =>
        tableId === action.tableId && removedPaths.has(path);
      const grouping: Grouping = {
        ...state.grouping,
        groupFields: state.grouping.groupFields.filter(f => !pruned(f.tableId, f.path)),
        aggregates: state.grouping.aggregates.filter(a => !pruned(a.tableId, a.path)),
        groupSets: state.grouping.groupSets
          .map(set => set.filter(f => !pruned(f.tableId, f.path)))
          .filter(set => set.length > 0),
      };
      const order: Order = {
        ...state.order,
        fields: state.order.fields.filter(f => !pruned(f.tableId, f.path)),
      };
      const totals: Totals = {
        ...state.totals,
        groupFields: state.totals.groupFields.filter(f => !pruned(f.tableId, f.path)),
        totalFields: state.totals.totalFields.filter(f => !pruned(f.tableId, f.path)),
      };
      const indexing: Indexing = {
        ...state.indexing,
        indexes: state.indexing.indexes.map(idx => ({
          ...idx,
          fields: idx.fields.filter(f => !pruned(f.tableId, f.path)),
        })),
      };

      return { ...state, tables, selectedTables, selectedFields, grouping, order, totals, indexing };
    }

    case 'ADD_TAB_SECTION_WITH_TABLE': {
      const { parentTableFullName, tsName, tsFullName, tsFields } = action;

      let tableId: string;
      let newSelectedTables = state.selectedTables;
      let newFocusedTableId = state.focusedSelectedTableId;

      const existing = state.selectedTables.find(t => t.fullName === parentTableFullName);
      if (existing) {
        tableId = existing.id;
      } else {
        tableId = `t${++_tableCounter}`;
        newSelectedTables = [...state.selectedTables, { id: tableId, fullName: parentTableFullName }];
        newFocusedTableId = tableId;
      }

      const alreadyIn = state.tabSectionFields.some(ts => ts.tableId === tableId && ts.tsName === tsName);
      if (alreadyIn) {
        return newSelectedTables !== state.selectedTables
          ? { ...state, selectedTables: newSelectedTables, focusedSelectedTableId: newFocusedTableId }
          : state;
      }

      return {
        ...state,
        selectedTables: newSelectedTables,
        focusedSelectedTableId: newFocusedTableId,
        tabSectionFields: [...state.tabSectionFields, { tableId, tsName, tsFullName, fields: tsFields }],
      };
    }

    case 'REMOVE_TAB_SECTION': {
      const tabSectionFields = state.tabSectionFields.filter(
        ts => !(ts.tableId === action.tableId && ts.tsName === action.tsName)
      );
      return { ...state, tabSectionFields };
    }

    case 'REMOVE_TAB_SECTION_SUB_FIELD': {
      const tabSectionFields = state.tabSectionFields.map(ts => {
        if (ts.tableId !== action.tableId || ts.tsName !== action.tsName) return ts;
        const fields = ts.fields.filter(f => f !== action.fieldName);
        return { ...ts, fields };
      }).filter(ts => ts.fields.length > 0);
      return { ...state, tabSectionFields };
    }

    case 'REMOVE_FIELD': {
      const removed = state.selectedFields[action.fieldIdx];
      const fields = state.selectedFields.filter((_, i) => i !== action.fieldIdx);
      // Выражения (path === '') не имеют ссылок в группировке — нечего пруны.
      if (!removed || removed.path === '') {
        return { ...state, selectedFields: fields, focusedSelectedFieldIdx: null };
      }
      const { tableId, path } = removed;
      const grouping: Grouping = {
        ...state.grouping,
        groupFields: state.grouping.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        aggregates: state.grouping.aggregates.filter(a => !(a.tableId === tableId && a.path === path)),
        groupSets: state.grouping.groupSets
          .map(set => set.filter(f => !(f.tableId === tableId && f.path === path)))
          .filter(set => set.length > 0),
      };
      const order: Order = {
        ...state.order,
        fields: state.order.fields.filter(f => !(f.tableId === tableId && f.path === path)),
      };
      const totals: Totals = {
        ...state.totals,
        groupFields: state.totals.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        totalFields: state.totals.totalFields.filter(f => !(f.tableId === tableId && f.path === path)),
      };
      const indexing: Indexing = {
        ...state.indexing,
        indexes: state.indexing.indexes.map(idx => ({
          ...idx,
          fields: idx.fields.filter(f => !(f.tableId === tableId && f.path === path)),
        })),
      };
      return { ...state, selectedFields: fields, grouping, order, totals, indexing, focusedSelectedFieldIdx: null };
    }

    case 'FOCUS_SELECTED_TABLE':
      return { ...state, focusedSelectedTableId: action.id };

    case 'FOCUS_SELECTED_FIELD':
      return { ...state, focusedSelectedFieldIdx: action.idx };

    case 'SET_VIRTUAL_PARAMS': {
      const selectedTables = state.selectedTables.map(t =>
        t.id === action.tableId
          ? { ...t, virtual: { ...action.params, ...(t.virtual?.correspondence !== undefined ? { correspondence: t.virtual.correspondence } : {}) } }
          : t
      );
      return { ...state, selectedTables };
    }

    case 'ADD_EXPRESSION_FIELD': {
      const field: SelectedField = { tableId: action.tableId, path: '', expression: action.expression };
      if (action.alias) field.alias = action.alias;
      return { ...state, selectedFields: [...state.selectedFields, field] };
    }

    case 'SET_GROUPING_MULTIPLE':
      return { ...state, grouping: { ...state.grouping, multiple: action.multiple } };

    case 'ADD_GROUP_FIELD': {
      const { tableId, path } = action;
      if (state.grouping.groupFields.some(f => f.tableId === tableId && f.path === path)) return state;
      return {
        ...state,
        grouping: {
          ...state.grouping,
          groupFields: [...state.grouping.groupFields, { tableId, path }],
          aggregates: state.grouping.aggregates.filter(a => !(a.tableId === tableId && a.path === path)),
        },
      };
    }

    case 'REMOVE_GROUP_FIELD': {
      const { tableId, path } = action;
      return {
        ...state,
        grouping: {
          ...state.grouping,
          groupFields: state.grouping.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        },
      };
    }

    case 'ADD_SUMMABLE_FIELD': {
      const { tableId, path, func } = action;
      if (state.grouping.aggregates.some(a => a.tableId === tableId && a.path === path)) return state;
      return {
        ...state,
        grouping: {
          ...state.grouping,
          aggregates: [...state.grouping.aggregates, { tableId, path, func }],
          groupFields: state.grouping.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        },
      };
    }

    case 'REMOVE_SUMMABLE_FIELD': {
      const { tableId, path } = action;
      return {
        ...state,
        grouping: {
          ...state.grouping,
          aggregates: state.grouping.aggregates.filter(a => !(a.tableId === tableId && a.path === path)),
        },
      };
    }

    case 'SET_SUMMABLE_FUNC': {
      const { tableId, path, func } = action;
      return {
        ...state,
        grouping: {
          ...state.grouping,
          aggregates: state.grouping.aggregates.map(a =>
            a.tableId === tableId && a.path === path ? { ...a, func } : a
          ),
        },
      };
    }

    case 'ADD_GROUP_SET':
      return { ...state, grouping: { ...state.grouping, groupSets: [...state.grouping.groupSets, []] } };

    case 'REMOVE_GROUP_SET': {
      const groupSets = state.grouping.groupSets.filter((_, i) => i !== action.index);
      return { ...state, grouping: { ...state.grouping, groupSets } };
    }

    case 'ADD_FIELD_TO_SET': {
      const { index, tableId, path } = action;
      const set = state.grouping.groupSets[index];
      if (!set) return state;
      if (set.some(f => f.tableId === tableId && f.path === path)) return state;
      const groupSets = state.grouping.groupSets.map((s, i) =>
        i === index ? [...s, { tableId, path }] : s
      );
      return { ...state, grouping: { ...state.grouping, groupSets } };
    }

    case 'REMOVE_FIELD_FROM_SET': {
      const { index, tableId, path } = action;
      const groupSets = state.grouping.groupSets.map((s, i) =>
        i === index ? s.filter(f => !(f.tableId === tableId && f.path === path)) : s
      );
      return { ...state, grouping: { ...state.grouping, groupSets } };
    }

    case 'ADD_CONDITION': {
      const { tableId, path } = action;
      const param = `&${path.split('.').pop()}`;
      const condition: Condition = { custom: false, tableId, path, operator: '=', param };
      return { ...state, conditions: [...state.conditions, condition] };
    }

    case 'REMOVE_CONDITION': {
      const conditions = state.conditions.filter((_, i) => i !== action.index);
      return { ...state, conditions };
    }

    case 'SET_CONDITION_CUSTOM': {
      const conditions = state.conditions.map((c, i) =>
        i === action.index ? { ...c, custom: action.custom } : c
      );
      return { ...state, conditions };
    }

    case 'SET_CONDITION_OPERATOR': {
      const conditions = state.conditions.map((c, i) =>
        i === action.index ? { ...c, operator: action.operator } : c
      );
      return { ...state, conditions };
    }

    case 'SET_CONDITION_PARAM': {
      const conditions = state.conditions.map((c, i) =>
        i === action.index ? { ...c, param: action.param } : c
      );
      return { ...state, conditions };
    }

    case 'SET_CONDITION_EXPRESSION': {
      // Правка текста выражения делает условие чисто произвольным: разобранный
      // подзапрос (фаза 6.14.4) сбрасывается, иначе генератор отрисовал бы
      // устаревшую структуру вместо нового текста.
      const conditions = state.conditions.map((c, i) =>
        i === action.index ? { ...c, expression: action.expression, subquery: undefined } : c
      );
      return { ...state, conditions };
    }

    case 'ADD_JOIN': {
      // Связь по умолчанию между первыми двумя выбранными таблицами.
      if (state.selectedTables.length < 2) return state;
      const join: Join = {
        leftTableId: state.selectedTables[0].id,
        rightTableId: state.selectedTables[1].id,
        leftAll: false,
        rightAll: false,
        custom: false,
        operator: '=',
      };
      return { ...state, joins: [...state.joins, join] };
    }

    case 'REMOVE_JOIN':
      return { ...state, joins: state.joins.filter((_, i) => i !== action.index) };

    case 'ADD_JOIN_CONDITION': {
      // Добавить ещё один (стандартный) конъюнкт к существующему соединению.
      const joins = state.joins.map((j, i) => {
        if (i !== action.index) return j;
        const conds = j.conditions ?? [topLevelConjunct(j)];
        const fresh: JoinCondition = {
          custom: false,
          leftTableId: j.leftTableId,
          rightTableId: j.rightTableId,
          operator: '=',
        };
        return syncMirror({ ...j, conditions: [...conds, fresh] });
      });
      return { ...state, joins };
    }

    case 'REMOVE_JOIN_CONDITION': {
      const joins = state.joins.flatMap((j, i) => {
        if (i !== action.index) return [j];
        const conds = j.conditions ?? [topLevelConjunct(j)];
        const nextConds = conds.filter((_, k) => k !== action.condIndex);
        // Удалили последний конъюнкт → удаляем всё соединение.
        if (nextConds.length === 0) return [];
        return [syncMirror({ ...j, conditions: nextConds })];
      });
      return { ...state, joins };
    }

    case 'SET_JOIN_TABLE': {
      // Сторона таблицы конъюнкта (leftTableId/rightTableId) хранится и в
      // верхнеуровневых полях соединения (порядок рендера условия), и в конъюнкте.
      const field = action.side === 'left' ? 'leftTableId' : 'rightTableId';
      const joins = state.joins.map((j, i) => {
        if (i !== action.index) return j;
        const ci = action.condIndex ?? 0;
        if (!j.conditions && ci === 0) return { ...j, [field]: action.tableId };
        const conds = j.conditions ?? [topLevelConjunct(j)];
        if (ci < 0 || ci >= conds.length) return j;
        const nextConds = conds.map((c, k) => (k === ci ? { ...c, [field]: action.tableId } : c));
        return syncMirror({ ...j, conditions: nextConds });
      });
      return { ...state, joins };
    }

    case 'SET_JOIN_ALL': {
      const joins = state.joins.map((j, i) =>
        i === action.index
          ? { ...j, [action.side === 'left' ? 'leftAll' : 'rightAll']: action.value }
          : j
      );
      return { ...state, joins };
    }

    case 'SET_JOIN_CUSTOM':
      return updateJoinConjunct(state, action.index, action.condIndex, { custom: action.custom });

    case 'SET_JOIN_FIELD':
      return updateJoinConjunct(state, action.index, action.condIndex, {
        [action.side === 'left' ? 'leftPath' : 'rightPath']: action.path,
      });

    case 'SET_JOIN_OPERATOR':
      return updateJoinConjunct(state, action.index, action.condIndex, { operator: action.operator });

    case 'SET_JOIN_EXPRESSION':
      return updateJoinConjunct(state, action.index, action.condIndex, { expression: action.expression });

    case 'SET_SELECTION_TOP': {
      const selection = { ...state.selection };
      if (action.top === undefined || action.top === 0) {
        delete selection.top;
      } else {
        selection.top = action.top;
      }
      return { ...state, selection };
    }

    case 'SET_SELECTION_DISTINCT':
      return { ...state, selection: { ...state.selection, distinct: action.distinct } };

    case 'SET_SELECTION_ALLOWED':
      return { ...state, selection: { ...state.selection, allowed: action.allowed } };

    case 'SET_QUERY_TYPE':
      // Фаза 8.1 — смена типа контейнера разрывает привязку его комментариев
      // (уровня запроса и полей), поэтому они сбрасываются.
      return {
        ...state,
        queryType: action.queryType,
        queryComments: undefined,
        selectedFields: stripFieldComments(state.selectedFields),
      };

    case 'SET_TEMP_TABLE_NAME':
      // Фаза 8.1 — комментарии привязаны к контейнеру (имени ВТ); смена имени их сбрасывает.
      return {
        ...state,
        tempTableName: action.name,
        queryComments: undefined,
        selectedFields: stripFieldComments(state.selectedFields),
      };

    case 'SET_LOCK_ENABLED':
      return {
        ...state,
        lockEnabled: action.enabled,
        lockForUpdate: action.enabled ? state.lockForUpdate : [],
      };

    case 'ADD_LOCK_TABLE': {
      if (state.lockForUpdate.includes(action.fullName)) return state;
      return { ...state, lockForUpdate: [...state.lockForUpdate, action.fullName] };
    }

    case 'REMOVE_LOCK_TABLE':
      return { ...state, lockForUpdate: state.lockForUpdate.filter(n => n !== action.fullName) };

    case 'ADD_QUERY': {
      // Сохранить активный запрос в его слот, добавить новый пустой запрос и сделать его активным.
      const savedQueries = [...state.savedQueries];
      savedQueries[state.activeQuery] = snapshotActive(state);
      savedQueries.push(null);
      const queryList = [...state.queryList, { name: `Запрос ${state.queryList.length + 1}`, distinct: false }];
      const activeQuery = queryList.length - 1;
      return {
        ...state,
        queryList,
        savedQueries,
        activeQuery,
        ...restoreSaved(state, null),
      };
    }

    case 'SET_ACTIVE_QUERY': {
      const { index } = action;
      if (index === state.activeQuery) return state;
      if (index < 0 || index >= state.queryList.length) return state;
      // Сохранить текущий активный, загрузить целевой, целевой слот делаем live (null).
      const savedQueries = [...state.savedQueries];
      savedQueries[state.activeQuery] = snapshotActive(state);
      const target = savedQueries[index];
      savedQueries[index] = null;
      return {
        ...state,
        savedQueries,
        activeQuery: index,
        ...restoreSaved(state, target),
      };
    }

    case 'REMOVE_QUERY': {
      const { index } = action;
      if (state.queryList.length === 1) return state; // нельзя удалить последний
      if (index < 0 || index >= state.queryList.length) return state;

      const queryList = state.queryList.filter((_, i) => i !== index);
      const savedQueries = state.savedQueries.filter((_, i) => i !== index);

      if (index === state.activeQuery) {
        // Удаляем активный → выбрать соседа новым активным и загрузить его.
        const newActive = index >= queryList.length ? queryList.length - 1 : index;
        const target = savedQueries[newActive];
        savedQueries[newActive] = null;
        return {
          ...state,
          queryList,
          savedQueries,
          activeQuery: newActive,
          ...restoreSaved(state, target),
        };
      }

      // Удаляем неактивный → активный остаётся live, поправить индекс при сдвиге.
      const activeQuery = index < state.activeQuery ? state.activeQuery - 1 : state.activeQuery;
      return { ...state, queryList, savedQueries, activeQuery };
    }

    case 'RENAME_QUERY': {
      const queryList = state.queryList.map((q, i) =>
        i === action.index ? { ...q, name: action.name } : q
      );
      return { ...state, queryList };
    }

    case 'SET_QUERY_DISTINCT': {
      const queryList = state.queryList.map((q, i) =>
        i === action.index ? { ...q, distinct: action.distinct } : q
      );
      return { ...state, queryList };
    }

    case 'SET_COLUMN_ALIAS': {
      const { alias, newAlias } = action;
      // Активный запрос — в плоских полях; остальные — в snapshot'ах.
      // Фаза 8.1 — applyColumnAlias снимает комментарии у переименованного поля.
      const selectedFields = applyColumnAlias(state.selectedFields, alias, newAlias);
      const savedQueries = state.savedQueries.map((sq, i) =>
        i === state.activeQuery || sq === null
          ? sq
          : { ...sq, selectedFields: applyColumnAlias(sq.selectedFields, alias, newAlias) }
      );
      return { ...state, selectedFields, savedQueries };
    }

    case 'MOVE_UNION_COLUMN': {
      const { index, dir } = action;
      const target = dir === 'up' ? index - 1 : index + 1;
      // Колонки объединения позиционны: i-я колонка = i-е скалярное поле каждого
      // участника. Своп i-го и соседнего поля выполняем во ВСЕХ участниках (активный
      // — в плоских полях, остальные — в snapshot'ах). Участник, у которого нет поля
      // на этих позициях, остаётся без изменений (его ячейка и так NULL).
      const swap = (arr: SelectedField[]): SelectedField[] => {
        if (index < 0 || target < 0 || index >= arr.length || target >= arr.length) return arr;
        const next = [...arr];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      };
      const swapped = swap(state.selectedFields);
      if (swapped === state.selectedFields) return state; // позиция вне диапазона активного — нет хода
      const savedQueries = state.savedQueries.map((sq, i) =>
        i === state.activeQuery || sq === null
          ? sq
          : { ...sq, selectedFields: swap(sq.selectedFields) }
      );
      return { ...state, selectedFields: swapped, savedQueries };
    }

    case 'ADD_BATCH_QUERY': {
      // Сохранить активный запрос пакета в его слот, добавить новый пустой и сделать активным.
      const batchSaved = [...state.batchSaved];
      batchSaved[state.activeBatch] = snapshotActiveBatch(state);
      batchSaved.push(null);
      const activeBatch = batchSaved.length - 1;
      return {
        ...state,
        batchSaved,
        activeBatch,
        ...restoreBatch(state, null),
      };
    }

    case 'SET_ACTIVE_BATCH': {
      const { index } = action;
      if (index === state.activeBatch) return state;
      if (index < 0 || index >= state.batchSaved.length) return state;
      const batchSaved = [...state.batchSaved];
      batchSaved[state.activeBatch] = snapshotActiveBatch(state);
      const target = batchSaved[index];
      batchSaved[index] = null;
      return {
        ...state,
        batchSaved,
        activeBatch: index,
        ...restoreBatch(state, target),
      };
    }

    case 'REMOVE_BATCH_QUERY': {
      const { index } = action;
      if (state.batchSaved.length === 1) return state; // нельзя удалить последний
      if (index < 0 || index >= state.batchSaved.length) return state;

      if (index === state.activeBatch) {
        // Удаляем активный → перед удалением неактивные слоты должны быть заполнены.
        const batchSaved = state.batchSaved.filter((_, i) => i !== index);
        const newActive = index >= batchSaved.length ? batchSaved.length - 1 : index;
        const target = batchSaved[newActive];
        batchSaved[newActive] = null;
        return {
          ...state,
          batchSaved,
          activeBatch: newActive,
          ...restoreBatch(state, target),
        };
      }

      // Удаляем неактивный → активный остаётся live, поправить индекс при сдвиге.
      const batchSaved = state.batchSaved.filter((_, i) => i !== index);
      const activeBatch = index < state.activeBatch ? state.activeBatch - 1 : state.activeBatch;
      return { ...state, batchSaved, activeBatch };
    }

    case 'MOVE_BATCH_QUERY': {
      const { index, dir } = action;
      const target = dir === 'up' ? index - 1 : index + 1;
      if (index < 0 || index >= state.batchSaved.length) return state;
      if (target < 0 || target >= state.batchSaved.length) return state;

      // Снять активный в его слот, чтобы все слоты были заполнены при перестановке.
      const batchSaved = [...state.batchSaved];
      batchSaved[state.activeBatch] = snapshotActiveBatch(state);
      [batchSaved[index], batchSaved[target]] = [batchSaved[target], batchSaved[index]];

      // Пересчитать activeBatch так, чтобы он указывал на тот же запрос пакета.
      let activeBatch = state.activeBatch;
      if (state.activeBatch === index) activeBatch = target;
      else if (state.activeBatch === target) activeBatch = index;

      const snap = batchSaved[activeBatch];
      batchSaved[activeBatch] = null;
      return {
        ...state,
        batchSaved,
        activeBatch,
        ...restoreBatch(state, snap),
      };
    }

    case 'LOAD_BATCH': {
      // Загрузить весь распарсенный пакет в свежее состояние документа/пакета,
      // сохранив метаданные (tables/expandedRefs). Пустой пакет → пустой initial.
      if (action.doc.members.length === 0) {
        return {
          ...state,
          activeBatch: 0,
          batchSaved: [null],
          ...restoreBatch(state, null),
          focusedDbTableFullName: null,
          focusedDbFieldPath: null,
        };
      }
      // Счётчик id таблиц — за пределы загруженных позиционных id (t0, t1, …), чтобы
      // следующая интерактивно добавленная таблица не получила уже занятый id.
      syncTableCounter(action.doc);
      // Синтез метатаблиц источников-подзапросов и ссылок на ВТ ДО docToSnapshot
      // (мутирует fullName/tempTable тех же объектов SelectedTable, которые попадут в
      // снимок). Новый массив tables создаём только при наличии синтетики — иначе
      // ссылка на tables сохраняется.
      const subqueryMetas = synthesizeSubqueryTables(action.doc, new Set(state.tables.map(t => t.fullName)));
      const known = new Set([...state.tables.map(t => t.fullName), ...subqueryMetas.map(m => m.fullName)]);
      const tempMetas = synthesizeTempTables(action.doc, known);
      const newMetas = [...subqueryMetas, ...tempMetas];
      const snaps = action.doc.members.map(docToSnapshot);
      const savedQueries: (SavedQuery | null)[] = snaps[0].savedQueries.slice();
      savedQueries[0] = null;
      return {
        ...state,
        ...(newMetas.length > 0 ? { tables: [...state.tables, ...newMetas] } : {}),
        activeBatch: 0,
        batchSaved: snaps.map((s, i) => (i === 0 ? null : s)),
        queryList: snaps[0].queryList,
        activeQuery: 0,
        savedQueries,
        ...restoreSaved(state, snaps[0].savedQueries[0]),
        focusedDbTableFullName: null,
        focusedDbFieldPath: null,
      };
    }

    case 'ADD_ORDER_FIELD': {
      const { tableId, path } = action;
      if (state.order.fields.some(f => f.tableId === tableId && f.path === path)) return state;
      return {
        ...state,
        order: { ...state.order, fields: [...state.order.fields, { tableId, path, direction: 'asc' }] },
      };
    }

    case 'REMOVE_ORDER_FIELD': {
      const { tableId, path } = action;
      return {
        ...state,
        order: { ...state.order, fields: state.order.fields.filter(f => !(f.tableId === tableId && f.path === path)) },
      };
    }

    case 'SET_ORDER_DIRECTION': {
      const { tableId, path, direction } = action;
      return {
        ...state,
        order: {
          ...state.order,
          fields: state.order.fields.map(f =>
            f.tableId === tableId && f.path === path ? { ...f, direction } : f
          ),
        },
      };
    }

    case 'SET_ORDER_AUTO':
      return { ...state, order: { ...state.order, auto: action.auto } };

    case 'ADD_TOTAL_GROUP_FIELD': {
      const { tableId, path } = action;
      if (state.totals.groupFields.some(f => f.tableId === tableId && f.path === path)) return state;
      return {
        ...state,
        totals: { ...state.totals, groupFields: [...state.totals.groupFields, { tableId, path, kind: 'elements' }] },
      };
    }

    case 'REMOVE_TOTAL_GROUP_FIELD': {
      const { tableId, path } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          groupFields: state.totals.groupFields.filter(f => !(f.tableId === tableId && f.path === path)),
        },
      };
    }

    case 'SET_TOTAL_GROUP_KIND': {
      const { tableId, path, kind } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          groupFields: state.totals.groupFields.map(f =>
            f.tableId === tableId && f.path === path ? { ...f, kind } : f
          ),
        },
      };
    }

    case 'SET_TOTAL_GROUP_ALIAS': {
      const { tableId, path, alias } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          groupFields: state.totals.groupFields.map(f =>
            f.tableId === tableId && f.path === path ? { ...f, alias } : f
          ),
        },
      };
    }

    case 'ADD_TOTAL_FIELD': {
      const { tableId, path } = action;
      if (state.totals.totalFields.some(f => f.tableId === tableId && f.path === path)) return state;
      // 8.3.2: новое итоговое поле — простой агрегат КОЛИЧЕСТВО(<псевдонимКолонки>).
      // operandAlias — псевдоним соответствующей колонки выборки (или последний
      // сегмент пути), func задаёт функцию агрегата; генератор печатает их канонически
      // через wrapAggregate (expression не нужен).
      const operandAlias = totalOperandAlias(state, tableId, path);
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: [...state.totals.totalFields, { tableId, path, func: 'Количество', operandAlias }],
        },
      };
    }

    case 'REMOVE_TOTAL_FIELD': {
      const { index } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: state.totals.totalFields.filter((_, i) => i !== index),
        },
      };
    }

    case 'SET_TOTAL_FIELD_FUNC': {
      const { index, func } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: state.totals.totalFields.map((f, i) =>
            // Смена функции: операнд (operandAlias) сохраняем, сырое expression
            // сбрасываем — генератор соберёт ФУНКЦИЯ(operandAlias) канонически.
            i === index
              ? { ...f, func, operandAlias: f.operandAlias ?? totalOperandAlias(state, f.tableId, f.path), expression: undefined }
              : f
          ),
        },
      };
    }

    case 'SET_TOTAL_GRAND':
      return { ...state, totals: { ...state.totals, grand: action.grand } };

    case 'ADD_BUILDER_FIELD':
      return {
        ...state,
        builder: updateBuilderSection(state.builder, action.section, rows => [...rows, action.field]),
      };

    case 'REMOVE_BUILDER_FIELD':
      return {
        ...state,
        builder: updateBuilderSection(state.builder, action.section, rows =>
          rows.filter((_, i) => i !== action.index)
        ),
      };

    case 'SET_BUILDER_FIELD_CHILD':
      return {
        ...state,
        builder: updateBuilderSection(state.builder, action.section, rows =>
          rows.map((r, i) => (i === action.index ? { ...r, child: action.child } : r))
        ),
      };

    case 'SET_BUILDER_FIELD_ALIAS':
      return {
        ...state,
        builder: updateBuilderSection(state.builder, action.section, rows =>
          rows.map((r, i) => (i === action.index ? { ...r, alias: action.alias } : r))
        ),
      };

    case 'ADD_INDEX':
      return {
        ...state,
        indexing: { ...state.indexing, indexes: [...state.indexing.indexes, { unique: false, fields: [] }] },
      };

    case 'COPY_INDEX': {
      const src = state.indexing.indexes[action.index];
      if (!src) return state;
      const copy: QueryIndex = { unique: src.unique, fields: [...src.fields] };
      return {
        ...state,
        indexing: { ...state.indexing, indexes: [...state.indexing.indexes, copy] },
      };
    }

    case 'REMOVE_INDEX':
      return {
        ...state,
        indexing: { ...state.indexing, indexes: state.indexing.indexes.filter((_, i) => i !== action.index) },
      };

    case 'MOVE_INDEX': {
      const { index, dir } = action;
      const target = dir === 'up' ? index - 1 : index + 1;
      if (index < 0 || index >= state.indexing.indexes.length) return state;
      if (target < 0 || target >= state.indexing.indexes.length) return state;
      const indexes = [...state.indexing.indexes];
      [indexes[index], indexes[target]] = [indexes[target], indexes[index]];
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'SET_INDEX_UNIQUE': {
      if (!state.indexing.indexes[action.index]) return state;
      const indexes = state.indexing.indexes.map((idx, i) =>
        i === action.index ? { ...idx, unique: action.unique } : idx
      );
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'ADD_INDEX_FIELD': {
      const { index, tableId, path } = action;
      const idx = state.indexing.indexes[index];
      if (!idx) return state;
      if (idx.fields.some(f => f.tableId === tableId && f.path === path)) return state;
      const indexes = state.indexing.indexes.map((it, i) =>
        i === index ? { ...it, fields: [...it.fields, { tableId, path }] } : it
      );
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'ADD_ALL_INDEX_FIELDS': {
      const { index } = action;
      const idx = state.indexing.indexes[index];
      if (!idx) return state;
      const toAdd = action.fields.filter(
        nf => !idx.fields.some(f => f.tableId === nf.tableId && f.path === nf.path)
      );
      if (toAdd.length === 0) return state;
      const indexes = state.indexing.indexes.map((it, i) =>
        i === index ? { ...it, fields: [...it.fields, ...toAdd.map(f => ({ tableId: f.tableId, path: f.path }))] } : it
      );
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'REMOVE_INDEX_FIELD': {
      const { index, tableId, path } = action;
      if (!state.indexing.indexes[index]) return state;
      const indexes = state.indexing.indexes.map((it, i) =>
        i === index ? { ...it, fields: it.fields.filter(f => !(f.tableId === tableId && f.path === path)) } : it
      );
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'CLEAR_INDEX_FIELDS': {
      const { index } = action;
      if (!state.indexing.indexes[index]) return state;
      const indexes = state.indexing.indexes.map((it, i) =>
        i === index ? { ...it, fields: [] } : it
      );
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    case 'MOVE_INDEX_FIELD': {
      const { index, tableId, path, dir } = action;
      const idx = state.indexing.indexes[index];
      if (!idx) return state;
      const pos = idx.fields.findIndex(f => f.tableId === tableId && f.path === path);
      if (pos === -1) return state;
      const target = dir === 'up' ? pos - 1 : pos + 1;
      if (target < 0 || target >= idx.fields.length) return state;
      const fields = [...idx.fields];
      [fields[pos], fields[target]] = [fields[target], fields[pos]];
      const indexes = state.indexing.indexes.map((it, i) => (i === index ? { ...it, fields } : it));
      return { ...state, indexing: { ...state.indexing, indexes } };
    }

    default:
      return state;
  }
}
