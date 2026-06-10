import { describe, it, expect } from 'vitest';
import { generate, generateDocument, generateBatch } from '../../src/core/query/sdblGenerator';
import { parseQuery, parseDocument, parseBatch } from '../../src/core/query/sdblParser';
import { tokenize } from '../../src/core/query/sdblLexer';
import type { QueryModel, AggregateFunction } from '../../src/core/query/queryModel';
import type { QueryDocument, UnionMember } from '../../src/core/query/unionModel';
import type { BatchDocument } from '../../src/core/query/batchModel';

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
    // `~` встречается в корпусе только внутри строк/комментариев, поэтому остаётся
    // неподдерживаемым символом тела запроса.
    expect(() => tokenize('ВЫБРАТЬ ~')).toThrow(/1:9|line 1|col 9/i);
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

describe('parseQuery 6.2.B — виртуальные таблицы (round-trip)', () => {
  it('РС срез без параметров', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: {} }],
      fields: [{ tableId: 't1', path: 'Период', alias: 'Период' }],
    });
  });

  it('РС срез: period + condition', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс', alias: 'Курс' }],
    });
  });

  it('РС срез: только period', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период' } }],
      fields: [{ tableId: 't1', path: 'Курс', alias: 'Курс' }],
    });
  });

  it('РС срез: только condition (пропущенная позиция period)', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс', alias: 'Курс' }],
    });
  });

  it('РН Обороты: фиксированная арность 4', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РН1.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон', periodicity: 'Авто', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    });
  });

  it('РН Обороты: хвостовые пустые позиции сохраняются', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РН1.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    });
  });

  it('РН Обороты: пропущенный endPeriod в середине', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РН1.Обороты', virtual: { startPeriod: '&Нач', periodicity: 'Месяц' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    });
  });

  it('РН Остатки', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РН1.Остатки', virtual: { period: '&Период', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Остаток', alias: 'Ресурс1Остаток' }],
    });
  });

  it('РН ОстаткиИОбороты: фиксированная арность 5', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РН1.ОстаткиИОбороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон', periodicity: 'Авто', fillMethod: 'ДвиженияИГраницыПериода', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    });
  });

  describe('РегистрБухгалтерии', () => {
    const mk = (slice: string, virtual: any): QueryModel => ({
      tables: [{ id: 't1', fullName: `РегистрБухгалтерии.РБ1.${slice}`, virtual }],
      fields: [{ tableId: 't1', path: 'Счет', alias: 'Счет' }],
    });

    it('Остатки', () => roundTrip(mk('Остатки', { period: '&П', accountCondition: 'Счет = &С', condition: 'Организация = &О' })));
    it('Обороты non-corr', () => roundTrip(mk('Обороты', { periodicity: 'Авто', correspondence: false })));
    it('Обороты corr (арность 8, correspondence)', () => roundTrip(mk('Обороты', { periodicity: 'Период', correspondence: true })));
    it('ОборотыДтКт (арность 8)', () => roundTrip(mk('ОборотыДтКт', { periodicity: 'Период' })));
    it('ОстаткиИОбороты', () => roundTrip(mk('ОстаткиИОбороты', { periodicity: 'Период', fillMethod: 'ДвиженияИГраницыПериода' })));
    it('ДвиженияССубконто без параметров', () => roundTrip(mk('ДвиженияССубконто', {})));
    it('ДвиженияССубконто с top', () => roundTrip(mk('ДвиженияССубконто', { top: '3' })));
  });

  it('deep-equality: virtual params парсятся в правильную форму', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс', alias: 'Курс' }],
    });
    const model = parseQuery(text);
    expect(model.tables[0].virtual).toEqual({ period: '&Период', condition: 'Валюта = &Валюта' });
  });

  it('deep-equality: РБ Обороты corr → correspondence:true', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'РегистрБухгалтерии.РБ1.Обороты', virtual: { periodicity: 'Период', correspondence: true } }],
      fields: [{ tableId: 't1', path: 'Счет', alias: 'Счет' }],
    });
    const model = parseQuery(text);
    expect(model.tables[0].virtual).toEqual({ periodicity: 'Период', correspondence: true });
  });
});

