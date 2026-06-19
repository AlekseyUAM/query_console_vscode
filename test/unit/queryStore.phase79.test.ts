import { describe, it, expect } from 'vitest';
import { reducer, initialState, assembleBatch } from '../../src/webview/state/queryStore';
import type { QueryState } from '../../src/webview/state/queryStore';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { parseBatch } from '../../src/core/query/sdblParser';
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

function withMetadata(): QueryState {
  let s = initialState();
  s = reducer(s, { type: 'SET_METADATA', tables: [валюты] });
  return s;
}

describe('7.8.13 — ADD_TABLE duplicates get ordinal synonyms', () => {
  it('appends a second selected table with alias Валюты1 and generates КАК Валюты1', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    expect(s.selectedTables).toHaveLength(2);
    expect(s.selectedTables[0].alias).toBeUndefined();
    expect(s.selectedTables[1].alias).toBe('Валюты1');

    // add a field to each table so both appear in FROM
    const [t0, t1] = s.selectedTables;
    s = reducer(s, { type: 'ADD_FIELD', tableId: t0.id, fieldPath: 'Код' });
    s = reducer(s, { type: 'ADD_FIELD', tableId: t1.id, fieldPath: 'Код' });
    const text = generateBatch(assembleBatch(s));
    expect(text).toContain('КАК Валюты1');
  });

  it('assigns Валюты1, Валюты2 for three copies', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    expect(s.selectedTables.map(t => t.alias)).toEqual([undefined, 'Валюты1', 'Валюты2']);
  });
});

describe('7.8.11 — ADD_FIELD_WITH_TABLE duplicates get ordinal column synonyms', () => {
  it('allows three copies of Код with aliases [undefined, Код1, Код2]', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'Справочник.Валюты', fieldPath: 'Код' });
    expect(s.selectedFields).toHaveLength(3);
    expect(s.selectedFields.map(f => f.alias)).toEqual([undefined, 'Код1', 'Код2']);
    const text = generateBatch(assembleBatch(s));
    expect(text).toContain('КАК Код1');
    expect(text).toContain('КАК Код2');
  });
});

describe('7.8.16 — ADD_ALL_FIELDS_DUP appends all fields with synonyms', () => {
  it('appends every meta field again, assigning ordinal aliases to duplicates', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    const tid = s.selectedTables[0].id;
    s = reducer(s, { type: 'ADD_FIELD', tableId: tid, fieldPath: 'Код' });
    const before = s.selectedFields.length;
    s = reducer(s, { type: 'ADD_ALL_FIELDS_DUP', tableId: tid });
    expect(s.selectedFields).toHaveLength(before + валюты.fields.length);
    // the duplicate Код (second occurrence) gets alias Код1
    const кодFields = s.selectedFields.filter(f => f.tableId === tid && f.path === 'Код');
    expect(кодFields).toHaveLength(2);
    expect(кодFields[0].alias).toBeUndefined();
    expect(кодFields[1].alias).toBe('Код1');
  });

  it('returns state unchanged when the table id is unknown', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    const prev = s;
    s = reducer(s, { type: 'ADD_ALL_FIELDS_DUP', tableId: 'nope' });
    expect(s).toBe(prev);
  });
});

describe('7.8.14 — UPDATE_TEMP_TABLE renames + replaces columns + prunes fields', () => {
  it('renames the temp table, drops a column, keeps the surviving selected field, then prunes it on second drop', () => {
    let s = initialState();
    s = reducer(s, {
      type: 'ADD_TEMP_TABLE',
      name: 'ВТТовары',
      fields: [{ name: 'Товар' }, { name: 'Количество' }],
    });
    const tid = s.selectedTables.find(t => t.tempTable)!.id;
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'ВТТовары', fieldPath: 'Товар' });
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Товар')).toHaveLength(1);

    // rename ВТТовары → ВТ2, dropping Количество (keep Товар).
    s = reducer(s, { type: 'UPDATE_TEMP_TABLE', tableId: tid, name: 'ВТ2', fields: [{ name: 'Товар' }] });

    const meta = s.tables.find(t => t.fullName === 'ВТ2');
    expect(meta).toBeDefined();
    expect(meta!.fields.map(f => f.name)).toEqual(['Товар']);
    expect(meta!.fields[0].types).toEqual([]);
    // old synthetic meta is gone.
    expect(s.tables.find(t => t.fullName === 'ВТТовары')).toBeUndefined();
    // the selected table is renamed (same id, still tempTable).
    const sel = s.selectedTables.find(t => t.id === tid)!;
    expect(sel.fullName).toBe('ВТ2');
    expect(sel.tempTable).toBe(true);
    // the previously-selected Товар field survives.
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Товар')).toHaveLength(1);

    // a second update dropping Товар too → the selected field is pruned.
    s = reducer(s, { type: 'UPDATE_TEMP_TABLE', tableId: tid, name: 'ВТ2', fields: [] });
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Товар')).toHaveLength(0);
    const meta2 = s.tables.find(t => t.fullName === 'ВТ2');
    expect(meta2!.fields).toHaveLength(0);
  });

  it('prunes grouping/order/totals/indexing references for dropped temp-table fields', () => {
    let s = initialState();
    s = reducer(s, { type: 'ADD_TEMP_TABLE', name: 'ВТ', fields: [{ name: 'Товар' }] });
    const tid = s.selectedTables.find(t => t.tempTable)!.id;
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: 'ВТ', fieldPath: 'Товар' });
    s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: tid, path: 'Товар' });
    s = reducer(s, { type: 'ADD_ORDER_FIELD', tableId: tid, path: 'Товар' });
    expect(s.grouping.groupFields).toHaveLength(1);
    expect(s.order.fields).toHaveLength(1);

    s = reducer(s, { type: 'UPDATE_TEMP_TABLE', tableId: tid, name: 'ВТ', fields: [] });
    expect(s.grouping.groupFields).toHaveLength(0);
    expect(s.order.fields).toHaveLength(0);
  });

  it('returns state unchanged when the table id is missing or not a temp table', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    const prev = s;
    expect(reducer(s, { type: 'UPDATE_TEMP_TABLE', tableId: 'nope', name: 'X', fields: [] })).toBe(prev);
    // an ordinary (non-temp) table is not updatable as a temp table.
    const realId = s.selectedTables[0].id;
    expect(reducer(s, { type: 'UPDATE_TEMP_TABLE', tableId: realId, name: 'X', fields: [] })).toBe(prev);
  });
});

