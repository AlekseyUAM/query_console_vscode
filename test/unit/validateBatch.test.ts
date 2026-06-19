import { describe, it, expect } from 'vitest';
import { validateBatchText } from '../../src/core/query/validateBatch';

describe('validateBatchText (7.8.10)', () => {
  it('пустой текст → ok:false с «Пустой запрос»', () => {
    const r = validateBatchText('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Пустой запрос');
  });

  it('пробельный текст → ok:false с «Пустой запрос»', () => {
    const r = validateBatchText('   \n\t  ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Пустой запрос');
  });

  it('валидный запрос → ok:true', () => {
    const text = 'ВЫБРАТЬ\n\tВалюты.Код КАК Код\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const r = validateBatchText(text);
    expect(r.ok).toBe(true);
  });

  it('битый запрос (пустой список выборки) → ok:false, error содержит «ошибку»', () => {
    const text = 'ВЫБРАТЬ ИЗ ИЗ';
    const r = validateBatchText(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ошибку');
  });
});
