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

  it('5b. aggregate over a qualified operand gets a synthesized alias', () => {
    // Конструктор 1С синтезирует `КАК <последний-сегмент>` для агрегата над
    // КВАЛИФИЦИРОВАННЫМ операндом (`СУММА(Валюты.Наценка)` → `КАК Наценка`);
    // парсер помечает поле `funcOperandQualified`. Round-trip идемпотентен.
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Наценка', func: 'Сумма', funcOperandQualified: true }],
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
      { tableId: 't0', path: 'Код', alias: 'КодВалюты', qualified: true },
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
      multiple: false, groupFields: [], groupSets: [], explicitGroupCount: 0,
      aggregates: [{ tableId: 't0', path: 'Наценка', func: 'КоличествоРазличных' }],
    });
    expect(model.fields).toEqual([
      { tableId: 't0', path: 'Наценка', alias: 'Наценка', func: 'КоличествоРазличных', funcOperandQualified: true },
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
    expect(model.tables[0].virtual).toEqual({ period: '&Период', condition: 'Валюта = &Валюта', hadParens: true });
  });

  it('deep-equality: РБ Обороты corr → correspondence:true', () => {
    const text = generate({
      tables: [{ id: 't1', fullName: 'РегистрБухгалтерии.РБ1.Обороты', virtual: { periodicity: 'Период', correspondence: true } }],
      fields: [{ tableId: 't1', path: 'Счет', alias: 'Счет' }],
    });
    const model = parseQuery(text);
    expect(model.tables[0].virtual).toEqual({ periodicity: 'Период', correspondence: true, hadParens: true });
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
    // Произвольное (custom) условие с оператором В: конструктор печатает `В (…)`
    // с пробелом перед скобкой (в отличие от простого условия — там одиночный
    // элемент без пробела). `НЕ` удерживает условие в категории произвольных
    // (при реразборе не сворачивается в простое).
    roundTrip({ ...base(), conditions: [{ custom: true, expression: 'НЕ Валюты.Код В(&Список)' }] });
  });

  it('простое + произвольное условие', () => {
    roundTrip({
      ...base(),
      conditions: [
        { custom: false, tableId: 't1', path: 'Код' },
        { custom: true, expression: 'НЕ Валюты.Код В(&Список)' },
      ],
    });
  });

  it('секция ИМЕЮЩИЕ (round-trip, агрегатное условие)', () => {
    const model: QueryModel = {
      ...base(),
      grouping: { multiple: false, groupFields: [{ tableId: 't1', path: 'Код' }], groupSets: [], aggregates: [] },
      having: [{ custom: true, expression: 'КОЛИЧЕСТВО(Валюты.Ссылка) = 0' }],
    };
    const text = generate(model);
    expect(text).toContain('\n\nИМЕЮЩИЕ\n\tКОЛИЧЕСТВО(Валюты.Ссылка) = 0');
    const reparsed = parseQuery(text);
    expect(reparsed.having).toEqual([{ custom: true, expression: 'КОЛИЧЕСТВО(Валюты.Ссылка) = 0' }]);
    expect(generate(reparsed)).toBe(text);
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
        seedTableId: 't0', joinedTableId: 't1',
        // Поконъюнктное условие (фаза 6.13): один стандартный конъюнкт
        // `seed.Ссылка = joined.ИмяПредопределенныхДанных` — без скобок.
        conditions: [
          {
            custom: false,
            leftTableId: 't0', leftPath: 'Ссылка',
            operator: '=',
            rightTableId: 't1', rightPath: 'ИмяПредопределенныхДанных',
          },
        ],
      },
    ]);
    expect(model.tables.map(t => t.id)).toEqual(['t0', 't1']);
  });
});

