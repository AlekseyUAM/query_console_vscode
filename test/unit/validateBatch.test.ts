import { describe, it, expect } from 'vitest';
import { validateBatchText, tryParseBatch, tryOpenBatch } from '../../src/core/query/validateBatch';
import { parseBatch } from '../../src/core/query/sdblParser';
import { buildResolverFromTables } from '../../src/core/metadata/buildModelResolver';
import type { MetaTable } from '../../src/core/metadata/types';

describe('validateBatchText (7.8.10)', () => {
  // Критерий «ОК» должен совпадать с открытием конструктором из текста: запрос
  // корректен ⟺ parseBatch его разбирает. Пустой текст разбирается в пустой пакет
  // (как при открытии из текста — открывается пустой конструктор) → ok:true.
  it('пустой/пробельный текст разбирается (как открытие из текста) → ok:true', () => {
    expect(validateBatchText('').ok).toBe(true);
    expect(validateBatchText('   \n\t  ').ok).toBe(true);
  });

  it('валидный запрос → ok:true', () => {
    const text = 'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты';
    expect(validateBatchText(text).ok).toBe(true);
  });

  it('битый запрос (пустой список выборки) → ok:false, error содержит «ошибку»', () => {
    const r = validateBatchText('ВЫБРАТЬ ИЗ ИЗ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ошибку');
  });

  // Два идентификатора подряд в элементе выборки (`аа а.asdfa` — пробел внутри) —
  // некорректный SDBL: запрос НЕ должен открываться, а давать ошибку с номером строки.
  it('два идентификатора подряд в поле выборки → ok:false', () => {
    const text = 'ВЫБРАТЬ\n\tаа а.asdfa КАК asdfa\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const r = validateBatchText(text);
    expect(r.ok).toBe(false);
    // ошибка ссылается на 2-ю строку (поле)
    if (!r.ok) expect(r.error).toMatch(/\b2:/);
  });

  it('тот же дефект во 2-м запросе пакета → весь пакет ok:false', () => {
    const text =
      'ВЫБРАТЬ\n\tааа.Ссылка КАК Ссылка\nПОМЕСТИТЬ ааа\nИЗ\n\tСправочник.Валюты КАК Валюты' +
      '\n;\n\n' + '/'.repeat(80) + '\n' +
      'ВЫБРАТЬ\n\tааа.Ссылка КАК Ссылка,\n\tаа а.asdfa КАК asdfa\nИЗ\n\tааа КАК ааа';
    expect(validateBatchText(text).ok).toBe(false);
  });

  // `Поле Алиас` без КАК — неявный псевдоним (валиден в 1С), НО хвостовой
  // зарезервированный идентификатор-связка (`Ссылка`=ССЫЛКА) псевдонимом быть не может —
  // `Банки.Ссылка Ссылка` некорректен (проверено реальным 1С: «Ожидается имя таблицы»).
  it('хвостовой зарезервированный идентификатор (Ссылка) не псевдоним → ok:false', () => {
    const text = 'ВЫБРАТЬ\n\tБанки.Ссылка Ссылка\nИЗ\n\tСправочник.Банки КАК Банки';
    expect(validateBatchText(text).ok).toBe(false);
  });

  it('валидные формы того же поля по-прежнему ok:true', () => {
    const from = '\nИЗ\n\tСправочник.Банки КАК Банки';
    // явный КАК с псевдонимом-резервом — допустимо
    expect(validateBatchText('ВЫБРАТЬ\n\tБанки.Ссылка КАК Ссылка' + from).ok).toBe(true);
    // неявный псевдоним обычным именем — допустимо
    expect(validateBatchText('ВЫБРАТЬ\n\tБанки.Ссылка Алиас' + from).ok).toBe(true);
    // просто поле — допустимо (хвостовой сегмент Ссылка после точки)
    expect(validateBatchText('ВЫБРАТЬ\n\tБанки.Ссылка' + from).ok).toBe(true);
  });

  it('валидное составное выражение поля по-прежнему ok:true (не ложное срабатывание)', () => {
    const text =
      'ВЫБРАТЬ\n\tВЫБОР КОГДА Валюты.Код = "1" ТОГДА Валюты.Наименование ИНАЧЕ "" КОНЕЦ КАК Имя,\n' +
      '\tПРЕДСТАВЛЕНИЕ(Валюты.Ссылка) КАК Пр,\n\tСУММА(Валюты.Код) Итог\n' +
      'ИЗ\n\tСправочник.Валюты КАК Валюты\nСГРУППИРОВАТЬ ПО\n\tВалюты.Наименование';
    expect(validateBatchText(text).ok).toBe(true);
  });

  it('критерий тот же, что и у parseBatch (открытие из текста)', () => {
    // Для любого текста: validateBatchText.ok ⟺ parseBatch не бросает.
    const samples = [
      'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты',
      'ВЫБРАТЬ ИЗ ИЗ',
      'ВЫБРАТЬ "abc',
      '',
    ];
    for (const text of samples) {
      let parseOk = true;
      try { parseBatch(text); } catch { parseOk = false; }
      expect(validateBatchText(text).ok).toBe(parseOk);
      expect(tryParseBatch(text).ok).toBe(parseOk);
    }
  });
});

describe('tryOpenBatch / validateBatchText с резолвером (8.4)', () => {
  const ВАЛЮТЫ: MetaTable = {
    kind: 'Справочник', name: 'Валюты', fullName: 'Справочник.Валюты', fields: [],
  };
  const resolver = buildResolverFromTables([ВАЛЮТЫ]);
  const good = 'ВЫБРАТЬ Т.Ссылка КАК С ИЗ Справочник.Валюты КАК Т';
  const bad = 'ВЫБРАТЬ Т.Ссылка КАК С ИЗ Справочник.Валюты1 КАК Т';

  it('хорошая таблица с резолвером → ok с doc', () => {
    const r = tryOpenBatch(good, resolver);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.members.length).toBe(1);
  });

  it('несуществующая таблица с резолвером → not ok с семантическим сообщением', () => {
    const r = tryOpenBatch(bad, resolver);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Таблица не найдена');
      expect(r.error).toContain('Справочник.Валюты1');
    }
  });

  it('без резолвера — прежнее поведение (семантика не проверяется)', () => {
    expect(tryOpenBatch(bad).ok).toBe(true);
    expect(tryOpenBatch(bad, undefined).ok).toBe(true);
  });

  it('синтаксическая ошибка ловится прежде семантики', () => {
    const r = tryOpenBatch('ВЫБРАТЬ ИЗ ИЗ', resolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('Таблица не найдена');
  });

  it('validateBatchText с резолвером: несуществующая таблица → ok:false', () => {
    const r = validateBatchText(bad, resolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Таблица не найдена');
  });

  it('validateBatchText с резолвером: хорошая таблица → ok:true', () => {
    expect(validateBatchText(good, resolver).ok).toBe(true);
  });

  it('validateBatchText без резолвера — прежнее поведение', () => {
    expect(validateBatchText(bad).ok).toBe(true);
  });
});
