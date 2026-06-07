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
