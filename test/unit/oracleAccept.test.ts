import { describe, it, expect } from 'vitest';
import { acceptAgainstOracle, firstDiffLine } from '../../src/cli/oracleAccept';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';

const canon = (t: string) => generateBatch(parseBatch(t));

describe('firstDiffLine', () => {
  it('находит первую расходящуюся строку (1-based)', () => {
    expect(firstDiffLine('А\nБ\nВ', 'А\nX\nВ')).toEqual({ line: 2, a: 'Б', b: 'X' });
  });
  it('возвращает line:0 для равных', () => {
    expect(firstDiffLine('А', 'А').line).toBe(0);
  });
});

describe('acceptAgainstOracle', () => {
  it('ok=true когда наш текст совпал с query_text конструктора', () => {
    const input = 'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const r = acceptAgainstOracle(input, canon(input));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('mismatch когда наш текст отличается', () => {
    const input = 'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const r = acceptAgainstOracle(input, 'ВЫБРАТЬ\n\tДРУГОЙ ТЕКСТ');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mismatch');
    expect(r.detail).toMatch(/^L\d+:/);
  });

  it('parse-exception когда parseBatch бросает', () => {
    const r = acceptAgainstOracle('ВЫБРАТЬ # ИЗ %%%', 'неважно');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('parse-exception');
    expect((r.detail ?? '').length).toBeGreaterThan(0);
  });
});
