import { describe, it, expect } from 'vitest';
import { generate, generateDocument, generateBatch } from '../../src/core/query/sdblGenerator';
import type { QueryDocument, UnionMember } from '../../src/core/query/unionModel';
import type { BatchDocument } from '../../src/core/query/batchModel';
import type { QueryModel } from '../../src/core/query/queryModel';
import { assertValidSdbl } from '../helpers/assertValidSdbl';

describe('generate', () => {
  it('returns empty string when no tables', () => {
    const model: QueryModel = { tables: [], fields: [] };
    expect(generate(model)).toBe('');
  });

  it('returns empty string when no fields', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [],
    };
    expect(generate(model)).toBe('');
  });

  it('generates a minimal single-table single-field query', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('puts comma after each field except the last', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't1', path: 'Наименование' },
        { tableId: 't1', path: 'ЗагружаетсяИзИнтернета' },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tВалюты.Наименование КАК Наименование,\n\tВалюты.ЗагружаетсяИзИнтернета КАК ЗагружаетсяИзИнтернета\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('generates multi-table FROM separated by comma', () => {
    const model: QueryModel = {
      tables: [
        { id: 't1', fullName: 'Справочник.Валюты' },
        { id: 't2', fullName: 'Документ.Счет' },
      ],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't2', path: 'Дата' },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tСчет.Дата КАК Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Счет КАК Счет'
    );
  });

  it('resolves alias conflict with numeric suffix', () => {
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
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tВалюты1.Дата КАК Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Валюты КАК Валюты1'
    );
  });

  it('uses explicit alias when provided', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты', alias: 'Вал' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВал.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Вал'
    );
  });

  it('supports multi-segment field path', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'ОсновнаяВалюта.Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.ОсновнаяВалюта.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('appends КАК alias when field alias is set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'КодВалюты' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК КодВалюты\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('renders a virtual slice table without parens when no params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: {} }],
      fields: [{ tableId: 't1', path: 'Период' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Период КАК Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК КурсыСрезПоследних'
    );
  });

  it('renders a virtual slice table with period and condition params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс КАК Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК КурсыСрезПоследних'
    );
  });

  it('renders only period when condition empty', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс КАК Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, ) КАК КурсыСрезПоследних'
    );
  });

  it('renders leading comma when only condition set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс КАК Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК КурсыСрезПоследних'
    );
  });

  it('renders an expression field with explicit alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: '', expression: 'ВЫРАЗИТЬ(Валюты.Код КАК ЧИСЛО)', alias: 'КодЧисло' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВЫРАЗИТЬ(Валюты.Код КАК ЧИСЛО) КАК КодЧисло\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('auto-generates aliases Поле1, Поле2 for expression fields without alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: '', expression: 'СУММА(Валюты.Код)' },
        { tableId: 't1', path: '', expression: 'МАКСИМУМ(Валюты.Код)' },
      ],
    };
    const text = generate(model);
    expect(text).toContain('\tСУММА(Валюты.Код) КАК Поле1,');
    expect(text).toContain('\tМАКСИМУМ(Валюты.Код) КАК Поле2\n');
  });

  it('renders accumulation Обороты with positional params (start, end, periodicity, condition)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон', periodicity: 'Авто', condition: 'Измерение1 = &Пар' } }],
      fields: [
        { tableId: 't1', path: 'Измерение1', alias: 'Измерение1' },
        { tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' },
      ],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон, Авто, Измерение1 = &Пар) КАК РегистрНакопленияОст'
    );
  });

  it('renders accumulation Остатки with period and condition', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Остатки', virtual: { period: '&Период', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Остаток', alias: 'Ресурс1Остаток' }],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.Остатки(&Период, Измерение1 = &Пар) КАК РегистрНакопленияОст'
    );
  });

  it('renders accumulation ОстаткиИОбороты with all five positional params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты', virtual: { startPeriod: '&НачалоПериода', endPeriod: '&КонецП', periodicity: 'Авто', fillMethod: 'ДвиженияИГраницыПериода', condition: 'Измерение1 = &Пар' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот', alias: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain(
      'РегистрНакопления.РегистрНакопленияОст.ОстаткиИОбороты(&НачалоПериода, &КонецП, Авто, ДвиженияИГраницыПериода, Измерение1 = &Пар) КАК РегистрНакопленияОст'
    );
  });

  it('keeps fixed arity 4 for Обороты (only start/end period set, trailing empties kept)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон, , ) КАК РегистрНакопленияОст');
  });

  it('keeps empty middle and trailing positions for Обороты (start + periodicity, no end)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', periodicity: 'Месяц' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, , Месяц, ) КАК РегистрНакопленияОст');
  });

  it('uses object name (not concat) as virtual table alias', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Остатки', virtual: { period: '&П' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Остаток' }],
    };
    expect(generate(model)).toContain('КАК РегистрНакопленияОст');
    expect(generate(model)).not.toContain('РегистрНакопленияОстОстатки КАК');
  });

  describe('accounting register virtual table source', () => {
    const mk = (slice: string, virtual: any) => ({
      tables: [{ id: 't1', fullName: `РегистрБухгалтерии.РБ1.${slice}`, virtual }],
      fields: [{ tableId: 't1', path: 'Счет' }],
    } as QueryModel);

    it('Остатки без параметров — без скобок', () => {
      expect(generate(mk('Остатки', {}))).toContain('РегистрБухгалтерии.РБ1.Остатки КАК РБ1');
    });

    it('Остатки с периодом и условием счёта (арность 4)', () => {
      const text = generate(mk('Остатки', { period: '&П', accountCondition: 'Счет = &С' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Остатки(&П, Счет = &С, , ) КАК РБ1');
    });

    it('Обороты corr: периодичность в поз.3, фикс. арность 8, хвост сохранён', () => {
      const text = generate(mk('Обороты', { periodicity: 'Период', correspondence: true }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Обороты(, , Период, , , , , ) КАК РБ1');
    });

    it('Обороты non-corr: арность 6', () => {
      const text = generate(mk('Обороты', { periodicity: 'Авто', correspondence: false }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.Обороты(, , Авто, , , ) КАК РБ1');
    });

    it('ОборотыДтКт: арность 8', () => {
      const text = generate(mk('ОборотыДтКт', { periodicity: 'Период' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ОборотыДтКт(, , Период, , , , , ) КАК РБ1');
    });

    it('ОстаткиИОбороты: арность 7, метод дополнения в поз.4', () => {
      const text = generate(mk('ОстаткиИОбороты', { periodicity: 'Период', fillMethod: 'ДвиженияИГраницыПериода' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ОстаткиИОбороты(, , Период, ДвиженияИГраницыПериода, , , ) КАК РБ1');
    });

    it('ДвиженияССубконто без параметров — без скобок', () => {
      expect(generate(mk('ДвиженияССубконто', {}))).toContain('РегистрБухгалтерии.РБ1.ДвиженияССубконто КАК РБ1');
    });

    it('ДвиженияССубконто с параметром Первые (арность 5)', () => {
      const text = generate(mk('ДвиженияССубконто', { top: '3' }));
      expect(text).toContain('РегистрБухгалтерии.РБ1.ДвиженияССубконто(, , , , 3) КАК РБ1');
    });
  });
});

describe('generate — группировка', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Наценка', alias: 'Наценка' }],
  });

  describe('агрегатные обёртки в ВЫБРАТЬ', () => {
    const cases: Array<[string, string]> = [
      ['Сумма', 'СУММА(Валюты.Наценка) КАК Наценка'],
      ['Количество', 'КОЛИЧЕСТВО(Валюты.Наценка) КАК Наценка'],
      ['КоличествоРазличных', 'КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Валюты.Наценка) КАК Наценка'],
      ['Максимум', 'МАКСИМУМ(Валюты.Наценка) КАК Наценка'],
      ['Минимум', 'МИНИМУМ(Валюты.Наценка) КАК Наценка'],
      ['Среднее', 'СРЕДНЕЕ(Валюты.Наценка) КАК Наценка'],
    ];
    for (const [func, expected] of cases) {
      it(`${func} → ${expected}`, () => {
        const model = base();
        model.grouping = {
          multiple: false,
          groupFields: [],
          groupSets: [],
          aggregates: [{ tableId: 't1', path: 'Наценка', func: func as any }],
        };
        expect(generate(model)).toContain(`\t${expected}`);
      });
    }

    it('суммируемое поле без псевдонима — без КАК', () => {
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
      const text = generate(model);
      expect(text).toContain('\tСУММА(Валюты.Наценка)\n');
      expect(text).not.toContain('СУММА(Валюты.Наценка) КАК');
    });

    it('не оборачивает поля с expression', () => {
      const model: QueryModel = {
        tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
        fields: [{ tableId: 't1', path: '', expression: 'Валюты.Наценка', alias: 'Наценка' }],
        grouping: {
          multiple: false,
          groupFields: [{ tableId: 't1', path: 'Код' }],
          groupSets: [],
          aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
        },
      };
      // expression-поле остаётся как есть, без СУММА(...)
      expect(generate(model)).toContain('\tВалюты.Наценка КАК Наценка');
    });
  });

  describe('одна группировка', () => {
    const model = (): QueryModel => ({
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

    it('добавляет секцию СГРУППИРОВАТЬ ПО после ИЗ', () => {
      const text = generate(model());
      expect(text).toBe(
        'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка,\n' +
        '\tСУММА(Валюты.Наценка) КАК Наценка,\n' +
        '\tВалюты.Код КАК Код\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '\n' +
        'СГРУППИРОВАТЬ ПО\n' +
        '\tВалюты.Ссылка,\n' +
        '\tВалюты.Код'
      );
    });

    it('валидный SDBL', async () => {
      await assertValidSdbl(generate(model()));
    });
  });

  describe('несколько группировок', () => {
    const model = (): QueryModel => ({
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

    it('добавляет секцию ГРУППИРУЮЩИМ НАБОРАМ с 3 наборами', () => {
      const text = generate(model());
      expect(text).toBe(
        'ВЫБРАТЬ\n' +
        '\tВалюты.ОсновнаяВалюта КАК ОсновнаяВалюта,\n' +
        '\tСУММА(Валюты.Наценка) КАК Наценка,\n' +
        '\tВалюты.Код КАК Код,\n' +
        '\tВалюты.Представление КАК Представление\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '\n' +
        'СГРУППИРОВАТЬ ПО ГРУППИРУЮЩИМ НАБОРАМ\n' +
        '(\n' +
        '\t(Валюты.ОсновнаяВалюта,\n' +
        '\t\tВалюты.Ссылка),\n' +
        '\t(Валюты.Код),\n' +
        '\t(Валюты.Представление)\n' +
        ')'
      );
    });

    it('пропускает пустые наборы', () => {
      const m = model();
      m.grouping!.groupSets = [
        [{ tableId: 't1', path: 'Код' }],
        [],
        [{ tableId: 't1', path: 'Представление' }],
      ];
      const text = generate(m);
      expect(text).toContain('(Валюты.Код)');
      expect(text).toContain('(Валюты.Представление)');
      expect(text).not.toContain('()');
    });

    it('валидный SDBL', async () => {
      await assertValidSdbl(generate(model()));
    });
  });

  describe('неактивная группировка не меняет вывод', () => {
    const plain: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    const expected = 'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты';

    it('grouping undefined → как раньше', () => {
      expect(generate(plain)).toBe(expected);
    });

    it('single без полей группировки → как раньше', () => {
      const model: QueryModel = {
        ...plain,
        grouping: { multiple: false, groupFields: [], groupSets: [], aggregates: [] },
      };
      expect(generate(model)).toBe(expected);
    });

    it('multiple без непустых наборов → как раньше', () => {
      const model: QueryModel = {
        ...plain,
        grouping: { multiple: true, groupFields: [], groupSets: [[]], aggregates: [] },
      };
      expect(generate(model)).toBe(expected);
    });
  });
});

describe('generate — условия (ГДЕ)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [
      { tableId: 't1', path: 'Код', alias: 'Код' },
      { tableId: 't1', path: 'Наименование', alias: 'Наименование' },
    ],
  });

  it('одно простое условие → оператор и параметр по умолчанию', () => {
    const model = base();
    model.conditions = [{ custom: false, tableId: 't1', path: 'Код' }];
    const text = generate(model);
    expect(text).toContain('ГДЕ\n\tВалюты.Код = &Код');
  });

  it('два простых условия → соединены через И (эталон)', () => {
    const model = base();
    model.conditions = [
      { custom: false, tableId: 't1', path: 'Код' },
      { custom: false, tableId: 't1', path: 'Наименование' },
    ];
    const text = generate(model);
    expect(text).toContain(
      'ГДЕ\n' +
      '\tВалюты.Код = &Код\n' +
      '\tИ Валюты.Наименование = &Наименование'
    );
  });

  it('нестандартный оператор и явный параметр', () => {
    const model = base();
    model.conditions = [
      { custom: false, tableId: 't1', path: 'Код', operator: '>=', param: '&МинКод' },
    ];
    expect(generate(model)).toContain('ГДЕ\n\tВалюты.Код >= &МинКод');
  });

  it('произвольное условие-членство с одиночным параметром печатается без пробела (как конструктор 1С)', () => {
    // Оракул (MCP validate_query) у одиночного ПАРАМЕТРА `В(&П)` пробел НЕ ставит даже в
    // произвольном листе-условии ГДЕ верхнего уровня (см. tightenLeafInOperator); для
    // значения/выражения (`В (ЗНАЧЕНИЕ(…))`) пробел сохраняется.
    const model = base();
    model.conditions = [{ custom: true, expression: 'Валюты.Код В (&Список)' }];
    expect(generate(model)).toContain('ГДЕ\n\tВалюты.Код В(&Список)');
  });

  it('оператор В без пробела перед списком значений (как конструктор 1С)', () => {
    const model = base();
    model.conditions = [{ custom: false, tableId: 't1', path: 'Код', operator: 'В', param: '(&Список)' }];
    expect(generate(model)).toContain('ГДЕ\n\tВалюты.Код В(&Список)');
  });

  it('оператор В ИЕРАРХИИ без пробела перед скобкой', () => {
    const model = base();
    model.conditions = [{ custom: false, tableId: 't1', path: 'Код', operator: 'В', param: 'ИЕРАРХИИ (&Род)' }];
    expect(generate(model)).toContain('ГДЕ\n\tВалюты.Код В ИЕРАРХИИ(&Род)');
  });

  it('пустое произвольное условие и условие без path пропускаются', () => {
    const model = base();
    model.conditions = [
      { custom: true, expression: '   ' },
      { custom: false, tableId: 't1' },
    ];
    const text = generate(model);
    expect(text).not.toContain('ГДЕ');
  });

  it('секция ИМЕЮЩИЕ: пустая строка-разделитель, после группировки', () => {
    const model = base();
    model.grouping = { multiple: false, groupFields: [{ tableId: 't1', path: 'Код' }], groupSets: [], aggregates: [] };
    model.having = [{ custom: true, expression: 'КОЛИЧЕСТВО(Валюты.Ссылка) = 0' }];
    const text = generate(model);
    // Согласование СГРУППИРОВАТЬ ПО с выборкой (фаза 6.16.62): НЕагрегатное поле выборки
    // `Наименование`, которого нет в группировке, дописывается (как делает конструктор 1С).
    expect(text).toContain(
      '\nСГРУППИРОВАТЬ ПО\n\tВалюты.Код,\n\tВалюты.Наименование\n\nИМЕЮЩИЕ\n\tКОЛИЧЕСТВО(Валюты.Ссылка) = 0'
    );
  });

  it('lastSegment берётся из последнего сегмента пути', () => {
    const model = base();
    model.conditions = [{ custom: false, tableId: 't1', path: 'Владелец.Код' }];
    expect(generate(model)).toContain('\tВалюты.Владелец.Код = &Код');
  });

  it('псевдоним берётся из tableId, если не разрешён', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код', alias: 'Код' }],
      conditions: [{ custom: false, tableId: 'unknown', path: 'Код' }],
    };
    expect(generate(model)).toContain('\tunknown.Код = &Код');
  });

  it('ГДЕ располагается после ИЗ и до СГРУППИРОВАТЬ ПО', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код', alias: 'Код' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      conditions: [{ custom: false, tableId: 't1', path: 'Код' }],
      grouping: {
        multiple: false,
        groupFields: [{ tableId: 't1', path: 'Код' }],
        groupSets: [],
        aggregates: [{ tableId: 't1', path: 'Наценка', func: 'Сумма' }],
      },
    };
    const text = generate(model);
    const iz = text.indexOf('ИЗ');
    const where = text.indexOf('ГДЕ');
    const group = text.indexOf('СГРУППИРОВАТЬ ПО');
    expect(iz).toBeGreaterThanOrEqual(0);
    expect(where).toBeGreaterThan(iz);
    expect(group).toBeGreaterThan(where);
  });

  describe('пустые условия не меняют вывод', () => {
    const plain: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    const expected = 'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты';

    it('conditions undefined → как раньше', () => {
      expect(generate(plain)).toBe(expected);
    });

    it('conditions [] → как раньше', () => {
      expect(generate({ ...plain, conditions: [] })).toBe(expected);
    });

    it('только нерендерящиеся условия → как раньше', () => {
      expect(
        generate({ ...plain, conditions: [{ custom: true, expression: '' }, { custom: false }] })
      ).toBe(expected);
    });
  });

  it('валидный SDBL', async () => {
    const model = base();
    model.conditions = [
      { custom: false, tableId: 't1', path: 'Код' },
      { custom: false, tableId: 't1', path: 'Наименование' },
    ];
    await assertValidSdbl(generate(model));
  });
});

describe('generate — дополнительно (фаза 5.3)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const expectedPlain =
    'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';

  describe('ВЫБРАТЬ модификаторы', () => {
    it('ПЕРВЫЕ N', () => {
      expect(generate({ ...base(), selection: { top: 2 } })).toBe(
        'ВЫБРАТЬ ПЕРВЫЕ 2\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('РАЗЛИЧНЫЕ', () => {
      expect(generate({ ...base(), selection: { distinct: true } })).toBe(
        'ВЫБРАТЬ РАЗЛИЧНЫЕ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('РАЗРЕШЕННЫЕ', () => {
      expect(generate({ ...base(), selection: { allowed: true } })).toBe(
        'ВЫБРАТЬ РАЗРЕШЕННЫЕ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('комбинация в порядке РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ ПЕРВЫЕ', () => {
      expect(
        generate({ ...base(), selection: { allowed: true, distinct: true, top: 2 } })
      ).toBe(
        'ВЫБРАТЬ РАЗРЕШЕННЫЕ РАЗЛИЧНЫЕ ПЕРВЫЕ 2\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('top = 0 печатает ПЕРВЫЕ 0 (конструктор сохраняет нулевой лимит, MCP 6.15.11b)', () => {
      expect(generate({ ...base(), selection: { top: 0 } })).toBe(
        'ВЫБРАТЬ ПЕРВЫЕ 0\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('отрицательный top не добавляет ПЕРВЫЕ', () => {
      expect(generate({ ...base(), selection: { top: -1 } })).toBe(expectedPlain);
    });

    it('пустой selection → как раньше', () => {
      expect(generate({ ...base(), selection: {} })).toBe(expectedPlain);
    });
  });

  describe('ПОМЕСТИТЬ / ДОБАВИТЬ', () => {
    it('ПОМЕСТИТЬ перед ИЗ', () => {
      expect(
        generate({ ...base(), queryType: 'createTemp', tempTableName: 'ВремТаб' })
      ).toBe(
        'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nПОМЕСТИТЬ ВремТаб\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('ДОБАВИТЬ перед ИЗ', () => {
      expect(
        generate({ ...base(), queryType: 'appendTemp', tempTableName: 'ВремТаб' })
      ).toBe(
        'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nДОБАВИТЬ ВремТаб\nИЗ\n\tСправочник.Валюты КАК Валюты'
      );
    });

    it('createTemp без имени → как раньше', () => {
      expect(generate({ ...base(), queryType: 'createTemp' })).toBe(expectedPlain);
      expect(generate({ ...base(), queryType: 'createTemp', tempTableName: '' })).toBe(
        expectedPlain
      );
    });

    it('валидный SDBL с ПОМЕСТИТЬ', async () => {
      await assertValidSdbl(
        generate({ ...base(), queryType: 'createTemp', tempTableName: 'ВремТаб' })
      );
    });
  });

  describe('УНИЧТОЖИТЬ', () => {
    it('УНИЧТОЖИТЬ как единственная строка', () => {
      expect(
        generate({ ...base(), queryType: 'dropTemp', tempTableName: 'ВремТаб' })
      ).toBe('УНИЧТОЖИТЬ ВремТаб');
    });

    it('dropTemp без имени → пустая строка', () => {
      expect(generate({ ...base(), queryType: 'dropTemp' })).toBe('');
    });

    it('dropTemp игнорирует отсутствие таблиц/полей', () => {
      expect(
        generate({ tables: [], fields: [], queryType: 'dropTemp', tempTableName: 'ВремТаб' })
      ).toBe('УНИЧТОЖИТЬ ВремТаб');
    });
  });

  describe('ДЛЯ ИЗМЕНЕНИЯ', () => {
    it('одна таблица с пустой строкой-разделителем (эталон)', () => {
      expect(
        generate({ ...base(), lockForUpdate: ['Справочник.Валюты'] })
      ).toBe(
        'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты\n\nДЛЯ ИЗМЕНЕНИЯ\n\tСправочник.Валюты'
      );
    });

    it('две таблицы', () => {
      expect(
        generate({ ...base(), lockForUpdate: ['Справочник.Валюты', 'Справочник.Контрагенты'] })
      ).toBe(
        'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты\n\nДЛЯ ИЗМЕНЕНИЯ\n\tСправочник.Валюты\n\tСправочник.Контрагенты'
      );
    });

    it('пустой lockForUpdate → как раньше', () => {
      expect(generate({ ...base(), lockForUpdate: [] })).toBe(expectedPlain);
    });

    it('валидный SDBL с ДЛЯ ИЗМЕНЕНИЯ', async () => {
      await assertValidSdbl(generate({ ...base(), lockForUpdate: ['Справочник.Валюты'] }));
    });
  });

  describe('комбинации и порядок секций', () => {
    it('модификаторы + ГДЕ + СГРУППИРОВАТЬ ПО + ДЛЯ ИЗМЕНЕНИЯ в правильном порядке', () => {
      const model: QueryModel = {
        tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
        fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
        selection: { distinct: true },
        conditions: [{ custom: false, tableId: 't1', path: 'Код' }],
        grouping: { multiple: false, groupFields: [{ tableId: 't1', path: 'Ссылка' }], groupSets: [], aggregates: [] },
        lockForUpdate: ['Справочник.Валюты'],
      };
      expect(generate(model)).toBe(
        [
          'ВЫБРАТЬ РАЗЛИЧНЫЕ',
          '\tВалюты.Ссылка КАК Ссылка',
          'ИЗ',
          '\tСправочник.Валюты КАК Валюты',
          'ГДЕ',
          '\tВалюты.Код = &Код',
          '',
          'СГРУППИРОВАТЬ ПО',
          '\tВалюты.Ссылка',
          '',
          'ДЛЯ ИЗМЕНЕНИЯ',
          '\tСправочник.Валюты',
        ].join('\n')
      );
    });

    it('новые поля undefined → байт-в-байт как раньше', () => {
      expect(generate(base())).toBe(expectedPlain);
    });
  });

  describe('generateDocument (объединения)', () => {
    // Участник 0: Справочник.Валюты с полями Ссылка, Код и ДЛЯ ИЗМЕНЕНИЯ.
    const valuteMember = () => ({
      name: 'Запрос 1',
      distinct: false,
      model: {
        tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
        fields: [
          { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
          { tableId: 't1', path: 'Код', alias: 'Код' },
        ],
        lockForUpdate: ['Справочник.Валюты'],
      } as QueryModel,
    });

    // Участник 1: Справочник.ВариантыОтветовАнкет с полями Ссылка, Наименование.
    const variantMember = (distinct = false) => ({
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

    it('пустой документ → пустая строка', () => {
      expect(generateDocument({ members: [] })).toBe('');
    });

    it('один участник → идентично generate(model)', () => {
      const doc: QueryDocument = { members: [valuteMember()] };
      expect(generateDocument(doc)).toBe(generate(valuteMember().model));
    });

    it('два участника воспроизводят эталон tmp/объединения.md', async () => {
      // Позиционное выравнивание (6.15.22): 2 столбца, заголовки — от участника 0
      // (Ссылка, Код); вторая колонка совмещает «Код» и «Наименование» по позиции.
      const doc: QueryDocument = { members: [valuteMember(), variantMember()] };
      const expected = [
        'ВЫБРАТЬ',
        '\tВалюты.Ссылка КАК Ссылка,',
        '\tВалюты.Код КАК Код',
        'ИЗ',
        '\tСправочник.Валюты КАК Валюты',
        '',
        'ДЛЯ ИЗМЕНЕНИЯ',
        '\tСправочник.Валюты',
        '',
        'ОБЪЕДИНИТЬ ВСЕ',
        '',
        'ВЫБРАТЬ',
        '\tВариантыОтветовАнкет.Ссылка,',
        '\tВариантыОтветовАнкет.Наименование',
        'ИЗ',
        '\tСправочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет',
      ].join('\n');
      expect(generateDocument(doc)).toBe(expected);
      await assertValidSdbl(generateDocument(doc));
    });

    it('distinct=true у участника → ОБЪЕДИНИТЬ (без ВСЕ)', () => {
      const doc: QueryDocument = { members: [valuteMember(), variantMember(true)] };
      const text = generateDocument(doc);
      expect(text).toContain('\n\nОБЪЕДИНИТЬ\n\n');
      expect(text).not.toContain('ОБЪЕДИНИТЬ ВСЕ');
    });

    it('заголовок колонки берётся из участника 0; КАК печатается только у него (6.15.22)', async () => {
      // Позиционная модель: псевдоним столбца — от участника 0; участник 1 печатает
      // выражения как есть, без КАК, независимо от своих псевдонимов.
      const m0 = valuteMember();
      m0.model.fields[0].alias = 'Труляля';
      const m1 = variantMember();
      m1.model.fields[0].alias = 'Труляля';
      const doc: QueryDocument = { members: [m0, m1] };
      const expected = [
        'ВЫБРАТЬ',
        '\tВалюты.Ссылка КАК Труляля,',
        '\tВалюты.Код КАК Код',
        'ИЗ',
        '\tСправочник.Валюты КАК Валюты',
        '',
        'ДЛЯ ИЗМЕНЕНИЯ',
        '\tСправочник.Валюты',
        '',
        'ОБЪЕДИНИТЬ ВСЕ',
        '',
        'ВЫБРАТЬ',
        '\tВариантыОтветовАнкет.Ссылка,',
        '\tВариантыОтветовАнкет.Наименование',
        'ИЗ',
        '\tСправочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет',
      ].join('\n');
      expect(generateDocument(doc)).toBe(expected);
      await assertValidSdbl(generateDocument(doc));
    });
  });
});

describe('generate — связи (joins)', () => {
  const twoTables = (): QueryModel => ({
    tables: [
      { id: 't1', fullName: 'Справочник.Валюты' },
      { id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' },
    ],
    fields: [
      { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
      { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
    ],
  });

  const head =
    'ВЫБРАТЬ\n' +
    '\tВалюты.Ссылка КАК Ссылка,\n' +
    '\tВалюты.Наценка КАК Наценка\n' +
    'ИЗ\n';

  it('нет связей → список таблиц через запятую (как раньше)', async () => {
    const model = twoTables();
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты,\n' +
      '\tСправочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет'
    );
    await assertValidSdbl(generate(model));
  });

  it('внутреннее соединение (leftAll=false, rightAll=false)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: false, rightAll: false, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
    };
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО Валюты.Ссылка = ВариантыОтветовАнкет.ИмяПредопределенныхДанных'
    );
    await assertValidSdbl(generate(model));
  });

  it('левое соединение (leftAll=true, rightAll=false)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: true, rightAll: false, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
    };
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tЛЕВОЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО Валюты.Ссылка = ВариантыОтветовАнкет.ИмяПредопределенныхДанных'
    );
    await assertValidSdbl(generate(model));
  });

  it('полное соединение (leftAll=true, rightAll=true)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: true, rightAll: true, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
    };
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tПОЛНОЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО Валюты.Ссылка = ВариантыОтветовАнкет.ИмяПредопределенныхДанных'
    );
    await assertValidSdbl(generate(model));
  });

  it('правое соединение сохраняется без перестановки таблиц (leftAll=false, rightAll=true)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: false, rightAll: true, custom: false,
        leftPath: 'Ссылка', operator: '=', rightPath: 'ИмяПредопределенныхДанных',
      }],
    };
    // Конструктор 1С сохраняет ПРАВОЕ СОЕДИНЕНИЕ как есть: затравка = Валюты,
    // присоединяемая = ВариантыОтветовАнкет, условие ПО не меняется.
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tПРАВОЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО Валюты.Ссылка = ВариантыОтветовАнкет.ИмяПредопределенныхДанных'
    );
    await assertValidSdbl(generate(model));
  });

  it('одиночное произвольное условие связи оборачивается в скобки (как конструктор 1С)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: false, rightAll: true, custom: true,
        expression: 'Валюты.Ссылка = &Труляля',
      }],
    };
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tПРАВОЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО (Валюты.Ссылка = &Труляля)'
    );
    await assertValidSdbl(generate(model));
  });

  it('составное произвольное условие связи — переотрисовка форматером (фаза 6.10)', async () => {
    const model: QueryModel = {
      ...twoTables(),
      joins: [{
        leftTableId: 't1', rightTableId: 't2',
        leftAll: false, rightAll: false, custom: true,
        expression: '(Валюты.Ссылка = &Влад) И (ВариантыОтветовАнкет.ПометкаУдаления = ЛОЖЬ)',
      }],
    };
    // Конструктор 1С трактует условие как И-цепочку конъюнктов: первый — на строке
    // ПО (скобки из исходника сохраняются), каждый следующий — `И (…)` на отступе 3.
    expect(generate(model)).toContain(
      '\t\tПО (Валюты.Ссылка = &Влад)\n' +
      '\t\t\tИ (ВариантыОтветовАнкет.ПометкаУдаления = ЛОЖЬ)'
    );
  });

  it('таблица без связи дописывается после цепочки через запятую', async () => {
    const model: QueryModel = {
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
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
      '\tВалюты.Ссылка КАК Ссылка\n' +
      'ИЗ\n' +
      '\tСправочник.Валюты КАК Валюты\n' +
      '\t\tВНУТРЕННЕЕ СОЕДИНЕНИЕ Справочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет\n' +
      '\t\tПО Валюты.Ссылка = ВариантыОтветовАнкет.ИмяПредопределенныхДанных,\n' +
      '\tДокумент.Счет КАК Счет'
    );
    await assertValidSdbl(generate(model));
  });

  it('пустые связи → вывод как без связей', () => {
    const model: QueryModel = { ...twoTables(), joins: [] };
    expect(generate(model)).toBe(
      head +
      '\tСправочник.Валюты КАК Валюты,\n' +
      '\tСправочник.ВариантыОтветовАнкет КАК ВариантыОтветовАнкет'
    );
  });
});

