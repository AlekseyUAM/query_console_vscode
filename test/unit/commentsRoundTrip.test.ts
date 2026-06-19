/**
 * Фаза 8.1 — приёмка сквозного цикла сохранения комментариев.
 *
 * Канонический пример из требований: открыть текст с комментариями 4 видов и
 * пересобрать его генератором байт-в-байт. Без опции `preserveComments` тот же текст
 * пересобирается БЕЗ комментариев (поведение оракула не меняется).
 */
import { describe, it, expect } from 'vitest';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';

const SPEC_WITH_COMMENTS = [
  'ВЫБРАТЬ',
  '\tВалюты.Ссылка КАК Ссылка, // комментарий 1-го вида',
  '// комментарий 2-го вида',
  '\tВалюты.Наименование КАК Наименование',
  'ПОМЕСТИТЬ Вал',
  'ИЗ',
  '\tСправочник.Валюты КАК Валюты',
  ';',
  '',
  '/'.repeat(80),
  '// комментарий 3-го вида',
  'ВЫБРАТЬ',
  '\tБригады.Ссылка КАК Ссылка',
  'ИЗ',
  '// комментарий 4-го вида',
  '\tСправочник.Бригады КАК Бригады',
].join('\n');

const SPEC_NO_COMMENTS = [
  'ВЫБРАТЬ',
  '\tВалюты.Ссылка КАК Ссылка,',
  '\tВалюты.Наименование КАК Наименование',
  'ПОМЕСТИТЬ Вал',
  'ИЗ',
  '\tСправочник.Валюты КАК Валюты',
  ';',
  '',
  '/'.repeat(80),
  'ВЫБРАТЬ',
  '\tБригады.Ссылка КАК Ссылка',
  'ИЗ',
  '\tСправочник.Бригады КАК Бригады',
].join('\n');

describe('Фаза 8.1 — round-trip комментариев', () => {
  it('с preserveComments комментарии 4 видов сохраняются байт-в-байт', () => {
    const doc = parseBatch(SPEC_WITH_COMMENTS, undefined, { preserveComments: true });
    expect(generateBatch(doc)).toBe(SPEC_WITH_COMMENTS);
  });

  it('без опции тот же текст пересобирается без комментариев', () => {
    const doc = parseBatch(SPEC_WITH_COMMENTS);
    expect(generateBatch(doc)).toBe(SPEC_NO_COMMENTS);
  });

  it('идемпотентность: повторный round-trip с опцией стабилен', () => {
    const once = generateBatch(parseBatch(SPEC_WITH_COMMENTS, undefined, { preserveComments: true }));
    const twice = generateBatch(parseBatch(once, undefined, { preserveComments: true }));
    expect(twice).toBe(once);
  });
});
