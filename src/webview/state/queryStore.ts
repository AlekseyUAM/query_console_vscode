import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField, SelectedTabSectionField, VirtualParams, Grouping, AggregateFunction } from '../../core/query/queryModel';
import type { RefId } from '../../shared/messages';
import type { MetaField } from '../../core/metadata/types';

export interface QueryState {
  tables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  tabSectionFields: SelectedTabSectionField[];
  grouping: Grouping;
  expandedRefs: Map<string, MetaField[]>;
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedTableId: string | null;
  focusedSelectedFieldIdx: number | null;
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
  | { type: 'REMOVE_FIELD_FROM_SET'; index: number; tableId: string; path: string };

export function initialState(): QueryState {
  return {
    tables: [],
    selectedTables: [],
    selectedFields: [],
    tabSectionFields: [],
    grouping: { multiple: false, groupFields: [], groupSets: [], aggregates: [] },
    expandedRefs: new Map(),
    focusedDbTableFullName: null,
    focusedDbFieldPath: null,
    focusedSelectedTableId: null,
    focusedSelectedFieldIdx: null,
  };
}

let _tableCounter = 0;

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
      const filtered = state.selectedTables.filter(t => t.id !== action.tableId);
      const fields = state.selectedFields.filter(f => f.tableId !== action.tableId);
      const tabSectionFields = state.tabSectionFields.filter(ts => ts.tableId !== action.tableId);
      return { ...state, selectedTables: filtered, selectedFields: fields, tabSectionFields, focusedSelectedTableId: null };
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
      const fields = state.selectedFields.filter((_, i) => i !== action.fieldIdx);
      return { ...state, selectedFields: fields, focusedSelectedFieldIdx: null };
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

    default:
      return state;
  }
}
