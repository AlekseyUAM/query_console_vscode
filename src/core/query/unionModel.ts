import type { QueryModel, SelectedField } from './queryModel';
import { fieldExpr, synthesizedFieldAlias } from './sdblGenerator';

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
 * Псевдоним поля для целей объединения/совпадения: явный `alias`, иначе
 * синтезированный конструктором (склейка сегментов у квалифицированного поля,
 * последний сегмент у голого — см. synthesizedFieldAlias); для произвольного
 * поля без псевдонима — сам текст выражения. `model` нужна для определения
 * ТЧ-источника при склейке; без неё — последний сегмент (legacy-вызовы).
 */
export function fieldAlias(field: SelectedField, model?: QueryModel): string {
  if (field.alias) return field.alias;
  if (field.expression) return field.expression;
  if (model) return synthesizedFieldAlias(model, field);
  return field.path.split('.').pop()!;
}

/**
 * Колонки вертикального объединения.
 *
 * 1С выравнивает столбцы объединения ПОЗИЦИОННО (по индексу), а не по псевдониму:
 *   - количество колонок = число полей у участника 0 (он задаёт «форму» union;
 *     при расхождении ширины 1С ругается, но если ширина прочих участников больше,
 *     лишние ячейки тоже выводятся, поэтому берём максимум по всем участникам);
 *   - заголовок i-й колонки = псевдоним i-го поля участника 0;
 *   - `cells[k][i]` = выражение i-го поля участника k «как есть» (даже если функция
 *     или псевдоним отличаются от других веток); отсутствующее поле → null (→ NULL).
 *
 * Учитываются только `model.fields` (табличные части и хвостовые поля в объединении
 * не участвуют).
 */
export function deriveUnionColumns(members: UnionMember[]): UnionColumn[] {
  const width = members.reduce((w, m) => Math.max(w, m.model.fields.length), 0);
  const head = members[0]?.model.fields ?? [];

  const columns: UnionColumn[] = [];
  for (let i = 0; i < width; i++) {
    const headField = head[i];
    columns.push({
      // Заголовок колонки — псевдоним соответствующего поля первого участника.
      alias: headField ? fieldAlias(headField, members[0].model) : `Поле${i + 1}`,
      cells: members.map(m => {
        const f = m.model.fields[i];
        return f ? fieldExpr(m.model, f) : null;
      }),
    });
  }

  return columns;
}