describe('parseQuery 6.15.5 — скобки конъюнкта ПО решаются структурой, не вводом', () => {
  // Конструктор 1С классифицирует конъюнкт условия `ПО` по СТРУКТУРЕ, а не по
  // скобкам исходника: стандартная форма `<затравка>.<поле> <cmp> <присоединяемая>.<поле>`
  // печатается БЕЗ скобок, даже если разработчик обернул её во вводе; всё прочее —
  // В СКОБКАХ (эталон: золотой корпус — 575 голых конъюнктов все стандартные,
  // 679 скобочных все произвольные, исключений нет).
  const norm = (text: string): string => generate(parseQuery(text));

  it('обёрнутый стандартный конъюнкт → скобки снимаются (одиночный)', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО (Т.А = Б.А)'
    );
    expect(out).toContain('\t\tПО Т.А = Б.А');
  });

  it('обёрнутые стандартные конъюнкты в И-цепочке → скобки снимаются (фикстура bsl_13)', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Т.А = Б.А) И (Т.Код = Б.Код)'
    );
    expect(out).toContain('\t\tПО Т.А = Б.А\n\t\t\tИ Т.Код = Б.Код');
  });

  it('смешанная цепочка: стандартный без скобок, произвольный (перестановка) в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Т.А = Б.А) И (Б.Код = Т.Код)'
    );
    expect(out).toContain('\t\tПО Т.А = Б.А\n\t\t\tИ (Б.Код = Т.Код)');
  });

  it('обёрнутая перестановка операндов (joined слева) остаётся в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО (Б.А = Т.А)'
    );
    expect(out).toContain('\t\tПО (Б.А = Т.А)');
  });

  it('обёрнутый конъюнкт с параметром остаётся в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО (Т.А = &П)'
    );
    expect(out).toContain('\t\tПО (Т.А = &П)');
  });

  it('обёрнутый конъюнкт от промежуточной таблицы цепочки остаётся в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = Б.А ' +
      'ЛЕВОЕ СОЕДИНЕНИЕ Справочник.В КАК В ПО (Б.А = В.А)'
    );
    expect(out).toContain('\t\tПО (Б.А = В.А)');
  });

  it('идемпотентность: снятая форма стабильна при повторном прогоне', () => {
    const once = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Т.А = Б.А) И (Т.Код = Б.Код)'
    );
    expect(norm(once)).toBe(once);
  });

  // Скобки вокруг ВСЕЙ И-цепочки (`ПО (a И b)`) конструктор раскрывает: делит на
  // конъюнкты и классифицирует каждый заново (корпус: ПрефиксацияОбъектовСлужебный
  // bsl_5, ЭлектроннаяПодписьСлужебный bsl_2).
  it('ПО (a И b): скобки всей цепочки раскрываются, конъюнкты классифицируются', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Б.А = Т.А И Б.Код = Т.Код)'
    );
    expect(out).toContain('\t\tПО (Б.А = Т.А)\n\t\t\tИ (Б.Код = Т.Код)');
  });

  it('ПО (a И b) со стандартным конъюнктом: стандартный голый, произвольный в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Т.А = Б.А И Б.Код = Т.Код)'
    );
    expect(out).toContain('\t\tПО Т.А = Б.А\n\t\t\tИ (Б.Код = Т.Код)');
  });

  // Сложный конъюнкт (многострочная ИЛИ-группа) больше не уводит ВСЁ условие на
  // legacy-путь: простые конъюнкты классифицируются, сложные рендерятся форматером
  // с прежней геометрией (корпус: ВариантыОтчетов bsl_26–28).
  it('перестановка + ИЛИ-группа: простой конъюнкт в скобках, геометрия группы прежняя', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Б.А = Т.А И (Т.Флаг ИЛИ Т.Код В (&Список))'
    );
    expect(out).toContain(
      '\t\tПО (Б.А = Т.А)\n' +
      '\t\t\tИ (Т.Флаг\n' +
      '\t\t\t\tИЛИ Т.Код В (&Список))'
    );
  });

  it('стандартный конъюнкт + ИЛИ-группа: стандартный остаётся голым', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А И (Т.Флаг ИЛИ Т.Код В (&Список))'
    );
    expect(out).toContain(
      '\t\tПО Т.А = Б.А\n' +
      '\t\t\tИ (Т.Флаг\n' +
      '\t\t\t\tИЛИ Т.Код В (&Список))'
    );
  });

  // Верхнеуровневое ИЛИ: делить по И нельзя (И связывает сильнее) — всё условие
  // один произвольный конъюнкт в скобках (корпус: НастройкиВариантовОтчетов bsl_6,
  // ЗначенияГруппДоступа bsl_1/3).
  it('ПО a ИЛИ b И c: одно условие в скобках, И не разделитель', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Б.А = Т.А ИЛИ Т.Код = Б.Код И Б.Флаг'
    );
    expect(out).toContain(
      '\t\tПО (Б.А = Т.А\n' +
      '\t\t\t\tИЛИ Т.Код = Б.Код\n' +
      '\t\t\t\t\tИ Б.Флаг)'
    );
  });

  it('ПО (a И b ИЛИ c): скобки с верхнеуровневым ИЛИ внутри не раскрываются', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО (Т.А = Б.А И Б.Флаг ИЛИ Т.Код = Б.Код)'
    );
    expect(out).toContain(
      '\t\tПО (Т.А = Б.А\n' +
      '\t\t\t\t\tИ Б.Флаг\n' +
      '\t\t\t\tИЛИ Т.Код = Б.Код)'
    );
  });

  // ВЫБОР-конъюнкт конструктор печатает в скобках (корпус: 6/6 в скобках, голых
  // нет — УправлениеДоступомСлужебный bsl_195 и др.).
  it('ВЫБОР-конъюнкт в И-цепочке остаётся в скобках', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А И (ВЫБОР КОГДА Т.Флаг ТОГДА ИСТИНА ИНАЧЕ ЛОЖЬ КОНЕЦ)'
    );
    expect(out).toContain('\t\t\tИ (ВЫБОР');
    expect(out).toMatch(/КОНЕЦ\)/);
  });

  // Многострочный лист в произвольном конъюнкте сплющивается (правило 6.15.3 для
  // ПО; корпус: ВариантыОтчетов bsl_26–28).
  it('многострочный В-лист конъюнкта сплющивается в одну строку', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А И Б.Код В (\n\t\t&Один,\n\t\t&Два)'
    );
    expect(out).toContain('\t\t\tИ (Б.Код В (&Один, &Два))');
  });

  it('идемпотентность раскрытой И-цепочки и смешанного условия', () => {
    for (const src of [
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО (Б.А = Т.А И Б.Код = Т.Код)',
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Б.А = Т.А И (Т.Флаг ИЛИ Т.Код В (&Список))',
    ]) {
      const once = norm(src);
      expect(norm(once)).toBe(once);
    }
  });
});

describe('parseQuery 6.15.7 — блок построителя {ГДЕ}: условия-выражения и стоп на «{»', () => {
  const norm = (text: string): string => generate(parseQuery(text));

  // Читалка условия ПО не должна заглатывать `{ГДЕ …}` (корпус: Взаимодействия
  // bsl_65 — условие оставалось custom-в-скобках с «{» в тексте).
  it('{ГДЕ} после условия ПО: условие стандартное голое, блок распознан', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А\n{ГДЕ\n\tТ.Ссылка КАК Поиск\n\t,&ОтборКонтакт}'
    );
    expect(out).toContain('\t\tПО Т.А = Б.А\n{ГДЕ');
    expect(out).toContain('{ГДЕ\n\tТ.Ссылка КАК Поиск,\n\t(&ОтборКонтакт)}');
  });

  // Одиночный параметр — элемент-условие в скобках БЕЗ псевдонима (bsl_65).
  it('параметр в {ГДЕ} оборачивается в скобки без псевдонима', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т\n{ГДЕ\n\t&Отбор}'
    );
    expect(out).toContain('{ГДЕ\n\t(&Отбор)}');
  });

  // Условие-выражение получает автопсевдоним Поле<N>, N продолжает счёт условий
  // запроса (1 статическое ГДЕ + первое условие построителя → Поле2; корпус:
  // ДвиженияДокумента bsl_1/2 — обе формы входа, голая и в скобках).
  it('условие-выражение в {ГДЕ}: скобки + КАК Поле2 после одного статического ГДЕ', () => {
    for (const entry of ['"&ИмяГруппировки" В (&СписокРегистров)', '("&ИмяГруппировки" В (&СписокРегистров))']) {
      const out = norm(
        'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ГДЕ &Поле = &Знач\n{ГДЕ\n\t' + entry + '}'
      );
      expect(out).toContain('{ГДЕ\n\t("&ИмяГруппировки" В (&СписокРегистров)) КАК Поле2}');
    }
  });

  // Без резолвера суффикс `.*` сохраняется во всех формах (с псевдонимом и без) —
  // живой оракул подтверждает сохранение `Поле.* КАК Алиас`. Снятие `.*` выполняет
  // resolveBuilderStar только по метаданным (см. отдельный describe ниже).
  it('{ГДЕ}: «.*» сохраняется без резолвера (с псевдонимом и без)', () => {
    const out1 = norm('ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т\n{ГДЕ\n\tТ.Ссылка.* КАК Псевдоним}');
    expect(out1).toContain('{ГДЕ\n\tТ.Ссылка.* КАК Псевдоним}');
    const out2 = norm('ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т\n{ГДЕ\n\tТ.Ссылка.*}');
    expect(out2).toContain('{ГДЕ\n\tТ.Ссылка.*}');
  });

  it('идемпотентность всех форм {ГДЕ}', () => {
    for (const src of [
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = Б.А\n{ГДЕ\n\tТ.Ссылка КАК Поиск\n\t,&ОтборКонтакт}',
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ГДЕ &Поле = &Знач\n{ГДЕ\n\t"&Имя" В (&Список)}',
    ]) {
      const once = norm(src);
      expect(norm(once)).toBe(once);
    }
  });
});

