import { describe, it, expect } from 'vitest';
import { accumPeriodFields, PERIODICITY_VALUES, FILL_METHOD_VALUES } from '../../src/core/query/accumVirtualFields';

const names = (p: string | undefined) => accumPeriodFields(p).map(f => f.name);

describe('accumPeriodFields', () => {
  it('returns no period fields for empty/Период', () => {
    expect(names(undefined)).toEqual([]);
    expect(names('')).toEqual([]);
    expect(names('Период')).toEqual([]);
  });

  it('Запись → Период, Регистратор, НомерСтроки', () => {
    expect(names('Запись')).toEqual(['Период', 'Регистратор', 'НомерСтроки']);
  });

  it('Регистратор → Период, Регистратор', () => {
    expect(names('Регистратор')).toEqual(['Период', 'Регистратор']);
  });

  it('time-unit periodicity → Период only', () => {
    expect(names('Месяц')).toEqual(['Период']);
    expect(names('Секунда')).toEqual(['Период']);
    expect(names('Полугодие')).toEqual(['Период']);
  });

  it('Авто → ПериодСекунда…ПериодГод, Регистратор, НомерСтроки', () => {
    expect(names('Авто')).toEqual([
      'ПериодСекунда', 'ПериодМинута', 'ПериодЧас', 'ПериодДень', 'ПериодНеделя',
      'ПериодДекада', 'ПериодМесяц', 'ПериодКвартал', 'ПериодПолугодие', 'ПериодГод',
      'Регистратор', 'НомерСтроки',
    ]);
  });

  it('marks period fields as standard-kind МetaField with Дата/Число types', () => {
    const f = accumPeriodFields('Месяц')[0];
    expect(f.kind).toBe('standard');
    expect(f.types).toEqual([{ primitive: 'Дата' }]);
  });

  it('exposes value lists for dialog dropdowns', () => {
    expect(PERIODICITY_VALUES[0]).toBe('Период');
    expect(PERIODICITY_VALUES).toContain('Авто');
    expect(PERIODICITY_VALUES).toHaveLength(14);
    expect(FILL_METHOD_VALUES).toEqual(['Движения', 'ДвиженияИГраницыПериода']);
  });
});
