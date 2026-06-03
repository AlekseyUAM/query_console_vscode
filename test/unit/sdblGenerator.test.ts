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
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Период\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних КАК КурсыСрезПоследних'
    );
  });

  it('renders a virtual slice table with period and condition params', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период', condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период, Валюта = &Валюта) КАК КурсыСрезПоследних'
    );
  });

  it('renders only period when condition empty', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { period: '&Период' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(&Период) КАК КурсыСрезПоследних'
    );
  });

  it('renders leading comma when only condition set', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'РегистрСведений.Курсы.СрезПоследних', virtual: { condition: 'Валюта = &Валюта' } }],
      fields: [{ tableId: 't1', path: 'Курс' }],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n\tКурсыСрезПоследних.Курс\nИЗ\n\tРегистрСведений.Курсы.СрезПоследних(, Валюта = &Валюта) КАК КурсыСрезПоследних'
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
});