describe('parseQuery 6.2.B — ГДЕ (round-trip)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [
      { tableId: 't1', path: 'Код', alias: 'Код' },
      { tableId: 't1', path: 'Наименование', alias: 'Наименование' },
    ],
  });

  it('одно простое условие', () => {
    roundTrip({ ...base(), conditions: [{ custom: false, tableId: 't1', path: 'Код' }] });
  });

  it('два простых условия (И)', () => {
    roundTrip({
      ...base(),
      conditions: [
        { custom: false, tableId: 't1', path: 'Код' },
        { custom: false, tableId: 't1', path: 'Наименование' },
      ],
    });
  });

  it('нестандартный оператор и явный параметр', () => {
    roundTrip({ ...base(), conditions: [{ custom: false, tableId: 't1', path: 'Код', operator: '>=', param: '&МинКод' }] });
  });

  it('операторы В / МЕЖДУ / ПОДОБНО', () => {
    roundTrip({ ...base(), conditions: [{ custom: false, tableId: 't1', path: 'Код', operator: 'ПОДОБНО', param: '&Шаблон' }] });
  });

  it('произвольное условие со скобками', () => {
    roundTrip({ ...base(), conditions: [{ custom: true, expression: 'Валюты.Код В (&Список)' }] });
  });

  it('простое + произвольное условие', () => {
    roundTrip({
      ...base(),
      conditions: [
        { custom: false, tableId: 't1', path: 'Код' },
        { custom: true, expression: 'Валюты.Код В (&Список)' },
      ],
    });
  });

  it('deep-equality: простое условие парсится в Condition', () => {
    const text = generate({ ...base(), conditions: [{ custom: false, tableId: 't1', path: 'Код' }] });
    const model = parseQuery(text);
    expect(model.conditions).toEqual([
      { custom: false, tableId: 't0', path: 'Код', operator: '=', param: '&Код' },
    ]);
  });
});

describe('parseQuery 6.2.B — соединения (round-trip)', () => {
  const twoTables = (): QueryModel => ({
    tables: [
      { id: 't1', fullName: 'Справочник.Валюты' },
      { id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' },
    ],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const joinOf = (leftAll: boolean, rightAll: boolean): QueryModel => ({
    ...twoTables(),
    joins: [{
      leftTableId: 't1', rightTableId: 't2',
      leftAll, rightAll, custom: false,
      leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
    }],
  });

  it('внутреннее соединение', () => roundTrip(joinOf(false, false)));
  it('левое соединение', () => roundTrip(joinOf(true, false)));
  it('полное соединение', () => roundTrip(joinOf(true, true)));

  it('произвольное условие связи (скобки)', () => {
    roundTrip({
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: true, rightAll: false, custom: true,
        expression: 'Валюты.Ссылка = &Труляля',
      }],
    });
  });

  it('таблица без связи (trailing)', () => {
    roundTrip({
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' },
        { id: 't3', fullName: 'Документ.Счет' },
      ],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: false, rightAll: false, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
    });
  });

  it('deep-equality: внутреннее соединение парсится в Join', () => {
    const text = generate(joinOf(false, false));
    const model = parseQuery(text);
    expect(model.joins).toEqual([
      {
        leftTableId: 't0', rightTableId: 't1',
        leftAll: false, rightAll: false, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      },
    ]);
    expect(model.tables.map(t => t.id)).toEqual(['t0', 't1']);
  });
});

describe('parseQuery 6.2.B — группировка (round-trip)', () => {
  it('одна группировка + агрегат', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
        { tableId: 't1', path: 'Код', alias: 'Код' },
      ],
      grouping: {
        multiple: false,
        groupFields: [
          { tableId: 't1', path: 'Ссылка' },
          { tableId: 't1', path: 'Код' },
        ],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    });
  });

  it('группирующие наборы', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'ОсновнаяВалюта', alias: 'ОсновнаяВалюта' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
        { tableId: 't1', path: 'Код', alias: 'Код' },
        { tableId: 't1', path: 'Представление', alias: 'Представление' },
      ],
      grouping: {
        multiple: true,
        groupFields: [],
        groupSets: [
          [
            { tableId: 't1', path: 'ОсновнаяВалюта' },
            { tableId: 't1', path: 'Ссылка' },
          ],
          [{ tableId: 't1', path: 'Код' }],
          [{ tableId: 't1', path: 'Представление' }],
        ],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    });
  });

  it('deep-equality: группировка сохраняет агрегаты и группировочные поля', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      grouping: {
        multiple: false,
        groupFields: [{ tableId: 't1', path: 'Ссылка' }],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    });
    const model = parseQuery(text);
    expect(model.grouping).toEqual({
      multiple: false,
      groupFields: [{ tableId: 't0', path: 'Ссылка' }],
      groupSets: [],
      aggregates: [{ tableId: 't0', path: 'Наценка', func: 'Сумма' }],
    });
  });
});

