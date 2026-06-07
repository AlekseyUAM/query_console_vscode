import { describe, it, expect } from 'vitest';
import {
  reducer,
  initialState,
  snapshotActive,
  restoreSaved,
  buildModelFromFlat,
  assembleMembers,
} from '../../src/webview/state/queryStore';
import { deriveUnionColumns } from '../../src/core/query/unionModel';
import type { MetaTable } from '../../src/core/metadata/types';

const mockTable: MetaTable = {
  kind: 'Справочник',
  name: 'Валюты',
  fullName: 'Справочник.Валюты',
  fields: [
    { name: 'Код', types: [{ primitive: 'Строка' }] },
    { name: 'Наименование', types: [{ primitive: 'Строка' }] },
  ],
};

const mockTable2: MetaTable = {
  kind: 'Документ',
  name: 'СчетНаОплату',
  fullName: 'Документ.СчетНаОплату',
  fields: [{ name: 'Дата', types: [{ primitive: 'Дата' }] }],
};

const mockSlice: MetaTable = {
  kind: 'РегистрСведений',
  name: 'Курсы.СрезПоследних',
  fullName: 'РегистрСведений.Курсы.СрезПоследних',
  fields: [{ name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] }],
  virtual: { slice: 'СрезПоследних', baseFullName: 'РегистрСведений.Курсы' },
};

