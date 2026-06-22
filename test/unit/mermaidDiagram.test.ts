import { describe, it, expect } from 'vitest';
import { buildDiagram } from '../../src/core/query/mermaidDiagram';
import type { BatchDocument } from '../../src/core/query/batchModel';
import type { QueryModel, Join, SelectedTable } from '../../src/core/query/queryModel';

const emptyBatch: BatchDocument = { members: [] };

function q(model: Partial<QueryModel>): { members: { name: string; distinct: boolean; model: QueryModel }[] } {
  const full: QueryModel = { tables: [], fields: [], ...model };
  return { members: [{ name: '', distinct: false, model: full }] };
}

describe('buildDiagram — диспетчер и устойчивость', () => {
  it('пустой пакет + flowchart → плейсхолдер, не бросает', () => {
    const out = buildDiagram(emptyBatch, 'flowchart', 0);
    expect(out).toContain('graph');
    expect(out).toContain('Пустой запрос');
  });

  it('неизвестный kind → плейсхолдер', () => {
    // @ts-expect-error проверяем defensive-ветку
    const out = buildDiagram(emptyBatch, 'nope', 0);
    expect(out).toContain('Пустой запрос');
  });

  it('пустой пакет + joinTree → плейсхолдер', () => {
    const out = buildDiagram(emptyBatch, 'joinTree', 0);
    expect(out).toContain('Пустой запрос');
  });
});

describe('flowchart', () => {
  it('ПОМЕСТИТЬ ВТ → потребитель: узлы и ребро с именем ВТ', () => {
    const batch: BatchDocument = {
      members: [
        q({ queryType: 'createTemp', tempTableName: 'ВТТовары', tables: [{ id: 'a', fullName: 'Справочник.Номенклатура' }] }),
        q({ queryType: 'select', tables: [{ id: 'b', fullName: 'ВТТовары' }] }),
      ],
    };
    const out = buildDiagram(batch, 'flowchart', 0);
    expect(out.startsWith('graph TD')).toBe(true);
    expect(out).toContain('ПОМЕСТИТЬ ВТТовары');
    expect(out).toContain('Запрос 2');
    expect(out).toContain('q0 -->|"ВТТовары"| q1');
  });

  it('УНИЧТОЖИТЬ ВТ — отдельный узел без исходящих рёбер', () => {
    const batch: BatchDocument = {
      members: [q({ queryType: 'dropTemp', tempTableName: 'ВТТовары' })],
    };
    const out = buildDiagram(batch, 'flowchart', 0);
    expect(out).toContain('УНИЧТОЖИТЬ ВТТовары');
    expect(out).not.toContain('-->');
  });
});

describe('joinTree', () => {
  it('ЛЕВОЕ соединение двух таблиц с простым условием', () => {
    const tables: SelectedTable[] = [
      { id: 'A', fullName: 'Справочник.Заказы', alias: 'Заказы' },
      { id: 'B', fullName: 'Справочник.Контрагенты', alias: 'Контр' },
    ];
    const joins: Join[] = [{
      leftTableId: 'A', rightTableId: 'B', leftAll: true, rightAll: false,
      custom: false, leftPath: 'Контрагент', operator: '=', rightPath: 'Ссылка',
    }];
    const batch: BatchDocument = { members: [q({ tables, joins })] };
    const out = buildDiagram(batch, 'joinTree', 0);
    expect(out).toContain('graph TD');
    expect(out).toContain('subgraph');
    expect(out).toContain('ЛЕВОЕ');
    expect(out).toContain('Контрагент = Ссылка');
    expect(out).toContain('-->');
  });

  it('одна таблица → есть subgraph и узел, но нет join-ребра', () => {
    const batch: BatchDocument = {
      members: [q({ tables: [{ id: 'A', fullName: 'Справочник.Заказы', alias: 'Заказы' }] })],
    };
    const out = buildDiagram(batch, 'joinTree', 0);
    expect(out).toContain('subgraph');
    expect(out).toContain('Справочник.Заказы');
    expect(out).not.toContain('-->|');
  });

  it('виртуальная таблица регистра → узел-цилиндр', () => {
    const batch: BatchDocument = {
      members: [q({ tables: [{ id: 'A', fullName: 'РегистрСведений.Цены', alias: 'Цены' }] })],
    };
    const out = buildDiagram(batch, 'joinTree', 0);
    expect(out).toContain('[(');
  });

  it('два запроса в пакете → вертикальный коннектор', () => {
    const batch: BatchDocument = {
      members: [
        q({ queryType: 'createTemp', tempTableName: 'ВТ1', tables: [{ id: 'A', fullName: 'Справочник.Заказы' }] }),
        q({ tables: [{ id: 'B', fullName: 'Справочник.Контрагенты' }] }),
      ],
    };
    const out = buildDiagram(batch, 'joinTree', 0);
    expect(out).toContain('-.->');
  });

  it('декартово: две таблицы без соединений', () => {
    const batch: BatchDocument = {
      members: [q({
        tables: [
          { id: 'A', fullName: 'Справочник.Заказы' },
          { id: 'B', fullName: 'Справочник.Контрагенты' },
        ],
      })],
    };
    const out = buildDiagram(batch, 'joinTree', 0);
    expect(out).toContain('-.->');
    expect(out).toContain('декартово');
  });
});

describe('экранирование', () => {
  it('кавычки и скобки в подписи не ломают mermaid', () => {
    const batch: BatchDocument = {
      members: [q({ tables: [{ id: 'A', fullName: 'Справочник."Странное[имя]"', alias: 'A' }] })],
    };
    const out = buildDiagram(batch, 'joinTree', 0);
    // подпись узла не содержит сырых "/[/] (проверяем построчно)
    const nodeLine = out.split('\n').find(l => l.includes('Справочник'))!;
    const label = nodeLine.slice(nodeLine.indexOf('"') + 1, nodeLine.lastIndexOf('"'));
    expect(label).not.toMatch(/["[\]]/);
    expect(out).toContain("Справочник.'Странное имя'");
  });
});
