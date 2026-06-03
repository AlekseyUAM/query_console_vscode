import { describe, it, expect } from 'vitest';
import { FUNCTION_CATALOG, type FunctionGroup, type FunctionLeaf } from '../../src/core/query/functionCatalog';

function isLeaf(n: FunctionGroup | FunctionLeaf): n is FunctionLeaf {
  return 'template' in n;
}

function allLeaves(group: FunctionGroup): FunctionLeaf[] {
  return group.children.flatMap(c => (isLeaf(c) ? [c] : allLeaves(c)));
}

describe('FUNCTION_CATALOG', () => {
  it('has the three top-level groups', () => {
    const labels = FUNCTION_CATALOG.children.map(c => c.label);
    expect(labels).toEqual(['Функции', 'Операторы', 'Прочее']);
  });

  it('includes ДОБАВИТЬКДАТЕ with a templated signature', () => {
    const leaf = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'ДОБАВИТЬКДАТЕ')!;
    expect(leaf.template).toBe('ДОБАВИТЬКДАТЕ(<Дата>, <Тип>, <Количество>)');
  });

  it('includes aggregate СУММА with templated argument', () => {
    const leaf = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'СУММА')!;
    expect(leaf.template).toBe('СУММА(<Выражение>)');
  });

  it('operators insert the symbol/keyword itself', () => {
    const and = allLeaves(FUNCTION_CATALOG).find(l => l.label === 'И')!;
    expect(and.template).toBe('И');
    const eq = allLeaves(FUNCTION_CATALOG).find(l => l.label === '=')!;
    expect(eq.template).toBe('=');
  });

  it('Прочее contains СГРУППИРОВАНОПО', () => {
    const misc = FUNCTION_CATALOG.children.find(c => c.label === 'Прочее') as FunctionGroup;
    expect(allLeaves(misc).map(l => l.label)).toContain('СГРУППИРОВАНОПО');
  });
});
