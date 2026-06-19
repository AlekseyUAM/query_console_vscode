import { describe, it, expect } from 'vitest';
import { buildDiagram } from '../../src/core/query/mermaidDiagram';
import type { BatchDocument } from '../../src/core/query/batchModel';
import type { QueryModel } from '../../src/core/query/queryModel';

const emptyBatch: BatchDocument = { members: [] };

function q(model: Partial<QueryModel>): { members: { name: string; distinct: boolean; model: QueryModel }[] } {
  const full: QueryModel = { tables: [], fields: [], ...model };
  return { members: [{ name: '', distinct: false, model: full }] };
}

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

describe('packageFlow', () => {
  it('ПОМЕСТИТЬ ВТ → потребитель: узлы и ребро с именем ВТ', () => {
    const batch: BatchDocument = {
      members: [
        q({ queryType: 'createTemp', tempTableName: 'ВТТовары', tables: [{ id: 'a', fullName: 'Справочник.Номенклатура' }] }),
        q({ queryType: 'select', tables: [{ id: 'b', fullName: 'ВТТовары' }] }),
      ],
    };
    const out = buildDiagram(batch, 'packageFlow', 0);
    expect(out.startsWith('graph TD')).toBe(true);
    expect(out).toContain('ПОМЕСТИТЬ ВТТовары');
    expect(out).toContain('Запрос 2');
    expect(out).toContain('q0 -->|"ВТТовары"| q1');
  });

  it('УНИЧТОЖИТЬ ВТ — отдельный узел без исходящих рёбер', () => {
    const batch: BatchDocument = {
      members: [q({ queryType: 'dropTemp', tempTableName: 'ВТТовары' })],
    };
    const out = buildDiagram(batch, 'packageFlow', 0);
    expect(out).toContain('УНИЧТОЖИТЬ ВТТовары');
    expect(out).not.toContain('-->');
  });
});
