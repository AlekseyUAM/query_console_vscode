import { describe, it, expect } from 'vitest';
import { parseBatch } from '../../src/core/query/sdblParser';
import { extractFeatures, featureKey } from '../../tooling/corpus-verify/features';

describe('extractFeatures', () => {
  it('single simple select: no joins, one table, queryType select', () => {
    const fv = extractFeatures(parseBatch('ВЫБРАТЬ Валюты.Ссылка ИЗ Справочник.Валюты КАК Валюты'));
    expect(fv.isPackage).toBe(false);
    expect(fv.hasUnions).toBe(false);
    expect(fv.maxTables).toBe(1);
    expect(fv.hasJoins).toBe(false);
    expect(fv.active).toEqual({ tableCount: 1, queryType: 'select' });
  });

  it('detects package (>1 statement) and temp-table create', () => {
    const text = [
      'ВЫБРАТЬ Валюты.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТ ИЗ Справочник.Валюты КАК Валюты',
      'ВЫБРАТЬ ВТ.Ссылка ИЗ ВТ КАК ВТ',
    ].join(';\n');
    const fv = extractFeatures(parseBatch(text));
    expect(fv.isPackage).toBe(true);
    expect(fv.queryTypes).toContain('createTemp');
    expect(fv.active.queryType).toBe('createTemp');
  });

  it('detects union (ОБЪЕДИНИТЬ ВСЕ)', () => {
    const text = 'ВЫБРАТЬ 1 КАК А ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ 2 КАК А';
    expect(extractFeatures(parseBatch(text)).hasUnions).toBe(true);
  });

  it('featureKey is stable & order-independent for joinKinds/queryTypes', () => {
    const a = extractFeatures(parseBatch('ВЫБРАТЬ Валюты.Ссылка ИЗ Справочник.Валюты КАК Валюты'));
    const b = extractFeatures(parseBatch('ВЫБРАТЬ Валюты.Код ИЗ Справочник.Валюты КАК Валюты'));
    expect(featureKey(a)).toBe(featureKey(b)); // оба: 1 таблица, select, без секций
  });
});