describe('parseQuery 6.2.B — комбинированный запрос (round-trip)', () => {
  it('соединения + ГДЕ + группировка + агрегаты', () => {
    roundTrip({
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' },
      ],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: true, rightAll: false, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
      conditions: [
        { custom: false, tableId: 't1', path: 'Код' },
        { custom: true, expression: 'Валюты.Наценка > (&Мин)' },
      ],
      grouping: {
        multiple: false,
        groupFields: [{ tableId: 't1', path: 'Ссылка' }],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    });
  });
});

// ───────────────────────────── 6.2.C ─────────────────────────────

describe('parseQuery 6.2.C — временные таблицы (round-trip)', () => {
  it('createTemp: ПОМЕСТИТЬ', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      queryType: 'createTemp',
      tempTableName: 'ВремТаб',
    });
  });

  it('appendTemp: ДОБАВИТЬ', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      queryType: 'appendTemp',
      tempTableName: 'ВремТаб',
    });
  });

  it('dropTemp: УНИЧТОЖИТЬ (самостоятельный запрос)', () => {
    roundTrip({
      tables: [],
      fields: [],
      queryType: 'dropTemp',
      tempTableName: 'ВремТаб',
    });
  });

  it('deep-equality: УНИЧТОЖИТЬ парсится в dropTemp', () => {
    const model = parseQuery('УНИЧТОЖИТЬ ВремТаб');
    expect(model.queryType).toBe('dropTemp');
    expect(model.tempTableName).toBe('ВремТаб');
    expect(model.tables).toEqual([]);
    expect(model.fields).toEqual([]);
  });

  it('deep-equality: ПОМЕСТИТЬ парсится в createTemp', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      queryType: 'createTemp',
      tempTableName: 'ВТ1',
    });
    const model = parseQuery(text);
    expect(model.queryType).toBe('createTemp');
    expect(model.tempTableName).toBe('ВТ1');
  });
});

describe('parseQuery 6.2.C — УПОРЯДОЧИТЬ ПО (round-trip)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [
      { tableId: 't1', path: 'Код', alias: 'Код' },
      { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
    ],
  });

  it('возрастание', () => {
    roundTrip({ ...base(), order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'asc' }], auto: false } });
  });

  it('убывание (УБЫВ)', () => {
    roundTrip({ ...base(), order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'desc' }], auto: false } });
  });

  it('несколько полей asc/desc', () => {
    roundTrip({
      ...base(),
      order: {
        fields: [
          { tableId: 't1', path: 'Код', direction: 'asc' },
          { tableId: 't1', path: 'Ссылка', direction: 'desc' },
        ],
        auto: false,
      },
    });
  });

  it('авто + поля', () => {
    roundTrip({ ...base(), order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'desc' }], auto: true } });
  });

  it('только авто', () => {
    roundTrip({ ...base(), order: { fields: [], auto: true } });
  });

  it('поле не из выборки (по последнему сегменту пути)', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      order: { fields: [{ tableId: 't1', path: 'Владелец.Код', direction: 'asc' }], auto: false },
    });
  });
});

describe('parseQuery 6.2.C — ИТОГИ (round-trip)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [
      { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
      { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
    ],
  });

  it('ИТОГИ ПО без агрегатов: elements + alias', () => {
    roundTrip({
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    });
  });

  it('ИТОГИ ПО без агрегатов: ИЕРАРХИЯ', () => {
    roundTrip({
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'hierarchy' }],
        totalFields: [],
        grand: false,
      },
    });
  });

  it('ИТОГИ ПО без агрегатов: ТОЛЬКО ИЕРАРХИЯ + alias', () => {
    roundTrip({
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'onlyHierarchy', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    });
  });

  it('ИТОГИ с агрегатами + ПО', () => {
    roundTrip({
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements' }],
        totalFields: [{ tableId: 't1', path: 'Наценка', expression: 'СУММА(Наценка)' }],
        grand: false,
      },
    });
  });

  it('ИТОГИ с ОБЩИЕ (grand)', () => {
    roundTrip({
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'onlyHierarchy', alias: 'Ссылка11' }],
        totalFields: [],
        grand: true,
      },
    });
  });

  it('только ОБЩИЕ без группировочных полей', () => {
    roundTrip({
      ...base(),
      totals: { groupFields: [], totalFields: [], grand: true },
    });
  });
});