describe('generate — порядок (УПОРЯДОЧИТЬ ПО, фаза 5.6)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const head =
    'ВЫБРАТЬ\n' +
    '\tВалюты.Ссылка КАК Ссылка\n' +
    'ИЗ\n' +
    '\tСправочник.Валюты КАК Валюты';

  it('возрастание: поле по псевдониму выборки без суффикса', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'asc' }], auto: false },
    };
    expect(generate(model)).toBe(head + '\n\nУПОРЯДОЧИТЬ ПО\n\tСсылка');
    await assertValidSdbl(generate(model));
  });

  it('убывание: суффикс УБЫВ', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'desc' }], auto: false },
    };
    expect(generate(model)).toBe(head + '\n\nУПОРЯДОЧИТЬ ПО\n\tСсылка УБЫВ');
    await assertValidSdbl(generate(model));
  });

  it('авто + поле: строка АВТОУПОРЯДОЧИВАНИЕ после полей', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'desc' }], auto: true },
    };
    expect(generate(model)).toBe(head + '\n\nУПОРЯДОЧИТЬ ПО\n\tСсылка УБЫВ\nАВТОУПОРЯДОЧИВАНИЕ');
    await assertValidSdbl(generate(model));
  });

  it('только авто без полей: секция = только АВТОУПОРЯДОЧИВАНИЕ', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [], auto: true },
    };
    // Бесхозное АВТОУПОРЯДОЧИВАНИЕ (без секции порядок/ИТОГИ/индекс) отбивается ОДНИМ
    // `\n` от тела — сверено живым оракулом 1С на корпусе (фаза 6.16.46), без пустой строки.
    expect(generate(model)).toBe(head + '\nАВТОУПОРЯДОЧИВАНИЕ');
    await assertValidSdbl(generate(model));
  });

  it('несколько полей: запятая после всех, кроме последнего', async () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код', alias: 'Код' },
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
      ],
      order: {
        fields: [
          { tableId: 't1', path: 'Код', direction: 'asc' },
          { tableId: 't1', path: 'Ссылка', direction: 'desc' },
        ],
        auto: false,
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код,\n\tВалюты.Ссылка КАК Ссылка\n' +
      'ИЗ\n\tСправочник.Валюты КАК Валюты\n\n' +
      'УПОРЯДОЧИТЬ ПО\n\tКод,\n\tСсылка УБЫВ'
    );
    await assertValidSdbl(generate(model));
  });

  it('поле не из выборки печатается квалифицированно (конструктор 1С, фаза 6.15.4)', async () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      order: { fields: [{ tableId: 't1', path: 'Владелец.Код', direction: 'asc' }], auto: false },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты\n\n' +
      'УПОРЯДОЧИТЬ ПО\n\tВалюты.Владелец.Код'
    );
  });

  it('неактивный order (пустой, без авто) не меняет вывод', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [], auto: false },
    };
    expect(generate(model)).toBe(head);
    await assertValidSdbl(generate(model));
  });

  it('отсутствие order не меняет вывод', () => {
    expect(generate(base())).toBe(head);
  });
});

