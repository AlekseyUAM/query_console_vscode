import { describe, it, expect } from 'vitest';
import { RecursionGuard } from '../../tooling/real-constructor/recursionGuard';

describe('RecursionGuard', () => {
  it('пускает на новый заголовок в пределах глубины', () => {
    const g = new RecursionGuard();
    expect(g.shouldEnter('Выбор поля', 1)).toBe(true);
  });

  it('не пускает повторно на тот же заголовок (без учёта регистра/пробелов)', () => {
    const g = new RecursionGuard();
    expect(g.shouldEnter('Выбор поля', 1)).toBe(true);
    expect(g.shouldEnter('  выбор ПОЛЯ  ', 2)).toBe(false);
  });

  it('не пускает глубже maxDepth', () => {
    const g = new RecursionGuard({ maxDepth: 2 });
    expect(g.shouldEnter('A', 2)).toBe(true);
    expect(g.shouldEnter('B', 3)).toBe(false);
  });

  it('не пускает на пустой заголовок', () => {
    const g = new RecursionGuard();
    expect(g.shouldEnter('   ', 1)).toBe(false);
  });

  it('считает посещённые окна', () => {
    const g = new RecursionGuard();
    g.shouldEnter('A', 1);
    g.shouldEnter('B', 1);
    g.shouldEnter('A', 1);
    expect(g.visitedCount).toBe(2);
  });
});
