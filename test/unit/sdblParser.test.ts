import { describe, it, expect } from 'vitest';
import { generate } from '../../src/core/query/sdblGenerator';
import { parseQuery } from '../../src/core/query/sdblParser';
import { tokenize } from '../../src/core/query/sdblLexer';
import type { QueryModel, AggregateFunction } from '../../src/core/query/queryModel';

/** Round-trip oracle: generate(parseQuery(generate(model))) === generate(model). */
function roundTrip(model: QueryModel): void {
  const text = generate(model);
  const reparsed = parseQuery(text);
  expect(generate(reparsed)).toBe(text);
}

describe('sdblLexer', () => {
  it('tokenizes a minimal query into keywords/idents/punct/eof', () => {
    const tokens = tokenize('ВЫБРАТЬ\n\tВалюты.Код\nИЗ\n\tСправочник.Валюты КАК Валюты');
    expect(tokens[tokens.length - 1].type).toBe('eof');
    expect(tokens[0]).toMatchObject({ type: 'keyword', value: 'ВЫБРАТЬ' });
    // keyword canonical uppercase; ident keeps original
    const izIdx = tokens.findIndex(t => t.type === 'keyword' && t.value === 'ИЗ');
    expect(izIdx).toBeGreaterThan(0);
  });

  it('keeps original text for idents and uppercases keywords', () => {
    const tokens = tokenize('выбрать Валюты.Код из Справочник.Валюты как Валюты');
    expect(tokens[0]).toMatchObject({ type: 'keyword', value: 'ВЫБРАТЬ' });
    const ident = tokens.find(t => t.type === 'ident');
    expect(ident?.value).toBe('Валюты');
  });

  it('skips // comments but tracks line/col', () => {
    const tokens = tokenize('ВЫБРАТЬ // комментарий\n\tВалюты.Код');
    // comment must not appear
    expect(tokens.some(t => t.value.includes('комментарий'))).toBe(false);
    const kod = tokens.find(t => t.value === 'Код');
    expect(kod?.line).toBe(2);
  });

  it('lexes params, strings, numbers, dates and 2-char operators', () => {
    const tokens = tokenize('&Параметр "стр""ока" 12.5 \'2020-01-01\' <= >= <>');
    expect(tokens[0]).toMatchObject({ type: 'param', value: '&Параметр' });
    expect(tokens[1]).toMatchObject({ type: 'string' });
    expect(tokens[2]).toMatchObject({ type: 'number', value: '12.5' });
    expect(tokens[3]).toMatchObject({ type: 'date' });
    expect(tokens[4]).toMatchObject({ type: 'punct', value: '<=' });
    expect(tokens[5]).toMatchObject({ type: 'punct', value: '>=' });
    expect(tokens[6]).toMatchObject({ type: 'punct', value: '<>' });
  });

  it('throws a clear error with line/col on unexpected char', () => {
    expect(() => tokenize('ВЫБРАТЬ @')).toThrow(/1:9|line 1|col 9/i);
  });
});

describe('parseQuery — round-trip identity (generate∘parse∘generate)', () => {
  it('1. minimal: one table, one field with alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'КодВалюты' }],
    };
    roundTrip(model);
  });

  it('2. field without alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    roundTrip(model);
  });

  it('2b. dotted path without alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Контрагент.Наименование' }],
    };
    roundTrip(model);
  });

  it('3. multiple tables comma-separated, fields from each', () => {
    const model: QueryModel = {
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Документ.Счет' },
      ],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't2', path: 'Дата', alias: 'ДатаСчета' },
      ],
    };
    roundTrip(model);
  });

  it('3b. alias conflict resolved with numeric suffix', () => {
    const model: QueryModel = {
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Документ.Валюты' },
      ],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't2', path: 'Дата' },
      ],
    };
    roundTrip(model);
  });

  it('3c. explicit table alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты', alias: 'Вал' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    roundTrip(model);
  });

  it('4. all modifiers: РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ ПЕРВЫЕ 10', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      selection: { allowed: true, distinct: true, top: 10 },
    };
    roundTrip(model);
  });

  it('4b. single modifier ПЕРВЫЕ', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка' }],
      selection: { top: 5 },
    };
    roundTrip(model);
  });

  const aggCases: AggregateFunction[] = [
    'Сумма', 'Количество', 'КоличествоРазличных', 'Максимум', 'Минимум', 'Среднее',
  ];
  for (const func of aggCases) {
    it(`5. aggregate ${func}`, () => {
      const model: QueryModel = {
        tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
        fields: [{ tableId: 't1', path: 'Наценка', alias: 'Наценка' }],
        grouping: {
          multiple: false,
          groupFields: [],
          groupSets: [],
          aggregates: [{ tableId: 't1', path: 'Наценка', func }],
        },
      };
      roundTrip(model);
    });
  }

  it('5b. aggregate without alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Наценка' }],
      grouping: {
        multiple: false,
        groupFields: [],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    };
    roundTrip(model);
  });

  it('6. expression field with explicit alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: '', expression: 'ВЫРАЗИТЬ(Валюты.Код КАК ЧИСЛО)', alias: 'КодЧисло' }],
    };
    roundTrip(model);
  });

  it('6b. expression field with auto-alias Поле1/Поле2', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: '', expression: 'СУММА(Валюты.Код)' },
        { tableId: 't1', path: '', expression: 'МАКСИМУМ(Валюты.Код)' },
      ],
    };
    roundTrip(model);
  });
});

describe('parseQuery — model shape', () => {
  it('synthesizes tableId t0, resolves field prefixes', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'КодВалюты' }],
    });
    const model = parseQuery(text);
    // alias is always captured from the parsed КАК (safe for round-trip even when
    // it equals defaultTableAlias).
    expect(model.tables).toEqual([
      { id: 't0', fullName: 'Справочник.Валюты', alias: 'Валюты' },
    ]);
    expect(model.fields).toEqual([
      { tableId: 't0', path: 'Код', alias: 'КодВалюты' },
    ]);
    expect(model.selection).toBeUndefined();
    expect(model.grouping).toBeUndefined();
  });

  it('builds grouping.aggregates for an aggregate field', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Наценка', alias: 'Наценка' }],
      grouping: {
        multiple: false, groupFields: [], groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'КоличествоРазличных' }],
      },
    });
    const model = parseQuery(text);
    expect(model.grouping).toEqual({
      multiple: false, groupFields: [], groupSets: [],
      aggregates: [{ tableId: 't0', path: 'Наценка', func: 'КоличествоРазличных' }],
    });
    expect(model.fields).toEqual([
      { tableId: 't0', path: 'Наценка', alias: 'Наценка' },
    ]);
  });
});
