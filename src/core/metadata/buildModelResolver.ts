/**
 * Построение `MetadataResolver` из in-memory модели метаданных (`MetaTable[]`).
 *
 * Единый источник правды для резолва таблиц: им пользуются и YAML-кэш
 * (`buildYamlResolver` делегирует сюда), и webview (резолвер из дерева
 * `metadataTree`). Строит три карты — те же, что и прежний YAML-резолвер:
 *   - `byFull`: реальные таблицы по полному имени (развёртка `*`, проверка
 *     существования);
 *   - `byFullVirtual`: виртуальные таблицы (срезы РС / Остатки-Обороты) отдельным
 *     слоем (`tableByFullName` намеренно их НЕ возвращает — приоритет реальной);
 *   - `canonByUpper`: канонические полные имена по ВЕРХ-регистру (регистро-
 *     независимый резолв), включая табличные части (3-сегментное имя).
 */
import type { MetadataResolver } from '../query/metadataResolver';
import type { MetaTable } from './types';

export function buildResolverFromTables(tables: MetaTable[]): MetadataResolver {
  const byFull = new Map<string, MetaTable>();
  const byFullVirtual = new Map<string, MetaTable>();
  const canonByUpper = new Map<string, string>();
  for (const t of tables) {
    // Развёртка `*` по РЕАЛЬНОЙ таблице приоритетна; виртуальные — отдельным слоем.
    if (t.virtual) {
      if (!byFullVirtual.has(t.fullName)) byFullVirtual.set(t.fullName, t);
      continue;
    }
    if (!byFull.has(t.fullName)) byFull.set(t.fullName, t);
    const up = t.fullName.toUpperCase();
    if (!canonByUpper.has(up)) canonByUpper.set(up, t.fullName);
    for (const ts of t.tabularSections ?? []) {
      const tup = ts.fullName.toUpperCase();
      if (!canonByUpper.has(tup)) canonByUpper.set(tup, ts.fullName);
    }
  }
  return {
    tableByFullName: (fullName) => byFull.get(fullName),
    virtualTableByFullName: (fullName) => byFullVirtual.get(fullName),
    canonicalFullName: (fullName) => canonByUpper.get(fullName.toUpperCase()),
  };
}
