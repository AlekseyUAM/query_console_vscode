import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField, SelectedTabSectionField, VirtualParams, Grouping, AggregateFunction, Condition, ConditionOperator, Selection, QueryType, QueryModel, Join, Order, SortDirection, Totals, TotalKind } from '../../core/query/queryModel';
import type { RefId } from '../../shared/messages';
import type { MetaField } from '../../core/metadata/types';
import { fieldAlias, type UnionMember } from '../../core/query/unionModel';
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
  | { type: 'SET_JOIN_TABLE'; index: number; side: 'left' | 'right'; tableId: string }
  | { type: 'SET_JOIN_ALL'; index: number; side: 'left' | 'right'; value: boolean }
  | { type: 'SET_JOIN_CUSTOM'; index: number; custom: boolean }
  | { type: 'SET_JOIN_FIELD'; index: number; side: 'left' | 'right'; path: string }
  | { type: 'SET_JOIN_OPERATOR'; index: number; operator: ConditionOperator }
  | { type: 'SET_JOIN_EXPRESSION'; index: number; expression: string }
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
  // --- слой пакета запросов ---
  | { type: 'ADD_BATCH_QUERY' }
  | { type: 'SET_ACTIVE_BATCH'; index: number }
  | { type: 'REMOVE_BATCH_QUERY'; index: number }
  | { type: 'MOVE_BATCH_QUERY'; index: number; dir: 'up' | 'down' }
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
  | { type: 'REMOVE_TOTAL_FIELD'; tableId: string; path: string }
  | { type: 'SET_TOTAL_FIELD_EXPRESSION'; tableId: string; path: string; expression: string }
  | { type: 'SET_TOTAL_GRAND'; grand: boolean };

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

// ============================================================================
// Слой документа объединения: снимок/восстановление активного запроса.
// ============================================================================

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

/** Применить переименование псевдонима колонки к списку полей одного запроса. */
function applyColumnAlias(fields: SelectedField[], alias: string, newAlias: string): SelectedField[] {
  return fields.map(f => (fieldAlias(f) === alias ? { ...f, alias: newAlias } : f));
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
      const alreadyIn = state.selectedTables.some(t => t.fullName === action.table.fullName);
      if (alreadyIn) return state;
      const id = `t${++_tableCounter}`;
      const newTable: SelectedTable = { id, fullName: action.table.fullName };
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
      return { ...state, selectedTables: filtered, selectedFields: fields, tabSectionFields, grouping, conditions, joins, lockForUpdate, order, totals, focusedSelectedTableId: null };
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

      const alreadyIn = state.selectedFields.some(f => f.tableId === tableId && f.path === action.fieldPath);
      if (alreadyIn) {
        return newSelectedTables !== state.selectedTables
          ? { ...state, selectedTables: newSelectedTables, focusedSelectedTableId: newFocusedTableId }
          : state;
      }

      return {
        ...state,
        selectedTables: newSelectedTables,
        focusedSelectedTableId: newFocusedTableId,
        selectedFields: [...state.selectedFields, { tableId, path: action.fieldPath }],
      };
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
      return { ...state, selectedFields: fields, grouping, order, totals, focusedSelectedFieldIdx: null };
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
      const conditions = state.conditions.map((c, i) =>
        i === action.index ? { ...c, expression: action.expression } : c
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

    case 'SET_JOIN_TABLE': {
      const joins = state.joins.map((j, i) =>
        i === action.index
          ? { ...j, [action.side === 'left' ? 'leftTableId' : 'rightTableId']: action.tableId }
          : j
      );
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

    case 'SET_JOIN_CUSTOM': {
      const joins = state.joins.map((j, i) =>
        i === action.index ? { ...j, custom: action.custom } : j
      );
      return { ...state, joins };
    }

    case 'SET_JOIN_FIELD': {
      const joins = state.joins.map((j, i) =>
        i === action.index
          ? { ...j, [action.side === 'left' ? 'leftPath' : 'rightPath']: action.path }
          : j
      );
      return { ...state, joins };
    }

    case 'SET_JOIN_OPERATOR': {
      const joins = state.joins.map((j, i) =>
        i === action.index ? { ...j, operator: action.operator } : j
      );
      return { ...state, joins };
    }

    case 'SET_JOIN_EXPRESSION': {
      const joins = state.joins.map((j, i) =>
        i === action.index ? { ...j, expression: action.expression } : j
      );
      return { ...state, joins };
    }

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
      return { ...state, queryType: action.queryType };

    case 'SET_TEMP_TABLE_NAME':
      return { ...state, tempTableName: action.name };

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
      const selectedFields = applyColumnAlias(state.selectedFields, alias, newAlias);
      const savedQueries = state.savedQueries.map((sq, i) =>
        i === state.activeQuery || sq === null
          ? sq
          : { ...sq, selectedFields: applyColumnAlias(sq.selectedFields, alias, newAlias) }
      );
      return { ...state, selectedFields, savedQueries };
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
      const last = path.split('.').pop() ?? path;
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: [...state.totals.totalFields, { tableId, path, expression: `СУММА(${last})` }],
        },
      };
    }

    case 'REMOVE_TOTAL_FIELD': {
      const { tableId, path } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: state.totals.totalFields.filter(f => !(f.tableId === tableId && f.path === path)),
        },
      };
    }

    case 'SET_TOTAL_FIELD_EXPRESSION': {
      const { tableId, path, expression } = action;
      return {
        ...state,
        totals: {
          ...state.totals,
          totalFields: state.totals.totalFields.map(f =>
            f.tableId === tableId && f.path === path ? { ...f, expression } : f
          ),
        },
      };
    }

    case 'SET_TOTAL_GRAND':
      return { ...state, totals: { ...state.totals, grand: action.grand } };

    default:
      return state;
  }
}
