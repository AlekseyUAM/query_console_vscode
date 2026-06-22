import type { BatchDocument } from './batchModel';
import type { QueryDocument } from './unionModel';
import type { QueryModel, SelectedTable, Join } from './queryModel';

export type DiagramKind = 'flowchart' | 'joinTree';

/** Экранирование подписи узла/ребра: убираем ломающие mermaid символы. */
function esc(label: string): string {
  const s = String(label ?? '')
    .replace(/[[\]{}|<>]/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/ '/g, "'")
    .trim();
  return s.length ? s : ' ';
}

function node(id: string, label: string): string {
  return `  ${id}["${esc(label)}"]`;
}

function edge(from: string, to: string, label?: string): string {
  return label != null && label.length
    ? `  ${from} -->|"${esc(label)}"| ${to}`
    : `  ${from} --> ${to}`;
}

function placeholder(): string {
  return 'graph TD\n' + node('n0', 'Пустой запрос');
}

/** Модель «головного» участника запроса пакета. */
function headModel(doc: QueryDocument): QueryModel | undefined {
  return doc.members[0]?.model;
}

export function buildDiagram(
  batch: BatchDocument,
  kind: DiagramKind,
  activeIndex: number,
): string {
  void activeIndex;
  try {
    switch (kind) {
      case 'flowchart':
        return packageFlowDiagram(batch);
      case 'joinTree':
        return joinTreeDiagram(batch);
      default:
        return placeholder();
    }
  } catch {
    return placeholder();
  }
}

// --- генераторы диаграмм ---

function packageNodeLabel(doc: QueryDocument, i: number): string {
  const m = headModel(doc);
  const qt = m?.queryType;
  const name = m?.tempTableName;
  if ((qt === 'createTemp' || qt === 'appendTemp') && name) {
    return `${i + 1}. ПОМЕСТИТЬ ${name}`;
  }
  if (qt === 'dropTemp' && name) {
    return `${i + 1}. УНИЧТОЖИТЬ ${name}`;
  }
  return `Запрос ${i + 1}`;
}

function packageFlowDiagram(batch: BatchDocument): string {
  if (!batch.members.length) return placeholder();
  const lines = ['graph TD'];

  // Имя ВТ (в верхнем регистре) → индекс запроса-производителя.
  const producer = new Map<string, number>();
  batch.members.forEach((doc, i) => {
    const m = headModel(doc);
    if ((m?.queryType === 'createTemp' || m?.queryType === 'appendTemp') && m.tempTableName) {
      producer.set(m.tempTableName.toUpperCase(), i);
    }
    lines.push(node(`q${i}`, packageNodeLabel(doc, i)));
  });

  // Ребро на каждую таблицу-потребителя, чьё имя совпало с произведённой ВТ.
  batch.members.forEach((doc, i) => {
    const seen = new Set<string>();
    for (const um of doc.members) {
      for (const t of um.model.tables) {
        const key = (t.fullName ?? '').toUpperCase();
        const p = producer.get(key);
        if (p == null || p === i) continue;
        const ek = `${p}->${i}:${key}`;
        if (seen.has(ek)) continue;
        seen.add(ek);
        lines.push(edge(`q${p}`, `q${i}`, t.fullName));
      }
    }
  });

  return lines.join('\n');
}

function tableLabel(t: SelectedTable): string {
  if (t.alias && t.alias !== t.fullName) return `${t.fullName} (${t.alias})`;
  return t.fullName || t.alias || 'Таблица';
}

function joinKindLabel(j: Join): string {
  if (j.leftAll && j.rightAll) return 'ПОЛНОЕ';
  if (j.leftAll) return 'ЛЕВОЕ';
  if (j.rightAll) return 'ПРАВОЕ';
  return 'ВНУТРЕННЕЕ';
}

function joinConditionText(j: Join): string {
  if (j.expression) return j.expression;
  if (j.leftPath && j.rightPath) return `${j.leftPath} ${j.operator ?? '='} ${j.rightPath}`;
  return '';
}

/** Виртуальная таблица регистра → узел-цилиндр. */
function isRegister(t: SelectedTable): boolean {
  return !!t.virtual || /^Регистр(Сведений|Накопления|Бухгалтерии|Расчета)\./.test(t.fullName || '');
}

/** Заголовок субграфа запроса пакета (`Запрос N · <суффикс>`). */
function jtTitle(model: QueryModel | undefined, i: number): string {
  const qt = model?.queryType;
  const name = model?.tempTableName;
  if ((qt === 'createTemp' || qt === 'appendTemp') && name) {
    return `Запрос ${i + 1} · ВТ.${name}`;
  }
  if (qt === 'dropTemp' && name) {
    return `Запрос ${i + 1} · УНИЧТОЖИТЬ ${name}`;
  }
  return `Запрос ${i + 1}`;
}

/** Дерево соединений всего пакета (см. tmp/1.md, раздел 3). */
function joinTreeDiagram(batch: BatchDocument): string {
  if (!batch.members.length) return placeholder();
  const lines = ['graph TD'];

  const firsts: string[] = [];
  const lasts: string[] = [];

  batch.members.forEach((doc, i) => {
    const model = doc.members[0]?.model;
    lines.push(`  subgraph JT${i}["${esc(jtTitle(model, i))}"]`);

    const tables = model?.tables ?? [];
    if (!tables.length) {
      const only = `q${i}t0`;
      lines.push(`    ${only}["${esc('(нет таблиц)')}"]`);
      firsts[i] = only;
      lasts[i] = only;
      lines.push('  end');
      return;
    }

    const nodeId = (j: number): string => `q${i}t${j}`;
    const idOf = new Map<string, string>();
    tables.forEach((t, j) => idOf.set(t.id, nodeId(j)));

    // Узлы таблиц.
    tables.forEach((t, j) => {
      const id = nodeId(j);
      const label = t.subquery ? `(подзапрос ${t.alias || ''})` : tableLabel(t);
      if (isRegister(t)) {
        lines.push(`    ${id}[("${esc(label)}")]`);
      } else {
        lines.push(`    ${id}["${esc(label)}"]`);
      }
    });

    // Рёбра соединений.
    const linked = new Set<string>();
    for (const j of model?.joins ?? []) {
      const fromTableId = j.seedTableId ?? j.leftTableId;
      const toTableId = j.joinedTableId ?? j.rightTableId;
      const from = idOf.get(fromTableId);
      const to = idOf.get(toTableId);
      if (!from || !to) continue;
      const cond = joinConditionText(j);
      const kind = joinKindLabel(j);
      const label = cond ? `${cond} · ${kind}` : kind;
      lines.push(`    ${from} -->|"${esc(label)}"| ${to}`);
      linked.add(fromTableId);
      linked.add(toTableId);
    }

    // Декартовы связи: первая таблица → каждая не участвовавшая в соединении.
    const root = nodeId(0);
    tables.forEach((t, j) => {
      if (j === 0) return;
      if (linked.has(t.id)) return;
      lines.push(`    ${root} -.->|"${esc('декартово (ГДЕ)')}"| ${nodeId(j)}`);
    });

    firsts[i] = nodeId(0);
    lasts[i] = nodeId(tables.length - 1);
    lines.push('  end');
  });

  // Вертикальные коннекторы между запросами пакета.
  for (let i = 1; i < batch.members.length; i++) {
    lines.push(`  ${lasts[i - 1]} -.-> ${firsts[i]}`);
  }

  return lines.join('\n');
}
