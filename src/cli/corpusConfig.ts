/**
 * Единый загрузчик конфигурации корпусного тестирования.
 *
 * Источники путей (приоритет по возрастанию): дефолты < корневой `.env` < `process.env`.
 * Все каталоги резолвятся в абсолютные пути относительно корня репозитория.
 * Зависимостей нет — парсер `.env` написан вручную.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface CorpusConfig {
  metaQueriesDir: string;
  configDir: string;
  metadataCacheDir: string;
  queryCorpusDir: string;
  errorsDir: string;
  mcpUrl?: string;
}

/** Разобрать содержимое `.env`: пропустить пустые строки и `#`-комментарии, KEY=VALUE, снять кавычки. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const DEFAULTS: Record<string, string> = {
  META_QUERIES_DIR: 'tmp/meta1c',
  CONFIG_DIR: 'src/cf',
  METADATA_CACHE_DIR: 'tmp/parser_data',
  QUERY_CORPUS_DIR: 'tmp/query1c',
  ERRORS_DIR: 'tmp/corpus-errors',
  MCP_URL: '',
};

export function getConfig(root = process.cwd()): CorpusConfig {
  const envFile = path.join(root, '.env');
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};

  const resolveKey = (key: string): string => {
    const raw = process.env[key] ?? fileEnv[key] ?? DEFAULTS[key];
    return raw ?? DEFAULTS[key];
  };

  const mcpRaw = resolveKey('MCP_URL').trim();

  return {
    metaQueriesDir: path.resolve(root, resolveKey('META_QUERIES_DIR')),
    configDir: path.resolve(root, resolveKey('CONFIG_DIR')),
    metadataCacheDir: path.resolve(root, resolveKey('METADATA_CACHE_DIR')),
    queryCorpusDir: path.resolve(root, resolveKey('QUERY_CORPUS_DIR')),
    errorsDir: path.resolve(root, resolveKey('ERRORS_DIR')),
    mcpUrl: mcpRaw === '' ? undefined : mcpRaw,
  };
}

export function goldenPath(cfg: CorpusConfig): string {
  return path.join(cfg.queryCorpusDir, 'oracle', 'golden.jsonl');
}