describe('resolveBuilderStar — суффикс `.*` поля построителя по метаданным', () => {
  // Заглушка-резолвер: справочник Валюты (Ссылка — ссылка, Код — строка).
  const resolver = {
    tableByFullName: (full: string) =>
      full === 'Справочник.Валюты'
        ? {
            kind: 'Справочник' as const, name: 'Валюты', fullName: 'Справочник.Валюты',
            fields: [
              { name: 'Ссылка', kind: 'standard' as const, types: [{ ref: { kind: 'Справочник' as const, name: 'Валюты' } }] },
              { name: 'Код', kind: 'standard' as const, types: [{ primitive: 'Строка' as const }] },
            ],
          }
        : undefined,
  };
  const norm = (text: string): string => generateBatch(parseBatch(text, resolver));

  it('ссылочное поле сохраняет `.*`, скалярное — теряет', () => {
    const refOut = norm('ВЫБРАТЬ Т.Ссылка КАК С ИЗ Справочник.Валюты КАК Т\n{ГДЕ\n\tТ.Ссылка.* КАК К}');
    expect(refOut).toContain('{ГДЕ\n\tТ.Ссылка.* КАК К}');
    const scalarOut = norm('ВЫБРАТЬ Т.Ссылка КАК С ИЗ Справочник.Валюты КАК Т\n{ГДЕ\n\tТ.Код.* КАК К}');
    expect(scalarOut).toContain('{ГДЕ\n\tТ.Код КАК К}');
  });

  it('источник-параметр `&Имя`: `.*` теряется (поле нерезолвимо)', () => {
    const out = norm('ВЫБРАТЬ О.Ссылка КАК С ИЗ &ИмяТаблицы КАК О\n{ГДЕ\n\tО.Ссылка.* КАК К}');
    expect(out).toContain('{ГДЕ\n\tО.Ссылка КАК К}');
  });

  it('нерезолвимая таблица (пробел в метаданных): `.*` сохраняется консервативно', () => {
    const out = norm('ВЫБРАТЬ Т.Поле КАК С ИЗ Справочник.Неизвестный КАК Т\n{ГДЕ\n\tТ.Поле.* КАК К}');
    expect(out).toContain('{ГДЕ\n\tТ.Поле.* КАК К}');
  });
});

