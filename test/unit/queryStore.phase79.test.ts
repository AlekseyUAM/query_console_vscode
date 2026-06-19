import { describe, it, expect } from 'vitest';
import { reducer, initialState, assembleBatch } from '../../src/webview/state/queryStore';
import type { QueryState } from '../../src/webview/state/queryStore';
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
