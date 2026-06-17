/**
 * Конфигурация драйвера реального конструктора. Источники (по возрастанию приоритета):
 * дефолты < корневой `.env` < `process.env`. Парсер `.env` переиспользуется из corpusConfig (DRY).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseEnv } from '../../src/cli/corpusConfig';

export interface RealConstructorConfig {
  /** Базовый URL веб-публикации, всегда с завершающим `/`. */
  webUrl: string;
  user: string;
  password: string;
}

const DEFAULTS: Record<string, string> = {
  WEB_1C_URL: 'http://host.docker.internal/smallb/ru_RU/',
  USER_1C: '',
  PASSWORD_1C: '',
};

export function getRealConstructorConfig(root = process.cwd()): RealConstructorConfig {
  const envFile = path.join(root, '.env');
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const resolve = (key: string): string => process.env[key] ?? fileEnv[key] ?? DEFAULTS[key] ?? '';
  let webUrl = resolve('WEB_1C_URL').trim();
  if (!webUrl.endsWith('/')) webUrl += '/';
  return { webUrl, user: resolve('USER_1C'), password: resolve('PASSWORD_1C') };
}
