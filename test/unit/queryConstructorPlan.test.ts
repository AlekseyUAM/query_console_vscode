import { describe, it, expect } from 'vitest';
import { planQueryConstructor } from '../../src/extension/queryConstructorPlan';

describe('planQueryConstructor', () => {
  it('returns an open plan when offset is inside a query literal', () => {
    const source =
      'Запрос = Новый Запрос;\n' +
      'Запрос.Текст =\n' +
      '"ВЫБРАТЬ\n' +
      '|	Валюты.Код\n' +
      '|ИЗ\n' +
      '|	Справочник.Валюты КАК Валюты";\n';
    const open = source.indexOf('"');
    const close = source.indexOf('";');
    const offset = source.indexOf('Валюты.Код');

    const plan = planQueryConstructor(source, offset);

    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') throw new Error('expected open');
    expect(plan.queryRange).toEqual({ start: open, end: close + 1 });
    expect(plan.queryText).toBe(
      'ВЫБРАТЬ\n	Валюты.Код\nИЗ\n	Справочник.Валюты КАК Валюты'
    );
  });

  it('returns a prompt plan when offset falls outside any query literal', () => {
    const source =
      'Запрос = Новый Запрос;\n' +
      'Запрос.Текст =\n' +
      '"ВЫБРАТЬ\n' +
      '|	Валюты.Код\n' +
      '|ИЗ\n' +
      '|	Справочник.Валюты КАК Валюты";\n';
    const offset = 2; // inside `Запрос`, before any literal

    const plan = planQueryConstructor(source, offset);

    expect(plan.kind).toBe('prompt');
    if (plan.kind !== 'prompt') throw new Error('expected prompt');
    expect(plan.offset).toBe(offset);
  });
});
