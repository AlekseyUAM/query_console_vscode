import { describe, it, expect } from 'vitest';
import { classifyCorpus, sampleRepresentatives, type CorpusEntry } from '../../tooling/corpus-verify/classes';
import type { FeatureVector } from '../../tooling/corpus-verify/features';

function fv(over: Partial<FeatureVector>): FeatureVector {
  return {
    isPackage: false, hasUnions: false, maxTables: 1, hasJoins: false, joinKinds: [],
    queryTypes: ['select'], hasIndexing: false, hasGrouping: false, hasTotals: false,
    hasOrder: false, hasConditions: false, hasHaving: false, hasSubquery: false,
    hasVirtual: false, hasParams: false, hasBuilder: false, hasTabSections: false,
    hasExpressions: false, top: false, distinct: false, allowed: false,
    active: { tableCount: 1, queryType: 'select' }, ...over,
  };
}

describe('classifyCorpus / sampleRepresentatives', () => {
  it('groups identical feature vectors and sorts by class size desc', () => {
    const entries: CorpusEntry[] = [
      { name: 'a.txt', fv: fv({}) },
      { name: 'b.txt', fv: fv({}) },
      { name: 'c.txt', fv: fv({ hasJoins: true, maxTables: 2 }) },
    ];
    const classes = classifyCorpus(entries);
    expect(classes.length).toBe(2);
    expect(classes[0].members).toEqual(['a.txt', 'b.txt']); // крупнейший класс первым
    expect(classes[1].members).toEqual(['c.txt']);
  });

  it('takes up to perClass representatives from each class', () => {
    const entries: CorpusEntry[] = [
      { name: 'a.txt', fv: fv({}) }, { name: 'b.txt', fv: fv({}) }, { name: 'c.txt', fv: fv({}) },
      { name: 'd.txt', fv: fv({ hasTotals: true }) },
    ];
    const sample = sampleRepresentatives(classifyCorpus(entries), 2);
    expect(sample).toEqual(['a.txt', 'b.txt', 'd.txt']); // 2 из большого класса + 1 редкого
  });
});
