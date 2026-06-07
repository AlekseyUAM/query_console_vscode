import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../../src/webview/state/queryStore';
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