describe('generate — итоги (ИТОГИ … ПО …, фаза 5.7)', () => {
  const base = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Тест' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const head =
    'ВЫБРАТЬ\n' +
    '\tТест.Ссылка КАК Ссылка\n' +
    'ИЗ\n' +
    '\tСправочник.Тест КАК Тест';

  it('тип итогов «Элементы»: поле по псевдониму выборки без суффикса', async () => {
    const model: QueryModel = {
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    };
    expect(generate(model)).toBe(head + '\nИТОГИ ПО\n\tСсылка КАК Ссылка11');
    await assertValidSdbl(generate(model));
  });

  it('тип итогов «Элементы и иерархия»: суффикс ИЕРАРХИЯ', async () => {
    const model: QueryModel = {
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'hierarchy', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    };
    expect(generate(model)).toBe(head + '\nИТОГИ ПО\n\tСсылка ИЕРАРХИЯ КАК Ссылка11');
    await assertValidSdbl(generate(model));
  });

  it('тип итогов «Только иерархия»: суффикс ТОЛЬКО ИЕРАРХИЯ', async () => {
    const model: QueryModel = {
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'onlyHierarchy', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    };
    expect(generate(model)).toBe(head + '\nИТОГИ ПО\n\tСсылка ТОЛЬКО ИЕРАРХИЯ КАК Ссылка11');
    await assertValidSdbl(generate(model));
  });

  it('группировочное поле без псевдонима: без части КАК', async () => {
    const model: QueryModel = {
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements' }],
        totalFields: [],
        grand: false,
      },
    };
    expect(generate(model)).toBe(head + '\nИТОГИ ПО\n\tСсылка');
    await assertValidSdbl(generate(model));
  });

  it('итоговое поле СУММА(...): формат ИТОГИ … ПО …', async () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements' }],
        totalFields: [{ tableId: 't1', path: 'Наценка', expression: 'СУММА(Наценка)' }],
        grand: false,
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка,\n\tВалюты.Наценка КАК Наценка\n' +
      'ИЗ\n\tСправочник.Валюты КАК Валюты\n' +
      'ИТОГИ\n\tСУММА(Наценка)\nПО\n\tСсылка'
    );
    await assertValidSdbl(generate(model));
  });

  it('итоговое поле без expression: дефолт СУММА(<псевдоним>)', async () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Наценка', alias: 'Наценка' },
      ],
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements' }],
        totalFields: [{ tableId: 't1', path: 'Наценка' }],
        grand: false,
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка,\n\tВалюты.Наценка КАК Наценка\n' +
      'ИЗ\n\tСправочник.Валюты КАК Валюты\n' +
      'ИТОГИ\n\tСУММА(Наценка)\nПО\n\tСсылка'
    );
    await assertValidSdbl(generate(model));
  });

  it('«Общие итоги»: ОБЩИЕ первым элементом списка ПО', async () => {
    const model: QueryModel = {
      ...base(),
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'onlyHierarchy', alias: 'Ссылка11' }],
        totalFields: [],
        grand: true,
      },
    };
    expect(generate(model)).toBe(
      head + '\nИТОГИ ПО\n\tОБЩИЕ,\n\tСсылка ТОЛЬКО ИЕРАРХИЯ КАК Ссылка11'
    );
    await assertValidSdbl(generate(model));
  });

  it('только «Общие итоги» без группировочных полей: ИТОГИ ПО ОБЩИЕ', async () => {
    const model: QueryModel = {
      ...base(),
      totals: { groupFields: [], totalFields: [], grand: true },
    };
    expect(generate(model)).toBe(head + '\nИТОГИ ПО\n\tОБЩИЕ');
    await assertValidSdbl(generate(model));
  });

  it('неактивные итоги (пусто, без grand) не меняют вывод', async () => {
    const model: QueryModel = {
      ...base(),
      totals: { groupFields: [], totalFields: [], grand: false },
    };
    expect(generate(model)).toBe(head);
    await assertValidSdbl(generate(model));
  });

  it('отсутствие totals не меняет вывод', () => {
    expect(generate(base())).toBe(head);
  });

  it('порядок + итоги вместе: УПОРЯДОЧИТЬ ПО, затем ИТОГИ ПО', async () => {
    const model: QueryModel = {
      ...base(),
      order: { fields: [{ tableId: 't1', path: 'Ссылка', direction: 'asc' }], auto: false },
      totals: {
        groupFields: [{ tableId: 't1', path: 'Ссылка', kind: 'elements', alias: 'Ссылка11' }],
        totalFields: [],
        grand: false,
      },
    };
    expect(generate(model)).toBe(
      head + '\n\nУПОРЯДОЧИТЬ ПО\n\tСсылка\nИТОГИ ПО\n\tСсылка КАК Ссылка11'
    );
    await assertValidSdbl(generate(model));
  });
});

