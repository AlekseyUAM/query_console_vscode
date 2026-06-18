import * as fs from 'fs';
import * as path from 'path';
import type { MetaTable } from '../../src/core/metadata/types';

/** Путь к кэшу реальных метаданных (результат парсинга выгрузки конфигурации). */
export const MODEL_CACHE = path.resolve('tmp/parser_data/model-cache.json');

/**
 * Читает `tmp/parser_data/model-cache.json` и возвращает `model.tables` — это уже
 * готовый `MetaTable[]` для сообщения `metadataTree` (как в боевом расширении).
 */
export function loadMetaTables(file = MODEL_CACHE): MetaTable[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { model?: { tables?: MetaTable[] } };
  const tables = raw.model?.tables;
  if (!Array.isArray(tables)) {
    throw new Error(`Неожиданная структура ${file}: нет model.tables`);
  }
  return tables;
}

/** Пишет метаданные в harness-каталог как metadata.json (его подгрузит мок acquireVsCodeApi). */
export function writeHarnessMetadata(harnessDir: string, tables: MetaTable[]): string {
  const out = path.join(harnessDir, 'metadata.json');
  fs.writeFileSync(out, JSON.stringify(tables), 'utf8');
  return out;
}
