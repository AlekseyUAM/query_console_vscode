/**
 * Сборщик golden-эталонов: для каждого tmp/query1c/*.txt вызывает validate_query
 * и дописывает строку в tmp/query1c/oracle/golden.jsonl. Резюмируемо.
 *
 * Это единственная ступень конвейера с доступом к mcp, поэтому здесь же — ворота
 * валидности корпуса: запрос, который не проходит validate_query, в golden НЕ
 * попадает, а его исходный .txt удаляется из tmp/query1c. После прогона корпус и
 * golden содержат только валидные запросы (extractQueries — чистый текст-скан без
 * валидации — пишет все литералы; отбраковка происходит здесь).
 *
 * Запуск: node out/cli/harvestOracle.js [--force]
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateQuery, readMcpUrl, normalizeQueryText } from './mcpClient';
import { getConfig } from './corpusConfig';

const CONCURRENCY = 8;

function normInput(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

export async function run(): Promise<void> {
  const force = process.argv.includes('--force');
  const cfg = getConfig();
  const corpusDir = cfg.queryCorpusDir;
  const outDir = path.join(corpusDir, 'oracle');
  const goldenPath = path.join(outDir, 'golden.jsonl');
  fs.mkdirSync(outDir, { recursive: true });

  const done = new Set<string>();
  if (!force && fs.existsSync(goldenPath)) {
    for (const line of fs.readFileSync(goldenPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).file); } catch { /* ignore */ }
    }
  }
  if (force && fs.existsSync(goldenPath)) fs.rmSync(goldenPath);

  const files = fs.readdirSync(corpusDir).filter((f) => f.endsWith('.txt') && !done.has(f)).sort();
  const url = cfg.mcpUrl ?? readMcpUrl();
  const out = fs.createWriteStream(goldenPath, { flags: 'a' });
  let i = 0, ok = 0, removed = 0, fail = 0;

  async function worker(): Promise<void> {
    while (i < files.length) {
      const file = files[i++];
      const txtPath = path.join(corpusDir, file);
      const input = normInput(fs.readFileSync(txtPath, 'utf8'));
      try {
        const r = await validateQuery(input, url);
        if (r.valid) {
          out.write(JSON.stringify({ file, valid: true, input, query_text: normalizeQueryText(r.query_text) }) + '\n');
          ok++;
        } else {
          // Невалидный запрос в корпусе не храним: не пишем в golden и удаляем .txt.
          fs.rmSync(txtPath, { force: true });
          removed++;
        }
      } catch (e) {
        fail++;
        process.stderr.write(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      if ((ok + removed + fail) % 50 === 0) process.stderr.write(`… ${ok + removed + fail}/${files.length}\n`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.end();
  process.stderr.write(`Готово: собрано ${ok}, отбраковано (удалено) ${removed}, ошибок ${fail}, пропущено ${done.size}.\n`);
}

if (require.main === module) run();