describe('generateBatch', () => {
  // Разделитель пакета 1С: строка с `;`, пустая строка, ровно 80 символов `/`, перевод строки.
  const SEP = '\n;\n\n' + '/'.repeat(80) + '\n';

  const docOf = (model: QueryModel): QueryDocument => ({
    members: [{ name: 'Запрос пакета 1', distinct: false, model }],
  });

  const valuesRef = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  const anketaModel = (): QueryModel => ({
    tables: [{ id: 't2', fullName: 'Документ.Анкета' }],
    fields: [{ tableId: 't2', path: 'ВерсияДанных', alias: 'ВерсияДанных' }],
  });

  it('0 участников → пустая строка', () => {
    const batch: BatchDocument = { members: [] };
    expect(generateBatch(batch)).toBe('');
  });

  it('один участник = generateDocument байт-в-байт (без `;` и разделителя)', () => {
    const doc = docOf(valuesRef());
    const batch: BatchDocument = { members: [doc] };
    expect(generateBatch(batch)).toBe(generateDocument(doc));
    expect(generateBatch(batch)).toBe(
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'
    );
  });

  it('разделитель содержит ровно 80 символов `/`', () => {
    expect(SEP).toBe('\n;\n\n' + '////////////////////////////////////////////////////////////////////////////////' + '\n');
    const slashes = SEP.replace(/[^/]/g, '');
    expect(slashes.length).toBe(80);
  });

  it('два участника соединяются разделителем пакета', async () => {
    const batch: BatchDocument = {
      members: [docOf(valuesRef()), docOf(anketaModel())],
    };
    const expected =
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты' +
      SEP +
      'ВЫБРАТЬ\n\tАнкета.ВерсияДанных КАК ВерсияДанных\nИЗ\n\tДокумент.Анкета КАК Анкета';
    expect(generateBatch(batch)).toBe(expected);
    for (const block of generateBatch(batch).split(SEP)) {
      await assertValidSdbl(block);
    }
  });

  it('три участника: ПОМЕСТИТЬ, обычный и УНИЧТОЖИТЬ как самостоятельные блоки', async () => {
    const createModel: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
      queryType: 'createTemp',
      tempTableName: 'аааббб',
    };
    const dropModel: QueryModel = {
      tables: [],
      fields: [],
      queryType: 'dropTemp',
      tempTableName: 'аааббб',
    };
    const batch: BatchDocument = {
      members: [docOf(createModel), docOf(anketaModel()), docOf(dropModel)],
    };
    const expected =
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nПОМЕСТИТЬ аааббб\nИЗ\n\tСправочник.Валюты КАК Валюты' +
      SEP +
      'ВЫБРАТЬ\n\tАнкета.ВерсияДанных КАК ВерсияДанных\nИЗ\n\tДокумент.Анкета КАК Анкета' +
      SEP +
      'УНИЧТОЖИТЬ аааббб';
    expect(generateBatch(batch)).toBe(expected);
    for (const block of generateBatch(batch).split(SEP)) {
      await assertValidSdbl(block);
    }
  });

  it('пустые участники отбрасываются при соединении', () => {
    const emptyDoc: QueryDocument = {
      members: [{ name: 'Пустой', distinct: false, model: { tables: [], fields: [] } }],
    };
    const batch: BatchDocument = {
      members: [docOf(valuesRef()), emptyDoc, docOf(anketaModel())],
    };
    const expected =
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты' +
      SEP +
      'ВЫБРАТЬ\n\tАнкета.ВерсияДанных КАК ВерсияДанных\nИЗ\n\tДокумент.Анкета КАК Анкета';
    expect(generateBatch(batch)).toBe(expected);
  });
});

