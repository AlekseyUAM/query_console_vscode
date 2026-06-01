import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField } from '../../core/query/queryModel';
import type { RefId } from '../../shared/messages';
import type { MetaField } from '../../core/metadata/types';

export interface QueryState {
  tables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  expandedRefs: Map<string, MetaField[]>;
  generatedText: string;
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedTableId: string | null;
  focusedSelectedFieldIdx: number | null;
}

export type QueryAction =
  | { type: 'SET_METADATA'; tables: MetaTable[] }
  | { type: 'SET_GENERATED_TEXT'; text: string }
  | { type: 'SET_REF_FIELDS'; ref: RefId; fields: MetaField[] }
  | { type: 'FOCUS_DB_TABLE'; fullName: string }
  | { type: 'FOCUS_DB_FIELD'; tableFullName: string; fieldPath: string }
  | { type: 'ADD_TABLE'; table: MetaTable }
  | { type: 'REMOVE_TABLE'; tableId: string }
  | { type: 'ADD_FIELD'; tableId: string; fieldPath: string }
  | { type: 'REMOVE_FIELD'; fieldIdx: number }
  | { type: 'FOCUS_SELECTED_TABLE'; id: string }
  | { type: 'FOCUS_SELECTED_FIELD'; idx: number };

export function initialState(): QueryState {
  return {
    tables: [],
    selectedTables: [],
    selectedFields: [],
    expandedRefs: new Map(),
    generatedText: '',
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

    case 'SET_GENERATED_TEXT':
      return { ...state, generatedText: action.text };

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
      return {
        ...state,
        selectedTables: [...state.selectedTables, { id, fullName: action.table.fullName }],
        focusedSelectedTableId: id,
      };
    }

    case 'REMOVE_TABLE': {
      const filtered = state.selectedTables.filter(t => t.id !== action.tableId);
      const fields = state.selectedFields.filter(f => f.tableId !== action.tableId);
      return { ...state, selectedTables: filtered, selectedFields: fields, focusedSelectedTableId: null };
    }

    case 'ADD_FIELD': {
      const alreadyIn = state.selectedFields.some(
        f => f.tableId === action.tableId && f.path === action.fieldPath
      );
      if (alreadyIn) return state;
      const newField = { tableId: action.tableId, path: action.fieldPath };
      return { ...state, selectedFields: [...state.selectedFields, newField] };
    }

    case 'REMOVE_FIELD': {
      const fields = state.selectedFields.filter((_, i) => i !== action.fieldIdx);
      return { ...state, selectedFields: fields, focusedSelectedFieldIdx: null };
    }

    case 'FOCUS_SELECTED_TABLE':
      return { ...state, focusedSelectedTableId: action.id };

    case 'FOCUS_SELECTED_FIELD':
      return { ...state, focusedSelectedFieldIdx: action.idx };

    default:
      return state;
  }
}
