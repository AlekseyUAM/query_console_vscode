/**
 * Сборщик golden-эталонов: для каждого tmp/query1c/*.txt вызывает validate_query
 * и дописывает строку в tmp/query1c/oracle/golden.jsonl. Резюмируемо.
 * Запуск: node out/cli/harvestOracle.js [--force]
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateQuery, readMcpUrl, normalizeQueryText } from './mcpClient';

const CONCURRENCY = 8;

function normInput(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

async function run(): Promise<void> {
  const force = process.argv.includes('--force');
  const corpusDir = path.resolve('tmp/query1c');
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
  const url = readMcpUrl();
  const out = fs.createWriteStream(goldenPath, { flags: 'a' });
  let i = 0, ok = 0, fail = 0;

  async function worker(): Promise<void> {
    while (i < files.length) {
      const file = files[i++];
      const input = normInput(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
      try {
        const r = await validateQuery(input, url);
        out.write(JSON.stringify({ file, valid: r.valid, input, query_text: normalizeQueryText(r.query_text) }) + '\n');
        ok++;
      } catch (e) {
        fail++;
        process.stderr.write(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      if ((ok + fail) % 50 === 0) process.stderr.write(`… ${ok + fail}/${files.length}\n`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.end();
  process.stderr.write(`Готово: собрано ${ok}, ошибок ${fail}, пропущено ${done.size}.\n`);
}

if (require.main === module) run();
