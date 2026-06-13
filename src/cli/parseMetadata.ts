import * as fs from 'fs';
import * as path from 'path';
import { parseConfiguration } from '../core/metadata/parser/parseConfiguration';
import { getConfig } from './corpusConfig';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function main(): void {
  const cfg = getConfig();
  const cf = path.resolve(getArg('cf') ?? cfg.configDir);
  const out = getArg('out') ?? cfg.metadataCacheDir;

  if (!fs.existsSync(cf)) {
    console.error(`Каталог cf не найден: ${cf}`);
    process.exit(1);
  }

  const s = parseConfiguration(cf, out);
  const c = s.counts;
  console.log(
    `Справочники: ${c['Справочник'] || 0}  Документы: ${c['Документ'] || 0}  ` +
      `Константы: ${c['Константа'] || 0}  Перечисления: ${c['Перечисление'] || 0}`
  );
  console.log(`Пропущено (ошибки парсинга): ${s.skipped}`);
  console.log(`→ ${s.outCfDir}`);

  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.error('Распарсено 0 объектов');
    process.exit(1);
  }
}

main();
