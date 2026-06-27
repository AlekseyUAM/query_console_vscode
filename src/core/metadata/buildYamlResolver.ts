/**
 * Построение `MetadataResolver` из YAML-кэша метаданных (`<dir>/cf`-уровень).
 *
 * Резолвер нужен слою приёмки (`oracleAccept`) и корпусному регресс-тесту для
 * развёртки `ВЫБРАТЬ *` / `Таблица.*` (фаза 6.15.15): состав колонок берётся из
 * РЕАЛЬНОЙ таблицы по её полному имени. Если каталог отсутствует/пуст — резолвер
 * не строится (звезда не разворачивается, поведение прежнее).
 *
 * Логика построения карт вынесена в `buildResolverFromTables` (единый источник
 * правды, общий с webview-резолвером); здесь — лишь загрузка модели из ФС.
 */
import * as fs from 'fs';
import { loadMetadataFromYaml } from './yamlLoader';
import { buildResolverFromTables } from './buildModelResolver';
import type { MetadataResolver } from '../query/metadataResolver';

export function buildYamlResolver(cfDir: string): MetadataResolver | undefined {
  if (!fs.existsSync(cfDir)) return undefined;
  const model = loadMetadataFromYaml(cfDir);
  return buildResolverFromTables(model.tables);
}
