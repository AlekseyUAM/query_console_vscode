import type { QueryModel, SelectedField } from './queryModel';
import { fieldExpr } from './sdblGenerator';

/** Один запрос-участник объединения. */
export interface UnionMember {
  name: string;
  /** true → ОБЪЕДИНИТЬ (без дубликатов); false → ОБЪЕДИНИТЬ ВСЕ. */
  distinct: boolean;
  model: QueryModel;
}

/** Колонка объединения: общий псевдоним и выражение каждого участника (или null). */
export interface UnionColumn {
  alias: string;
  cells: (string | null)[];
}

/** Документ конструктора: набор запросов-участников объединения. */
export interface QueryDocument {
  members: UnionMember[];
}

/**
 * Псевдоним поля для целей объединения: явный `alias`, иначе последний сегмент
 * пути; для произвольного поля без псевдонима — сам текст выражения.
 */
export function fieldAlias(field: SelectedField): string {
  if (field.alias) return field.alias;
  if (field.expression) return field.expression;
  return field.path.split('.').pop()!;
}

/**
 * Колонки вертикального объединения.
 *
 * 1. Порядок колонок — по первому появлению псевдонима среди участников
 *    (сначала поля участника 0, затем новые псевдонимы участника 1 и т.д.).
 *    Учитываются только `model.fields` (табличные части и хвостовые поля
 *    в объединении не участвуют).
 * 2. Для каждой колонки `cells[i]` — выражение поля участника i, чей псевдоним
 *    совпадает с псевдонимом колонки, иначе null.
 */
export function deriveUnionColumns(members: UnionMember[]): UnionColumn[] {
  const order: string[] = [];
  const index = new Map<string, number>();

  for (const m of members) {
    for (const f of m.model.fields) {
      const alias = fieldAlias(f);
      if (!index.has(alias)) {
        index.set(alias, order.length);
        order.push(alias);
      }
    }
  }

  const columns: UnionColumn[] = order.map(alias => ({
    alias,
    cells: members.map(() => null as string | null),
  }));

  members.forEach((m, i) => {
    for (const f of m.model.fields) {
      const alias = fieldAlias(f);
      const col = columns[index.get(alias)!];
      // Первое поле с данным псевдонимом у участника определяет выражение ячейки.
      if (col.cells[i] === null) col.cells[i] = fieldExpr(m.model, f);
    }
  });

  return columns;
}
