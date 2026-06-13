import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadMetadataFromYaml } from '../../src/core/metadata/yamlLoader';
import { generate } from '../../src/core/query/sdblGenerator';
import { buildSelectAllModel } from '../../src/core/query/buildSelectAllModel';
import type { MetaTable } from '../../src/core/metadata/types';

// Закоммиченные эталоны и YAML-кэш текущей конфигурации (не зависят от gitignored
// tmp/ — переживают очистку tmp и смену конфигурации). Подмножество meta1c,
// нужное этим тестам, лежит в test/fixtures/corpus/meta1c; полный YAML-кэш —
// в test/fixtures/corpus/metadata/cf (тот же, что у corpusRegression).
const REF_DIR = path.resolve(__dirname, '../fixtures/corpus/meta1c');
const YAML_DIR = path.resolve(__dirname, '../fixtures/corpus/metadata/cf');
const model = loadMetadataFromYaml(YAML_DIR);
const byFull = new Map(model.tables.map(t => [t.fullName, t]));

/**
 * Читает эталонный файл и нормализует его:
 * - снимает BOM (U+FEFF / EF BB BF): файлы 1С сохраняются с BOM
 * - нормализует CRLF → LF: файлы 1С используют CRLF, generate() — LF
 * Trailing-newline: файлы не содержат завершающего перевода строки, generate() тоже.
 */
function ref(file: string): string {
  return fs.readFileSync(path.join(REF_DIR, file), 'utf8')
    .replace(/^﻿/, '')        // снять BOM
    .replace(/\r\n/g, '\n');  // нормализовать CRLF → LF
}

function gen(fullName: string, periodicity?: string): string {
  const t = byFull.get(fullName) as MetaTable;
  expect(t, `таблица ${fullName} есть в модели`).toBeTruthy();
  return generate(buildSelectAllModel(t, periodicity));
}

/**
 * Имя эталонного файла в текущей выгрузке (tmp/meta1c) строится из полного
 * имени таблицы заменой точек на подчёркивания, с добавлением периодичности:
 *   РегистрНакопления.РегистрНакопленияОст.Обороты + "Период"
 *   → РегистрНакопления_РегистрНакопленияОст_Обороты_Период.txt
 */
function refFile(fullName: string, periodicity?: string): string {
  let name = fullName.replace(/\./g, '_');
  if (periodicity) name += '_' + periodicity;
  return ref(name + '.txt');
}

function check(fullName: string, periodicity?: string): void {
  expect(gen(fullName, periodicity)).toBe(refFile(fullName, periodicity));
}

describe('golden: справочники', () => {
  it('Справочник.Валюты', () => check('Справочник.Валюты'));
  it('Справочник.ЗначенияСвойствОбъектов (с общими реквизитами)', () =>
    check('Справочник.ЗначенияСвойствОбъектов'));
});

describe('golden: документы', () => {
  it('Документ.Анкета (с ТЧ Состав)', () => check('Документ.Анкета'));
});

describe('golden: регистр сведений', () => {
  const F = 'РегистрСведений.АрхивСообщенийОбменов';
  it('реальная таблица', () => check(F));
  it('СрезПервых', () => check(F + '.СрезПервых'));
  it('СрезПоследних', () => check(F + '.СрезПоследних'));
});

// Все периодичности ВТ Обороты/ОстаткиИОбороты (имя файла-эталона = периодичность).
const PERIODICITIES = [
  'Период', 'Запись', 'Регистратор',
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год', 'Декада', 'Полугодие',
  'Авто',
];

describe('golden: регистр накопления (Остатки) РегистрНакопленияОст', () => {
  const F = 'РегистрНакопления.РегистрНакопленияОст';
  it('реальная таблица', () => check(F));
  it('Остатки', () => check(`${F}.Остатки`));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => check(`${F}.Обороты`, p));
    it(`ОстаткиИОбороты/${p}`, () => check(`${F}.ОстаткиИОбороты`, p));
  }
});

describe('golden: регистр накопления (Обороты) РегистрНакопленияОбор', () => {
  const F = 'РегистрНакопления.РегистрНакопленияОбор';
  it('реальная таблица', () => check(F));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => check(`${F}.Обороты`, p));
  }
});

describe('golden: регистр бухгалтерии (некорр) РегистрБухгалтерии2', () => {
  const F = 'РегистрБухгалтерии.РегистрБухгалтерии2';
  it('реальная таблица', () => check(F));
  it('Остатки', () => check(`${F}.Остатки`));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => check(`${F}.Обороты`, p));
    it(`ОстаткиИОбороты/${p}`, () => check(`${F}.ОстаткиИОбороты`, p));
  }
  it('ДвиженияССубконто', () => check(`${F}.ДвиженияССубконто`));
});

describe('golden: регистр бухгалтерии (корр) РегистрБухгалтерии1', () => {
  const F = 'РегистрБухгалтерии.РегистрБухгалтерии1';
  it('реальная таблица', () => check(F));
  it('Остатки', () => check(`${F}.Остатки`));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => check(`${F}.Обороты`, p));
    it(`ОстаткиИОбороты/${p}`, () => check(`${F}.ОстаткиИОбороты`, p));
    it(`ОборотыДтКт/${p}`, () => check(`${F}.ОборотыДтКт`, p));
  }
  it('ДвиженияССубконто', () => check(`${F}.ДвиженияССубконто`));
});

describe('golden: прочие типы', () => {
  it('Перечисление.Перечисление1', () => check('Перечисление.Перечисление1'));
  it('ПланВидовХарактеристик.ВидыСубконто', () => check('ПланВидовХарактеристик.ВидыСубконто'));
  it('ПланСчетов.ПланСчетов1 (с ТЧ ВидыСубконто)', () => check('ПланСчетов.ПланСчетов1'));
  it('ПланОбмена.ОбновлениеИнформационнойБазы (с общим реквизитом)', () =>
    check('ПланОбмена.ОбновлениеИнформационнойБазы'));
  it('БизнесПроцесс.Задание', () => check('БизнесПроцесс.Задание'));
  it('Задача.ЗадачаИсполнителя', () => check('Задача.ЗадачаИсполнителя'));
});
