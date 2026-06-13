import { describe, it, expect } from 'vitest';
import { acceptAgainstOracle } from '../../src/cli/oracleAccept';
import { parseBatch } from '../../src/core/query/sdblParser';
import { generateBatch } from '../../src/core/query/sdblGenerator';

const canon = (t: string) => generateBatch(parseBatch(t));

describe('acceptAgainstOracle — дополнительные поля (ours/errorClass/errorLine)', () => {
  it('ok=true: дополнительные поля не заполняются', () => {
    const input = 'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const r = acceptAgainstOracle(input, canon(input));
    expect(r.ok).toBe(true);
    expect(r.ours).toBeUndefined();
    expect(r.errorClass).toBeUndefined();
    expect(r.errorLine).toBeUndefined();
  });

  it('mismatch: ours — сгенерированный текст, errorClass=mismatch, errorLine>=1', () => {
    const input = 'ВЫБРАТЬ\n\tВалюты.Ссылка КАК Ссылка\nИЗ\n\tСправочник.Валюты КАК Валюты';
    const wrong = 'ВЫБРАТЬ\n\tДРУГОЙ ТЕКСТ';
    const r = acceptAgainstOracle(input, wrong);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mismatch');
    expect(r.errorClass).toBe('mismatch');
    expect(r.ours).toBe(canon(input));
    expect(r.errorLine).toBeGreaterThanOrEqual(1);
  });

  it('parse-exception: ours пустой, errorClass — непустое имя класса', () => {
    const r = acceptAgainstOracle('ВЫБРАТЬ # ИЗ %%%', 'неважно');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('parse-exception');
    expect(r.ours).toBe('');
    expect(typeof r.errorClass).toBe('string');
    expect((r.errorClass ?? '').length).toBeGreaterThan(0);
    expect(typeof r.errorLine).toBe('number');
  });
});
