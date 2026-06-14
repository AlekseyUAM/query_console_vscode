/**
 * Построение `MetadataResolver` из YAML-кэша метаданных (`<dir>/cf`-уровень).
 *
 * Резолвер нужен слою приёмки (`oracleAccept`) и корпусному регресс-тесту для
 * развёртки `ВЫБРАТЬ *` / `Таблица.*` (фаза 6.15.15): состав колонок берётся из
 * РЕАЛЬНОЙ таблицы по её полному имени. Если каталог отсутствует/пуст — резолвер
 * не строится (звезда не разворачивается, поведение прежнее).
 */
import * as fs from 'fs';
import { loadMetadataFromYaml } from './yamlLoader';
import type { MetadataResolver } from '../query/metadataResolver';
import type { MetaTable } from './types';

export function buildYamlResolver(cfDir: string): MetadataResolver | undefined {
  if (!fs.existsSync(cfDir)) return undefined;
  const model = loadMetadataFromYaml(cfDir);
  const byFull = new Map<string, MetaTable>();
  // Канонические полные имена по ВЕРХНЕМУ регистру (фаза 6.16.49): конструктор 1С
  // печатает имя метаданных в каноническом написании, тогда как источник может
  // нести произвольный регистр. Индекс покрывает и табличные части (3-сегментное
  // имя), чьё каноническое имя живёт в `tabularSections[].fullName`.
  const canonByUpper = new Map<string, string>();
  for (const t of model.tables) {
    // Развёртка `*` идёт по РЕАЛЬНОЙ таблице (не по виртуальным срезам).
    if (t.virtual) continue;
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
    canonicalFullName: (fullName) => canonByUpper.get(fullName.toUpperCase()),
  };
}
