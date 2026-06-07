import { describe, it, expect } from 'vitest';
import { generate } from '../../src/core/query/sdblGenerator';
import type { QueryModel } from '../../src/core/query/queryModel';

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
      'ВЫБРАТЬ\n\tВалюты.Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
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
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tВалюты.Наименование,\n\tВалюты.ЗагружаетсяИзИнтернета\nИЗ\n\tСправочник.Валюты КАК Валюты'
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
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tСчет.Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Счет КАК Счет'
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
      'ВЫБРАТЬ\n\tВалюты.Код,\n\tВалюты1.Дата\nИЗ\n\tСправочник.Валюты КАК Валюты,\n\tДокумент.Валюты КАК Валюты1'
    );
  });

  it('uses explicit alias when provided', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты', alias: 'Вал' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВал.Код\nИЗ\n\tСправочник.Валюты КАК Вал'
    );
  });

  it('supports multi-segment field path', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'ОсновнаяВалюта.Код' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tВалюты.ОсновнаяВалюта.Код\nИЗ\n\tСправочник.Валюты КАК Валюты'
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
      'ВЫБРАТЬ\n\tКурсы.Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК Курсы'
    );
  });

  it('renders a virtual slice table with period and condition params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК Курсы'
    );
  });

  it('renders only period when condition empty', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период) КАК Курсы'
    );
  });

  it('renders leading comma when only condition set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсы.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК Курсы'
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

  it('drops trailing empty positions for Обороты (only start/end period set)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', endPeriod: '&Кон' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, &Кон) КАК РегистрНакопленияОст');
  });

  it('keeps empty middle position for Обороты (start + periodicity, no end)', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрНакопления.РегистрНакопленияОст.Обороты', virtual: { startPeriod: '&Нач', periodicity: 'Месяц' } }],
      fields: [{ tableId: 't1', path: 'Ресурс1Оборот' }],
    };
    expect(generate(model)).toContain('РегистрНакопления.РегистрНакопленияОст.Обороты(&Нач, , Месяц) КАК РегистрНакопленияОст');
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
