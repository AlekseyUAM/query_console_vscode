import type { BatchDocument } from './batchModel';
import type { QueryDocument } from './unionModel';
import type {
  QueryModel, SelectedTable, Join, FieldRef, OrderField, TotalField, Condition,
} from './queryModel';
import { orderedSelectElements, elementAlias } from './unionModel';

export type DiagramKind = 'packageFlow' | 'joins' | 'unions' | 'fields';

/** Экранирование подписи узла/ребра: убираем ломающие mermaid символы. */
function esc(label: string): string {
  const s = String(label ?? '')
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]{}|<>]/g, ' ')
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

/** Модель «головного» участника запроса пакета (для joins/fields). */
function headModel(doc: QueryDocument): QueryModel | undefined {
  return doc.members[0]?.model;
}

export function buildDiagram(
  batch: BatchDocument,
  kind: DiagramKind,
  activeIndex: number,
): string {
  try {
    const active = batch.members[activeIndex];
    switch (kind) {
      case 'packageFlow':
        return packageFlowDiagram(batch);
      case 'joins': {
        const m = active && headModel(active);
        return m ? joinsDiagram(m) : placeholder();
      }
      case 'unions':
        return active ? unionsDiagram(active) : placeholder();
      case 'fields': {
        const m = active && headModel(active);
        return m ? fieldsDiagram(m) : placeholder();
      }
      default:
        return placeholder();
    }
  } catch {
    return placeholder();
  }
}

// --- генераторы (заглушки; реальные реализации — Tasks 2–5) ---

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

function joinsDiagram(model: QueryModel): string {
  if (!model.tables.length) return placeholder();
  const lines = ['graph LR'];
  const idOf = new Map<string, string>();
  model.tables.forEach((t, i) => {
    const nid = `t${i}`;
    idOf.set(t.id, nid);
    lines.push(node(nid, tableLabel(t)));
  });
  for (const j of model.joins ?? []) {
    const l = idOf.get(j.leftTableId);
    const r = idOf.get(j.rightTableId);
    if (!l || !r) continue;
    const cond = joinConditionText(j);
    const label = cond ? `${joinKindLabel(j)}: ${cond}` : joinKindLabel(j);
    lines.push(edge(l, r, label));
  }
  return lines.join('\n');
}

function unionsDiagram(_doc: QueryDocument): string {
  return placeholder();
}

function fieldsDiagram(_model: QueryModel): string {
  return placeholder();
}
