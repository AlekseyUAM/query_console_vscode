import { describe, it, expect } from 'vitest';
import { accountingParamFields } from '../../src/core/query/accountingVirtualParams';

const keys = (slice: string, corr: boolean) => accountingParamFields(slice, corr).map(f => f.key);

describe('accountingParamFields', () => {
  it('Остатки', () => {
    expect(keys('Остатки', true)).toEqual(['period', 'accountCondition', 'condition']);
  });
  it('Обороты corr includes corrAccountCondition', () => {
    expect(keys('Обороты', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountCondition', 'condition', 'corrAccountCondition']);
  });
  it('Обороты non-corr omits corrAccountCondition', () => {
    expect(keys('Обороты', false)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountCondition', 'condition']);
  });
  it('ОборотыДтКт', () => {
    expect(keys('ОборотыДтКт', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'accountDtCondition', 'accountKtCondition', 'condition']);
  });
  it('ОстаткиИОбороты has fillMethod', () => {
    expect(keys('ОстаткиИОбороты', true)).toEqual(['startPeriod', 'endPeriod', 'periodicity', 'fillMethod', 'accountCondition', 'condition']);
    expect(accountingParamFields('ОстаткиИОбороты', true).find(f => f.key === 'fillMethod')!.control).toBe('fillMethod');
  });
  it('ДвиженияССубконто', () => {
    expect(keys('ДвиженияССубконто', false)).toEqual(['startPeriod', 'endPeriod', 'condition', 'order', 'top']);
  });
});
