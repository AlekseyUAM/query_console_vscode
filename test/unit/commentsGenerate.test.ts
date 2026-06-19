import { describe, it, expect } from 'vitest';
import { generate } from '../../src/core/query/sdblGenerator';
import type { QueryModel } from '../../src/core/query/queryModel';

describe('comments generation (phase 8.1, step 5)', () => {
  it('emits trailing comment (vid 1) after comma and leading comment (vid 2) on own col-0 line', () => {
    const model: QueryModel = {
      queryType: 'createTemp',
      tempTableName: 'Вал',
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код', commentTrailing: '// c1' },
        { tableId: 't1', path: 'Наименование', commentLeading: ['// c2'] },
      ],
    };
    expect(generate(model)).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Код КАК Код, // c1\n' +
        '// c2\n' +
        '\tВалюты.Наименование КАК Наименование\n' +
        'ПОМЕСТИТЬ Вал\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты'
    );
  });

  it('emits beforeSelect (vid 3) before ВЫБРАТЬ and afterFrom (vid 4) right after ИЗ', () => {
    const model: QueryModel = {
      comments: { beforeSelect: ['// c3'], afterFrom: ['// c4'] },
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [{ tableId: 't1', path: 'Код' }],
    };
    expect(generate(model)).toBe(
      '// c3\n' +
        'ВЫБРАТЬ\n' +
        '\tВалюты.Код КАК Код\n' +
        'ИЗ\n' +
        '// c4\n' +
        '\tСправочник.Валюты КАК Валюты'
    );
  });

  it('produces identical output (no stray //) when no comments present', () => {
    const model: QueryModel = {
      tables: [{ id: 't1', fullName: 'Справочник.Валюты' }],
      fields: [
        { tableId: 't1', path: 'Код' },
        { tableId: 't1', path: 'Наименование' },
      ],
    };
    const out = generate(model);
    expect(out).toBe(
      'ВЫБРАТЬ\n' +
        '\tВалюты.Код КАК Код,\n' +
        '\tВалюты.Наименование КАК Наименование\n' +
        'ИЗ\n' +
        '\tСправочник.Валюты КАК Валюты'
    );
    expect(out).not.toContain('//');
  });
});
