import { describe, it, expect } from 'vitest';
import { buildResolverFromTables } from '../../src/core/metadata/buildModelResolver';
import type { MetaTable } from '../../src/core/metadata/types';

const ВАЛЮТЫ: MetaTable = {
  kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты',
  fields: [{ name: 'Реквизит1', kind: 'attribute', types: [] }],
  tabularSections: [
    {
      kind: 'ТабличнаяЧасть', name: 'Курсы', fullName: 'Справочник.Валюты.Курсы',
      fields: [{ name: 'Курс', kind: 'attribute', types: [] }],
    },
  ],
};

const ОСТАТКИ: MetaTable = {
  kind: 'РегистрНакопления', name: 'Товары', fullName: 'РегистрНакопления.Товары.Остатки',
  fields: [{ name: 'КоличествоОстаток', kind: 'resource', types: [] }],
  virtual: { slice: 'Остатки', baseFullName: 'РегистрНакопления.Товары' },
};

const resolver = buildResolverFromTables([ВАЛЮТЫ, ОСТАТКИ]);

describe('buildResolverFromTables', () => {
  it('резолвит реальную таблицу по полному имени', () => {
    expect(resolver.tableByFullName('Справочник.Валюты')).toBe(ВАЛЮТЫ);
    // виртуальные не попадают в реальную карту
    expect(resolver.tableByFullName('РегистрНакопления.Товары.Остатки')).toBeUndefined();
  });

  it('резолвит виртуальную таблицу отдельным слоем', () => {
    expect(resolver.virtualTableByFullName!('РегистрНакопления.Товары.Остатки')).toBe(ОСТАТКИ);
    // реальная не попадает в виртуальную карту
    expect(resolver.virtualTableByFullName!('Справочник.Валюты')).toBeUndefined();
  });

  it('каноническое имя резолвится регистронезависимо (реальная и ТЧ)', () => {
    expect(resolver.canonicalFullName!('справочник.валюты')).toBe('Справочник.Валюты');
    expect(resolver.canonicalFullName!('СПРАВОЧНИК.ВАЛЮТЫ.КУРСЫ')).toBe('Справочник.Валюты.Курсы');
  });

  it('неизвестная таблица → undefined во всех картах', () => {
    expect(resolver.tableByFullName('Справочник.Нет')).toBeUndefined();
    expect(resolver.virtualTableByFullName!('Справочник.Нет')).toBeUndefined();
    expect(resolver.canonicalFullName!('Справочник.Нет')).toBeUndefined();
  });
});
