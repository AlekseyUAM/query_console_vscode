import { describe, it, expect } from 'vitest';
import { reducer, initialState, assembleBatch } from '../../src/webview/state/queryStore';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { parseBatch } from '../../src/core/query/sdblParser';

// 7.8.8-fix2 — коллизия id таблиц после открытия из текста.
//
// Парсер нумерует таблицы позиционно (`t0`, `t1`, …), а интерактивные добавления
// (`ADD_TABLE`/`ADD_TEMP_TABLE`/`ADD_SUBQUERY_TABLE`) берут id из общего счётчика
// `_tableCounter`, стартующего с 0. После открытия запроса из текста счётчик НЕ
// синхронизировался — поэтому первая добавленная таблица получала id `t1`, уже
// занятый загруженной таблицей. `resolveAliases` ключует псевдонимы по id, и
// поздняя таблица затирала псевдоним ранней: подзапрос печатался `КАК ВТ`, а ВТ —
// `ВТ КАК ВТ1`, поле подзапроса `ВложенныйЗапрос.ВерсияДанных` уезжало в `ВТ`.
//
// ВАЖНО: `_tableCounter` — модульное состояние, общее для тестов одного файла.
// Этот тест ДОЛЖЕН быть в отдельном файле и первым добавлять таблицу, чтобы
// счётчик был ещё мал (как в свежей сессии конструктора) — иначе баг скрыт.

const SUBQUERY_PLUS_TEMP =
  'ВЫБРАТЬ\n' +
  '	Валюты.Ссылка КАК Ссылка,\n' +
  '	Валюты.Наименование КАК Наименование,\n' +
  '	ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты,\n' +
  '	(ВЫБРАТЬ\n' +
  '		АвансовыйОтчет.ВерсияДанных КАК ВерсияДанных\n' +
  '	ИЗ\n' +
  '		Документ.АвансовыйОтчет КАК АвансовыйОтчет) КАК ВложенныйЗапрос\n' +
  'ГДЕ\n' +
  '	Валюты.Код = &Код';

describe('table id collision after load (7.8.8-fix2)', () => {
  it('a temp table added after loading a subquery query keeps a distinct id/alias', () => {
    let s = reducer(initialState(), { type: 'LOAD_BATCH', doc: parseBatch(SUBQUERY_PLUS_TEMP) });
    s = reducer(s, { type: 'ADD_TEMP_TABLE', name: 'ВТ', fields: [{ name: 'фыва' }] });

    // id всех выбранных таблиц уникальны
    const ids = s.selectedTables.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    const text = generateBatch(assembleBatch(s));
    // подзапрос сохраняет свой псевдоним; ВТ остаётся ВТ; поле подзапроса не уезжает в ВТ
    expect(text).toContain(') КАК ВложенныйЗапрос');
    expect(text).toContain('ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных');
    expect(text).toContain('ВТ КАК ВТ');
    expect(text).not.toContain('КАК ВТ1');
    expect(text).not.toContain('ВТ.ВерсияДанных');
  });
});
