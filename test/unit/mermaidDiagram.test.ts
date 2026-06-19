import { describe, it, expect } from 'vitest';
import { buildDiagram } from '../../src/core/query/mermaidDiagram';
import type { BatchDocument } from '../../src/core/query/batchModel';

const emptyBatch: BatchDocument = { members: [] };

describe('buildDiagram — диспетчер и устойчивость', () => {
  it('пустой пакет → плейсхолдер, не бросает', () => {
    const out = buildDiagram(emptyBatch, 'packageFlow', 0);
    expect(out).toContain('graph');
    expect(out).toContain('Пустой запрос');
  });

  it('неизвестный kind → плейсхолдер', () => {
    // @ts-expect-error проверяем defensive-ветку
    const out = buildDiagram(emptyBatch, 'nope', 0);
    expect(out).toContain('Пустой запрос');
  });

  it('activeIndex за пределами пакета → плейсхолдер', () => {
    const out = buildDiagram(emptyBatch, 'joins', 5);
    expect(out).toContain('Пустой запрос');
  });
});