describe('7.8.15 — UPDATE_SUBQUERY_TABLE replaces subquery + columns + prunes fields', () => {
  const docKodNaim = parseBatch(
    'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tВалюты.Наименование КАК Наименование\nИЗ\n\tСправочник.Валюты КАК Валюты'
  ).members[0];
  const docKod = parseBatch(
    'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
  ).members[0];
  const docX = parseBatch(
    'ВЫБРАТЬ\n\tВалюты.Код КАК X\nИЗ\n\tСправочник.Валюты КАК Валюты'
  ).members[0];

  it('replaces subquery + synthetic columns, keeps surviving field, prunes the dropped one', () => {
    let s = initialState();
    s = reducer(s, { type: 'ADD_SUBQUERY_TABLE', name: 'ВложенныйЗапрос', subquery: docKodNaim, columns: ['Код', 'Наименование'] });
    const sel0 = s.selectedTables.find(t => t.subquery)!;
    const tid = sel0.id;
    const fullName = sel0.fullName;
    // synthetic meta has both columns.
    expect(s.tables.find(t => t.fullName === fullName)!.fields.map(f => f.name)).toEqual(['Код', 'Наименование']);

    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: fullName, fieldPath: 'Код' });
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Код')).toHaveLength(1);

    // update to a doc with just Код.
    s = reducer(s, { type: 'UPDATE_SUBQUERY_TABLE', tableId: tid, subquery: docKod, columns: ['Код'] });

    const meta = s.tables.find(t => t.fullName === fullName)!;
    expect(meta.fields.map(f => f.name)).toEqual(['Код']);
    expect(meta.fields[0].types).toEqual([]);
    const sel = s.selectedTables.find(t => t.id === tid)!;
    expect(sel.subquery).toBe(docKod); // subquery replaced
    expect(sel.fullName).toBe(fullName); // name unchanged
    // the selected Код field survives.
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Код')).toHaveLength(1);

    // a second update with columns ['X'] prunes the Код selected field.
    s = reducer(s, { type: 'UPDATE_SUBQUERY_TABLE', tableId: tid, subquery: docX, columns: ['X'] });
    expect(s.tables.find(t => t.fullName === fullName)!.fields.map(f => f.name)).toEqual(['X']);
    expect(s.selectedFields.filter(f => f.tableId === tid && f.path === 'Код')).toHaveLength(0);
  });

  it('prunes grouping/order references for dropped subquery columns', () => {
    let s = initialState();
    s = reducer(s, { type: 'ADD_SUBQUERY_TABLE', name: 'ВложенныйЗапрос', subquery: docKodNaim, columns: ['Код', 'Наименование'] });
    const tid = s.selectedTables.find(t => t.subquery)!.id;
    const fullName = s.selectedTables.find(t => t.subquery)!.fullName;
    s = reducer(s, { type: 'ADD_FIELD_WITH_TABLE', tableFullName: fullName, fieldPath: 'Код' });
    s = reducer(s, { type: 'ADD_GROUP_FIELD', tableId: tid, path: 'Код' });
    s = reducer(s, { type: 'ADD_ORDER_FIELD', tableId: tid, path: 'Код' });
    expect(s.grouping.groupFields).toHaveLength(1);
    expect(s.order.fields).toHaveLength(1);

    s = reducer(s, { type: 'UPDATE_SUBQUERY_TABLE', tableId: tid, subquery: docX, columns: ['X'] });
    expect(s.grouping.groupFields).toHaveLength(0);
    expect(s.order.fields).toHaveLength(0);
  });

  it('returns state unchanged when the table id is missing or not a subquery', () => {
    let s = withMetadata();
    s = reducer(s, { type: 'ADD_TABLE', table: валюты });
    const prev = s;
    expect(reducer(s, { type: 'UPDATE_SUBQUERY_TABLE', tableId: 'nope', subquery: docKod, columns: ['Код'] })).toBe(prev);
    const realId = s.selectedTables[0].id;
    expect(reducer(s, { type: 'UPDATE_SUBQUERY_TABLE', tableId: realId, subquery: docKod, columns: ['Код'] })).toBe(prev);
  });
});
