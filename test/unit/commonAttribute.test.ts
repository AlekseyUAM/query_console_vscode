import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseXml, firstElementChild } from '../../src/core/metadata/parser/dom';
import { parseCommonAttribute } from '../../src/core/metadata/parser/commonAttribute';

// Закоммиченные XML-фикстуры (не зависят от gitignored src/cf) — test/fixtures/cf-objects.
const CA_DIR = path.join(__dirname, '..', 'fixtures', 'cf-objects', 'CommonAttributes');

function readCa(filename: string): any {
  const xml = fs.readFileSync(path.join(CA_DIR, filename), 'utf8');
  const doc = parseXml(xml)!;
  return firstElementChild(doc.documentElement);
}

describe('parseCommonAttribute', () => {
  it('парсит имя и состав (Use), мапит префикс English→русский', () => {
    const ca = parseCommonAttribute(readCa('НаименованиеЯзык1.xml'))!;
    expect(ca).toBeTruthy();
    expect(ca.name).toBe('НаименованиеЯзык1');
    // Состав содержит русские fullName объектов, входящих в реквизит.
    expect(ca.content).toContain('Справочник.ЗначенияСвойствОбъектов');
    expect(ca.content).toContain('ПланВидовХарактеристик.ОбъектыАдресацииЗадач');
    // AutoUse=DontUse → флаг не выставлен, исключений нет.
    expect(ca.autoUse).toBeUndefined();
  });

  it('реквизит-разделитель с AutoUse=Use: пустой content, флаг autoUse, dontUse', () => {
    const ca = parseCommonAttribute(readCa('ОбластьДанныхОсновныеДанные.xml'))!;
    expect(ca.name).toBe('ОбластьДанныхОсновныеДанные');
    expect(ca.autoUse).toBe(true);
    // Все элементы состава помечены DontUse — явных Use нет.
    expect(ca.content).toEqual([]);
    // DontUse мапятся в русские fullName (ScheduledJob отбрасывается как не-таблица).
    expect(ca.dontUse).toContain('РегистрСведений.СообщенияОбменаДанными');
    expect(ca.dontUse?.some(s => s.startsWith('ScheduledJob'))).toBe(false);
  });

  it('возвращает только русские fullName известных типов (без ScheduledJob)', () => {
    const ca = parseCommonAttribute(readCa('ОбластьДанныхВспомогательныеДанные.xml'))!;
    expect(ca.content).toContain('РегистрСведений.ПотокиОбновления');
    expect(ca.content).toContain('Справочник.СеансыОбменовДанными');
    expect(ca.content.every(s => /^[А-Яа-я]/.test(s))).toBe(true);
  });
});