describe('Построитель: блоки {…}', () => {
  // Базовая модель: ВЫБРАТЬ Валюты.Ссылка КАК Ссылка ИЗ Справочник.Валюты КАК Валюты.
  const baseModel = (): QueryModel => ({
    tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
    fields: [{ tableId: 't1', path: 'Ссылка', alias: 'Ссылка' }],
  });

  it('пустой/отсутствующий builder не меняет вывод (регрессия)', () => {
    const expected =
      'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';
    expect(generate(baseModel())).toBe(expected);

    const withEmpty: QueryModel = {
      ...baseModel(),
      builder: { fields: [], conditions: [], order: [], totals: [] },
    };
    expect(generate(withEmpty)).toBe(expected);
  });

  it('{ВЫБРАТЬ …} после полей выборки, перед ИЗ', () => {
    const model: QueryModel = {
      ...baseModel(),
      builder: {
        fields: [
          { ref: 'Ресурс1Оборот', child: false, alias: 'труляля' },
          { ref: 'Валюты.Ссылка', child: true },
        ],
        conditions: [],
        order: [],
        totals: [],
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка\n' +
        '{ВЫБРАТЬ\n' +
        '\tРесурс1Оборот КАК труляля,\n' +
        '\tВалюты.Ссылка.*}\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты'
    );
  });

  it('{ГДЕ …} после секции ИЗ', () => {
    const model: QueryModel = {
      ...baseModel(),
      builder: {
        fields: [],
        conditions: [
          { ref: 'Валюты.Ссылка', child: true },
          { ref: 'РегистрНакопленияОборОбороты.Измерение1', child: false },
        ],
        order: [],
        totals: [],
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '{ГДЕ\n' +
        '\tВалюты.Ссылка.*,\n' +
        '\tРегистрНакопленияОборОбороты.Измерение1}'
    );
  });

  it('{УПОРЯДОЧИТЬ ПО …} после ИЗ/группировки', () => {
    const model: QueryModel = {
      ...baseModel(),
      builder: {
        fields: [],
        conditions: [],
        order: [
          { ref: 'Ссылка', child: true },
          { ref: 'Измерение1', child: false, alias: 'Измерение1ааа' },
        ],
        totals: [],
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '{УПОРЯДОЧИТЬ ПО\n' +
        '\tСсылка.*,\n' +
        '\tИзмерение1 КАК Измерение1ааа}'
    );
  });

  it('{ИТОГИ ПО …} после {УПОРЯДОЧИТЬ ПО}', () => {
    const model: QueryModel = {
      ...baseModel(),
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
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '{ИТОГИ ПО\n' +
        '\tИзмерение1,\n' +
        '\tРесурс1Оборот,\n' +
        '\tСсылка.* КАК а11}'
    );
  });

  it('поле с child и alias рендерится как Ссылка.* КАК а11', () => {
    const model: QueryModel = {
      ...baseModel(),
      builder: {
        fields: [{ ref: 'Ссылка', child: true, alias: 'а11' }],
        conditions: [],
        order: [],
        totals: [],
      },
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка\n' +
        '{ВЫБРАТЬ\n' +
        '\tСсылка.* КАК а11}\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты'
    );
  });
});

describe('ИНДЕКСИРОВАТЬ (фаза 5.10)', () => {
  // Пять полей выборки временной таблицы Справочник.Валюты.
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

  const head =
    'ВЫБРАТЬ\n' +
    '\tВалюты.Ссылка КАК Ссылка,\n' +
    '\tВалюты.ВерсияДанных КАК ВерсияДанных,\n' +
    '\tВалюты.ПометкаУдаления КАК ПометкаУдаления,\n' +
    '\tВалюты.Наименование КАК Наименование,\n' +
    '\tВалюты.НаименованиеПолное КАК НаименованиеПолное\n' +
    'ПОМЕСТИТЬ ааа\n' +
    'ИЗ\n' +
    '\tСправочник.Валюты КАК Валюты';

  it('один индекс → ИНДЕКСИРОВАТЬ ПО без выражения уникальности', () => {
    const model: QueryModel = {
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
    };
    expect(generate(model)).toBe(
      head + '\n\nИНДЕКСИРОВАТЬ ПО\n\tСсылка,\n\tНаименование'
    );
  });

  it('два индекса → ИНДЕКСИРОВАТЬ ПО НАБОРАМ с УНИКАЛЬНО (эталон)', () => {
    const model: QueryModel = {
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
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Ссылка КАК Ссылка,\n' +
        '\tВалюты.ВерсияДанных КАК ВерсияДанных,\n' +
        '\tВалюты.ПометкаУдаления КАК ПометкаУдаления,\n' +
        '\tВалюты.Наименование КАК Наименование,\n' +
        '\tВалюты.НаименованиеПолное КАК НаименованиеПолное\n' +
        'ПОМЕСТИТЬ ааа\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты\n' +
        '\n' +
        'ИНДЕКСИРОВАТЬ ПО НАБОРАМ\n' +
        '(\n' +
        '\t(Ссылка),\n' +
        '\t(ПометкаУдаления,\n' +
        '\tНаименование) УНИКАЛЬНО\n' +
        ')'
    );
  });

  it('пустые индексы (fields: []) пропускаются', () => {
    const model: QueryModel = {
      ...fiveFieldModel(),
      indexing: { indexes: [{ unique: false, fields: [] }, { unique: true, fields: [] }] },
    };
    expect(generate(model)).toBe(head);
    expect(generate(model)).not.toContain('ИНДЕКСИРОВАТЬ');
  });

  it('queryType=select → нет секции ИНДЕКСИРОВАТЬ', () => {
    const model: QueryModel = {
      ...fiveFieldModel(),
      queryType: 'select',
      tempTableName: undefined,
      indexing: {
        indexes: [{ unique: false, fields: [{ tableId: 't1', path: 'Ссылка' }] }],
      },
    };
    expect(generate(model)).not.toContain('ИНДЕКСИРОВАТЬ');
  });

  it('отсутствие indexing не меняет вывод', () => {
    expect(generate(fiveFieldModel())).toBe(head);
  });
});

describe('источник-подзапрос (ИЗ (ВЫБРАТЬ …) КАК …)', () => {
  it('одиночный источник-подзапрос с одним внутренним ВЫБРАТЬ', () => {
    const inner: QueryDocument = {
      members: [
        {
          name: 'Запрос 1',
          distinct: false,
          model: {
            tables: [{ id: 't0', fullName: 'Справочник.Валюты', alias: 'Валюты' }],
            fields: [{ tableId: 't0', path: 'Код', alias: 'Код' }],
          },
        },
      ],
    };
    const model: QueryModel = {
      tables: [{ id: 't0', fullName: '', alias: 'Данные', subquery: inner }],
      fields: [{ tableId: 't0', path: 'Код', alias: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
      '\tДанные.Код КАК Код\n' +
      'ИЗ\n' +
      '\t(ВЫБРАТЬ\n' +
      '\t\tВалюты.Код КАК Код\n' +
      '\tИЗ\n' +
      '\t\tСправочник.Валюты КАК Валюты) КАК Данные'
    );
  });

  it('источник-подзапрос с ОБЪЕДИНИТЬ ВСЕ реиндентирует и пустую строку-разделитель в один таб', () => {
    const member = (distinct: boolean, codeField: string): UnionMember => ({
      name: 'Запрос',
      distinct,
      model: {
        tables: [{ id: 't0', fullName: 'Справочник.Валюты', alias: 'Валюты' }],
        fields: [{ tableId: 't0', path: codeField, alias: 'Код' }],
      },
    });
    const inner: QueryDocument = { members: [member(false, 'Код'), member(false, 'Наименование')] };
    const model: QueryModel = {
      tables: [{ id: 't0', fullName: '', alias: 'Данные', subquery: inner }],
      fields: [{ tableId: 't0', path: 'Код', alias: 'Код' }],
    };
    const out = generate(model);
    // Пустая строка-разделитель ОБЪЕДИНИТЬ внутри подзапроса реиндентируется в один таб.
    expect(out).toContain('\n\t\n\tОБЪЕДИНИТЬ ВСЕ\n\t\n');
    // Хвост закрывается `) КАК Данные`.
    expect(out.endsWith(') КАК Данные')).toBe(true);
  });
});