describe('parseQuery 6.15.8 — вложенные соединения (правовложенное дерево)', () => {
  const norm = (text: string): string => generate(parseQuery(text));

  // Правовложенная цепочка `A СОЕД B СОЕД C ПО bc ПО ab`: присоединяемый источник
  // несёт вложенную подцепочку, ПО внешнего соединения идёт ПОСЛЕ внутренних.
  // Канон конструктора (корпус: ПользователиСлужебный bsl_15–17): вложенные
  // СОЕДИНЕНИЕ/ПО на +1 таб, ПО внешнего — после подцепочки на базовом отступе.
  it('вложенная подцепочка: отступ +1, ПО внешнего после внутренних', () => {
    const out = norm(
      'ВЫБРАТЬ А.Ссылка КАК Ссылка ИЗ Справочник.А КАК А ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО А.Ссылка = Б.Ссылка ' +
      'ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Ц КАК Ц ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Д КАК Д ПО Ц.Ссылка = Д.Ссылка ' +
      'ПО А.Ссылка = Ц.Ссылка'
    );
    expect(out).toContain(
      'ИЗ\n' +
      '\tСправочник.А КАК А\n' +
      '\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б\n' +
      '\t\tПО А.Ссылка = Б.Ссылка\n' +
      '\t\tЛЕВОЕ СОЕДИНЕНИЕ Справочник.Ц КАК Ц\n' +
      '\t\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Д КАК Д\n' +
      '\t\t\tПО Ц.Ссылка = Д.Ссылка\n' +
      '\t\tПО А.Ссылка = Ц.Ссылка'
    );
  });

  it('вложенная подцепочка из двух соединений + И-конъюнкты на глубине', () => {
    const out = norm(
      'ВЫБРАТЬ А.Ссылка КАК Ссылка ИЗ Справочник.А КАК А ' +
      'ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Ц КАК Ц ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Д КАК Д ПО Ц.Ссылка = Д.Ссылка И (Д.Код = &Код) ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Е КАК Е ПО Ц.Ссылка = Е.Ссылка ' +
      'ПО (Ц.Код = А.Код)'
    );
    expect(out).toContain(
      '\t\tЛЕВОЕ СОЕДИНЕНИЕ Справочник.Ц КАК Ц\n' +
      '\t\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Д КАК Д\n' +
      '\t\t\tПО Ц.Ссылка = Д.Ссылка\n' +
      '\t\t\t\tИ (Д.Код = &Код)\n' +
      '\t\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Е КАК Е\n' +
      '\t\t\tПО Ц.Ссылка = Е.Ссылка\n' +
      '\t\tПО (Ц.Код = А.Код)'
    );
  });

  // МЕЖДУ-конъюнкт — произвольный, печатается в скобках одной строкой; `И` диапазона
  // не делает его «сложным» (корпус: ГрафикиРаботы bsl_6).
  it('МЕЖДУ-конъюнкт в ПО оборачивается в скобки', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А И Б.Дата МЕЖДУ &ДатаНачала И &ДатаОкончания'
    );
    expect(out).toContain('\t\t\tИ (Б.Дата МЕЖДУ &ДатаНачала И &ДатаОкончания)');
  });

  // Двойные скобки исходника не накапливаются: `((НЕ x))` → `(НЕ x)` (корпус:
  // Взаимодействия bsl_47).
  it('двойные скобки конъюнкта сводятся к одинарным', () => {
    const out = norm(
      'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ' +
      'ПО Т.А = Б.А И ((НЕ Б.ПометкаУдаления))'
    );
    expect(out).toContain('\t\t\tИ (НЕ Б.ПометкаУдаления)');
  });

  it('идемпотентность вложенного дерева соединений', () => {
    const once = norm(
      'ВЫБРАТЬ А.Ссылка КАК Ссылка ИЗ Справочник.А КАК А ' +
      'ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Ц КАК Ц ' +
      'ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Д КАК Д ПО Ц.Ссылка = Д.Ссылка ' +
      'ПО А.Ссылка = Ц.Ссылка'
    );
    expect(norm(once)).toBe(once);
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
      explicitGroupCount: 1,
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

  it('квалифицированное поле таблицы сохраняется как Псевдоним.Поле', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      order: { fields: [{ tableId: 't1', path: 'РеквизитДопУпорядочивания', direction: 'asc', qualified: true }], auto: false },
    };
    const text = generate(model);
    expect(text).toContain('УПОРЯДОЧИТЬ ПО\n\tВалюты.РеквизитДопУпорядочивания');
    // парсинг квалифицированной ссылки восстанавливает qualified-поле
    const reparsed = parseQuery(text);
    expect(reparsed.order?.fields[0]).toMatchObject({ path: 'РеквизитДопУпорядочивания', qualified: true });
    expect(generate(reparsed)).toBe(text);
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

  // Фаза 6.15.2 (правка ревью): деление пакета по сырому тексту НЕ должно
  // срабатывать внутри многострочного строкового литерала — литерал 1С может
  // содержать перевод строки и строку из одного `;`.
  it('5. строка из `;` внутри многострочного строкового литерала НЕ делит пакет', () => {
    const text = 'ВЫБРАТЬ "абв\n;\nгде" КАК Поле ИЗ Справочник.Валюты КАК Валюты';
    const batch = parseBatch(text);
    expect(batch.members.length).toBe(1);
    // Конструктор 1С добавляет базовый отступ поля (+1 таб) каждой строке-продолжению
    // многострочного строкового литерала (сверено живым оракулом validate_query).
    expect(generateBatch(batch)).toContain('"абв\n\t;\n\tгде"');
  });

  it('6. `;` + слэши внутри литерала НЕ делят пакет, а настоящий разделитель ПОСЛЕ литерала делит', () => {
    const text =
      'ВЫБРАТЬ "абв\n;\n////////\nгде" КАК Поле ИЗ Справочник.Валюты КАК Валюты' +
      '\n;\n\n////////////////////////////////////////////////////////////////////////////////\n' +
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const batch = parseBatch(text);
    expect(batch.members.length).toBe(2);
    // +1 таб строкам-продолжениям литерала (как конструктор 1С; см. тест 5 выше).
    expect(generateBatch(batch)).toContain('"абв\n\t;\n\t////////\n\tгде"');
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

  // 6.11: подзапрос в источнике ИЗ — полноценный узел модели (узел subquery + alias).
  it('6.4.3 подзапрос в ИЗ разбирается как узел модели (subquery + alias)', () => {
    const model = parseQuery('ВЫБРАТЬ Т.Поле ИЗ (ВЫБРАТЬ В.Код КАК Поле ИЗ Спр.В КАК В) КАК Т');
    expect(model.tables[0].fullName).toBe('');
    expect(model.tables[0].alias).toBe('Т');
    expect(model.tables[0].subquery).toBeDefined();
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

// ─────────────── 6.5: покрытие ошибочных и краевых путей ───────────────
// Точечные входы, прицельно проходящие ветви разбора, не покрытые round-trip
// тестами генератора (ошибки лексера/парсера, краевые случаи).

describe('sdblLexer — ошибки и краевые случаи', () => {
  it('бросает на "#" без имени', () => {
    expect(() => tokenize('ИЗ #')).toThrow(/Лексическая ошибка/);
  });

  it('бросает на "&" без имени параметра', () => {
    expect(() => tokenize('ГДЕ Т.А = &')).toThrow(/имя параметра/);
  });

  it('лексит подстановку #Имя как ident', () => {
    const tokens = tokenize('#ВТ');
    expect(tokens[0]).toMatchObject({ type: 'ident', value: '#ВТ' });
  });
});

describe('parseQuery — ошибки разбора (error paths)', () => {
  it('пустой ввод: нет ВЫБРАТЬ', () => {
    expect(() => parseQuery('')).toThrow(/ожидалось ключевое слово «ВЫБРАТЬ»/);
  });

  it('expectKeyword: не то ключевое слово', () => {
    expect(() => parseQuery('ИЗ Справочник.Валюты')).toThrow(/ВЫБРАТЬ/);
  });

  it('expectPunct: ожидался символ', () => {
    // ГРУППИРУЮЩИМ НАБОРАМ без открывающей скобки.
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т СГРУППИРОВАТЬ ПО ГРУППИРУЮЩИМ НАБОРАМ Т.А';
    expect(() => parseQuery(text)).toThrow(/ожидался символ «\(»/);
  });

  it('ПЕРВЫЕ без числа', () => {
    expect(() => parseQuery('ВЫБРАТЬ ПЕРВЫЕ Т.А ИЗ Справочник.Валюты КАК Т')).toThrow(/ожидалось число после ПЕРВЫЕ/);
  });

  it('пустой список выборки', () => {
    expect(() => parseQuery('ВЫБРАТЬ ИЗ Справочник.Валюты КАК Т')).toThrow(/пустой список выборки/);
  });

  it('пустой элемент выборки (двойная запятая)', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А, , Т.Б ИЗ Справочник.Валюты КАК Т')).toThrow(/пустой элемент выборки/);
  });

  it('КАК без псевдонима поля', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А КАК , Т.Б ИЗ Справочник.Валюты КАК Т')).toThrow(/псевдоним после КАК/);
  });

  it('КАК без псевдонима таблицы', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК ,')).toThrow(/псевдоним таблицы после КАК/);
  });

  it('подзапрос в источнике ИЗ (…) разбирается в узел subquery (6.11)', () => {
    const model = parseQuery('ВЫБРАТЬ Т.А ИЗ (ВЫБРАТЬ В.А КАК А ИЗ Спр.В КАК В) КАК Т');
    expect(model.tables[0].subquery).toBeDefined();
    expect(model.tables[0].alias).toBe('Т');
  });

  it('ИЗ без имени источника', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А ИЗ ,')).toThrow(/ожидалось имя/);
  });

  it('точечное имя: нет сегмента после точки', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.1 КАК Т')).toThrow(/сегмент имени после/);
  });

  it('незакрытая скобка параметров виртуальной таблицы', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Т.Остатки(&П КАК Т')).toThrow(/незакрытая скобка/);
  });

  it('табличная часть: ожидалось поле', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.Товары.(, КАК Х) КАК Товары ИЗ Документ.Р КАК Т')).toThrow(/поле табличной части/);
  });

  it('пустое условие соединения после ПО', () => {
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО ГДЕ Т.А = 1';
    expect(() => parseQuery(text)).toThrow(/пустое условие соединения/);
  });

  it('УПОРЯДОЧИТЬ ПО без псевдонима', () => {
    const text = 'ВЫБРАТЬ Т.А КАК А ИЗ Справочник.Валюты КАК Т УПОРЯДОЧИТЬ ПО ,';
    expect(() => parseQuery(text)).toThrow(/псевдоним поля упорядочивания/);
  });

  it('ИТОГИ ПО без псевдонима группировки', () => {
    const text = 'ВЫБРАТЬ Т.А КАК А ИЗ Справочник.Валюты КАК Т ИТОГИ ПО ,';
    expect(() => parseQuery(text)).toThrow(/псевдоним группировочного поля итогов/);
  });

  it('ИТОГИ: пустое выражение агрегата', () => {
    const text = 'ВЫБРАТЬ Т.А КАК А ИЗ Справочник.Валюты КАК Т ИТОГИ , ПО А';
    expect(() => parseQuery(text)).toThrow(/выражение агрегата итогов/);
  });

  it('СГРУППИРОВАТЬ ПО: нет ссылки на поле группировки', () => {
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т СГРУППИРОВАТЬ ПО ,';
    expect(() => parseQuery(text)).toThrow(/ссылка на поле группировки/);
  });

  it('ИНДЕКСИРОВАТЬ ПО: нет псевдонима поля индекса', () => {
    const text = 'ВЫБРАТЬ Т.А КАК А ИЗ Справочник.Валюты КАК Т ИНДЕКСИРОВАТЬ ПО ,';
    expect(() => parseQuery(text)).toThrow(/псевдоним поля индекса/);
  });

  it('построитель: нет ссылки поля', () => {
    const text = 'ВЫБРАТЬ Т.А {ВЫБРАТЬ ,} ИЗ Справочник.Валюты КАК Т';
    expect(() => parseQuery(text)).toThrow(/ссылка поля построителя/);
  });

  it('построитель: нет сегмента после точки', () => {
    const text = 'ВЫБРАТЬ Т.А {ВЫБРАТЬ Поле.,} ИЗ Справочник.Валюты КАК Т';
    expect(() => parseQuery(text)).toThrow(/сегмент ссылки построителя/);
  });
});

describe('parseQuery — краевые ветви', () => {
  it('УНИЧТОЖИТЬ <имя> — самостоятельный запрос dropTemp', () => {
    const model = parseQuery('УНИЧТОЖИТЬ ВТ');
    expect(model.queryType).toBe('dropTemp');
    expect(model.tempTableName).toBe('ВТ');
  });

  it('источник без КАК и без голого псевдонима → синтез псевдонима по умолчанию', () => {
    const model = parseQuery('ВЫБРАТЬ Валюты.Код ИЗ Справочник.Валюты');
    expect(model.tables[0].alias).toBe('Валюты');
  });

  it('источник с голым псевдонимом (без КАК)', () => {
    const model = parseQuery('ВЫБРАТЬ Спр.Код ИЗ Справочник.Валюты Спр');
    expect(model.tables[0].alias).toBe('Спр');
  });

  it('произвольное (custom) условие ГДЕ, не распознаваемое как простое', () => {
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ГДЕ ЕСТЬNULL(Т.А, 0) = 1';
    const model = parseQuery(text);
    expect(model.conditions?.[0].custom).toBe(true);
  });

  it('ИТОГИ СУММА(<неизвестныйПсевдоним>) → expression без резолвинга (aliasMap.get undefined)', () => {
    const text = 'ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ СУММА(НеизвестноеПоле) ПО А';
    const model = parseQuery(text);
    expect(model.totals?.totalFields[0].expression).toBe('СУММА(НеизвестноеПоле)');
    expect(model.totals?.totalFields[0].tableId).toBe('');
  });

  it('stripOuterParens: несбалансированные внешние скобки возвращаются без изменений', () => {
    // condText начинается «(» и кончается «)», но скобки несбалансированы →
    // первая открывающая не закрывается последней → текст возвращается как есть.
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО ((Т.А = Б.А)';
    const model = parseQuery(text);
    expect(model.joins?.[0].custom).toBe(true);
    expect(model.joins?.[0].expression).toBe('((Т.А = Б.А)');
  });

  it('custom условие соединения без внешних скобок не теряет смысл (stripOuterParens возврат без скобок)', () => {
    // Выражение начинается со скобки, но она НЕ охватывает всё — stripOuterParens вернёт как есть.
    const text = 'ВЫБРАТЬ Т.А ИЗ Справочник.Валюты КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО (Т.А = Б.А) ИЛИ (Т.Б = Б.Б)';
    const model = parseQuery(text);
    expect(model.joins?.[0].custom).toBe(true);
    expect(model.joins?.[0].expression).toContain('ИЛИ');
  });
});

describe('parseQuery — виртуальные таблицы с пропущенными позициями', () => {
  it('РН Остатки без условия (только период)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.Остатки(&Дата) КАК Т');
    expect(m.tables[0].virtual).toEqual({ period: '&Дата', hadParens: true });
  });

  it('РН Остатки совсем без аргументов (все позиции пустые)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.Остатки() КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РН Обороты с пропущенными серединными позициями', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.Обороты(, , , Т.Б = 1) КАК Т');
    expect(m.tables[0].virtual).toEqual({ condition: 'Т.Б = 1', hadParens: true });
  });

  it('РН ОстаткиИОбороты с пропущенными позициями', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.ОстаткиИОбороты(&Н, &К) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', endPeriod: '&К', hadParens: true });
  });

  it('РБ Остатки без позиций', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.Остатки() КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РБ Обороты non-corr (6 позиций, без корреспонденции)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.Обороты(&Н, &К) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', endPeriod: '&К', hadParens: true });
    expect(m.tables[0].virtual?.correspondence).toBeUndefined();
  });

  it('РБ ОборотыДтКт без позиций', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ОборотыДтКт() КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РБ ОстаткиИОбороты без позиций', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ОстаткиИОбороты() КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РБ ДвиженияССубконто без позиций', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ДвиженияССубконто() КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РБ неизвестный срез (default — нет раскладки)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.НеизвестныйСрез(&П) КАК Т');
    expect(m.tables[0].virtual).toEqual({ hadParens: true });
  });

  it('РН Обороты с одним аргументом (хвостовые позиции отсутствуют → ?? "")', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.Обороты(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РН ОстаткиИОбороты с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.ОстаткиИОбороты(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РБ Обороты с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.Обороты(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РБ ОборотыДтКт с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ОборотыДтКт(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РБ ОстаткиИОбороты (бух) с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ОстаткиИОбороты(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РБ ДвиженияССубконто с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.ДвиженияССубконто(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ startPeriod: '&Н', hadParens: true });
  });

  it('РБ Остатки с одним аргументом', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрБухгалтерии.Х.Остатки(&Н) КАК Т');
    expect(m.tables[0].virtual).toEqual({ period: '&Н', hadParens: true });
  });
});

