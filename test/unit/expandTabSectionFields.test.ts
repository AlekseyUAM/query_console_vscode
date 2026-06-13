import { describe, it, expect } from 'vitest';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import type { MetadataResolver } from '../../src/core/query/metadataResolver';
import type { MetaTable } from '../../src/core/metadata/types';

// Инлайн-метаданные. Состав/порядок колонок ТЧ подтверждён живым оракулом
// (mcp validate_query на Справочник.СертификатыКлючейЭлектроннойПодписиИШифрования):
//   С.Пользователи → С.Пользователи.(Ссылка, НомерСтроки, Пользователь).
const ТАБ: MetaTable = {
  kind: 'Справочник', name: 'Таб', fullName: 'Справочник.Таб',
  fields: [
    { name: 'Ссылка', kind: 'standard', types: [] },
    { name: 'Реквизит1', kind: 'attribute', types: [] },
  ],
  tabularSections: [
    {
      kind: 'ТабличнаяЧасть', name: 'Пользователи', fullName: 'Справочник.Таб.Пользователи',
      fields: [
        { name: 'Ссылка', kind: 'standard', types: [] },
        { name: 'НомерСтроки', kind: 'standard', types: [] },
        { name: 'Пользователь', kind: 'attribute', types: [] },
      ],
    },
  ],
};

const resolver: MetadataResolver = {
  tableByFullName: (fullName) => (fullName === 'Справочник.Таб' ? ТАБ : undefined),
};

const render = (input: string, r?: MetadataResolver): string =>
  generateBatch(parseBatch(input, r));

describe('expandTabSectionFields — развёртка простого поля-ТЧ в проекцию колонок', () => {
  it('поле Алиас.ТЧ КАК ТЧ среди скалярных полей → проекция ТЧ на своём месте', () => {
    const out = render([
      'ВЫБРАТЬ',
      '\tТаб.Реквизит1 КАК Реквизит1,',
      '\tТаб.Пользователи КАК Пользователи,',
      '\tТаб.Ссылка КАК Ссылка',
      'ИЗ',
      '\tСправочник.Таб КАК Таб',
    ].join('\n'), resolver);
    expect(out).toBe([
      'ВЫБРАТЬ',
      '\tТаб.Реквизит1 КАК Реквизит1,',
      '\tТаб.Пользователи.(',
      '\t\tСсылка КАК Ссылка,',
      '\t\tНомерСтроки КАК НомерСтроки,',
      '\t\tПользователь КАК Пользователь',
      '\t) КАК Пользователи,',
      '\tТаб.Ссылка КАК Ссылка',
      'ИЗ',
      '\tСправочник.Таб КАК Таб',
    ].join('\n'));
  });

  it('без резолвера поле-ТЧ остаётся простым полем (поведение прежнее)', () => {
    const out = render([
      'ВЫБРАТЬ',
      '\tТаб.Пользователи КАК Пользователи',
      'ИЗ',
      '\tСправочник.Таб КАК Таб',
    ].join('\n'));
    expect(out).toBe([
      'ВЫБРАТЬ',
      '\tТаб.Пользователи КАК Пользователи',
      'ИЗ',
      '\tСправочник.Таб КАК Таб',
    ].join('\n'));
  });
});
