/**
 * Быстрый пробник одного запроса: грузит resolver один раз, прогоняет
 * конструктор на input(ах) из corpus-error JSON(ов) и печатает фокус-дифф.
 * Использование:
 *   node out/cli/probeError.js <name1.txt.json> [name2.txt.json ...]
 *   node out/cli/probeError.js --all          (все из tmp/corpus-errors)
 * Имена ищутся в tmp/corpus-errors (или передавайте полный путь).
 */
import * as fs from 'fs';
import * as path from 'path';
import { acceptAgainstOracle } from './oracleAccept';
import { buildYamlResolver } from '../core/metadata/buildYamlResolver';
import { getConfig } from './corpusConfig';

const cfg = getConfig();
const resolver = buildYamlResolver(path.join(cfg.metadataCacheDir, 'cf'));
const errDir = cfg.errorsDir;

let names = process.argv.slice(2);
if (names.length === 1 && names[0] === '--all') {
  names = fs.readdirSync(errDir).filter((f) => f.endsWith('.json'));
}

let ok = 0, bad = 0;
for (const name of names) {
  const p = fs.existsSync(name) ? name : path.join(errDir, name);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const res = acceptAgainstOracle(d.исходныйТекстЗапроса, d.текстВалидатора, resolver);
  if (res.ok) {
    ok++;
    console.log(`OK  ${path.basename(p)}`);
    continue;
  }
  bad++;
  const exp = d.текстВалидатора.split('\n');
  const got = (res.ours ?? '').split('\n');
  let lo: number | null = null, hi = 0;
  for (let i = 0; i < Math.max(exp.length, got.length); i++) {
    if ((exp[i] ?? null) !== (got[i] ?? null)) { if (lo === null) lo = i; hi = i; }
  }
  console.log(`\n${'='.repeat(70)}\nMISMATCH ${path.basename(p)} reason=${res.reason}`);
  if (lo === null) { console.log('  (identical?!)'); continue; }
  const a = Math.max(0, lo - 2), b = Math.min(Math.max(exp.length, got.length) - 1, hi + 2);
  for (let i = a; i <= b; i++) {
    const e = exp[i] ?? '<EOF>', g = got[i] ?? '<EOF>';
    const m = e === g ? '  ' : '!!';
    console.log(`${m} ${i + 1}`);
    console.log('   V|' + e.replace(/\t/g, '»'));
    console.log('   C|' + g.replace(/\t/g, '»'));
  }
}
console.log(`\n=== probe: OK=${ok} MISMATCH=${bad} ===`);
