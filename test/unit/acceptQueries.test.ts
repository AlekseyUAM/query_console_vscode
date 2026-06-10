import { describe, it, expect } from 'vitest';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';
import { acceptOne } from '../../src/cli/acceptQueries';

describe('acceptOne', () => {
  it('принимает каноническую форму запроса (устойчивая неподвижная точка)', () => {
    // Каноническая форма — то, что выдаёт генератор; round-trip обязан совпасть.
    const canonical = generateBatch(
      parseBatch('ВЫБРАТЬ\n\tТ.Поле КАК Поле\nИЗ\n\tСправочник.Валюты КАК Т'),
    );
    const res = acceptOne(canonical);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('принимает простой канонический запрос без агрегатов', () => {
    const canonical = generateBatch(
      parseBatch('ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты'),
    );
    expect(acceptOne(canonical).ok).toBe(true);
  });

  it('отклоняет заведомо мусорную строку как parse-exception', () => {
    // `#` — недопустимый символ для лексера SDBL.
    const res = acceptOne('ВЫБРАТЬ # ИЗ %%% КАК');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('parse-exception');
    expect(typeof res.detail).toBe('string');
    expect((res.detail ?? '').length).toBeGreaterThan(0);
  });

  it('отклоняет пустой/неполный запрос как parse-exception', () => {
    const res = acceptOne('ВЫБРАТЬ ИЗ ГДЕ');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('parse-exception');
  });
});
