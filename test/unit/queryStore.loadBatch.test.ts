import { describe, it, expect } from 'vitest';
import {
  reducer,
  initialState,
  modelToFlat,
  docToSnapshot,
  assembleBatch,
  buildModelFromFlat,
  tempTableDialogInitial,
  availableTempTables,
} from '../../src/webview/state/queryStore';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { parseBatch } from '../../src/core/query/sdblParser';
import type { QueryModel } from '../../src/core/query/queryModel';
import type { MetaTable } from '../../src/core/metadata/types';

/** Round-trip a raw SDBL batch text through parse → LOAD_BATCH → assemble → generate. */
function roundTrip(text: string): string {
  const doc = parseBatch(text);
  const state = reducer(initialState(), { type: 'LOAD_BATCH', doc });
  return generateBatch(assembleBatch(state));
}

const SINGLE =
  'ВЫБРАТЬ\n' +
  '	Валюты.Код,\n' +
  '	Валюты.Наименование\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты';

const COMPLEX =
  'ВЫБРАТЬ\n' +
  '	Валюты.Код КАК Код,\n' +
  '	СУММА(Остатки.СуммаОстаток) КАК Сумма\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты\n' +
  '		ВНУТРЕННЕЕ СОЕДИНЕНИЕ РегистрНакопления.ВзаиморасчетыОстатки КАК Остатки\n' +
  '		ПО Валюты.Код = Остатки.Валюта\n' +
  'ГДЕ\n' +
  '	Валюты.Код = &Код\n' +
  'СГРУППИРОВАТЬ ПО\n' +
  '	Валюты.Код\n' +
  'УПОРЯДОЧИТЬ ПО\n' +
  '	Код\n' +
  'ИТОГИ\n' +
  '	СУММА(Сумма)\n' +
  'ПО\n' +
  '	ОБЩИЕ';

const UNION =
  'ВЫБРАТЬ\n' +
  '	Валюты.Код КАК Код\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты\n' +
  '\n' +
  'ОБЪЕДИНИТЬ ВСЕ\n' +
  '\n' +
  'ВЫБРАТЬ\n' +
  '	Страны.Код\n' +
  'ИЗ\n' +
  '	Справочник.Страны КАК Страны\n' +
  '\n' +
  'ОБЪЕДИНИТЬ\n' +
  '\n' +
  'ВЫБРАТЬ\n' +
  '	Города.Код\n' +
  'ИЗ\n' +
  '	Справочник.Города КАК Города';

const BATCH_SEP = '\n;\n\n' + '/'.repeat(80) + '\n';

const BATCH =
  'ВЫБРАТЬ\n' +
  '	Валюты.Код КАК Код\n' +
  'ПОМЕСТИТЬ ВТ_Коды\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты' +
  BATCH_SEP +
  'УНИЧТОЖИТЬ ВТ_Коды';

const INDEXED =
  'ВЫБРАТЬ\n' +
  '	Валюты.Код КАК Код,\n' +
  '	Валюты.Наименование КАК Наименование\n' +
  'ПОМЕСТИТЬ ВТ\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты\n' +
  'ИНДЕКСИРОВАТЬ ПО\n' +
  '	Код';