describe('queryStore reducer', () => {
  it('SET_METADATA updates tables', () => {
    const state = reducer(initialState(), { type: 'SET_METADATA', tables: [mockTable] });
    expect(state.tables).toHaveLength(1);
    expect(state.tables[0].fullName).toBe('Справочник.Валюты');
  });

  it('ADD_FIELD_WITH_TABLE adds table and field atomically', () => {
    const state = reducer(initialState(), { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    expect(state.selectedTables).toHaveLength(1);
    expect(state.selectedTables[0].fullName).toBe('Справочник.Валюты');
    expect(state.selectedFields).toHaveLength(1);
    expect(state.selectedFields[0].path).toBe('Код');
  });

  it('SET_REF_FIELDS adds to expandedRefs', () => {
    const ref = { kind: 'Справочник' as const, name: 'Валюты' };
    const fields = [{ name: 'Код', types: [{ primitive: 'Строка' }] }];
    const state = reducer(initialState(), { type: 'SET_REF_FIELDS', ref, fields });
    expect(state.expandedRefs.get('Справочник.Валюты')).toEqual(fields);
  });

  it('ADD_TABLE adds a table and sets focusedSelectedTableId', () => {
    const state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    expect(state.selectedTables).toHaveLength(1);
    expect(state.selectedTables[0].fullName).toBe('Справочник.Валюты');
    expect(state.focusedSelectedTableId).toBe(state.selectedTables[0].id);
  });

  it('ADD_TABLE does not duplicate tables', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    state = reducer(state, { type: 'ADD_TABLE', table: mockTable });
    expect(state.selectedTables).toHaveLength(1);
  });

  it('REMOVE_TABLE removes the table and its fields', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Код' });
    state = reducer(state, { type: 'REMOVE_TABLE', tableId });
    expect(state.selectedTables).toHaveLength(0);
    expect(state.selectedFields).toHaveLength(0);
  });

  it('ADD_FIELD adds a field', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Код' });
    expect(state.selectedFields).toHaveLength(1);
    expect(state.selectedFields[0].path).toBe('Код');
  });

  it('ADD_FIELD does not duplicate fields', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Код' });
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Код' });
    expect(state.selectedFields).toHaveLength(1);
  });

  it('REMOVE_FIELD removes field by index', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Код' });
    state = reducer(state, { type: 'ADD_FIELD', tableId, fieldPath: 'Наименование' });
    state = reducer(state, { type: 'REMOVE_FIELD', fieldIdx: 0 });
    expect(state.selectedFields).toHaveLength(1);
    expect(state.selectedFields[0].path).toBe('Наименование');
  });

  it('FOCUS_DB_TABLE sets focusedDbTableFullName and clears fieldPath', () => {
    const withField = reducer(initialState(), { type: 'FOCUS_DB_FIELD', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    const state = reducer(withField, { type: 'FOCUS_DB_TABLE', fullName: 'Документ.СчетНаОплату' });
    expect(state.focusedDbTableFullName).toBe('Документ.СчетНаОплату');
    expect(state.focusedDbFieldPath).toBeNull();
  });

  it('FOCUS_DB_FIELD sets both focusedDbTableFullName and focusedDbFieldPath', () => {
    const state = reducer(initialState(), { type: 'FOCUS_DB_FIELD', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    expect(state.focusedDbTableFullName).toBe('Справочник.Валюты');
    expect(state.focusedDbFieldPath).toBe('Код');
  });

  it('FOCUS_SELECTED_TABLE sets focusedSelectedTableId', () => {
    const state = reducer(initialState(), { type: 'FOCUS_SELECTED_TABLE', id: 't1' });
    expect(state.focusedSelectedTableId).toBe('t1');
  });

  it('FOCUS_SELECTED_FIELD sets focusedSelectedFieldIdx', () => {
    const state = reducer(initialState(), { type: 'FOCUS_SELECTED_FIELD', idx: 2 });
    expect(state.focusedSelectedFieldIdx).toBe(2);
  });

  it('ADD_TABLE marks a virtual table with empty params', () => {
    const state = reducer(initialState(), { type: 'ADD_TABLE', table: mockSlice });
    expect(state.selectedTables[0].virtual).toEqual({});
  });

  it('ADD_TABLE leaves non-virtual tables without virtual marker', () => {
    const state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    expect(state.selectedTables[0].virtual).toBeUndefined();
  });

  it('SET_VIRTUAL_PARAMS writes params to the matching table', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockSlice });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'SET_VIRTUAL_PARAMS', tableId, params: { period: '&Период', condition: 'Валюта = &В' } });
    expect(state.selectedTables[0].virtual).toEqual({ period: '&Период', condition: 'Валюта = &В' });
  });

  it('ADD_TABLE copies correspondence into selected virtual; SET_VIRTUAL_PARAMS preserves it', () => {
    const meta: MetaTable = {
      kind: 'РегистрБухгалтерии', name: 'РБ1', fullName: 'РегистрБухгалтерии.РБ1.Обороты',
      fields: [],
      virtual: { slice: 'Обороты', baseFullName: 'РегистрБухгалтерии.РБ1', correspondence: true },
    };
    let st = reducer(initialState(), { type: 'ADD_TABLE', table: meta });
    const id = st.selectedTables[0].id;
    expect(st.selectedTables[0].virtual).toEqual({ correspondence: true });
    st = reducer(st, { type: 'SET_VIRTUAL_PARAMS', tableId: id, params: { periodicity: 'Авто' } });
    expect(st.selectedTables[0].virtual).toEqual({ periodicity: 'Авто', correspondence: true });
  });

  it('ADD_EXPRESSION_FIELD appends an expression field', () => {
    let state = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
    const tableId = state.selectedTables[0].id;
    state = reducer(state, { type: 'ADD_EXPRESSION_FIELD', tableId, expression: 'СУММА(Валюты.Код)' });
    expect(state.selectedFields).toHaveLength(1);
    expect(state.selectedFields[0].expression).toBe('СУММА(Валюты.Код)');
    expect(state.selectedFields[0].tableId).toBe(tableId);
  });
});

