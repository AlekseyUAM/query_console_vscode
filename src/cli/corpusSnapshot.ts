/**
 * Снимок корпусного эталона в git: копирует свежий golden + YAML-кэш метаданных
 * из рабочего прогона (`QUERY_CORPUS_DIR/oracle/golden.jsonl`, `METADATA_CACHE_DIR/cf`)
 * в закоммиченную фикстуру `test/fixtures/corpus/{golden.jsonl, metadata/cf}`.
 *
 * Запускать ПОСЛЕ осознанного изменения конструктора и пере-harvest, когда
 * `npm run accept:oracle` снова даёт 1976/1976 — обновляет гейт `corpusRegression.test.ts`.
 *
 * Запуск: node out/cli/corpusSnapshot.js
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, goldenPath } from './corpusConfig';

function run(): void {
  const cfg = getConfig();
  const srcGolden = goldenPath(cfg);
  const srcMeta = path.join(cfg.metadataCacheDir, 'cf');
  const destDir = path.resolve('test/fixtures/corpus');
  const destGolden = path.join(destDir, 'golden.jsonl');
  const destMeta = path.join(destDir, 'metadata', 'cf');

  if (!fs.existsSync(srcGolden)) { console.error(`Нет ${srcGolden} — сначала npm run harvest`); process.exit(1); }
  if (!fs.existsSync(srcMeta)) { console.error(`Нет ${srcMeta} — сначала npm run parse`); process.exit(1); }

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcGolden, destGolden);
  fs.rmSync(path.join(destDir, 'metadata'), { recursive: true, force: true });
  fs.cpSync(srcMeta, destMeta, { recursive: true });

  const lines = fs.readFileSync(destGolden, 'utf8').split('\n').filter((l) => l.trim()).length;
  console.log(`Снимок обновлён: ${lines} запросов → ${destGolden}`);
  console.log(`Метаданные → ${destMeta}`);
}

if (require.main === module) run();
