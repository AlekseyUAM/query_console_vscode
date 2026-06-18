import { describe, it, expect } from 'vitest';
import { distinctFieldRefs } from '../../src/webview/fieldSource';

describe('distinctFieldRefs', () => {
  it('removes duplicate (tableId, path) keeping first order; drops expressions', () => {
    const out = distinctFieldRefs([
      { tableId: 't1', path: 'Дата', alias: 'Дата' },
      { tableId: 't1', path: 'Ссылка' },
      { tableId: 't1', path: 'Дата', alias: 'ДатаЗаказа' }, // дубль (tableId, path)
      { tableId: 't1', expression: 'ГОД(Т.Дата)' },         // выражение — исключается
    ] as any);
    expect(out.map((f: any) => f.path)).toEqual(['Дата', 'Ссылка']);
  });
});