describe('queryStore reducer — grouping', () => {
  it('initialState has empty grouping', () => {
    const g = initialState().grouping;
    expect(g).toEqual({ multiple: false, groupFields: [], groupSets: [], aggregates: [] });
  });

  it('SET_GROUPING_MULTIPLE toggles multiple', () => {
    let state = reducer(initialState(), { type: 'SET_GROUPING_MULTIPLE', multiple: true });
    expect(state.grouping.multiple).toBe(true);
    state = reducer(state, { type: 'SET_GROUPING_MULTIPLE', multiple: false });
    expect(state.grouping.multiple).toBe(false);
  });

  it('ADD_GROUP_FIELD appends and dedupes', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Код' });
    expect(state.grouping.groupFields).toEqual([{ tableId: 't1', path: 'Код' }]);
  });

  it('REMOVE_GROUP_FIELD removes the matching field', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Наименование' });
    state = reducer(state, { type: 'REMOVE_GROUP_FIELD', tableId: 't1', path: 'Код' });
    expect(state.grouping.groupFields).toEqual([{ tableId: 't1', path: 'Наименование' }]);
  });

  it('ADD_SUMMABLE_FIELD appends with func and dedupes', () => {
    let state = reducer(initialState(), { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Сумма', func: 'Сумма' });
    state = reducer(state, { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Сумма', func: 'Количество' });
    expect(state.grouping.aggregates).toEqual([{ tableId: 't1', path: 'Сумма', func: 'Сумма' }]);
  });

  it('SET_SUMMABLE_FUNC changes func of an existing aggregate', () => {
    let state = reducer(initialState(), { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Сумма', func: 'Сумма' });
    state = reducer(state, { type: 'SET_SUMMABLE_FUNC', tableId: 't1', path: 'Сумма', func: 'Среднее' });
    expect(state.grouping.aggregates[0].func).toBe('Среднее');
  });

  it('REMOVE_SUMMABLE_FIELD removes the matching aggregate', () => {
    let state = reducer(initialState(), { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Сумма', func: 'Сумма' });
    state = reducer(state, { type: 'REMOVE_SUMMABLE_FIELD', tableId: 't1', path: 'Сумма' });
    expect(state.grouping.aggregates).toHaveLength(0);
  });

  it('group/summable are mutually exclusive: ADD_SUMMABLE removes from groupFields', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Код', func: 'Количество' });
    expect(state.grouping.groupFields).toHaveLength(0);
    expect(state.grouping.aggregates).toEqual([{ tableId: 't1', path: 'Код', func: 'Количество' }]);
  });

  it('group/summable are mutually exclusive: ADD_GROUP_FIELD removes from aggregates', () => {
    let state = reducer(initialState(), { type: 'ADD_SUMMABLE_FIELD', tableId: 't1', path: 'Код', func: 'Количество' });
    state = reducer(state, { type: 'ADD_GROUP_FIELD', tableId: 't1', path: 'Код' });
    expect(state.grouping.aggregates).toHaveLength(0);
    expect(state.grouping.groupFields).toEqual([{ tableId: 't1', path: 'Код' }]);
  });

  it('ADD_GROUP_SET / REMOVE_GROUP_SET manage sets', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_SET' });
    state = reducer(state, { type: 'ADD_GROUP_SET' });
    expect(state.grouping.groupSets).toHaveLength(2);
    state = reducer(state, { type: 'REMOVE_GROUP_SET', index: 0 });
    expect(state.grouping.groupSets).toHaveLength(1);
  });

  it('ADD_FIELD_TO_SET appends to the right set and dedupes within set', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_SET' });
    state = reducer(state, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: 't1', path: 'Код' });
    expect(state.grouping.groupSets[0]).toEqual([{ tableId: 't1', path: 'Код' }]);
  });

  it('ADD_FIELD_TO_SET on a missing index is a no-op', () => {
    const state = reducer(initialState(), { type: 'ADD_FIELD_TO_SET', index: 5, tableId: 't1', path: 'Код' });
    expect(state.grouping.groupSets).toHaveLength(0);
  });

  it('REMOVE_FIELD_FROM_SET removes the field from its set', () => {
    let state = reducer(initialState(), { type: 'ADD_GROUP_SET' });
    state = reducer(state, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: 't1', path: 'Наименование' });
    state = reducer(state, { type: 'REMOVE_FIELD_FROM_SET', index: 0, tableId: 't1', path: 'Код' });
    expect(state.grouping.groupSets[0]).toEqual([{ tableId: 't1', path: 'Наименование' }]);
  });
});

describe('queryStore reducer — conditions', () => {
  it('initialState has empty conditions', () => {
    expect(initialState().conditions).toEqual([]);
  });

  it('ADD_CONDITION appends with default operator and param from last path segment', () => {
    const state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    expect(state.conditions).toEqual([
      { custom: false, tableId: 't1', path: 'Код', operator: '=', param: '&Код' },
    ]);
  });

  it('ADD_CONDITION derives param from the last segment of a composite path', () => {
    const state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Валюта.Код' });
    expect(state.conditions[0].param).toBe('&Код');
  });

  it('ADD_CONDITION allows duplicates (each drop adds a row)', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    expect(state.conditions).toHaveLength(2);
  });

  it('REMOVE_CONDITION removes by index', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'ADD_CONDITION', tableId: 't1', path: 'Наименование' });
    state = reducer(state, { type: 'REMOVE_CONDITION', index: 0 });
    expect(state.conditions).toHaveLength(1);
    expect(state.conditions[0].path).toBe('Наименование');
  });

  it('SET_CONDITION_CUSTOM toggles the custom flag of a row', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'SET_CONDITION_CUSTOM', index: 0, custom: true });
    expect(state.conditions[0].custom).toBe(true);
    state = reducer(state, { type: 'SET_CONDITION_CUSTOM', index: 0, custom: false });
    expect(state.conditions[0].custom).toBe(false);
  });

  it('SET_CONDITION_OPERATOR sets the operator of a row', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'SET_CONDITION_OPERATOR', index: 0, operator: '<>' });
    expect(state.conditions[0].operator).toBe('<>');
  });

  it('SET_CONDITION_PARAM sets the param of a row', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'SET_CONDITION_PARAM', index: 0, param: '&МойКод' });
    expect(state.conditions[0].param).toBe('&МойКод');
  });

  it('SET_CONDITION_EXPRESSION sets the expression of a row', () => {
    let state = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    state = reducer(state, { type: 'SET_CONDITION_EXPRESSION', index: 0, expression: 'Валюты.Код = &Код' });
    expect(state.conditions[0].expression).toBe('Валюты.Код = &Код');
  });

  it('condition actions on a missing index are no-ops', () => {
    const base = reducer(initialState(), { type: 'ADD_CONDITION', tableId: 't1', path: 'Код' });
    expect(reducer(base, { type: 'SET_CONDITION_OPERATOR', index: 9, operator: '<>' }).conditions[0].operator).toBe('=');
    expect(reducer(base, { type: 'REMOVE_CONDITION', index: 9 }).conditions).toHaveLength(1);
  });
});

