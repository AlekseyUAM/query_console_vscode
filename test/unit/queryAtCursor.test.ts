import { describe, it, expect } from 'vitest';
import { findQueryAt } from '../../src/extension/queryAtCursor';

describe('findQueryAt', () => {
  it('returns the hit when offset is inside a query literal (text de-piped, start/end at quotes)', () => {
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
    const hit = findQueryAt(source, offset);
    expect(hit).not.toBeNull();
    expect(hit!.start).toBe(open);
    expect(hit!.end).toBe(close + 1); // close quote included
    // de-piped reconstructed text
    expect(hit!.text).toBe(
      'ВЫБРАТЬ\n	Валюты.Код\nИЗ\n	Справочник.Валюты КАК Валюты'
    );
  });

  it('распознаёт запрос, начинающийся со строки-комментария (фаза 8.1)', () => {
    // 1С открывает такой текст конструктором: перед ВЫБРАТЬ — комментарий, и почти
    // на каждой строке хвостовой `//`. Наш экстрактор должен его опознать как запрос.
    const source = [
      'Запрос.Текст = " // ШЛЯПА !',
      '|ВЫБРАТЬ // ШЛЯПА !',
      '|\tВалюты.Ссылка КАК Ссылка // ШЛЯПА !',
      '|ИЗ // ШЛЯПА !',
      '|\tСправочник.Валюты КАК Валюты";',
    ].join('\n');
    const offset = source.indexOf('ВЫБРАТЬ');
    const hit = findQueryAt(source, offset);
    expect(hit).not.toBeNull();
    // Восстановленный текст СОХРАНЯЕТ ведущий комментарий (для парсера/связывателя).
    expect(hit!.text.startsWith(' // ШЛЯПА !\nВЫБРАТЬ')).toBe(true);
  });

  it('returns null when offset falls outside any string literal', () => {
    const source = 'Запрос.Текст = "ВЫБРАТЬ Валюты.Код ИЗ Справочник.Валюты КАК Валюты";';
    const offset = 2; // inside `Запрос`, before the quote
    expect(findQueryAt(source, offset)).toBeNull();
  });

  it('returns null when offset is inside a non-query string', () => {
    const source = 'Сообщить("Просто текст, не запрос");';
    const offset = source.indexOf('Просто');
    expect(findQueryAt(source, offset)).toBeNull();
  });

  it('returns the second hit when offset is in the second of two query literals', () => {
    const source =
      'А = "ВЫБРАТЬ Первый.Поле ИЗ Справочник.Первый КАК Первый";\n' +
      'Б = "ВЫБРАТЬ Второй.Поле ИЗ Справочник.Второй КАК Второй";\n';
    const secondOpen = source.indexOf('"', source.indexOf('Б ='));
    const offset = source.indexOf('Второй.Поле');
    const hit = findQueryAt(source, offset);
    expect(hit).not.toBeNull();
    expect(hit!.start).toBe(secondOpen);
    expect(hit!.text).toBe('ВЫБРАТЬ Второй.Поле ИЗ Справочник.Второй КАК Второй');
  });

  it('includes the quotes in [start,end) — offset on the opening quote returns the hit', () => {
    const source = 'Х = "ВЫБРАТЬ Т.Поле ИЗ Справочник.Т КАК Т";';
    const open = source.indexOf('"');
    const hit = findQueryAt(source, open);
    expect(hit).not.toBeNull();
    expect(hit!.start).toBe(open);
  });

  it('recognises УНИЧТОЖИТЬ queries', () => {
    const source = 'Х = "УНИЧТОЖИТЬ ВТ";';
    const offset = source.indexOf('УНИЧТОЖИТЬ');
    const hit = findQueryAt(source, offset);
    expect(hit).not.toBeNull();
    expect(hit!.text).toBe('УНИЧТОЖИТЬ ВТ');
  });
});
