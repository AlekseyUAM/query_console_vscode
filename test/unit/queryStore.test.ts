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

describe('queryStore reducer', () => {
  it('SET_METADATA updates tables', () => {
    const state = reducer(initialState(), { type: 'SET_METADATA', tables: [mockTable] });
    expect(state.tables).toHaveLength(1);
    expect(state.tables[0].fullName).toBe('Справочник.Валюты');
  });

  it('SET_GENERATED_TEXT updates generatedText', () => {
    const state = reducer(initialState(), { type: 'SET_GENERATED_TEXT', text: 'ВЫБРАТЬ 1' });
    expect(state.generatedText).toBe('ВЫБРАТЬ 1');
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
});