describe('queryStore reducer — Дополнительно (selection / query type / lock)', () => {
  it('initial state has selection/queryType/tempTableName/lock defaults', () => {
    const s = initialState();
    expect(s.selection).toEqual({});
    expect(s.queryType).toBe('select');
    expect(s.tempTableName).toBe('');
    expect(s.lockForUpdate).toEqual([]);
    expect(s.lockEnabled).toBe(false);
  });

  it('SET_SELECTION_TOP sets a numeric top', () => {
    const s = reducer(initialState(), { type: 'SET_SELECTION_TOP', top: 10 });
    expect(s.selection.top).toBe(10);
  });

  it('SET_SELECTION_TOP with undefined clears top', () => {
    let s = reducer(initialState(), { type: 'SET_SELECTION_TOP', top: 10 });
    s = reducer(s, { type: 'SET_SELECTION_TOP', top: undefined });
    expect(s.selection.top).toBeUndefined();
  });

  it('SET_SELECTION_TOP with 0 clears top', () => {
    let s = reducer(initialState(), { type: 'SET_SELECTION_TOP', top: 10 });
    s = reducer(s, { type: 'SET_SELECTION_TOP', top: 0 });
    expect(s.selection.top).toBeUndefined();
  });

  it('SET_SELECTION_DISTINCT toggles distinct', () => {
    const s = reducer(initialState(), { type: 'SET_SELECTION_DISTINCT', distinct: true });
    expect(s.selection.distinct).toBe(true);
  });

  it('SET_SELECTION_ALLOWED toggles allowed', () => {
    const s = reducer(initialState(), { type: 'SET_SELECTION_ALLOWED', allowed: true });
    expect(s.selection.allowed).toBe(true);
  });

  it('selection setters preserve other selection fields', () => {
    let s = reducer(initialState(), { type: 'SET_SELECTION_TOP', top: 5 });
    s = reducer(s, { type: 'SET_SELECTION_DISTINCT', distinct: true });
    s = reducer(s, { type: 'SET_SELECTION_ALLOWED', allowed: true });
    expect(s.selection).toEqual({ top: 5, distinct: true, allowed: true });
  });

  it('SET_QUERY_TYPE sets the query type', () => {
    const s = reducer(initialState(), { type: 'SET_QUERY_TYPE', queryType: 'createTemp' });
    expect(s.queryType).toBe('createTemp');
  });

  it('SET_TEMP_TABLE_NAME sets the temp table name', () => {
    const s = reducer(initialState(), { type: 'SET_TEMP_TABLE_NAME', name: 'ВТ_Курсы' });
    expect(s.tempTableName).toBe('ВТ_Курсы');
  });

  it('SET_LOCK_ENABLED true enables locking', () => {
    const s = reducer(initialState(), { type: 'SET_LOCK_ENABLED', enabled: true });
    expect(s.lockEnabled).toBe(true);
  });

  it('SET_LOCK_ENABLED false clears lockForUpdate', () => {
    let s = reducer(initialState(), { type: 'SET_LOCK_ENABLED', enabled: true });
    s = reducer(s, { type: 'ADD_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    s = reducer(s, { type: 'SET_LOCK_ENABLED', enabled: false });
    expect(s.lockEnabled).toBe(false);
    expect(s.lockForUpdate).toEqual([]);
  });

  it('ADD_LOCK_TABLE appends a table', () => {
    const s = reducer(initialState(), { type: 'ADD_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    expect(s.lockForUpdate).toEqual(['Справочник.Валюты']);
  });

  it('ADD_LOCK_TABLE dedupes', () => {
    let s = reducer(initialState(), { type: 'ADD_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    s = reducer(s, { type: 'ADD_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    expect(s.lockForUpdate).toEqual(['Справочник.Валюты']);
  });

  it('REMOVE_LOCK_TABLE removes a table', () => {
    let s = reducer(initialState(), { type: 'ADD_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    s = reducer(s, { type: 'ADD_LOCK_TABLE', fullName: 'Документ.СчетНаОплату' });
    s = reducer(s, { type: 'REMOVE_LOCK_TABLE', fullName: 'Справочник.Валюты' });
    expect(s.lockForUpdate).toEqual(['Документ.СчетНаОплату']);
  });
});

describe('queryStore — union document layer (multiple sub-queries)', () => {
  // Helper: a flat state with one field added, via ADD_FIELD_WITH_TABLE.
  function withField(state = initialState(), full = 'Справочник.Валюты', path = 'Код') {
    return reducer(state, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: full, fieldPath: path });
  }

  describe('initialState', () => {
    it('has one default sub-query, active 0, savedQueries [null]', () => {
      const s = initialState();
      expect(s.queryList).toEqual([{ name: 'Запрос 1', distinct: false }]);
      expect(s.activeQuery).toBe(0);
      expect(s.savedQueries).toEqual([null]);
      expect(s.selectedFields).toEqual([]);
    });
  });

  describe('snapshotActive / restoreSaved / buildModelFromFlat', () => {
    it('snapshotActive captures the per-query working set', () => {
      const s = withField();
      const snap = snapshotActive(s);
      expect(snap.selectedFields).toHaveLength(1);
      expect(snap.selectedTables).toHaveLength(1);
      expect(snap.queryType).toBe('select');
      // shared / transient fields not part of the snapshot
      expect((snap as Record<string, unknown>).tables).toBeUndefined();
      expect((snap as Record<string, unknown>).expandedRefs).toBeUndefined();
    });

    it('restoreSaved(null) yields empty defaults and resets focus', () => {
      const restored = restoreSaved(initialState(), null);
      expect(restored.selectedFields).toEqual([]);
      expect(restored.selectedTables).toEqual([]);
      expect(restored.focusedSelectedFieldIdx).toBeNull();
      expect(restored.focusedSelectedTableId).toBeNull();
    });

    it('snapshot → restore round-trips the working set', () => {
      const s = withField();
      const snap = snapshotActive(s);
      const restored = restoreSaved(initialState(), snap);
      expect(restored.selectedFields).toEqual(s.selectedFields);
      expect(restored.selectedTables).toEqual(s.selectedTables);
    });

    it('buildModelFromFlat assembles a QueryModel', () => {
      const s = withField();
      const model = buildModelFromFlat(snapshotActive(s));
      expect(model.tables).toEqual(s.selectedTables);
      expect(model.fields).toEqual(s.selectedFields);
      expect(model.queryType).toBe('select');
    });
  });

  describe('ADD_QUERY', () => {
    it('grows queryList, moves active to new, empties flat state, preserves prior in savedQueries', () => {
      const s0 = withField(); // active query 0 has a field
      const s1 = reducer(s0, { type: 'ADD_QUERY' });
      expect(s1.queryList).toHaveLength(2);
      expect(s1.queryList[1]).toEqual({ name: 'Запрос 2', distinct: false });
      expect(s1.activeQuery).toBe(1);
      expect(s1.savedQueries).toHaveLength(2);
      // new active slot is live (null), old slot has snapshot
      expect(s1.savedQueries[1]).toBeNull();
      expect(s1.savedQueries[0]).not.toBeNull();
      expect(s1.savedQueries[0]!.selectedFields).toHaveLength(1);
      // flat state empty
      expect(s1.selectedFields).toEqual([]);
    });
  });

  describe('SET_ACTIVE_QUERY', () => {
    it('no-op when index === activeQuery', () => {
      const s = withField();
      expect(reducer(s, { type: 'SET_ACTIVE_QUERY', index: 0 })).toBe(s);
    });

    it('round-trips snapshot/restore between two sub-queries', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // query 0: Код
      s = reducer(s, { type: 'ADD_QUERY' });
      s = withField(s, 'Документ.СчетНаОплату', 'Дата'); // query 1: Дата
      // switch back to 0
      s = reducer(s, { type: 'SET_ACTIVE_QUERY', index: 0 });
      expect(s.activeQuery).toBe(0);
      expect(s.selectedFields).toHaveLength(1);
      expect(s.selectedFields[0].path).toBe('Код');
      expect(s.savedQueries[0]).toBeNull();
      expect(s.savedQueries[1]).not.toBeNull();
      // switch to 1
      s = reducer(s, { type: 'SET_ACTIVE_QUERY', index: 1 });
      expect(s.activeQuery).toBe(1);
      expect(s.selectedFields).toHaveLength(1);
      expect(s.selectedFields[0].path).toBe('Дата');
      // savedQueries length stays in sync with queryList
      expect(s.savedQueries).toHaveLength(s.queryList.length);
    });
  });

  describe('REMOVE_QUERY', () => {
    it('cannot remove the last remaining query', () => {
      const s = withField();
      expect(reducer(s, { type: 'REMOVE_QUERY', index: 0 })).toBe(s);
    });

    it('removing the active query picks a neighbor and loads it', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0: Код
      s = reducer(s, { type: 'ADD_QUERY' });
      s = withField(s, 'Документ.СчетНаОплату', 'Дата'); // 1: Дата (active)
      s = reducer(s, { type: 'REMOVE_QUERY', index: 1 });
      expect(s.queryList).toHaveLength(1);
      expect(s.savedQueries).toHaveLength(1);
      expect(s.activeQuery).toBe(0);
      // neighbor (query 0) becomes live
      expect(s.savedQueries[0]).toBeNull();
      expect(s.selectedFields[0].path).toBe('Код');
    });

    it('removing a non-active query before active shifts the active index down', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0: Код
      s = reducer(s, { type: 'ADD_QUERY' }); // 1
      s = withField(s, 'Документ.СчетНаОплату', 'Дата'); // 1: Дата
      s = reducer(s, { type: 'ADD_QUERY' }); // 2 (active)
      s = withField(s, 'Справочник.Валюты', 'Наименование'); // 2: Наименование
      expect(s.activeQuery).toBe(2);
      // remove query 0 (non-active, before active)
      s = reducer(s, { type: 'REMOVE_QUERY', index: 0 });
      expect(s.queryList).toHaveLength(2);
      expect(s.activeQuery).toBe(1);
      // active stays live and unchanged
      expect(s.savedQueries[s.activeQuery]).toBeNull();
      expect(s.selectedFields[0].path).toBe('Наименование');
      // remaining saved query (former #1) preserved
      expect(s.savedQueries[0]!.selectedFields[0].path).toBe('Дата');
    });

    it('removing a non-active query after active keeps active index', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0: Код (will stay active)
      s = reducer(s, { type: 'ADD_QUERY' }); // 1
      s = withField(s, 'Документ.СчетНаОплату', 'Дата'); // 1: Дата
      s = reducer(s, { type: 'SET_ACTIVE_QUERY', index: 0 }); // active 0
      s = reducer(s, { type: 'REMOVE_QUERY', index: 1 });
      expect(s.queryList).toHaveLength(1);
      expect(s.activeQuery).toBe(0);
      expect(s.selectedFields[0].path).toBe('Код');
    });
  });

  describe('RENAME_QUERY / SET_QUERY_DISTINCT', () => {
    it('RENAME_QUERY updates the name', () => {
      let s = reducer(initialState(), { type: 'ADD_QUERY' });
      s = reducer(s, { type: 'RENAME_QUERY', index: 0, name: 'Основной' });
      expect(s.queryList[0].name).toBe('Основной');
      expect(s.queryList[1].name).toBe('Запрос 2');
    });

    it('SET_QUERY_DISTINCT updates the distinct flag', () => {
      let s = reducer(initialState(), { type: 'ADD_QUERY' });
      s = reducer(s, { type: 'SET_QUERY_DISTINCT', index: 1, distinct: true });
      expect(s.queryList[1].distinct).toBe(true);
      expect(s.queryList[0].distinct).toBe(false);
    });
  });

  describe('assembleMembers', () => {
    it('reflects the live active query plus saved others', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0: Код
      s = reducer(s, { type: 'ADD_QUERY' });
      s = withField(s, 'Документ.СчетНаОплату', 'Дата'); // 1: Дата (active)
      const members = assembleMembers(s);
      expect(members).toHaveLength(2);
      expect(members[0].name).toBe('Запрос 1');
      expect(members[0].model.fields[0].path).toBe('Код');
      expect(members[1].name).toBe('Запрос 2');
      expect(members[1].model.fields[0].path).toBe('Дата');
    });

    it('carries distinct flags from queryList', () => {
      let s = reducer(initialState(), { type: 'SET_QUERY_DISTINCT', index: 0, distinct: true });
      const members = assembleMembers(s);
      expect(members[0].distinct).toBe(true);
    });
  });

  describe('SET_COLUMN_ALIAS', () => {
    it('renames the matching field across every member and merges into one column', () => {
      // two members each with a field aliased "Код" (member 0 path Код, member 1 path Code via alias)
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0: path Код → alias Код
      s = reducer(s, { type: 'ADD_QUERY' });
      s = withField(s, 'Документ.СчетНаОплату', 'Код'); // 1: path Код → alias Код (active)
      // rename column "Код" → "Идентификатор"
      s = reducer(s, { type: 'SET_COLUMN_ALIAS', alias: 'Код', newAlias: 'Идентификатор' });
      // active (member 1) field gets alias in flat state
      expect(s.selectedFields[0].alias).toBe('Идентификатор');
      // saved (member 0) field gets alias in snapshot
      expect(s.savedQueries[0]!.selectedFields[0].alias).toBe('Идентификатор');
      // derive columns → single merged column with new alias
      const cols = deriveUnionColumns(assembleMembers(s));
      expect(cols).toHaveLength(1);
      expect(cols[0].alias).toBe('Идентификатор');
      expect(cols[0].cells.every(c => c !== null)).toBe(true);
    });
  });

  describe('existing actions still operate on the active query', () => {
    it('ADD_QUERY then editing affects only the new active query', () => {
      let s = withField(initialState(), 'Справочник.Валюты', 'Код'); // 0
      s = reducer(s, { type: 'ADD_QUERY' }); // 1 active, empty
      s = reducer(s, { type: 'SET_QUERY_TYPE', queryType: 'createTemp' });
      expect(s.queryType).toBe('createTemp');
      // query 0 snapshot retains its own (default) queryType
      expect(s.savedQueries[0]!.queryType).toBe('select');
    });
  });

  describe('REMOVE_TABLE cascades into grouping/conditions/lockForUpdate', () => {
    it('prunes grouping/conditions/lock entries of the removed table, leaves others intact', () => {
      // Two tables: t1 (Валюты) и t2 (СчётНаОплату).
      let s = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
      const t1 = s.selectedTables[0].id;
      s = reducer(s, { type: 'ADD_TABLE', table: mockTable2 });
      const t2 = s.selectedTables[1].id;

      // Поля выборки обеих таблиц.
      s = reducer(s, { type: 'ADD_FIELD', tableId: t1, fieldPath: 'Код' });
      s = reducer(s, { type: 'ADD_FIELD', tableId: t2, fieldPath: 'Дата' });

      // Группировка: groupFields, aggregates, наборы — ссылки на обе таблицы.
      s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: t2, path: 'Дата' });
      s = reducer(s, { type: 'ADD_SUMMABLE_FIELD', tableId: t1, path: 'Наименование', func: 'Сумма' });
      s = reducer(s, { type: 'ADD_SUMMABLE_FIELD', tableId: t2, path: 'Сумма', func: 'Сумма' });
      s = reducer(s, { type: 'ADD_GROUP_SET' });
      s = reducer(s, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: t2, path: 'Дата' });

      // Условия: простое условие на t1, простое условие на t2, произвольное (custom).
      s = reducer(s, { type: 'ADD_CONDITION', tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'ADD_CONDITION', tableId: t2, path: 'Дата' });
      const customIdx = s.conditions.length;
      s = reducer(s, { type: 'ADD_CONDITION', tableId: t2, path: 'Дата' });
      s = reducer(s, { type: 'SET_CONDITION_CUSTOM', index: customIdx, custom: true });
      s = reducer(s, { type: 'SET_CONDITION_EXPRESSION', index: customIdx, expression: 'ИСТИНА' });

      // Блокировка для обеих таблиц.
      s = reducer(s, { type: 'SET_LOCK_ENABLED', enabled: true });
      s = reducer(s, { type: 'ADD_LOCK_TABLE', fullName: mockTable.fullName });
      s = reducer(s, { type: 'ADD_LOCK_TABLE', fullName: mockTable2.fullName });

      // Удаляем t1.
      s = reducer(s, { type: 'REMOVE_TABLE', tableId: t1 });

      // groupFields: только t2 остался.
      expect(s.grouping.groupFields).toEqual([{ tableId: t2, path: 'Дата' }]);
      // aggregates: только t2 остался.
      expect(s.grouping.aggregates).toEqual([{ tableId: t2, path: 'Сумма', func: 'Сумма' }]);
      // groupSets: набор теперь содержит только t2.
      expect(s.grouping.groupSets).toEqual([[{ tableId: t2, path: 'Дата' }]]);
      // conditions: простое условие t1 удалено, простое t2 и custom остались.
      expect(s.conditions.filter(c => !c.custom && c.tableId === t1)).toEqual([]);
      expect(s.conditions.some(c => !c.custom && c.tableId === t2)).toBe(true);
      expect(s.conditions.some(c => c.custom && c.expression === 'ИСТИНА')).toBe(true);
      // lockForUpdate: запись t1 (Валюты) удалена, t2 (СчётНаОплату) остался.
      expect(s.lockForUpdate).toEqual([mockTable2.fullName]);
      // selectedTables/selectedFields пруны как раньше.
      expect(s.selectedTables.map(t => t.id)).toEqual([t2]);
      expect(s.selectedFields).toEqual([{ tableId: t2, path: 'Дата' }]);
    });

    it('drops a groupSet that becomes empty after removing its only table', () => {
      let s = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
      const t1 = s.selectedTables[0].id;
      s = reducer(s, { type: 'ADD_GROUP_SET' });
      s = reducer(s, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'REMOVE_TABLE', tableId: t1 });
      expect(s.grouping.groupSets).toEqual([]);
    });
  });

  describe('REMOVE_FIELD cascades into grouping (not conditions)', () => {
    it('prunes the removed field from groupFields/aggregates/sets, leaves others and conditions', () => {
      let s = reducer(initialState(), { type: 'ADD_TABLE', table: mockTable });
      const t1 = s.selectedTables[0].id;
      s = reducer(s, { type: 'ADD_FIELD', tableId: t1, fieldPath: 'Код' });          // idx 0
      s = reducer(s, { type: 'ADD_FIELD', tableId: t1, fieldPath: 'Наименование' }); // idx 1

      // Группировка ссылается на оба поля.
      s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'ADD_SUMMABLE_FIELD', tableId: t1, path: 'Наименование', func: 'Сумма' });
      s = reducer(s, { type: 'ADD_GROUP_SET' });
      s = reducer(s, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: t1, path: 'Код' });
      s = reducer(s, { type: 'ADD_FIELD_TO_SET', index: 0, tableId: t1, path: 'Наименование' });

      // Условие на удаляемое поле — должно ОСТАТЬСЯ.
      s = reducer(s, { type: 'ADD_CONDITION', tableId: t1, path: 'Код' });

      // Удаляем поле idx 0 (Код).
      s = reducer(s, { type: 'REMOVE_FIELD', fieldIdx: 0 });

      // Поле выборки удалено.
      expect(s.selectedFields).toEqual([{ tableId: t1, path: 'Наименование' }]);
      // groupFields: Код удалён.
      expect(s.grouping.groupFields).toEqual([]);
      // aggregates (Наименование) не тронуты.
      expect(s.grouping.aggregates).toEqual([{ tableId: t1, path: 'Наименование', func: 'Сумма' }]);
      // groupSets: Код удалён из набора, Наименование остался.
      expect(s.grouping.groupSets).toEqual([[{ tableId: t1, path: 'Наименование' }]]);
      // conditions НЕ тронуты при удалении поля.
      expect(s.conditions).toEqual([{ custom: false, tableId: t1, path: 'Код', operator: '=', param: '&Код' }]);
    });
  });
});