describe('LOAD_BATCH round-trip', () => {
  it('single query', () => {
    expect(roundTrip(SINGLE)).toBe(generateBatch(parseBatch(SINGLE)));
  });

  it('complex: join + where + grouping + order + totals', () => {
    expect(roundTrip(COMPLEX)).toBe(generateBatch(parseBatch(COMPLEX)));
  });

  it('union (3 members, distinct mix)', () => {
    expect(roundTrip(UNION)).toBe(generateBatch(parseBatch(UNION)));
  });

  it('batch (createTemp + dropTemp)', () => {
    expect(roundTrip(BATCH)).toBe(generateBatch(parseBatch(BATCH)));
  });

  it('temp table with index', () => {
    expect(roundTrip(INDEXED)).toBe(generateBatch(parseBatch(INDEXED)));
  });

  it('loads multiple batch members into batchSaved slots', () => {
    const doc = parseBatch(BATCH);
    const state = reducer(initialState(), { type: 'LOAD_BATCH', doc });
    expect(state.batchSaved.length).toBe(2);
    expect(state.activeBatch).toBe(0);
    expect(state.batchSaved[0]).toBeNull(); // active lives in flat fields
    expect(state.batchSaved[1]).not.toBeNull();
  });

  it('preserves metadata (tables) across LOAD_BATCH', () => {
    const tables: MetaTable[] = [
      { kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', fields: [] },
    ];
    let state = reducer(initialState(), { type: 'SET_METADATA', tables });
    const expanded = new Map(state.expandedRefs);
    expanded.set('k', []);
    state = { ...state, expandedRefs: expanded };
    const doc = parseBatch(SINGLE);
    const after = reducer(state, { type: 'LOAD_BATCH', doc });
    expect(after.tables).toBe(tables);
    expect(after.expandedRefs).toBe(expanded);
  });

  it('empty members behaves like an empty initial batch', () => {
    const state = reducer(initialState(), { type: 'LOAD_BATCH', doc: { members: [] } });
    expect(state.batchSaved).toEqual([null]);
    expect(state.activeBatch).toBe(0);
    expect(state.queryList.length).toBe(1);
    expect(state.selectedTables).toEqual([]);
  });

  it('resets focus fields', () => {
    let state = reducer(initialState(), { type: 'FOCUS_DB_TABLE', fullName: 'Справочник.Валюты' });
    state = { ...state, focusedSelectedTableId: 'x', focusedSelectedFieldIdx: 3 };
    const after = reducer(state, { type: 'LOAD_BATCH', doc: parseBatch(SINGLE) });
    expect(after.focusedSelectedTableId).toBeNull();
    expect(after.focusedSelectedFieldIdx).toBeNull();
  });
});

// 7.8.8-fix — открытие из текста источника-подзапроса `(ВЫБРАТЬ …) КАК ВложенныйЗапрос`
// должно синтезировать метатаблицу с колонками подзапроса, иначе конструктор не видит
// его полей (`fieldsForTable`/`TablesPanel` резолвят колонки по `fullName`).
const NESTED_SUBQUERY_SOURCE =
  'ВЫБРАТЬ\n' +
  '	Валюты.Ссылка КАК Ссылка,\n' +
  '	Валюты.Наименование КАК Наименование,\n' +
  '	ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты,\n' +
  '	(ВЫБРАТЬ\n' +
  '		ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных\n' +
  '	ИЗ\n' +
  '		(ВЫБРАТЬ\n' +
  '			ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных\n' +
  '		ИЗ\n' +
  '			(ВЫБРАТЬ\n' +
  '				АвансовыйОтчет.ВерсияДанных КАК ВерсияДанных\n' +
  '			ИЗ\n' +
  '				Документ.АвансовыйОтчет КАК АвансовыйОтчет) КАК ВложенныйЗапрос) КАК ВложенныйЗапрос) КАК ВложенныйЗапрос\n' +
  'ГДЕ\n' +
  '	Валюты.Код = &Код';

describe('LOAD_BATCH subquery source columns (7.8.8-fix)', () => {
  it('synthesizes a meta table with the subquery columns so the constructor sees its fields', () => {
    const doc = parseBatch(NESTED_SUBQUERY_SOURCE);
    const state = reducer(initialState(), { type: 'LOAD_BATCH', doc });

    const subSel = state.selectedTables.find(t => t.subquery !== undefined);
    expect(subSel).toBeDefined();
    // Источник-подзапрос из текста должен получить непустой fullName для резолва колонок.
    expect(subSel!.fullName).not.toBe('');

    const meta = state.tables.find(m => m.fullName === subSel!.fullName);
    expect(meta).toBeDefined();
    expect(meta!.kind).toBe('ТабличнаяЧасть');
    expect(meta!.fields.map(f => f.name)).toContain('ВерсияДанных');
  });

  it('does not allocate a new tables array when there are no subquery sources', () => {
    const tables: MetaTable[] = [
      { kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', fields: [] },
    ];
    const state = reducer(initialState(), { type: 'SET_METADATA', tables });
    const after = reducer(state, { type: 'LOAD_BATCH', doc: parseBatch(SINGLE) });
    expect(after.tables).toBe(tables);
  });

  it('round-trips the subquery source text unchanged (alias preserved)', () => {
    expect(roundTrip(NESTED_SUBQUERY_SOURCE)).toBe(generateBatch(parseBatch(NESTED_SUBQUERY_SOURCE)));
  });
});

// 7.8.8-fix3 — открытие из текста ссылки на временную таблицу `ВТ КАК ВТ` (внешняя ВТ,
// без ПОМЕСТИТЬ в запросе). Источник с односегментным именем, не являющийся подзапросом/
// виртуальной таблицей и не разрешимый в метаданных, — это ссылка на ВТ: помечаем
// tempTable:true и синтезируем метатаблицу с колонками из ссылок на её поля (`ВТ.asdfa`).
const TEMP_TABLE_REF =
  'ВЫБРАТЬ\n' +
  '	Валюты.Ссылка КАК Ссылка,\n' +
  '	ВложенныйЗапрос.ВерсияДанных КАК ВерсияДанных,\n' +
  '	ВТ.asdfa КАК asdfa\n' +
  'ИЗ\n' +
  '	Справочник.Валюты КАК Валюты,\n' +
  '	(ВЫБРАТЬ\n' +
  '		АвансовыйОтчет.ВерсияДанных КАК ВерсияДанных\n' +
  '	ИЗ\n' +
  '		Документ.АвансовыйОтчет КАК АвансовыйОтчет) КАК ВложенныйЗапрос,\n' +
  '	ВТ КАК ВТ\n' +
  'ГДЕ\n' +
  '	Валюты.Код = &Код';

describe('LOAD_BATCH temp-table reference (7.8.8-fix3)', () => {
  it('marks a bare-name non-metadata source as a temp table and synthesizes its columns', () => {
    const doc = parseBatch(TEMP_TABLE_REF);
    const state = reducer(initialState(), { type: 'LOAD_BATCH', doc });

    const vt = state.selectedTables.find(t => t.fullName === 'ВТ');
    expect(vt).toBeDefined();
    expect(vt!.tempTable).toBe(true);
    expect(vt!.subquery).toBeUndefined();

    const meta = state.tables.find(m => m.fullName === 'ВТ');
    expect(meta).toBeDefined();
    expect(meta!.kind).toBe('ТабличнаяЧасть');
    expect(meta!.fields.map(f => f.name)).toContain('asdfa');

    // подзапрос по-прежнему распознан как подзапрос (не перепутан с ВТ)
    const sub = state.selectedTables.find(t => t.subquery);
    expect(sub).toBeDefined();
    expect(sub!.tempTable).toBeUndefined();
  });

  it('does not mark real metadata tables as temp tables', () => {
    const tables: MetaTable[] = [
      { kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', fields: [] },
    ];
    let state = reducer(initialState(), { type: 'SET_METADATA', tables });
    state = reducer(state, { type: 'LOAD_BATCH', doc: parseBatch(SINGLE) });
    expect(state.selectedTables.every(t => !t.tempTable)).toBe(true);
    expect(state.tables.find(m => m.kind === 'ТабличнаяЧасть')).toBeUndefined();
  });

  it('round-trips the temp-table reference text unchanged', () => {
    expect(roundTrip(TEMP_TABLE_REF)).toBe(generateBatch(parseBatch(TEMP_TABLE_REF)));
  });

  // Имя источника-ВТ может начинаться на `&` (передача таблицы значений/ВТ параметром:
  // `&ВТ КАК ВТ`) — его поля тоже должны открываться (адресуются по псевдониму `ВТ.asdfa`).
  it('marks an `&`-prefixed temp-table source and synthesizes its columns', () => {
    const PARAM_TEMP =
      'ВЫБРАТЬ\n' +
      '	Валюты.Ссылка КАК Ссылка,\n' +
      '	ВТ.asdfa КАК asdfa\n' +
      'ИЗ\n' +
      '	Справочник.Валюты КАК Валюты,\n' +
      '	&ВТ КАК ВТ';
    const doc = parseBatch(PARAM_TEMP);
    const state = reducer(initialState(), { type: 'LOAD_BATCH', doc });

    const vt = state.selectedTables.find(s => s.fullName === '&ВТ');
    expect(vt).toBeDefined();
    expect(vt!.tempTable).toBe(true);

    const meta = state.tables.find(m => m.fullName === '&ВТ');
    expect(meta).toBeDefined();
    expect(meta!.kind).toBe('ТабличнаяЧасть');
    expect(meta!.fields.map(f => f.name)).toContain('asdfa');

    // генерация не меняется — источник остаётся `&ВТ КАК ВТ`
    expect(roundTrip(PARAM_TEMP)).toBe(generateBatch(parseBatch(PARAM_TEMP)));
  });

  // Имя ВТ может начинаться на `#` (подстановка). Окно ВТ должно показывать `#ВТ`
  // (РЕАЛЬНОЕ имя), а не `ВТ` (псевдоним без `#`), иначе ОК теряет `#` при переименовании.
  it('temp-table dialog initial uses the real name (#ВТ), and editing preserves it', () => {
    const HASH =
      'ВЫБРАТЬ\n' +
      '	Валюты.Ссылка КАК Ссылка,\n' +
      '	ВТ.asdfa КАК asdfa\n' +
      'ИЗ\n' +
      '	Справочник.Валюты КАК Валюты,\n' +
      '	#ВТ КАК ВТ';
    let state = reducer(initialState(), { type: 'LOAD_BATCH', doc: parseBatch(HASH) });
    const vt = state.selectedTables.find(t => t.fullName === '#ВТ')!;
    expect(vt.tempTable).toBe(true);

    const init = tempTableDialogInitial(state, vt.id);
    expect(init).toBeDefined();
    expect(init!.name).toBe('#ВТ');
    expect(init!.fields.map(f => f.name)).toContain('asdfa');

    // ОК окна с тем же именем не теряет `#`: источник остаётся `#ВТ КАК ВТ`.
    state = reducer(state, { type: 'UPDATE_TEMP_TABLE', tableId: vt.id, name: init!.name, fields: init!.fields });
    expect(state.selectedTables.find(t => t.id === vt.id)!.fullName).toBe('#ВТ');
    expect(generateBatch(assembleBatch(state))).toContain('#ВТ КАК ВТ');
  });
});

// 7.8.17 — группа «Временные таблицы» в дереве метаданных: ВТ, созданные ПОМЕСТИТЬ/
// ДОБАВИТЬ в запросах пакета СТРОГО ДО активного, доступны для перетаскивания.
describe('availableTempTables (7.8.17)', () => {
  const BATCH_TEMP =
    'ВЫБРАТЬ\n' +
    '	Валюты.Ссылка КАК Ссылка\n' +
    'ПОМЕСТИТЬ врем\n' +
    'ИЗ\n' +
    '	Справочник.Валюты КАК Валюты' +
    BATCH_SEP +
    'ВЫБРАТЬ\n' +
    '	Бригады.Ссылка КАК Ссылка\n' +
    'ДОБАВИТЬ врем1\n' +
    'ИЗ\n' +
    '	Справочник.Бригады КАК Бригады';

  it('is empty on the first batch query, lists `врем` on the second', () => {
    let state = reducer(initialState(), { type: 'LOAD_BATCH', doc: parseBatch(BATCH_TEMP) });
    // Активен запрос 0 (создаёт `врем`) — доступных ВТ ещё нет.
    expect(availableTempTables(state)).toEqual([]);

    // Переход на запрос 1 (`врем1`) — доступна `врем` с колонкой `Ссылка`.
    state = reducer(state, { type: 'SET_ACTIVE_BATCH', index: 1 });
    const tt = availableTempTables(state);
    expect(tt.map(t => t.name)).toEqual(['врем']);
    expect(tt[0].kind).toBe('ВременнаяТаблица');
    expect(tt[0].fields.map(f => f.name)).toEqual(['Ссылка']);
  });
});

describe('modelToFlat', () => {
  it('substitutes empty defaults for undefined optionals', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    const flat = modelToFlat(model);
    expect(flat.selectedTables).toBe(model.tables);
    expect(flat.selectedFields).toBe(model.fields);
    expect(flat.tabSectionFields).toEqual([]);
    expect(flat.grouping).toEqual({ multiple: false, groupFields: [], groupSets: [], aggregates: [] });
    expect(flat.conditions).toEqual([]);
    expect(flat.joins).toEqual([]);
    expect(flat.selection).toEqual({});
    expect(flat.queryType).toBe('select');
    expect(flat.tempTableName).toBe('');
    expect(flat.lockForUpdate).toEqual([]);
    expect(flat.order).toEqual({ fields: [], auto: false });
    expect(flat.totals).toEqual({ groupFields: [], totalFields: [], grand: false });
    expect(flat.builder).toEqual({ fields: [], conditions: [], order: [], totals: [] });
    expect(flat.indexing).toEqual({ indexes: [] });
  });

  it('is the inverse of buildModelFromFlat for fully-populated models', () => {
    const doc = parseBatch(COMPLEX);
    const model = doc.members[0].members[0].model;
    const flat = modelToFlat(model);
    const back = buildModelFromFlat(flat);
    // generated text must be identical
    expect(generateBatch({ members: [{ members: [{ name: 'Q', distinct: false, model: back }] }] }))
      .toBe(generateBatch({ members: [{ members: [{ name: 'Q', distinct: false, model }] }] }));
  });
});

describe('docToSnapshot', () => {
  it('maps members to queryList/savedQueries with activeQuery 0', () => {
    const doc = parseBatch(UNION);
    const snap = docToSnapshot(doc.members[0]);
    expect(snap.activeQuery).toBe(0);
    expect(snap.queryList.length).toBe(3);
    expect(snap.queryList.map(q => q.distinct)).toEqual([false, false, true]);
    expect(snap.savedQueries.length).toBe(3);
  });
});
