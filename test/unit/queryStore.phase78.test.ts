import { describe, it, expect } from 'vitest';
import { reducer, initialState, assembleBatch } from '../../src/webview/state/queryStore';
import type { QueryState } from '../../src/webview/state/queryStore';
import { deriveUnionColumns } from '../../src/core/query/unionModel';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import type { MetaTable } from '../../src/core/metadata/types';

const валюты: MetaTable = {
  kind: 'Справочник',
  name: 'Валюты',
  fullName: 'Справочник.Валюты',
  fields: [
    { name: 'Код', kind: 'attribute', types: [{ primitive: 'Строка' }] },
    { name: 'Наименование', kind: 'attribute', types: [{ primitive: 'Строка' }] },
    { name: 'Ссылка', kind: 'standard', types: [] },
  ],
};

function withMetadataAndTable(): QueryState {
  let s = initialState();
  s = reducer(s, { type: 'SET_METADATA', tables: [валюты] });
  s = reducer(s, { type: 'ADD_TABLE', table: валюты });
  return s;
}

describe('7.8.6 ADD_ALL_FIELDS_WITH_TABLE', () => {
  it('adds every field of the table, creating the source if missing', () => {
    let s = initialState();
    s = reducer(s, { type: 'SET_METADATA', tables: [валюты] });
    s = reducer(s, {
      type: 'ADD_ALL_FIELDS_WITH_TABLE',
      tableFullName: 'Справочник.Валюты',
      fieldPaths: валюты.fields.map(f => f.name),
    });
    expect(s.selectedTables).toHaveLength(1);
    expect(s.selectedFields.map(f => f.path)).toEqual(['Код', 'Наименование', 'Ссылка']);
  });

  it('does not duplicate fields already present', () => {
    let s = withMetadataAndTable();
    const tid = s.selectedTables[0].id;
    s = reducer(s, { type: 'ADD_FIELD', tableId: tid, fieldPath: 'Код' });
    s = reducer(s, {
      type: 'ADD_ALL_FIELDS_WITH_TABLE',
      tableFullName: 'Справочник.Валюты',
      fieldPaths: ['Код', 'Наименование', 'Ссылка'],
    });
    expect(s.selectedFields.filter(f => f.path === 'Код')).toHaveLength(1);
    expect(s.selectedFields).toHaveLength(3);
  });
});

describe('7.8.5 SET_FIELD_EXPRESSION', () => {
  it('replaces the field in place with an expression field (no extra field)', () => {
    let s = withMetadataAndTable();
    const tid = s.selectedTables[0].id;
    s = reducer(s, { type: 'ADD_FIELD', tableId: tid, fieldPath: 'Код' });
    s = reducer(s, { type: 'SET_FIELD_EXPRESSION', fieldIdx: 0, expression: 'ВЫРАЗИТЬ(Валюты.Код КАК Строка)' });
    expect(s.selectedFields).toHaveLength(1);
    expect(s.selectedFields[0].path).toBe('');
    expect(s.selectedFields[0].expression).toBe('ВЫРАЗИТЬ(Валюты.Код КАК Строка)');
    expect(s.selectedFields[0].tableId).toBe(tid);
  });

  it('prunes the old field path from grouping/order when converted to an expression', () => {
    let s = withMetadataAndTable();
    const tid = s.selectedTables[0].id;
    s = reducer(s, { type: 'ADD_FIELD', tableId: tid, fieldPath: 'Код' });
    s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: tid, path: 'Код' });
    s = reducer(s, { type: 'ADD_ORDER_FIELD', tableId: tid, path: 'Код' });
    expect(s.grouping.groupFields).toHaveLength(1);
    expect(s.order.fields).toHaveLength(1);
    s = reducer(s, { type: 'SET_FIELD_EXPRESSION', fieldIdx: 0, expression: 'ВЫРАЗИТЬ(Валюты.Код КАК Число)' });
    expect(s.grouping.groupFields).toHaveLength(0);
    expect(s.order.fields).toHaveLength(0);
  });
});

describe('7.8.9 ADD_TEMP_TABLE', () => {
  it('adds a synthetic source table (invisible in the DB tree) with untyped fields', () => {
    let s = initialState();
    s = reducer(s, {
      type: 'ADD_TEMP_TABLE',
      name: 'ВТТовары',
      fields: [
        { name: 'Товар' },
        { name: 'Количество' },
      ],
    });
    const meta = s.tables.find(t => t.fullName === 'ВТТовары');
    expect(meta).toBeDefined();
    // 'ТабличнаяЧасть' kind keeps it out of DbTreePanel groups.
    expect(meta!.kind).toBe('ТабличнаяЧасть');
    expect(meta!.fields.map(f => f.name)).toEqual(['Товар', 'Количество']);
    // 7.8.9: «Тип значения» удалён — синтетические колонки без типов.
    expect(meta!.fields[1].types).toEqual([]);
    const sel = s.selectedTables.find(t => t.fullName === 'ВТТовары');
    expect(sel).toBeDefined();
    // 7.8.14: источник помечен как ВТ для повторного открытия окна.
    expect(sel!.tempTable).toBe(true);
  });

  it('generates a FROM referencing the temp table', () => {
    let s = reducer(initialState(), {
      type: 'ADD_TEMP_TABLE',
      name: 'ВТТовары',
      fields: [{ name: 'Товар' }],
    });
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'ВТТовары', fieldPath: 'Товар' });
    const text = generateBatch(assembleBatch(s));
    expect(text).toContain('ВТТовары');
    expect(text).toContain('ВТТовары.Товар');
  });
});

describe('7.8.8 ADD_SUBQUERY_TABLE', () => {
  it('adds a subquery source whose columns resolve and round-trip into generation', () => {
    const doc = parseBatch('ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты').members[0];
    const columns = deriveUnionColumns(doc.members).map(c => c.alias);
    expect(columns).toContain('Код');

    let s = initialState();
    s = reducer(s, { type: 'ADD_SUBQUERY_TABLE', name: 'ВложенныйЗапрос', subquery: doc, columns });
    const meta = s.tables.find(t => t.fullName === 'ВложенныйЗапрос');
    expect(meta).toBeDefined();
    expect(meta!.fields.map(f => f.name)).toContain('Код');
    const sel = s.selectedTables.find(t => t.fullName === 'ВложенныйЗапрос');
    expect(sel!.subquery).toBeDefined();

    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'ВложенныйЗапрос', fieldPath: 'Код' });
    const text = generateBatch(assembleBatch(s));
    expect(text).toContain('(ВЫБРАТЬ');
    expect(text).toContain('КАК ВложенныйЗапрос');
    expect(text).toContain('ВложенныйЗапрос.Код');
  });

  it('makes unique names when the base already exists', () => {
    const doc = parseBatch('ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты').members[0];
    let s = initialState();
    s = reducer(s, { type: 'ADD_SUBQUERY_TABLE', name: 'ВложенныйЗапрос', subquery: doc, columns: ['Код'] });
    s = reducer(s, { type: 'ADD_SUBQUERY_TABLE', name: 'ВложенныйЗапрос', subquery: doc, columns: ['Код'] });
    const names = s.selectedTables.map(t => t.fullName);
    expect(names).toContain('ВложенныйЗапрос');
    expect(names).toContain('ВложенныйЗапрос2');
  });
});