describe('parseQuery — отрицательные ветви распознавания', () => {
  it('агрегат: тело не ФУНК(...) → трактуется как выражение', () => {
    const m = parseQuery('ВЫБРАТЬ СУММА + 1 КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('агрегат: ФУНК без скобки второй токен → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ СУММА Т.А КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('агрегат: неизвестная функция (МАКСИМУМ ок, но иное keyword) → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ ВЫРАЗИТЬ(Т.А КАК ЧИСЛО) КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('простое поле: неизвестный псевдоним при единственном источнике → квалификация (6.12)', () => {
    // Единственный источник: голову `Неизвестный` не считаем псевдонимом таблицы,
    // поэтому путь трактуется как голое поле и квалифицируется псевдонимом источника
    // `Т` (конструктор 1С при одной таблице привязывает поле к ней без метаинформации).
    const m = parseQuery('ВЫБРАТЬ Неизвестный.Поле КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeUndefined();
    expect(m.fields[0].tableId).toBe('t0');
    expect(m.fields[0].path).toBe('Неизвестный.Поле');
    expect(m.fields[0].alias).toBe('Х');
  });

  it('простое поле: неизвестный псевдоним при нескольких источниках → выражение', () => {
    // Несколько источников — без метаинформации привязать нельзя, остаётся выражением.
    const m = parseQuery('ВЫБРАТЬ Неизвестный.Поле КАК Х ИЗ Справочник.В КАК Т, Справочник.С КАК У');
    expect(m.fields[0].expression).toBe('Неизвестный.Поле');
  });

  it('простое поле: чётное число токенов в ссылке → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А. КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('агрегат КОЛИЧЕСТВО(РАЗЛИЧНЫЕ …) распознаётся, остальное — выражение', () => {
    const m = parseQuery('ВЫБРАТЬ КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.А) КАК К ИЗ Справочник.В КАК Т');
    expect(m.grouping?.aggregates[0].func).toBe('КоличествоРазличных');
  });

  it('агрегат: последний токен не «)» → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ СУММА(Т.А) + 1 КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('агрегат: keyword-функция не из набора агрегатов → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ МЕЖДУ(Т.А) КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('агрегат: аргумент не ссылка на поле (число) → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ СУММА(5) КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('ссылка поля с числовым сегментом → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ Т.5 КАК Х ИЗ Справочник.В КАК Т');
    expect(m.fields[0].expression).toBeDefined();
  });

  it('образец табличной части с числом во 2-м сегменте → обычное поле', () => {
    const m = parseQuery('ВЫБРАТЬ Т.5.А КАК Х ИЗ Справочник.В КАК Т');
    expect(m.tabSectionFields).toBeUndefined();
    expect(m.fields.length).toBe(1);
  });

  it('выборка без ИЗ — валидный запрос без источника (создание ВТ из констант)', () => {
    // 1С допускает `ВЫБРАТЬ <выражение>` без секции `ИЗ`; источник пуст.
    const m = parseQuery('ВЫБРАТЬ &Параметр КАК Поле');
    expect(m.tables).toHaveLength(0);
    expect(m.fields[0].expression).toBe('&Параметр');
  });
});

describe('parseQuery — упорядочивание/итоги по неаласированному полю', () => {
  it('УПОРЯДОЧИТЬ ПО последнему сегменту пути (поле без явного псевдонима)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.Код ИЗ Справочник.В КАК Т УПОРЯДОЧИТЬ ПО Код');
    expect(m.order?.fields[0].path).toBe('Код');
  });

  it('ИТОГИ ПО последнему сегменту пути дотированного поля', () => {
    const m = parseQuery('ВЫБРАТЬ Т.Контрагент.Наименование ИЗ Справочник.В КАК Т ИТОГИ ПО Наименование');
    expect(m.totals?.groupFields[0].path).toBe('Контрагент.Наименование');
  });

  it('ИТОГИ без ПО (доходит до eof в цикле агрегатов) → ошибка ПО', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ А')).toThrow(/ожидалось ключевое слово «ПО»/);
  });

  it('ИТОГИ КОЛИЧЕСТВО(А) — не СУММА, agg как выражение', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ КОЛИЧЕСТВО(А) ПО ОБЩИЕ');
    expect(m.totals?.totalFields[0].expression).toBe('КОЛИЧЕСТВО(А)');
    expect(m.totals?.totalFields[0].tableId).toBe('');
  });

  it('ИТОГИ СУММА(5) — 3-й токен не идент → выражение', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ СУММА(5) ПО ОБЩИЕ');
    expect(m.totals?.totalFields[0].expression).toBe('СУММА(5)');
  });

  it('ИТОГИ СУММА(А + 1) — 4 токена, последний не «)» обрабатывается как выражение', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ СУММА(А) + 0 ПО ОБЩИЕ');
    expect(m.totals?.totalFields[0].tableId).toBe('');
  });

  it('ИТОГИ агрегат из 4 токенов без скобки (СУММА А.Б) → выражение (matchSumAlias: 2-й токен не «(»)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ СУММА А.Б ПО ОБЩИЕ');
    expect(m.totals?.totalFields[0].tableId).toBe('');
    expect(m.totals?.totalFields[0].expression).toBe('СУММА А.Б');
  });
});

