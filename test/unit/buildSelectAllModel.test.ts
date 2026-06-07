import { describe, it, expect } from 'vitest';
import { buildSelectAllModel } from '../../src/core/query/buildSelectAllModel';
import type { MetaTable } from '../../src/core/metadata/types';

describe('buildSelectAllModel', () => {
  it('moves Предопределенный/ИмяПредопределенныхДанных to trailingFields, attributes after standard in fields', () => {
    const t: MetaTable = { kind: 'Справочник', name: 'X', fullName: 'Справочник.X', fields: [
      { name: 'Ссылка', kind: 'standard', types: [] },
      { name: 'Предопределенный', kind: 'standard', types: [] },
      { name: 'ИмяПредопределенныхДанных', kind: 'standard', types: [] },
      { name: 'Код', kind: 'standard', types: [] },
      { name: 'Рекв1', kind: 'attribute', types: [] },
    ]};
    const model = buildSelectAllModel(t);
    // Основные поля: стандартные (кроме TRAILING_STD) + атрибуты
    expect(model.fields.map(f => f.path)).toEqual(['Ссылка', 'Код', 'Рекв1']);
    // Завершающие поля (после ТЧ): Предопределенный, ИмяПредопределенныхДанных
    expect(model.trailingFields?.map(f => f.path)).toEqual(['Предопределенный', 'ИмяПредопределенныхДанных']);
    // Все поля (основные + завершающие) имеют alias === path
    const allFields = [...model.fields, ...(model.trailingFields ?? [])];
    expect(allFields.every(f => f.alias === f.path)).toBe(true);
  });

  it('sets tableId to t1 for all fields', () => {
    const t: MetaTable = { kind: 'Справочник', name: 'Y', fullName: 'Справочник.Y', fields: [
      { name: 'Ссылка', kind: 'standard', types: [] },
      { name: 'Код', kind: 'attribute', types: [] },
    ]};
    expect(buildSelectAllModel(t).fields.every(f => f.tableId === 't1')).toBe(true);
  });

  it('includes table with fullName and id t1', () => {
    const t: MetaTable = { kind: 'Справочник', name: 'Z', fullName: 'Справочник.Z', fields: [
      { name: 'Ссылка', kind: 'standard', types: [] },
    ]};
    const model = buildSelectAllModel(t);
    expect(model.tables).toHaveLength(1);
    expect(model.tables[0].id).toBe('t1');
    expect(model.tables[0].fullName).toBe('Справочник.Z');
  });

  it('maps tabular sections into tabSectionFields (each field once)', () => {
    const t: MetaTable = {
      kind: 'Справочник', name: 'W', fullName: 'Справочник.W',
      fields: [{ name: 'Ссылка', kind: 'standard', types: [] }],
      tabularSections: [{
        kind: 'ТабличнаяЧасть', name: 'ТЧ1', fullName: 'Справочник.W.ТЧ1',
        fields: [
          { name: 'Ссылка', kind: 'standard', types: [] },
          { name: 'Поле1', kind: 'attribute', types: [] },
        ],
      }],
    };
    const model = buildSelectAllModel(t);
    expect(model.tabSectionFields).toHaveLength(1);
    expect(model.tabSectionFields![0].tsName).toBe('ТЧ1');
    // Поля ТЧ — по одному разу (удвоение в эталонах 1С — артефакт выгрузки).
    expect(model.tabSectionFields![0].fields).toEqual(['Ссылка', 'Поле1']);
  });
});
