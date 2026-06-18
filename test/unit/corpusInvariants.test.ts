import { describe, it, expect } from 'vitest';
import { expectedTabs, checkInvariants, checkStructure, checkContent, type UiSnapshot } from '../../tooling/corpus-verify/invariants';
import type { FeatureVector } from '../../tooling/corpus-verify/features';

function fv(active: { tableCount: number; queryType: any }): FeatureVector {
  return {
    isPackage: false, hasUnions: false, maxTables: active.tableCount, hasJoins: active.tableCount > 1,
    joinKinds: [], queryTypes: [active.queryType], hasIndexing: false, hasGrouping: false,
    hasTotals: false, hasOrder: false, hasConditions: false, hasHaving: false, hasSubquery: false,
    hasVirtual: false, hasParams: false, hasBuilder: false, hasTabSections: false, hasExpressions: false,
    top: false, distinct: false, allowed: false, active,
  };
}

describe('expectedTabs', () => {
  it('single table select: base tabs, no Связи/Индексы', () => {
    expect(expectedTabs({ tableCount: 1, queryType: 'select' })).toEqual([
      'Таблицы и поля', 'Группировка', 'Условия', 'Дополнительно',
      'Объединения/Псевдонимы', 'Порядок', 'Итоги', 'Построитель', 'Пакет запросов',
    ]);
  });
  it('multi-table inserts Связи as 2nd', () => {
    expect(expectedTabs({ tableCount: 2, queryType: 'select' })[1]).toBe('Связи');
  });
  it('createTemp inserts Индексы after Дополнительно', () => {
    const tabs = expectedTabs({ tableCount: 1, queryType: 'createTemp' });
    expect(tabs[tabs.indexOf('Дополнительно') + 1]).toBe('Индексы');
  });
  it('dropTemp: only Дополнительно + Пакет запросов', () => {
    expect(expectedTabs({ tableCount: 1, queryType: 'dropTemp' })).toEqual(['Дополнительно', 'Пакет запросов']);
  });
});

describe('checkInvariants', () => {
  const okSnap = (over: Partial<UiSnapshot> = {}): UiSnapshot => ({
    tabs: expectedTabs({ tableCount: 1, queryType: 'select' }),
    tableLabels: ['Валюты'],
    fieldListGroups: [{ id: 'order-source', items: ['Валюты.Код', 'Валюты.Наименование'] }],
    clipped: [],
    ...over,
  });

  it('clean snapshot → no violations', () => {
    expect(checkInvariants(okSnap(), fv({ tableCount: 1, queryType: 'select' }))).toEqual([]);
  });
  it('flags tab-set mismatch', () => {
    const v = checkInvariants(okSnap({ tabs: ['Таблицы и поля'] }), fv({ tableCount: 1, queryType: 'select' }));
    expect(v.some(x => x.code === 'TABS')).toBe(true);
  });
  it('flags duplicate field nodes', () => {
    const v = checkInvariants(okSnap({ fieldListGroups: [{ id: 'order-source', items: ['Валюты.Дата', 'Валюты.Дата'] }] }), fv({ tableCount: 1, queryType: 'select' }));
    expect(v.some(x => x.code === 'DUP_FIELDS')).toBe(true);
  });
  it('flags clipped text without title', () => {
    const v = checkInvariants(okSnap({ clipped: [{ text: 'ОченьДлинноеИмя', hasTitle: false }] }), fv({ tableCount: 1, queryType: 'select' }));
    expect(v.some(x => x.code === 'CLIP')).toBe(true);
  });
  it('clipped WITH title → no CLIP violation', () => {
    const v = checkInvariants(okSnap({ clipped: [{ text: 'ОченьДлинноеИмя', hasTitle: true }] }), fv({ tableCount: 1, queryType: 'select' }));
    expect(v.some(x => x.code === 'CLIP')).toBe(false);
  });
});

describe('checkStructure / checkContent (split for per-tab traversal)', () => {
  const snap = (over: Partial<UiSnapshot> = {}): UiSnapshot => ({
    tabs: expectedTabs({ tableCount: 1, queryType: 'select' }),
    tableLabels: ['Валюты'],
    fieldListGroups: [],
    clipped: [],
    ...over,
  });

  it('checkStructure returns only structural codes (TABS/TABLE_COUNT), never content', () => {
    const v = checkStructure(
      snap({ tabs: ['Таблицы и поля'], fieldListGroups: [{ id: 'g', items: ['x', 'x'] }], clipped: [{ text: 'y', hasTitle: false }] }),
      fv({ tableCount: 1, queryType: 'select' }),
    );
    expect(v.every(x => x.code === 'TABS' || x.code === 'TABLE_COUNT')).toBe(true);
    expect(v.some(x => x.code === 'TABS')).toBe(true);
    expect(v.some(x => x.code === 'DUP_FIELDS' || x.code === 'CLIP')).toBe(false);
  });

  it('checkContent returns only content codes (DUP_FIELDS/CLIP), never structural', () => {
    const v = checkContent(snap({
      tabs: ['Таблицы и поля'], // wrong tab set — must be ignored by content pass
      fieldListGroups: [{ id: 'order-source', items: ['Дата', 'Дата'] }],
      clipped: [{ text: 'Длинное', hasTitle: false }],
    }));
    expect(v.every(x => x.code === 'DUP_FIELDS' || x.code === 'CLIP')).toBe(true);
    expect(v.some(x => x.code === 'DUP_FIELDS')).toBe(true);
    expect(v.some(x => x.code === 'CLIP')).toBe(true);
    expect(v.some(x => x.code === 'TABS' || x.code === 'TABLE_COUNT')).toBe(false);
  });

  it('checkInvariants == checkStructure + checkContent', () => {
    const s = snap({ fieldListGroups: [{ id: 'g', items: ['a', 'a'] }], clipped: [{ text: 'z', hasTitle: false }] });
    const f = fv({ tableCount: 1, queryType: 'select' });
    expect(checkInvariants(s, f)).toEqual([...checkStructure(s, f), ...checkContent(s)]);
  });
});
