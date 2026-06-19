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

function packageFlowDiagram(_batch: BatchDocument): string {
  return placeholder();
}

function joinsDiagram(_model: QueryModel): string {
  return placeholder();
}

function unionsDiagram(_doc: QueryDocument): string {
  return placeholder();
}

function fieldsDiagram(_model: QueryModel): string {
  return placeholder();
}
