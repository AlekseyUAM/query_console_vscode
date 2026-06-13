/**
 * Диагностика приёмки одного/нескольких файлов корпуса: печатает построчный
 * unified-diff `ours ¦ oracle` (наш generateBatch(parseBatch(input)) против
 * query_text оракула). Для разбора правил в 6.12.
 *
 * Запуск:
 *   node out/cli/oracleDiff.js <подстрока-имени-файла> [...ещё]
 *   node out/cli/oracleDiff.js --reason mismatch --grep "ПО (" --limit 10
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseBatch } from '../core/query/sdblParser';
import { generateBatch } from '../core/query/sdblGenerator';
import { getConfig, goldenPath } from './corpusConfig';

interface Golden { file: string; valid: boolean; input: string; query_text: string; }

function load(): Golden[] {
  const p = goldenPath(getConfig());
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function diff(input: string, oracle: string): { ok: boolean; ours: string; err?: string } {
  try {
    const ours = generateBatch(parseBatch(input));
    return { ok: ours === oracle, ours };
  } catch (e) {
    return { ok: false, ours: '', err: e instanceof Error ? e.message : String(e) };
  }
}

function show(g: Golden): void {
  const r = diff(g.input, g.query_text);
  console.log('\n========================================================');
  console.log(`FILE: ${g.file}  ${r.ok ? 'OK' : r.err ? 'PARSE-EXCEPTION' : 'MISMATCH'}`);
  if (r.err) { console.log('ERROR:', r.err); console.log('--- INPUT ---\n' + g.input); return; }
  const a = r.ours.split('\n'), b = g.query_text.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? '<нет>', y = b[i] ?? '<нет>';
    const mark = x === y ? '  ' : '≠ ';
    if (x === y) { console.log(`${mark}${i + 1}: ${JSON.stringify(x)}`); }
    else { console.log(`${mark}${i + 1}: OURS  ${JSON.stringify(x)}`); console.log(`  ${i + 1}: ORACL ${JSON.stringify(y)}`); }
  }
}

function run(): void {
  const args = process.argv.slice(2);
  const golden = load();
  let reason: string | null = null, grep: string | null = null, limit = 50;
  const subs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reason') reason = args[++i];
    else if (args[i] === '--grep') grep = args[++i];
    else if (args[i] === '--limit') limit = parseInt(args[++i], 10);
    else subs.push(args[i]);
  }
  let matched: Golden[] = golden.filter((g) => g.valid);
  if (subs.length) matched = matched.filter((g) => subs.some((s) => g.file.includes(s)));
  if (reason || grep) {
    matched = matched.filter((g) => {
      const r = diff(g.input, g.query_text);
      if (r.ok) return false;
      const rs = r.err ? 'parse-exception' : 'mismatch';
      if (reason && rs !== reason) return false;
      if (grep) { const blob = (r.ours + '\n' + g.query_text + '\n' + (r.err ?? '')); if (!blob.includes(grep)) return false; }
      return true;
    });
  }
  console.log(`Найдено: ${matched.length} (показываю ${Math.min(limit, matched.length)})`);
  matched.slice(0, limit).forEach(show);
}

if (require.main === module) run();
