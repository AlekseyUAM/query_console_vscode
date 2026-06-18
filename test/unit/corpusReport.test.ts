import { describe, it, expect } from 'vitest';
import { formatCoverageReport } from '../../tooling/corpus-verify/report';

describe('formatCoverageReport', () => {
  it('summarises classes, coverage and violations by code', () => {
    const md = formatCoverageReport({
      classes: [{ key: 'k1', members: ['a.txt', 'b.txt'] }, { key: 'k2', members: ['c.txt'] }],
      sampled: ['a.txt', 'c.txt'],
      results: [
        { name: 'a.txt', key: 'k1', violations: [] },
        { name: 'c.txt', key: 'k2', violations: [{ code: 'DUP_FIELDS', detail: 'order-source: дубль «X»' }] },
      ],
    });
    expect(md).toContain('Классов: 2');
    expect(md).toContain('Покрыто выборкой: 2');
    expect(md).toContain('Прогнано: 2');
    expect(md).toContain('DUP_FIELDS: 1');
    expect(md).toContain('c.txt');
  });

  it('flags uncovered classes (no sampled member)', () => {
    const md = formatCoverageReport({
      classes: [{ key: 'k1', members: ['a.txt'] }, { key: 'k2', members: ['b.txt'] }],
      sampled: ['a.txt'],
      results: [{ name: 'a.txt', key: 'k1', violations: [] }],
    });
    expect(md).toContain('Непокрытых классов: 1');
  });
});
