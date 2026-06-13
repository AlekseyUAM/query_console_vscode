/**
 * Внедрение «эталонных» запросов к метаданным в корпус: копирует каждый
 * `*.txt` из META_QUERIES_DIR в QUERY_CORPUS_DIR с префиксом `meta__<имя>`,
 * нормализуя содержимое (снять BOM, CRLF→LF). Эталоны проходят затем через ту же
 * приёмку, что и config-извлечённые запросы.
 *
 * Запуск: node out/cli/ingestMeta.js
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './corpusConfig';

function normalize(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function run(): void {
  const cfg = getConfig();
  const srcDir = cfg.metaQueriesDir;
  const outDir = cfg.queryCorpusDir;

  if (!fs.existsSync(srcDir)) {
    console.log(`Каталог эталонов отсутствует: ${srcDir} — пропуск.`);
    return;
  }

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.txt')).sort();
  if (files.length === 0) {
    console.log(`Эталонов нет в ${srcDir} — пропуск.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0;
  for (const f of files) {
    const text = normalize(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    fs.writeFileSync(path.join(outDir, `meta__${f}`), text, 'utf8');
    copied++;
  }

  console.log(`Скопировано эталонов: ${copied} → ${outDir}`);
}

if (require.main === module) run();
