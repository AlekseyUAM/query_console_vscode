import { describe, it, expect } from 'vitest';
import { validateBatchText, tryParseBatch } from '../../src/core/query/validateBatch';
import { parseBatch } from '../../src/core/query/sdblParser';

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