describe('parseQuery — вложенные скобки (depth-трекинг)', () => {
  it('параметры виртуальной таблицы с вложенными скобками в аргументе', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ РегистрНакопления.Р.Остатки(&Дата, Т.А В (1, 2)) КАК Т');
    expect(m.tables[0].virtual?.condition).toContain('(1, 2)');
  });

  it('условие соединения со вложенными скобками (depth++ в trySimpleJoinCondition)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = ЕСТЬNULL(Б.А, 0)');
    expect(m.joins?.[0].custom).toBe(true);
  });

  it('условие соединения: скобки в ЛЕВОЙ части до оператора (depth++/-- до opIdx)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО ЕСТЬNULL(Т.А, 0) = Б.А');
    expect(m.joins?.[0].custom).toBe(true);
  });

  it('условие соединения начинается с оператора → custom (opIdx<=0)', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО = Б.А');
    expect(m.joins?.[0].custom).toBe(true);
  });
});

describe('parseQuery — соединения и условия (доп. ветви)', () => {
  it('ПРАВОЕ соединение → rightAll', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ПРАВОЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = Б.А');
    expect(m.joins?.[0].rightAll).toBe(true);
    expect(m.joins?.[0].leftAll).toBe(false);
  });

  it('условие соединения завершается на СГРУППИРОВАТЬ', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = Б.А СГРУППИРОВАТЬ ПО Т.А');
    expect(m.joins?.length).toBe(1);
    expect(m.grouping?.groupFields.length).toBe(1);
  });

  it('простое условие соединения с неполной правой ссылкой → custom', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Б КАК Б ПО Т.А = 5');
    expect(m.joins?.[0].custom).toBe(true);
  });

  it('простое условие ГДЕ без оператора → custom', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А ИЗ Справочник.В КАК Т ГДЕ Т.А');
    expect(m.conditions?.[0].custom).toBe(true);
  });
});

