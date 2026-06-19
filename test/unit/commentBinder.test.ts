import { describe, it, expect } from 'vitest';
import { parseQuery } from '../../src/core/query/sdblParser';
import { extractComments } from '../../src/core/query/commentBinder';
import { fieldAlias } from '../../src/core/query/unionModel';

const findByAlias = (model: ReturnType<typeof parseQuery>, alias: string) =>
  model.fields.find(f => fieldAlias(f, model) === alias);

describe('extractComments', () => {
  it('Case A — хвостовой (вид 1) и полностью-строчный (вид 2) комментарии полей', () => {
    const text =
      'ВЫБРАТЬ\n' +
      '\tВалюты.Ссылка КАК Ссылка, // комментарий 1-го вида\n' +
      '// комментарий 2-го вида\n' +
      '\tВалюты.Наименование КАК Наименование\n' +
      'ПОМЕСТИТЬ Вал\n' +
      'ИЗ\n' +
      '\tСправочник.Валюты КАК Валюты';
    const model = parseQuery(text);
    extractComments(text, model);

    const ssylka = findByAlias(model, 'Ссылка');
    const naim = findByAlias(model, 'Наименование');
    expect(ssylka).toBeDefined();
    expect(naim).toBeDefined();
    expect(ssylka!.commentTrailing).toBe('// комментарий 1-го вида');
    expect(naim!.commentLeading).toEqual(['// комментарий 2-го вида']);
    // не протекли друг в друга
    expect(ssylka!.commentLeading).toBeUndefined();
    expect(naim!.commentTrailing).toBeUndefined();
    // контейнерных комментариев нет
    expect(model.comments).toBeUndefined();
  });

  it('Case B — beforeSelect (вид 3, без авто-разделителя) и afterFrom (вид 4)', () => {
    const queryPart =
      'ВЫБРАТЬ\n' +
      '\tБригады.Ссылка КАК Ссылка\n' +
      'ИЗ\n' +
      '\tСправочник.Бригады КАК Бригады';
    const fullText =
      '////////////////////////////////////////////////////////////////////////////////\n' +
      '// комментарий 3-го вида\n' +
      'ВЫБРАТЬ\n' +
      '\tБригады.Ссылка КАК Ссылка\n' +
      'ИЗ\n' +
      '// комментарий 4-го вида\n' +
      '\tСправочник.Бригады КАК Бригады';
    const model = parseQuery(queryPart);
    extractComments(fullText, model);

    expect(model.comments).toBeDefined();
    expect(model.comments!.beforeSelect).toEqual(['// комментарий 3-го вида']);
    expect(model.comments!.afterFrom).toEqual(['// комментарий 4-го вида']);
  });

  it('Case C — посторонний комментарий (после ГДЕ) никуда не привязывается', () => {
    const text =
      'ВЫБРАТЬ\n' +
      '\tБригады.Ссылка КАК Ссылка\n' +
      'ИЗ\n' +
      '\tСправочник.Бригады КАК Бригады\n' +
      'ГДЕ\n' +
      '\tБригады.Ссылка = &Ссылка // посторонний комментарий';
    const model = parseQuery(text);
    extractComments(text, model);

    const ssylka = findByAlias(model, 'Ссылка');
    expect(ssylka).toBeDefined();
    expect(ssylka!.commentTrailing).toBeUndefined();
    expect(ssylka!.commentLeading).toBeUndefined();
    // ГДЕ-комментарий не на своей строке без кода? он хвостовой к коду ГДЕ →
    // не beforeSelect/afterFrom (он трейлинговый), значит контейнерных нет
    expect(model.comments).toBeUndefined();
  });

  it('Case D — запрос без комментариев: модель не меняется', () => {
    const text =
      'ВЫБРАТЬ\n' +
      '\tБригады.Ссылка КАК Ссылка,\n' +
      '\tБригады.Наименование КАК Наименование\n' +
      'ИЗ\n' +
      '\tСправочник.Бригады КАК Бригады';
    const model = parseQuery(text);
    extractComments(text, model);

    expect(model.comments).toBeUndefined();
    for (const f of model.fields) {
      expect(f.commentLeading).toBeUndefined();
      expect(f.commentTrailing).toBeUndefined();
    }
  });
});
