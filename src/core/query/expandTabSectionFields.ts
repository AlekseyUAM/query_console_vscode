import type { QueryModel, SelectedField, SelectedTabSectionField } from './queryModel';
import type { MetadataResolver } from './metadataResolver';

/**
 * Развёртка ссылки на ТАБЛИЧНУЮ ЧАСТЬ в проекцию её колонок по метаданным
 * (фаза 6.15.23).
 *
 * Конструктор 1С: простое поле выборки `Алиас.ТЧ КАК ТЧ`, где последний сегмент
 * пути — имя табличной части таблицы-источника, разворачивается в проекцию
 * табличной части по её колонкам из метаданных:
 *   `Алиас.ТЧ КАК ТЧ` → `Алиас.ТЧ.(Ссылка КАК Ссылка, НомерСтроки КАК НомерСтроки,
 *                              <реквизит> КАК <реквизит>, …) КАК ТЧ`
 * Состав и порядок колонок — ровно `tabularSections[i].fields` метаданных
 * (стандартные `Ссылка`/`НомерСтроки` + реквизиты ТЧ). Подтверждено MCP
 * validate_query.
 *
 * Геометрия списка выборки (как у парсера для явной проекции ТЧ, фаза 6.15.20):
 * поля ДО первой проекции ТЧ остаются в `model.fields` (печатаются первыми, без
 * selectOrder); сама проекция ТЧ и все последующие элементы уходят в
 * `tabSectionFields`/`trailingFields` со сквозным `selectOrder`, по которому
 * генератор восстанавливает исходное перемежение.
 *
 * Без резолвера развёртка не выполняется (поведение прежнее: webview/extension
 * без метаданных). Применяется к одному QueryModel (участники объединения —
 * по отдельности вызывающим), как и `expandStarFields`.
 */
export function expandTabSectionFields(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  if (model.fields.length === 0) return;
  // Если в выборке уже есть явная проекция ТЧ — selectOrder проставлен парсером, и
  // конвертация смешала бы две схемы нумерации. Такие случаи в корпусе не требуют
  // развёртки простого поля-ТЧ; оставляем как есть.
  if (model.tabSectionFields && model.tabSectionFields.length > 0) return;

  // Псевдоним источника → fullName (по id таблицы). Подзапросы пропускаем.
  const idToFull = new Map<string, string>();
  for (const t of model.tables) {
    if (!t.subquery) idToFull.set(t.id, t.fullName);
  }

  const tsColumns = (fullName: string, tsName: string): string[] | undefined => {
    const meta = resolver.tableByFullName(fullName);
    if (!meta || !meta.tabularSections) return undefined;
    const ts = meta.tabularSections.find(s => s.name.toUpperCase() === tsName.toUpperCase());
    if (!ts) return undefined;
    return ts.fields.map(f => f.name);
  };

  // Индекс ПЕРВОГО конвертируемого поля (простое поле, путь = имя ТЧ источника).
  // Навигацию через ссылку (`Поле.ТЧ`) не трогаем.
  const convInfo = (f: SelectedField): { tsName: string; columns: string[] } | undefined => {
    if (f.expression !== undefined || f.func !== undefined) return undefined;
    const segs = f.path.split('.');
    if (segs.length !== 1) return undefined;
    const full = idToFull.get(f.tableId);
    if (!full) return undefined;
    const cols = tsColumns(full, segs[0]);
    return cols ? { tsName: segs[0], columns: cols } : undefined;
  };

  const firstIdx = model.fields.findIndex(f => convInfo(f) !== undefined);
  if (firstIdx === -1) return;

  const head: SelectedField[] = model.fields.slice(0, firstIdx);
  const tabSections: SelectedTabSectionField[] = [];
  const trailing: SelectedField[] = [];

  let order = firstIdx;
  for (let i = firstIdx; i < model.fields.length; i++) {
    const f = model.fields[i];
    const conv = convInfo(f);
    if (conv) {
      tabSections.push({
        tableId: f.tableId,
        tsName: conv.tsName,
        tsFullName: `${idToFull.get(f.tableId)}.${conv.tsName}`,
        fields: conv.columns,
        alias: f.alias ?? conv.tsName,
        selectOrder: order++,
      });
    } else {
      trailing.push({ ...f, selectOrder: order++ });
    }
  }

  model.fields = head;
  model.tabSectionFields = tabSections;
  if (trailing.length) model.trailingFields = [...trailing, ...(model.trailingFields ?? [])];
}
