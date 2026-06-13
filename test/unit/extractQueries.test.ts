import { describe, it, expect } from 'vitest';
import {
  extractQueryStrings,
  unescapeXmlEntities,
  extractQueriesFromXml,
} from '../../src/cli/extractQueries';

describe('extractQueryStrings', () => {
  it('извлекает один многострочный запрос с | и корректным lineStart', () => {
    const src = [
      'Процедура Тест()',
      '\tЗапрос.Текст = "ВЫБРАТЬ',
      '\t|\tТаблица.Поле',
      '\t|ИЗ',
      '\t|\tСправочник.Тест КАК Таблица";',
      'КонецПроцедуры',
    ].join('\n');
    const res = extractQueryStrings(src);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('ВЫБРАТЬ\n\tТаблица.Поле\nИЗ\n\tСправочник.Тест КАК Таблица');
    expect(res[0].lineStart).toBe(2);
  });

  it('извлекает два запроса в одном источнике, нумеруя по порядку', () => {
    const src = [
      'А = "ВЫБРАТЬ Поле1";',
      'Б = "ВЫБРАТЬ Поле2";',
    ].join('\n');
    const res = extractQueryStrings(src);
    expect(res).toHaveLength(2);
    expect(res[0].text).toBe('ВЫБРАТЬ Поле1');
    expect(res[0].lineStart).toBe(1);
    expect(res[1].text).toBe('ВЫБРАТЬ Поле2');
    expect(res[1].lineStart).toBe(2);
  });

  it('игнорирует строковый литерал, не являющийся запросом', () => {
    const src = 'Сообщить("Привет");';
    expect(extractQueryStrings(src)).toHaveLength(0);
  });

  it('разэкранирует "" внутри строки', () => {
    const src = 'Т = "ВЫБРАТЬ ""abc"" КАК Поле";';
    const res = extractQueryStrings(src);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('ВЫБРАТЬ "abc" КАК Поле');
  });

  it('игнорирует ВЫБРАТЬ внутри // комментария', () => {
    const src = [
      '// ВЫБРАТЬ это не запрос "ВЫБРАТЬ Поле"',
      'Х = 1;',
    ].join('\n');
    expect(extractQueryStrings(src)).toHaveLength(0);
  });

  it('распознаёт УНИЧТОЖИТЬ и регистронезависимость', () => {
    const src = 'Т = "уничтОжить Справочник.Тест";';
    const res = extractQueryStrings(src);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('уничтОжить Справочник.Тест');
  });

  it('игнорирует одинарные кавычки (даты) и не путает их со строками', () => {
    const src = 'Д = \'20240101\'; Т = "ВЫБРАТЬ 1";';
    const res = extractQueryStrings(src);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('ВЫБРАТЬ 1');
  });
});

describe('unescapeXmlEntities', () => {
  it('декодирует основные сущности', () => {
    expect(unescapeXmlEntities('a &lt; b &gt; c &amp; d')).toBe('a < b > c & d');
  });

  it('декодирует &quot; и &apos;', () => {
    expect(unescapeXmlEntities('&quot;x&quot; &apos;y&apos;')).toBe('"x" \'y\'');
  });

  it('приоритет слева направо: &amp;lt; → литерал &lt;, а не <', () => {
    expect(unescapeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('декодирует числовые сущности (dec и hex)', () => {
    expect(unescapeXmlEntities('&#1041;&#x42E;')).toBe('БЮ');
  });

  it('строку без сущностей возвращает без изменений', () => {
    expect(unescapeXmlEntities('ВЫБРАТЬ Поле')).toBe('ВЫБРАТЬ Поле');
  });
});

describe('extractQueriesFromXml', () => {
  it('извлекает один <query>, декодируя сущности', () => {
    const xml = '<dataSet><query>ВЫБРАТЬ Т.Поле\nГДЕ Т.А &lt;&gt; &amp;П</query></dataSet>';
    const res = extractQueriesFromXml(xml);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('ВЫБРАТЬ Т.Поле\nГДЕ Т.А <> &П');
  });

  it('извлекает несколько <query> с корректным lineStart', () => {
    const xml = [
      '<schema>',
      '  <query>ВЫБРАТЬ Поле1</query>',
      '  <other>x</other>',
      '  <query>ВЫБРАТЬ Поле2</query>',
      '</schema>',
    ].join('\n');
    const res = extractQueriesFromXml(xml);
    expect(res).toHaveLength(2);
    expect(res[0].text).toBe('ВЫБРАТЬ Поле1');
    expect(res[0].lineStart).toBe(2);
    expect(res[1].text).toBe('ВЫБРАТЬ Поле2');
    expect(res[1].lineStart).toBe(4);
  });

  it('игнорирует <query>, не начинающийся с ключевого слова', () => {
    const xml = '<query>не запрос</query>';
    expect(extractQueriesFromXml(xml)).toHaveLength(0);
  });

  it('игнорирует прочие теги (dataSource и т.п.)', () => {
    const xml = '<dataSource>ИсточникДанных1</dataSource>';
    expect(extractQueriesFromXml(xml)).toHaveLength(0);
  });
});
