import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadMetadataFromYaml } from '../../src/core/metadata/yamlLoader';
import { generate } from '../../src/core/query/sdblGenerator';
import { buildSelectAllModel } from '../../src/core/query/buildSelectAllModel';
import type { MetaTable } from '../../src/core/metadata/types';

const REF_DIR = path.resolve(__dirname, '../../tmp/meta1c');
const YAML_DIR = path.resolve(__dirname, '../../tmp/parser_data/cf');
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

describe('golden: справочники', () => {
  it('Справочник.Валюты', () => {
    expect(gen('Справочник.Валюты')).toBe(ref('СправочникВалюты.txt'));
  });
  it('Справочник.ЗначенияСвойствОбъектов (с общими реквизитами)', () => {
    expect(gen('Справочник.ЗначенияСвойствОбъектов')).toBe(ref('СправочникЗначенияСвойствОбъектов.txt'));
  });
});

describe('golden: документы', () => {
  it('Документ.Анкета (с ТЧ Состав)', () => {
    expect(gen('Документ.Анкета')).toBe(ref('ДокументАнкета.txt'));
  });
});

describe('golden: регистр сведений', () => {
  const F = 'РегистрСведений.АрхивСообщенийОбменов';
  it('реальная таблица', () => {
    expect(gen(F)).toBe(ref('РегистрСведенийАрхивСообщенийОбменов.txt'));
  });
  it('СрезПервых', () => {
    expect(gen(F + '.СрезПервых')).toBe(ref('РегистрСведенийАрхивСообщенийОбменовСрезПервых.txt'));
  });
  it('СрезПоследних', () => {
    expect(gen(F + '.СрезПоследних')).toBe(ref('РегистрСведенийАрхивСообщенийОбменовСрезПоследних.txt'));
  });
});

// Все периодичности ВТ Обороты/ОстаткиИОбороты (имя файла-эталона = периодичность).
const PERIODICITIES = [
  'Период', 'Запись', 'Регистратор',
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год', 'Декада', 'Полугодие',
  'Авто',
];

describe('golden: регистр накопления (Остатки) РегистрНакопленияОст', () => {
  const F = 'РегистрНакопления.РегистрНакопленияОст';
  const P = 'РегистрНакопленияОст';
  it('реальная таблица', () => expect(gen(F)).toBe(ref(`РегистрНакопления${P}.txt`)));
  it('Остатки', () => expect(gen(`${F}.Остатки`)).toBe(ref(`РегистрНакопления${P}Остатки.txt`)));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => expect(gen(`${F}.Обороты`, p)).toBe(ref(`РегистрНакопления${P}Обороты${p}.txt`)));
    it(`ОстаткиИОбороты/${p}`, () => expect(gen(`${F}.ОстаткиИОбороты`, p)).toBe(ref(`РегистрНакопления${P}ОстаткиИОбороты${p}.txt`)));
  }
});

describe('golden: регистр накопления (Обороты) РегистрНакопленияОбор', () => {
  const F = 'РегистрНакопления.РегистрНакопленияОбор';
  const P = 'РегистрНакопленияОбор';
  it('реальная таблица', () => expect(gen(F)).toBe(ref(`РегистрНакопления${P}.txt`)));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => expect(gen(`${F}.Обороты`, p)).toBe(ref(`РегистрНакопления${P}Обороты${p}.txt`)));
  }
});

describe('golden: регистр бухгалтерии (некорр) РегистрБухгалтерии2', () => {
  const F = 'РегистрБухгалтерии.РегистрБухгалтерии2';
  const P = 'РегистрБухгалтерии2';
  const R = 'РегистрБухгалтерии';
  it('реальная таблица', () => expect(gen(F)).toBe(ref(`${R}${P}.txt`)));
  it('Остатки', () => expect(gen(`${F}.Остатки`)).toBe(ref(`${R}${P}Остатки.txt`)));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => expect(gen(`${F}.Обороты`, p)).toBe(ref(`${R}${P}Обороты${p}.txt`)));
    it(`ОстаткиИОбороты/${p}`, () => expect(gen(`${F}.ОстаткиИОбороты`, p)).toBe(ref(`${R}${P}ОстаткиИОбороты${p}.txt`)));
  }
  it('ДвиженияССубконто', () => expect(gen(`${F}.ДвиженияССубконто`)).toBe(ref(`${R}${P}ДвиженияССубконто.txt`)));
});

describe('golden: регистр бухгалтерии (корр) РегистрБухгалтерии1', () => {
  const F = 'РегистрБухгалтерии.РегистрБухгалтерии1';
  const P = 'РегистрБухгалтерии1';
  const R = 'РегистрБухгалтерии';
  it('реальная таблица', () => expect(gen(F)).toBe(ref(`${R}${P}.txt`)));
  it('Остатки', () => expect(gen(`${F}.Остатки`)).toBe(ref(`${R}${P}Остатки.txt`)));
  for (const p of PERIODICITIES) {
    it(`Обороты/${p}`, () => expect(gen(`${F}.Обороты`, p)).toBe(ref(`${R}${P}Обороты${p}.txt`)));
    it(`ОстаткиИОбороты/${p}`, () => expect(gen(`${F}.ОстаткиИОбороты`, p)).toBe(ref(`${R}${P}ОстаткиИОбороты${p}.txt`)));
    it(`ОборотыДтКт/${p}`, () => expect(gen(`${F}.ОборотыДтКт`, p)).toBe(ref(`${R}${P}ОборотыДтКт${p}.txt`)));
  }
  it('ДвиженияССубконто', () => expect(gen(`${F}.ДвиженияССубконто`)).toBe(ref(`${R}${P}ДвиженияССубконто.txt`)));
});

describe('golden: прочие типы', () => {
  it('Перечисление.Перечисление1', () =>
    expect(gen('Перечисление.Перечисление1')).toBe(ref('ПеречислениеПеречисление1.txt')));
  it('ПланВидовХарактеристик.ВидыСубконто', () =>
    expect(gen('ПланВидовХарактеристик.ВидыСубконто')).toBe(ref('ПланВидовХарактеристикВидыСубконто.txt')));
  it('ПланСчетов.ПланСчетов1 (с ТЧ ВидыСубконто)', () =>
    expect(gen('ПланСчетов.ПланСчетов1')).toBe(ref('ПланСчетовПланСчетов1.txt')));
  it('ПланОбмена.ОбновлениеИнформационнойБазы (с общим реквизитом)', () =>
    expect(gen('ПланОбмена.ОбновлениеИнформационнойБазы')).toBe(ref('ПланОбменаОбновлениеИнформационнойБазы.txt')));
  it('БизнесПроцесс.Задание', () =>
    expect(gen('БизнесПроцесс.Задание')).toBe(ref('БизнесПроцессЗадание.txt')));
  it('Задача.ЗадачаИсполнителя', () =>
    expect(gen('Задача.ЗадачаИсполнителя')).toBe(ref('ЗадачаЗадачаИсполнителя.txt')));
});
