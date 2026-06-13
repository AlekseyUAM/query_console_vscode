import { describe, it, expect } from 'vitest';
import { deriveUnionColumns, fieldAlias } from '../../src/core/query/unionModel';
import type { UnionMember } from '../../src/core/query/unionModel';
import type { QueryModel } from '../../src/core/query/queryModel';

function member(name: string, model: QueryModel, distinct = false): UnionMember {
  return { name, distinct, model };
}

describe('fieldAlias', () => {
  it('uses explicit alias when present', () => {
    expect(fieldAlias({ tableId: 't1', path: 'Ссылка', alias: 'Труляля' })).toBe('Труляля');
  });

  it('falls back to last path segment', () => {
    expect(fieldAlias({ tableId: 't1', path: 'Владелец.Код' })).toBe('Код');
  });

  it('falls back to expression text for expression fields without alias', () => {
    expect(fieldAlias({ tableId: 't1', path: '', expression: 'ВЫРАЗИТЬ(1 КАК ЧИСЛО)' }))
      .toBe('ВЫРАЗИТЬ(1 КАК ЧИСЛО)');
  });
});

describe('deriveUnionColumns', () => {
  it('выравнивает колонки ПОЗИЦИОННО: i-я ячейка = i-е поле участника как есть (6.15.22)', () => {
    // Одинаковые псевдонимы в разных позициях НЕ сливаются: 1С берёт столбцы по индексу.
    const m0 = member('Запрос 1', {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't1', path: 'Код', alias: 'Код' },
      ],
    });
    const m1 = member('Запрос 2', {
      tables: [{ id: 't2', fullName: 'Справочник.ВариантыОтветовАнкет' }],
      fields: [
        { tableId: 't2', path: 'Ссылка', alias: 'Ссылка' },
        { tableId: 't2', path: 'Наименование', alias: 'Наименование' },
      ],
    });
    const cols = deriveUnionColumns([m0, m1]);
    // Заголовки — псевдонимы полей участника 0 по позициям.
    expect(cols.map(c => c.alias)).toEqual(['Ссылка', 'Код']);
    expect(cols[0].cells).toEqual(['Валюты.Ссылка', 'ВариантыОтветовАнкет.Ссылка']);
    // Позиция 2: «Код» участника 0 vs «Наименование» участника 1 — берутся как есть.
    expect(cols[1].cells).toEqual(['Валюты.Код', 'ВариантыОтветовАнкет.Наименование']);
  });

  it('заголовки колонок — псевдонимы полей участника 0 по позициям', () => {
    const m0 = member('Q1', {
      tables: [{ id: 't1', fullName: 'Справочник.А' }],
      fields: [
        { tableId: 't1', path: 'X', alias: 'X' },
        { tableId: 't1', path: 'Y', alias: 'Y' },
      ],
    });
    const m1 = member('Q2', {
      tables: [{ id: 't2', fullName: 'Справочник.Б' }],
      fields: [
        { tableId: 't2', path: 'Y', alias: 'Y' },
        { tableId: 't2', path: 'Z', alias: 'Z' },
      ],
    });
    const cols = deriveUnionColumns([m0, m1]);
    expect(cols.map(c => c.alias)).toEqual(['X', 'Y']);
    expect(cols[1].cells).toEqual(['А.Y', 'Б.Z']);
  });

  it('недостающее поле участника (ширина меньше) → null (→ NULL)', () => {
    const m0 = member('Q1', {
      tables: [{ id: 't1', fullName: 'Справочник.А' }],
      fields: [
        { tableId: 't1', path: 'X', alias: 'X' },
        { tableId: 't1', path: 'W', alias: 'W' },
      ],
    });
    const m1 = member('Q2', {
      tables: [{ id: 't2', fullName: 'Справочник.Б' }],
      fields: [{ tableId: 't2', path: 'Y', alias: 'Y' }],
    });
    const cols = deriveUnionColumns([m0, m1]);
    expect(cols[0].cells).toEqual(['А.X', 'Б.Y']);
    // У участника 1 второго столбца нет → null.
    expect(cols[1].cells).toEqual(['А.W', null]);
  });

  it('handles expression fields as cell expressions', () => {
    const m0 = member('Q1', {
      tables: [{ id: 't1', fullName: 'Справочник.А' }],
      fields: [{ tableId: 't1', path: '', alias: 'Сумма', expression: 'СУММА(А.Кол)' }],
    });
    const cols = deriveUnionColumns([m0]);
    expect(cols[0].alias).toBe('Сумма');
    expect(cols[0].cells).toEqual(['СУММА(А.Кол)']);
  });
});