describe('parseQuery 6.2.C — ИНДЕКСИРОВАТЬ ПО (round-trip)', () => {
  const fiveFieldModel = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [
      { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
      { tableId: 't1', path: 'ВерсияДанных', alias: 'ВерсияДанных' },
      { tableId: 't1', path: 'ПометкаУдаления', alias: 'ПометкаУдаления' },
      { tableId: 't1', path: 'Наименование', alias: 'Наименование' },
      { tableId: 't1', path: 'НаименованиеПолное', alias: 'НаименованиеПолное' },
    ],
    queryType: 'createTemp',
    tempTableName: 'ааа',
  });

  it('один индекс → ИНДЕКСИРОВАТЬ ПО', () => {
    roundTrip({
      ...fiveFieldModel(),
      indexing: {
        indexes: [
          {
            unique: false,
            fields: [
              { tableId: 't1', path: 'Ссылка' },
              { tableId: 't1', path: 'Наименование' },
            ],
          },
        ],
      },
    });
  });

  it('два индекса → ИНДЕКСИРОВАТЬ ПО НАБОРАМ с УНИКАЛЬНО', () => {
    roundTrip({
      ...fiveFieldModel(),
      indexing: {
        indexes: [
          { unique: false, fields: [{ tableId: 't1', path: 'Ссылка' }] },
          {
            unique: true,
            fields: [
              { tableId: 't1', path: 'ПометкаУдаления' },
              { tableId: 't1', path: 'Наименование' },
            ],
          },
        ],
      },
    });
  });
});

describe('parseQuery 6.2.C — ДЛЯ ИЗМЕНЕНИЯ (round-trip)', () => {
  it('одна таблица', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      lockForUpdate: ['Справочник.Валюты'],
    });
  });

  it('несколько таблиц', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      lockForUpdate: ['Справочник.Валюты', 'Справочник.Контрагенты'],
    });
  });

  it('deep-equality: ДЛЯ ИЗМЕНЕНИЯ парсится в lockForUpdate', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      lockForUpdate: ['Справочник.Валюты'],
    });
    const model = parseQuery(text);
    expect(model.lockForUpdate).toEqual(['Справочник.Валюты']);
  });
});

describe('parseQuery 6.2.C — построитель {…} (round-trip)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  it('{ВЫБРАТЬ …} с child и alias', () => {
    roundTrip({
      ...base(),
      builder: {
        fields: [
          { ref: 'Ресурс1Оборот', child: false, alias: 'труляля' },
          { ref: 'Валюты.Ссылка', child: true },
        ],
        conditions: [],
        order: [],
        totals: [],
      },
    });
  });

  it('{ГДЕ …}', () => {
    roundTrip({
      ...base(),
      builder: {
        fields: [],
        conditions: [
          { ref: 'Валюты.Ссылка', child: true },
          { ref: 'РегистрНакопленияОборОбороты.Измерение1', child: false },
        ],
        order: [],
        totals: [],
      },
    });
  });

  it('{УПОРЯДОЧИТЬ ПО …}', () => {
    roundTrip({
      ...base(),
      builder: {
        fields: [],
        conditions: [],
        order: [
          { ref: 'Ссылка', child: true },
          { ref: 'Измерение1', child: false, alias: 'Измерение1ааа' },
        ],
        totals: [],
      },
    });
  });

  it('{ИТОГИ ПО …}', () => {
    roundTrip({
      ...base(),
      builder: {
        fields: [],
        conditions: [],
        order: [],
        totals: [
          { ref: 'Измерение1', child: false },
          { ref: 'Ресурс1Оборот', child: false },
          { ref: 'Ссылка', child: true, alias: 'а11' },
        ],
      },
    });
  });

  it('child и alias вместе: Ссылка.* КАК а11', () => {
    roundTrip({
      ...base(),
      builder: {
        fields: [{ ref: 'Ссылка', child: true, alias: 'а11' }],
        conditions: [],
        order: [],
        totals: [],
      },
    });
  });

  it('deep-equality: {ВЫБРАТЬ} парсится в BuilderField', () => {
    const text = generate({
      ...base(),
      builder: {
        fields: [
          { ref: 'Ресурс1Оборот', child: false, alias: 'труляля' },
          { ref: 'Валюты.Ссылка', child: true },
        ],
        conditions: [],
        order: [],
        totals: [],
      },
    });
    const model = parseQuery(text);
    expect(model.builder?.fields).toEqual([
      { ref: 'Ресурс1Оборот', child: false, alias: 'труляля' },
      { ref: 'Валюты.Ссылка', child: true },
    ]);
  });
});

