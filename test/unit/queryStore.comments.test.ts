import { describe, it, expect } from 'vitest';
import {
  reducer,
  initialState,
  assembleBatch,
  buildModelFromFlat,
  snapshotActive,
} from '../../src/webview/state/queryStore';
import type { QueryState } from '../../src/webview/state/queryStore';
import type { BatchDocument } from '../../src/core/query/batchModel';
import type { MetaTable } from '../../src/core/metadata/types';

const валюты: MetaTable = {
  kind: 'Справочник',
  name: 'Валюты',
  fullName: 'Справочник.Валюты',
  fields: [
    { name: 'Код', kind: 'attribute', types: [{ primitive: 'Строка' }] },
    { name: 'Наименование', kind: 'attribute', types: [{ primitive: 'Строка' }] },
  ],
};

/** Базовое состояние с одной таблицей и одним полем «Код». */
function withFieldKod(): QueryState {
  let s = initialState();
  s = reducer(s, { type: 'SET_METADATA', tables: [валюты] });
  s = reducer(s, { type: 'ADD_TABLE', table: валюты });
  const tid = s.selectedTables[0].id;
  s = reducer(s, { type: 'ADD_FIELD', tableId: tid, fieldPath: 'Код' });
  return s;
}

describe('Фаза 8.1 — комментарии запроса в queryStore', () => {
  it('queryComments и комментарии полей переживают snapshotActive→buildModelFromFlat', () => {
    let s = withFieldKod();
    // Комментарий уровня запроса + хвостовой комментарий поля.
    s = {
      ...s,
      queryComments: { beforeSelect: ['// перед ВЫБРАТЬ'], afterFrom: ['// после ИЗ'] },
      selectedFields: s.selectedFields.map(f => ({
        ...f,
        commentTrailing: '// хвост',
        commentLeading: ['// ведущий'],
      })),
    };
    const snap = snapshotActive(s);
    expect(snap.comments).toEqual({ beforeSelect: ['// перед ВЫБРАТЬ'], afterFrom: ['// после ИЗ'] });
    const model = buildModelFromFlat(snap);
    expect(model.comments).toEqual({ beforeSelect: ['// перед ВЫБРАТЬ'], afterFrom: ['// после ИЗ'] });
    expect(model.fields[0].commentTrailing).toBe('// хвост');
    expect(model.fields[0].commentLeading).toEqual(['// ведущий']);

    // И в собранном документе пакета.
    const batch: BatchDocument = assembleBatch(s);
    const m0 = batch.members[0].members[0].model;
    expect(m0.comments).toEqual({ beforeSelect: ['// перед ВЫБРАТЬ'], afterFrom: ['// после ИЗ'] });
    expect(m0.fields[0].commentTrailing).toBe('// хвост');
  });

  it('SET_TEMP_TABLE_NAME сбрасывает queryComments и комментарии полей', () => {
    let s = withFieldKod();
    s = {
      ...s,
      queryComments: { beforeSelect: ['// c'] },
      selectedFields: s.selectedFields.map(f => ({ ...f, commentTrailing: '// t', commentLeading: ['// l'] })),
    };
    s = reducer(s, { type: 'SET_TEMP_TABLE_NAME', name: 'ВТ1' });
    expect(s.tempTableName).toBe('ВТ1');
    expect(s.queryComments).toBeUndefined();
    expect(s.selectedFields[0].commentTrailing).toBeUndefined();
    expect(s.selectedFields[0].commentLeading).toBeUndefined();
    expect('commentLeading' in s.selectedFields[0]).toBe(false);
  });

  it('SET_QUERY_TYPE сбрасывает queryComments и комментарии полей', () => {
    let s = withFieldKod();
    s = {
      ...s,
      queryComments: { afterFrom: ['// c'] },
      selectedFields: s.selectedFields.map(f => ({ ...f, commentTrailing: '// t' })),
    };
    s = reducer(s, { type: 'SET_QUERY_TYPE', queryType: 'createTemp' });
    expect(s.queryType).toBe('createTemp');
    expect(s.queryComments).toBeUndefined();
    expect(s.selectedFields[0].commentTrailing).toBeUndefined();
  });

  it('SET_COLUMN_ALIAS снимает комментарии у переименованного поля и переименовывает', () => {
    let s = withFieldKod();
    s = {
      ...s,
      selectedFields: s.selectedFields.map(f => ({
        ...f,
        commentTrailing: '// t',
        commentLeading: ['// l'],
      })),
    };
    // Псевдоним поля «Код» по умолчанию — «Код».
    s = reducer(s, { type: 'SET_COLUMN_ALIAS', alias: 'Код', newAlias: 'КодНовый' });
    expect(s.selectedFields[0].alias).toBe('КодНовый');
    expect(s.selectedFields[0].commentTrailing).toBeUndefined();
    expect(s.selectedFields[0].commentLeading).toBeUndefined();
  });

  it('SET_FIELD_EXPRESSION снимает комментарии у редактируемого поля', () => {
    let s = withFieldKod();
    s = {
      ...s,
      selectedFields: s.selectedFields.map(f => ({
        ...f,
        commentTrailing: '// t',
        commentLeading: ['// l'],
      })),
    };
    s = reducer(s, { type: 'SET_FIELD_EXPRESSION', fieldIdx: 0, expression: 'ВЫРАЗИТЬ(Валюты.Код КАК Строка)' });
    expect(s.selectedFields[0].expression).toBe('ВЫРАЗИТЬ(Валюты.Код КАК Строка)');
    expect(s.selectedFields[0].commentTrailing).toBeUndefined();
    expect(s.selectedFields[0].commentLeading).toBeUndefined();
  });
});