describe('parseQuery — итоги, табличные части, построитель (доп. ветви)', () => {
  it('ИТОГИ с несколькими агрегатами через запятую', () => {
    const text = 'ВЫБРАТЬ\n\tТ.А КАК А,\n\tТ.Б КАК Б\nИЗ\n\tСправочник.В КАК Т';
    const m = parseQuery(text + ' ИТОГИ СУММА(А), СУММА(Б) ПО ОБЩИЕ');
    expect(m.totals?.totalFields.length).toBe(2);
  });

  it('группировочное поле итогов с КАК <alias>', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ ПО А КАК ПсевдонимА');
    expect(m.totals?.groupFields[0].alias).toBe('ПсевдонимА');
  });

  it('группировочное поле итогов КАК без псевдонима → ошибка', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А КАК А ИЗ Справочник.В КАК Т ИТОГИ ПО А КАК ,')).toThrow(/псевдоним после КАК/);
  });

  it('табличная часть с неизвестным псевдонимом таблицы (tableId пустой)', () => {
    const m = parseQuery('ВЫБРАТЬ Неизв.Товары.(Номенклатура КАК Номенклатура) КАК Товары ИЗ Документ.Р КАК Т');
    expect(m.tabSectionFields?.[0].tableId).toBe('');
    expect(m.tabSectionFields?.[0].tsFullName).toBe('Товары');
  });

  it('поле построителя с КАК без псевдонима → ошибка', () => {
    expect(() => parseQuery('ВЫБРАТЬ Т.А {ВЫБРАТЬ Поле КАК ,} ИЗ Справочник.В КАК Т')).toThrow(/псевдоним после КАК/);
  });

  it('список полей: завершение по {ВЫБРАТЬ после запятой', () => {
    const m = parseQuery('ВЫБРАТЬ Т.А, {ВЫБРАТЬ Поле} ИЗ Справочник.В КАК Т');
    expect(m.builder?.fields.length).toBe(1);
  });
});

describe('parseDocument — переписывание псевдонимов колонок', () => {
  it('NULL-ячейка СОХРАНЯЕТСЯ на своей позиции (позиционное выравнивание, 6.15.22)', () => {
    // Участник 0 задаёт 2 колонки; участник 1 имеет NULL в первой позиции.
    const text =
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tВалюты.Наименование КАК Наименование\nИЗ\n\tСправочник.Валюты КАК Валюты\n\n' +
      'ОБЪЕДИНИТЬ ВСЕ\n\n' +
      'ВЫБРАТЬ\n\tNULL,\n\tКонтрагенты.Наименование,\n\tКонтрагенты.ИНН\nИЗ\n\tСправочник.Контрагенты КАК Контрагенты';
    const doc = parseDocument(text);
    expect(doc.members.length).toBe(2);
    // Участник 1: NULL сохранён на позиции 0 → все 3 поля на месте (NULL, Наименование, ИНН).
    expect(doc.members[1].model.fields.length).toBe(3);
    // Первая ячейка — литерал NULL (выражение).
    expect(doc.members[1].model.fields[0].expression?.trim().toUpperCase()).toBe('NULL');
  });

  it('expression-поле участника i>0 получает alias колонки (ветвь f.expression)', () => {
    const text =
      'ВЫБРАТЬ\n\tВыразить(Валюты.Код КАК Строка) КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты\n\n' +
      'ОБЪЕДИНИТЬ ВСЕ\n\n' +
      'ВЫБРАТЬ\n\tВыразить(Контрагенты.Код КАК Строка)\nИЗ\n\tСправочник.Контрагенты КАК Контрагенты';
    const doc = parseDocument(text);
    expect(doc.members[1].model.fields[0].alias).toBe('Код');
    expect(doc.members[1].model.fields[0].expression).toBeDefined();
  });
});