describe('parseQuery 6.2.C — табличные части (round-trip)', () => {
  it('одна табличная часть', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Заказы' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      tabSectionFields: [
        { tableId: 't1', tsName: 'Товары', tsFullName: 'Справочник.Заказы.Товары', fields: ['Номенклатура', 'Количество'] },
      ],
    });
  });

  it('хвостовое поле после табличной части', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Заказы' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      tabSectionFields: [
        { tableId: 't1', tsName: 'Товары', tsFullName: 'Справочник.Заказы.Товары', fields: ['Номенклатура', 'Количество'] },
      ],
      trailingFields: [{ tableId: 't1', path: 'Предопределенный', alias: 'Предопределенный' }],
    });
  });

  it('deep-equality: табличная часть парсится в tabSectionFields', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'Справочник.Заказы' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      tabSectionFields: [
        { tableId: 't1', tsName: 'Товары', tsFullName: 'Справочник.Заказы.Товары', fields: ['Номенклатура', 'Количество'] },
      ],
    });
    const model = parseQuery(text);
    expect(model.tabSectionFields).toHaveLength(1);
    expect(model.tabSectionFields![0].tableId).toBe('t0');
    expect(model.tabSectionFields![0].tsName).toBe('Товары');
    expect(model.tabSectionFields![0].fields).toEqual(['Номенклатура', 'Количество']);
  });
});

describe('parseQuery 6.2.C — большой комбинированный запрос (round-trip)', () => {
  it('createTemp + ГДЕ + группировка + УПОРЯДОЧИТЬ + ИТОГИ + ИНДЕКСИРОВАТЬ + ДЛЯ ИЗМЕНЕНИЯ', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Код', alias: 'Код' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      queryType: 'createTemp',
      tempTableName: 'ВТ',
      conditions: [{ custom: false, tableId: 't1', path: 'Код' }],
      grouping: {
        multiple: false,
        groupFields: [{ tableId: 't1', path: 'Ссылка' }, { tableId: 't1', path: 'Код' }],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
      order: {
        fields: [
          { tableId: 't1', path: 'Код', direction: 'asc' },
          { tableId: 't1', path: 'Ссылка', direction: 'desc' },
        ],
        auto: false,
      },
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements', alias: 'СсылкаИтог' }],
        totalFields: [{ tableId: 't1', path: 'Наценка', expression: 'СУММА(Наценка)' }],
        grand: true,
      },
      indexing: {
        indexes: [{ unique: false, fields: [{ tableId: 't1', path: 'Код' }] }],
      },
      lockForUpdate: ['Справочник.Валюты'],
    });
  });
});

describe('parseQuery 6.4 — операторы выражений в custom/expression (round-trip)', () => {
  it('WHERE с арифметикой (custom-условие c + и -) round-trips verbatim', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'Код' }],
      conditions: [{ custom: true, expression: 'Валюты.Дата >= &Нач - 3 + 1' }],
    });
  });

  it('поле-выражение с делением и конкатенацией строк round-trips verbatim', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Файлы' }],
      fields: [
        { tableId: 't1', path: '', expression: 'Файлы.Размер / 1024 / 1024', alias: 'Мб' },
        { tableId: 't1', path: '', expression: 'Файлы.Имя + "x"', alias: 'ИмяX' },
      ],
    });
  });

  it('ПОДОБНО-шаблон с % в custom-условии round-trips verbatim', () => {
    roundTrip({
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'Код' }],
      conditions: [{ custom: true, expression: 'Валюты.Код ПОДОБНО "%643%"' }],
    });
  });

  it('лексер не бросает на операторах выражений в реалистичных срезах', () => {
    expect(() => parseQuery(
      'ВЫБРАТЬ\n\tТ.Размер / 1024 КАК Мб\nИЗ\n\tСправочник.Файлы КАК Т\nГДЕ\n\tТ.Дата >= &Нач - 3'
    )).not.toThrow();
    expect(() => parseQuery(
      'ВЫБРАТЬ\n\tТ.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Т\nГДЕ\n\tТ.Код ПОДОБНО "%643%"'
    )).not.toThrow();
    expect(() => parseQuery(
      'ВЫБРАТЬ\n\tТ.Шапка?.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Файлы КАК Т'
    )).not.toThrow();
  });

  it('лексер токенизирует операторы выражений как punct', () => {
    const tokens = tokenize('+ - / % ? @ [ ]');
    const puncts = tokens.filter(t => t.type === 'punct').map(t => t.value);
    expect(puncts).toEqual(['+', '-', '/', '%', '?', '@', '[', ']']);
  });
});

