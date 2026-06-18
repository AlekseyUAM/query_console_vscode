/**
 * Уникальные простые поля выборки для исходных списков «Поля» (Порядок/Итоги/…).
 * Несколько колонок выборки могут делить (tableId, path) под разными псевдонимами
 * (`Т.Дата КАК Дата`, `Т.Дата КАК ДатаЗаказа`) — в списке-источнике, который
 * адресует поля по (tableId, path), это давало визуальный дубль (фаза 7.5, E2).
 */
export function distinctFieldRefs<T extends { tableId: string; path?: string; expression?: string }>(fields: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of fields) {
    if (f.expression || !f.path) continue;
    const key = `${f.tableId}:${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
