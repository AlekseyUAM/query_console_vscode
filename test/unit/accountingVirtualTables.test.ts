import { describe, it, expect } from 'vitest';
import { buildAccountingRegSlices } from '../../src/core/metadata/accountingVirtualTables';
import type { MetaTable } from '../../src/core/metadata/types';
import type { ParsedObject } from '../../src/core/metadata/parser/model';

const charts = new Map([['ПланСчетов1', { maxExtDimensionCount: 3, extDimensionTypes: 'ВидыСубконто' }]]);

const corrObj = {
  version: 1, kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии1',
  fullName: 'РегистрБухгалтерии.РегистрБухгалтерии1', uuid: 'r1',
  properties: { correspondence: true, chartOfAccounts: 'ПланСчетов1' },
} as unknown as ParsedObject;
const corrBase: MetaTable = {
  kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии1', fullName: 'РегистрБухгалтерии.РегистрБухгалтерии1',
  fields: [
    { name: 'Период', kind: 'standard', types: [{ primitive: 'Дата' }] },
    { name: 'Организация', kind: 'dimension', types: [{ primitive: 'Строка' }] },
    { name: 'Сумма', kind: 'resource', types: [{ primitive: 'Число' }] },
    { name: 'Реквизит1', kind: 'attribute', types: [{ primitive: 'Строка' }] },
  ],
};

const nonObj = {
  version: 1, kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии2',
  fullName: 'РегистрБухгалтерии.РегистрБухгалтерии2', uuid: 'r2',
  properties: { correspondence: false, chartOfAccounts: 'ПланСчетов1' },
} as unknown as ParsedObject;
const nonBase: MetaTable = {
  kind: 'РегистрБухгалтерии', name: 'РегистрБухгалтерии2', fullName: 'РегистрБухгалтерии.РегистрБухгалтерии2',
  fields: [
    { name: 'Измерение1', kind: 'dimension', types: [{ primitive: 'Строка' }] },
    { name: 'Ресурс1', kind: 'resource', types: [{ primitive: 'Число' }] },
  ],
};

const byName = (ts: MetaTable[], suffix: string) => ts.find(t => t.fullName.endsWith(suffix))!;
const names = (t: MetaTable) => t.fields.map(f => f.name);

describe('buildAccountingRegSlices (correspondence)', () => {
  const vts = buildAccountingRegSlices(corrObj, corrBase, charts);

  it('emits 5 VTs incl. ОборотыДтКт', () => {
    expect(vts.map(t => t.fullName.split('.')[2])).toEqual(
      ['Остатки', 'Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
    expect(vts[0].virtual).toEqual({ slice: 'Остатки', baseFullName: 'РегистрБухгалтерии.РегистрБухгалтерии1', correspondence: true });
  });

  it('Остатки: Счет, Субконто1..3, dims, развёрнутый ресурс', () => {
    expect(names(byName(vts, '.Остатки'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаОстаток', 'СуммаОстатокДт', 'СуммаОстатокКт', 'СуммаРазвернутыйОстатокДт', 'СуммаРазвернутыйОстатокКт',
    ]);
  });

  it('Обороты corr: dims между Субконто и КорСчет', () => {
    expect(names(byName(vts, '.Обороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'КорСчет', 'КорСубконто1', 'КорСубконто2', 'КорСубконто3',
      'СуммаОборот', 'СуммаОборотДт', 'СуммаОборотКт',
    ]);
  });

  it('ОборотыДтКт: Дт-блок, Кт-блок, dims, RОборот', () => {
    expect(names(byName(vts, '.ОборотыДтКт'))).toEqual([
      'СчетДт', 'СубконтоДт1', 'СубконтоДт2', 'СубконтоДт3',
      'СчетКт', 'СубконтоКт1', 'СубконтоКт2', 'СубконтоКт3',
      'Организv', 'СуммаОборот',
    ].map(x => x === 'Организv' ? 'Организация' : x));
  });

  it('ОстаткиИОбороты: Счет, Субконто, dims, развёртка Начальный/Оборот/Конечный', () => {
    expect(names(byName(vts, '.ОстаткиИОбороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Организация',
      'СуммаНачальныйОстаток', 'СуммаНачальныйОстатокДт', 'СуммаНачальныйОстатокКт',
      'СуммаНачальныйРазвернутыйОстатокДт', 'СуммаНачальныйРазвернутыйОстатокКт',
      'СуммаОборот', 'СуммаОборотДт', 'СуммаОборотКт',
      'СуммаКонечныйОстаток', 'СуммаКонечныйОстатокДт', 'СуммаКонечныйОстатокКт',
      'СуммаКонечныйРазвернутыйОстатокДт', 'СуммаКонечныйРазвернутыйОстатокКт',
    ]);
  });

  it('ДвиженияССубконто corr: Дт/Кт + ВидСубконто, dims, ресурс, реквизиты, без ВидДвижения', () => {
    expect(names(byName(vts, '.ДвиженияССубконто'))).toEqual([
      'Период', 'Регистратор', 'НомерСтроки', 'Активность',
      'СчетДт', 'СубконтоДт1', 'ВидСубконтоДт1', 'СубконтоДт2', 'ВидСубконтоДт2', 'СубконтоДт3', 'ВидСубконтоДт3',
      'СчетКт', 'СубконтоКт1', 'ВидСубконтоКт1', 'СубконтоКт2', 'ВидСубконтоКт2', 'СубконтоКт3', 'ВидСубконтоКт3',
      'Организация', 'Сумма', 'Реквизит1',
    ]);
  });
});

describe('buildAccountingRegSlices (non-correspondence)', () => {
  const vts = buildAccountingRegSlices(nonObj, nonBase, charts);

  it('emits 4 VTs without ОборотыДтКт', () => {
    expect(vts.map(t => t.fullName.split('.')[2])).toEqual(
      ['Остатки', 'Обороты', 'ОстаткиИОбороты', 'ДвиженияССубконто']);
  });

  it('Обороты non-corr: Счет, Субконто, dims, RОборот/Дт/Кт (без КорСчет)', () => {
    expect(names(byName(vts, '.Обороты'))).toEqual([
      'Счет', 'Субконто1', 'Субконто2', 'Субконто3', 'Измерение1',
      'Ресурс1Оборот', 'Ресурс1ОборотДт', 'Ресурс1ОборотКт',
    ]);
  });

  it('ДвиженияССубконто non-corr: Счет + ВидСубконто, dims, ресурс, ВидДвижения в конце', () => {
    expect(names(byName(vts, '.ДвиженияССубконто'))).toEqual([
      'Период', 'Регистратор', 'НомерСтроки', 'Активность',
      'Счет', 'Субконто1', 'ВидСубконто1', 'Субконто2', 'ВидСубконто2', 'Субконто3', 'ВидСубконто3',
      'Измерение1', 'Ресурс1', 'ВидДвижения',
    ]);
  });
});