describe('parseDocument — round-trip identity (generateDocument∘parseDocument∘generateDocument)', () => {
  function roundTripDoc(doc: QueryDocument): QueryDocument {
    const text = generateDocument(doc);
    const reparsed = parseDocument(text);
    expect(generateDocument(reparsed)).toBe(text);
    return reparsed;
  }

  const valuteMember = (distinct = false): UnionMember => ({
    name: 'Запрос 1',
    distinct,
    model: {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Код', alias: 'Код' },
      ],
      lockForUpdate: ['Справочник.Валюты'],
    } as QueryModel,
  });

  const variantMember = (distinct = false): UnionMember => ({
    name: 'Запрос 2',
    distinct,
    model: {
      tables: [{ id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' }],
      fields: [
        { tableId: 't2', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't2', path: 'Наименование', alias: 'Наименование' },
      ],
    } as QueryModel,
  });

  it('1. один участник → совпадает с generate (вырожденный случай)', () => {
    const doc: QueryDocument = { members: [valuteMember()] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(1);
    expect(generateDocument(reparsed)).toBe(generate(valuteMember().model));
  });

  it('2. два участника ОБЪЕДИНИТЬ ВСЕ', () => {
    const doc: QueryDocument = { members: [valuteMember(), variantMember(false)] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(2);
    expect(reparsed.members.map(m => m.distinct)).toEqual([false, false]);
  });

  it('3. два участника ОБЪЕДИНИТЬ (distinct)', () => {
    const doc: QueryDocument = { members: [valuteMember(), variantMember(true)] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(2);
    expect(reparsed.members.map(m => m.distinct)).toEqual([false, true]);
  });

  it('4. три участника со смешанными разделителями', () => {
    const third: UnionMember = {
      name: 'Запрос 3',
      distinct: false,
      model: {
        tables: [{ id: 't3', fullName: 'Справочник.Контрагенты' }],
        fields: [
          { tableId: 't3', path: 'Ссылка', alias: 'Ссылка' },
          { tableId: 't3', path: 'Код', alias: 'Код' },
        ],
      } as QueryModel,
    };
    const doc: QueryDocument = {
      members: [valuteMember(), variantMember(true), third],
    };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(3);
    expect(reparsed.members.map(m => m.distinct)).toEqual([false, true, false]);
  });

  it('5. участники с разным набором колонок (NULL-ячейки)', () => {
    const m0: UnionMember = {
      name: 'Q1',
      distinct: false,
      model: {
        tables: [{ id: 't1', fullName: 'Справочник.А' }],
        fields: [{ tableId: 't1', path: 'X', alias: 'X' }],
      } as QueryModel,
    };
    const m1: UnionMember = {
      name: 'Q2',
      distinct: false,
      model: {
        tables: [{ id: 't2', fullName: 'Справочник.Б' }],
        fields: [{ tableId: 't2', path: 'Y', alias: 'Y' }],
      } as QueryModel,
    };
    const doc: QueryDocument = { members: [m0, m1] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(2);
  });

  it('6. участник с подзапросом в ИЗ — слово ОБЪЕДИНИТЬ не должно делить на глубине', () => {
    // Произвольное условие соединения с подзапросом не нужно; вместо этого
    // используем виртуальную таблицу со скобками, гарантируя paren-depth > 0.
    const m0: UnionMember = {
      name: 'Q1',
      distinct: false,
      model: {
        tables: [
          {
            id: 't1',
            fullName: 'РегистрНакопления.Остатки.Остатки',
            virtual: { period: '&Дата', condition: 'Остатки.Склад = &Склад' },
          },
        ],
        fields: [{ tableId: 't1', path: 'КоличествоОстаток', alias: 'Кол' }],
      } as QueryModel,
    };
    const m1: UnionMember = {
      name: 'Q2',
      distinct: false,
      model: {
        tables: [{ id: 't2', fullName: 'Справочник.Товары' }],
        fields: [{ tableId: 't2', path: 'КоличествоТовара', alias: 'Кол' }],
      } as QueryModel,
    };
    const doc: QueryDocument = { members: [m0, m1] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(2);
  });

  it('7. участник с блоком построителя {ВЫБРАТЬ …} — brace-depth не путает разбиение', () => {
    const m0: UnionMember = {
      name: 'Q1',
      distinct: false,
      model: {
        tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
        fields: [{ tableId: 't1', path: 'Код', alias: 'Код' }],
        builder: {
          fields: [{ ref: 'Валюты.Наименование', child: false }],
          conditions: [],
          order: [],
          totals: [],
        },
      } as QueryModel,
    };
    const m1: UnionMember = {
      name: 'Q2',
      distinct: false,
      model: {
        tables: [{ id: 't2', fullName: 'Справочник.Контрагенты' }],
        fields: [{ tableId: 't2', path: 'Код', alias: 'Код' }],
      } as QueryModel,
    };
    const doc: QueryDocument = { members: [m0, m1] };
    const reparsed = roundTripDoc(doc);
    expect(reparsed.members.length).toBe(2);
  });
});

describe('parseBatch — round-trip identity (generateBatch∘parseBatch∘generateBatch)', () => {
  function roundTripBatch(batch: BatchDocument): BatchDocument {
    const text = generateBatch(batch);
    const reparsed = parseBatch(text);
    expect(generateBatch(reparsed)).toBe(text);
    return reparsed;
  }

  const docOf = (model: QueryModel): QueryDocument => ({
    members: [{ name: 'Запрос пакета 1', distinct: false, model }],
  });

  const valuesModel = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const anketaModel = (): QueryModel => ({
    tables: [{ id: 't2', fullName: 'Документ.Анкета' }],
    fields: [{ tableId: 't2', path: 'ВерсияДанных', alias: 'ВерсияДанных' }],
  });

  it('1. один участник (без разделителя и без объединения)', () => {
    const batch: BatchDocument = { members: [docOf(valuesModel())] };
    const reparsed = roundTripBatch(batch);
    expect(reparsed.members.length).toBe(1);
    expect(reparsed.members[0].members.length).toBe(1);
  });

  it('2. два участника', () => {
    const batch: BatchDocument = {
      members: [docOf(valuesModel()), docOf(anketaModel())],
    };
    const reparsed = roundTripBatch(batch);
    expect(reparsed.members.length).toBe(2);
  });

  it('3. участник пакета сам является объединением', () => {
    const unionDoc: QueryDocument = {
      members: [
        {
          name: 'Q1',
          distinct: false,
          model: {
            tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
            fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
          } as QueryModel,
        },
        {
          name: 'Q2',
          distinct: false,
          model: {
            tables: [{ id: 't2', fullName: 'Справочник.Контрагенты' }],
            fields: [{ tableId: 't2', path: 'Ссылка', alias: 'Ссылка' }],
          } as QueryModel,
        },
      ],
    };
    const batch: BatchDocument = {
      members: [unionDoc, docOf(anketaModel())],
    };
    const reparsed = roundTripBatch(batch);
    expect(reparsed.members.length).toBe(2);
    expect(reparsed.members[0].members.length).toBe(2);
  });

  it('4. участник с временной таблицей УНИЧТОЖИТЬ', () => {
    const createModel: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      queryType: 'createTemp',
      tempTableName: 'ВТВалюты',
    };
    const dropModel: QueryModel = {
      tables: [],
      fields: [],
      queryType: 'dropTemp',
      tempTableName: 'ВТВалюты',
    };
    const batch: BatchDocument = {
      members: [docOf(createModel), docOf(anketaModel()), docOf(dropModel)],
    };
    const reparsed = roundTripBatch(batch);
    expect(reparsed.members.length).toBe(3);
  });
});

// ─────────────────── задача 6.4: разбор реальных запросов ───────────────────
describe('parseQuery — 6.4: реальные запросы из корпуса', () => {
  // Фикс 1: &Параметр как имя источника ИЗ.
  it('6.4.1 принимает &Параметр как источник ИЗ (param как fullName)', () => {
    const model = parseQuery('ВЫБРАТЬ Т.Ссылка КАК Ссылка ИЗ &ВременнаяТаблица КАК Т');
    expect(model.tables[0].fullName).toBe('&ВременнаяТаблица');
    expect(model.tables[0].alias).toBe('Т');
    // Круговая идентичность через генератор.
    expect(generate(model)).toContain('ИЗ\n\t&ВременнаяТаблица КАК Т');
  });

  it('6.4.1b &Параметр-источник переживает round-trip', () => {
    const text = 'ВЫБРАТЬ\n\tТ.Ссылка КАК Ссылка\nИЗ\n\t&ВременнаяТаблица КАК Т';
    expect(generate(parseQuery(text))).toBe(text);
  });

  // Фикс 2: #Имя как имя источника ИЗ (подстановка временной таблицы).
  it('6.4.2 принимает #Имя как источник ИЗ', () => {
    const model = parseQuery('ВЫБРАТЬ Т.Ссылка КАК Ссылка ИЗ #Таблица КАК Т');
    expect(model.tables[0].fullName).toBe('#Таблица');
    expect(model.tables[0].alias).toBe('Т');
  });

  it('6.4.2b #Имя-источник переживает round-trip', () => {
    const text = 'ВЫБРАТЬ\n\tТ.Ссылка КАК Ссылка\nИЗ\n\t#Таблица КАК Т';
    expect(generate(parseQuery(text))).toBe(text);
  });

  // Фикс 3: подзапрос в источнике ИЗ — понятная ошибка, не «получено «(»».
  it('6.4.3 подзапрос в ИЗ отклоняется с понятным сообщением', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.Поле ИЗ (ВЫБРАТЬ 1 КАК Поле) КАК Т')).toThrow(
      /подзапрос в источнике ИЗ/
    );
  });

  // Фикс 4: КАК у источника необязателен.
  it('6.4.4 источник без КАК с голым псевдонимом', () => {
    const model = parseQuery('ВЫБРАТЬ Валюты.Код КАК Код ИЗ Справочник.Валюты Валюты');
    expect(model.tables[0].fullName).toBe('Справочник.Валюты');
    expect(model.tables[0].alias).toBe('Валюты');
  });

  it('6.4.4b источник без КАК и без псевдонима (синтез по умолчанию)', () => {
    const model = parseQuery('ВЫБРАТЬ Валюты.Код КАК Код ИЗ Справочник.Валюты ГДЕ Валюты.Код = &К');
    expect(model.tables[0].fullName).toBe('Справочник.Валюты');
    expect(model.tables[0].alias).toBe('Валюты');
    expect(model.conditions?.length).toBe(1);
  });

  // Фикс 6: имена-ключевые слова не искажаются (регистр сохраняется, не путаются
  // с агрегатами).
  it('6.4.6 поле Товары.Количество КАК Количество сохраняет регистр', () => {
    const text = 'ВЫБРАТЬ\n\tТовары.Количество КАК Количество\nИЗ\n\tСправочник.Товары КАК Товары';
    const model = parseQuery(text);
    expect(model.fields[0].path).toBe('Количество');
    expect(model.fields[0].alias).toBe('Количество');
    // Не агрегат.
    expect(model.grouping).toBeUndefined();
    expect(generate(model)).toBe(text);
  });

  it('6.4.6b сегмент пути .Дата не уходит в верхний регистр', () => {
    const text = 'ВЫБРАТЬ\n\tЗаказ.Дата КАК Дата\nИЗ\n\tДокумент.Заказ КАК Заказ';
    const model = parseQuery(text);
    expect(model.fields[0].path).toBe('Дата');
    expect(generate(model)).toBe(text);
  });

  it('6.4.6c поле с именем-ключевым словом в имени таблицы (Год/Месяц/Сумма)', () => {
    const text = 'ВЫБРАТЬ\n\tТ.Сумма КАК Сумма,\n\tТ.Год КАК Год\nИЗ\n\tРегистр.Обороты КАК Т';
    const model = parseQuery(text);
    expect(model.fields.map(f => f.path)).toEqual(['Сумма', 'Год']);
    expect(generate(model)).toBe(text);
  });
});
