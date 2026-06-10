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