describe('источник-подзапрос (ИЗ (ВЫБРАТЬ …) КАК …)', () => {
  // Простой подзапрос с одним внутренним ВЫБРАТЬ (эталон Test A из плана 6.11).
  const SIMPLE =
    'ВЫБРАТЬ\n' +
    '\tДанные.Код КАК Код\n' +
    'ИЗ\n' +
    '\t(ВЫБРАТЬ\n' +
    '\t\tВалюты.Код КАК Код\n' +
    '\tИЗ\n' +
    '\t\tСправочник.Валюты КАК Валюты) КАК Данные';

  // Канонический эталон спек §4: подзапрос с ОБЪЕДИНИТЬ ВСЕ + внешние
  // СГРУППИРОВАТЬ ПО / ИМЕЮЩИЕ.
  const REFERENCE =
    'ВЫБРАТЬ\n' +
    '\tДанные.Роль КАК Роль\n' +
    'ИЗ\n' +
    '\t(ВЫБРАТЬ РАЗЛИЧНЫЕ\n' +
    '\t\tРолиПрофилей.Роль КАК Роль,\n' +
    '\t\t-1 КАК ВидИзмененияСтроки\n' +
    '\tИЗ\n' +
    '\t\tСправочник.ПрофилиГруппДоступа.Роли КАК РолиПрофилей\n' +
    '\tГДЕ\n' +
    '\t\tРолиПрофилей.Ссылка = &СтарыйПрофиль\n' +
    '\t\n' +
    '\tОБЪЕДИНИТЬ ВСЕ\n' +
    '\t\n' +
    '\tВЫБРАТЬ РАЗЛИЧНЫЕ\n' +
    '\t\tРолиПрофилей.Роль,\n' +
    '\t\t1\n' +
    '\tИЗ\n' +
    '\t\tСправочник.ПрофилиГруппДоступа.Роли КАК РолиПрофилей\n' +
    '\tГДЕ\n' +
    '\t\tРолиПрофилей.Ссылка = &НовыйПрофиль) КАК Данные\n' +
    '\n' +
    'СГРУППИРОВАТЬ ПО\n' +
    '\tДанные.Роль\n' +
    '\n' +
    'ИМЕЮЩИЕ\n' +
    '\tСУММА(Данные.ВидИзмененияСтроки) <> 0';

  it('round-trip простого подзапроса (один внутренний ВЫБРАТЬ)', () => {
    expect(generate(parseQuery(SIMPLE))).toBe(SIMPLE);
  });

  it('парсит источник-подзапрос как узел модели с subquery и alias', () => {
    const model = parseQuery(SIMPLE);
    expect(model.tables.length).toBe(1);
    expect(model.tables[0].fullName).toBe('');
    expect(model.tables[0].alias).toBe('Данные');
    expect(model.tables[0].subquery?.members.length).toBe(1);
  });

  it('round-trip эталона §4 (ОБЪЕДИНИТЬ ВСЕ + СГРУППИРОВАТЬ/ИМЕЮЩИЕ)', () => {
    expect(generate(parseQuery(REFERENCE))).toBe(REFERENCE);
  });

  it('subquery эталона §4 содержит два участника ОБЪЕДИНИТЬ', () => {
    const model = parseQuery(REFERENCE);
    expect(model.tables[0].subquery?.members.length).toBe(2);
  });

  it('идемпотентность parse∘generate∘parse (эталон §4)', () => {
    const once = generate(parseQuery(REFERENCE));
    expect(generate(parseQuery(once))).toBe(once);
  });

  it('идемпотентность parse∘generate∘parse (простой подзапрос)', () => {
    const once = generate(parseQuery(SIMPLE));
    expect(generate(parseQuery(once))).toBe(once);
  });

  it('подзапрос без КАК → ошибка', () => {
    expect(() =>
      parseQuery('ВЫБРАТЬ Т.Поле ИЗ (ВЫБРАТЬ А.Б ИЗ Спр.В КАК А) Данные')
    ).toThrow();
  });

  it('незакрытый подзапрос → ошибка', () => {
    expect(() =>
      parseQuery('ВЫБРАТЬ Т.Поле ИЗ (ВЫБРАТЬ А.Б ИЗ Спр.В КАК А КАК Данные')
    ).toThrow();
  });
});

describe('классификация условий ГДЕ: параметр справа = стандартное, иначе «Произвольное» (6.14.4)', () => {
  const Q = `ВЫБРАТЬ
\tТ.Ссылка КАК Ссылка
ИЗ
\tСправочник.Валюты КАК Т
ГДЕ
\tТ.ПометкаУдаления = ЛОЖЬ
\tИ Т.Код = &Код
\tИ Т.Код МЕЖДУ &От И &До
\tИ Т.Код МЕЖДУ "а" И "я"
\tИ Т.Код В(&Список)
\tИ Т.Код В ("а", "б")
\tИ Т.Владелец = &Парам.Поле`;

  it('флаги custom расставлены по правилу мышиного редактора', () => {
    const m = parseQuery(Q);
    const flags = (m.conditions ?? []).map(c => c.custom);
    //            =ЛОЖЬ  =&Код  МЕЖДУ&& МЕЖДУ"" В(&)   В(сп)  =&П.Поле
    expect(flags).toEqual([true, false, false, true, false, true, false]);
  });

  it('custom-условие с не-параметром хранит выражение, текст байт-в-байт со стандартным рендером', () => {
    const m = parseQuery(Q);
    const custom = (m.conditions ?? []).filter(c => c.custom);
    expect(custom[0].expression).toBe('Т.ПометкаУдаления = ЛОЖЬ');
    expect(custom[1].expression).toBe('Т.Код МЕЖДУ "а" И "я"');
    expect(custom[2].expression).toBe('Т.Код В ("а", "б")');
    const once = generate(m);
    expect(generate(parseQuery(once))).toBe(once);
  });

  it('условие-подзапрос В (ВЫБРАТЬ …) помечено custom, рендер остаётся структурным', () => {
    const sub = `ВЫБРАТЬ
\tТ.Ссылка КАК Ссылка
ИЗ
\tСправочник.Валюты КАК Т
ГДЕ
\tТ.Ссылка В
\t\t\t(ВЫБРАТЬ
\t\t\t\tВ.Ссылка
\t\t\tИЗ
\t\t\t\tСправочник.Валюты КАК В)`;
    const m = parseQuery(sub);
    expect(m.conditions?.[0].custom).toBe(true);
    expect(m.conditions?.[0].subquery).toBeDefined();
    expect(m.conditions?.[0].expression).toBeUndefined();
    const once = generate(m);
    expect(generate(parseQuery(once))).toBe(once);
  });
});

describe('скан владельцев полей: подзапросы (ВЫБРАТЬ …) не участвуют (6.15.4, правка ревью)', () => {
  it('коллизия псевдонима подзапроса с внешним НЕ квалифицирует голое поле внешнего запроса', () => {
    // Единственное квалифицированное вхождение «Наименование» — внутри подзапроса
    // ГДЕ со СВОИМ псевдонимом Т (контекст подзапроса). Без пропуска зоны
    // (ВЫБРАТЬ …) скан зачислял его ВНЕШНЕЙ таблице Т, и голое «Наименование»
    // выборки ошибочно квалифицировалось как Т.Наименование. Должно остаться голым.
    const q = `ВЫБРАТЬ
\tНаименование
ИЗ
\tСправочник.Валюты КАК Т1
\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.Валюты КАК Т
\t\tПО Т1.Ссылка = Т.Ссылка
ГДЕ
\tТ1.Код В
\t\t\t(ВЫБРАТЬ
\t\t\t\tТ.Наименование
\t\t\tИЗ
\t\t\t\tСправочник.Другой КАК Т)`;
    const m = parseQuery(q);
    // Поле выборки осталось голым выражением (не привязано ни к одной таблице).
    expect(m.fields[0]).toMatchObject({ tableId: '', path: '', expression: 'Наименование' });
    const once = generate(m);
    expect(once).not.toContain('Т.Наименование КАК');
    // Идемпотентность: повторный round-trip не меняет текст.
    expect(generate(parseQuery(once))).toBe(once);
  });
});
