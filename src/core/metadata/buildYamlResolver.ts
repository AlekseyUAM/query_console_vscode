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
  for (const t of model.tables) {
    // Развёртка `*` идёт по РЕАЛЬНОЙ таблице (не по виртуальным срезам).
    if (t.virtual) continue;
    if (!byFull.has(t.fullName)) byFull.set(t.fullName, t);
  }
  return { tableByFullName: (fullName) => byFull.get(fullName) };
}
