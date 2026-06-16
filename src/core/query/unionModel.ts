import type { QueryModel, SelectedField, SelectedTabSectionField } from './queryModel';
import { fieldExpr, synthesizedFieldAlias } from './sdblGenerator';

/** Один запрос-участник объединения. */
export interface UnionMember {
  name: string;
  /** true → ОБЪЕДИНИТЬ (без дубликатов); false → ОБЪЕДИНИТЬ ВСЕ. */
  distinct: boolean;
  model: QueryModel;
}

/**
 * Один элемент списка выборки участника в ИСХОДНОМ порядке (selectOrder):
 * скалярное поле или проекция табличной части. Используется для позиционного
 * выравнивания столбцов объединения (проекция ТЧ — полноценный столбец, фаза 6.16).
 */
export type SelectElement =
  | { kind: 'field'; field: SelectedField }
  | { kind: 'ts'; tsf: SelectedTabSectionField };

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
 * Список элементов выборки участника в ИСХОДНОМ порядке выборки: скалярные поля
 * (`model.fields`), проекции ТЧ (`tabSectionFields`) и хвостовые поля
 * (`trailingFields`), упорядоченные по `selectOrder`. Голова (`model.fields`) идёт
 * первой; остальные перемежаются по selectOrder РОВНО как в buildFieldLines —
 * только когда он задан у ВСЕХ (чистая парсерная модель); иначе сохраняется
 * прежний бакет-порядок (все ТЧ, затем хвостовые поля).
 */
export function orderedSelectElements(model: QueryModel): SelectElement[] {
  const head: SelectElement[] = model.fields.map(field => ({ kind: 'field', field }));
  type Item = { order: number | undefined; seq: number; el: SelectElement };
  const rest: Item[] = [];
  let seq = 0;
  for (const tsf of model.tabSectionFields ?? []) {
    rest.push({ order: tsf.selectOrder, seq: seq++, el: { kind: 'ts', tsf } });
  }
  for (const field of model.trailingFields ?? []) {
    rest.push({ order: field.selectOrder, seq: seq++, el: { kind: 'field', field } });
  }
  if (rest.every(it => it.order !== undefined)) {
    rest.sort((a, b) => (a.order! - b.order!) || (a.seq - b.seq));
  }
  return [...head, ...rest.map(it => it.el)];
}

/**
 * Колонки вертикального объединения (ТОЛЬКО скалярные поля `model.fields`).
 *
 * 1С выравнивает столбцы объединения ПОЗИЦИОННО (по индексу), а не по псевдониму:
 *   - количество колонок = число полей у участника 0 (он задаёт «форму» union;
 *     при расхождении ширины берём максимум по всем участникам);
 *   - заголовок i-й колонки = псевдоним i-го поля участника 0;
 *   - `cells[k][i]` = выражение i-го поля участника k «как есть»; отсутствующее
 *     поле → null (→ NULL).
 *
 * Проекции ТЧ и хвостовые поля здесь НЕ учитываются — для объединений с проекцией
 * ТЧ генератор (`generateDocument`) строит строки из `orderedSelectElements`,
 * которые включают ТЧ как полноценный столбец (фаза 6.16). Эта функция оставлена
 * для скалярных объединений и обратной совместимости (UI/тесты).
 */
export function deriveUnionColumns(members: UnionMember[]): UnionColumn[] {
  const width = members.reduce((w, m) => Math.max(w, m.model.fields.length), 0);
  const head = members[0]?.model.fields ?? [];

  const columns: UnionColumn[] = [];
  for (let i = 0; i < width; i++) {
    const headField = head[i];
    columns.push({
      alias: headField ? fieldAlias(headField, members[0].model) : `Поле${i + 1}`,
      cells: members.map(m => {
        const f = m.model.fields[i];
        return f ? fieldExpr(m.model, f) : null;
      }),
    });
  }

  return columns;
}

/**
 * Есть ли в каком-либо участнике объединения проекция ТЧ. Признак, что выравнивать
 * столбцы нужно по `orderedSelectElements` (включая ТЧ/хвостовые поля), а не по
 * `deriveUnionColumns` (только скалярные `model.fields`).
 */
export function unionHasTabSection(members: UnionMember[]): boolean {
  return members.some(m => (m.model.tabSectionFields?.length ?? 0) > 0);
}

/**
 * Есть ли в каком-либо участнике объединения ХВОСТОВЫЕ поля (`trailingFields`):
 * явные поля выборки, идущие ПОСЛЕ развёрнутой звезды `Алиас.*` (источник —
 * табличная часть/таблица). Скалярный путь `deriveUnionColumns` учитывает только
 * `model.fields` и такие хвостовые столбцы терял; при их наличии выравниваем по
 * `orderedSelectElements` (как и при проекции ТЧ).
 */
export function unionHasTrailing(members: UnionMember[]): boolean {
  return members.some(m => (m.model.trailingFields?.length ?? 0) > 0);
}

/** Псевдоним столбца-элемента участника-головы (поле → fieldAlias; ТЧ → её псевдоним). */
export function elementAlias(el: SelectElement, model: QueryModel): string {
  if (el.kind === 'field') return fieldAlias(el.field, model);
  return el.tsf.alias ?? el.tsf.tsName;
}
