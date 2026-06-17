/**
 * Сверка остатка против ЖИВОГО оракула (источник истины), а не закоммиченного golden.
 * Для каждого corpus-error JSON: берёт исходный текст, спрашивает live validate_query,
 * прогоняет наш конструктор, печатает три вердикта:
 *   ours==live?  golden==live?  ours==golden?
 * и первый дифф ours-vs-live. Так видно: (а) устарел ли golden, (б) совпадает ли наш
 * вывод с ЖИВЫМ оракулом.
 * Запуск: node out/cli/reprobeOracle.js <name1.txt.json> [...]  |  --all
 * Доп. флаг --patch-golden: для записей, где ours==live, обновляет query_text в
 *   tmp/query1c/oracle/golden.jsonl ЖИВЫМ текстом (refresh устаревшего эталона).
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateQuery, readMcpUrl, normalizeQueryText } from './mcpClient';
import { parseBatch } from '../core/query/sdblParser';
import { generateBatch } from '../core/query/sdblGenerator';
import { buildYamlResolver } from '../core/metadata/buildYamlResolver';
import { getConfig, goldenPath } from './corpusConfig';

function firstDiff(a: string, b: string): string {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if ((la[i] ?? '<EOF>') !== (lb[i] ?? '<EOF>')) {
      return `  L${i + 1}\n   A|${(la[i] ?? '<EOF>').replace(/\t/g, '»')}\n   B|${(lb[i] ?? '<EOF>').replace(/\t/g, '»')}`;
    }
  }
  return '  (identical)';
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const resolver = buildYamlResolver(path.join(cfg.metadataCacheDir, 'cf'));
  const url = cfg.mcpUrl ?? readMcpUrl();
  const errDir = cfg.errorsDir;
  const patch = process.argv.includes('--patch-golden');
  let names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--all')) names = fs.readdirSync(errDir).filter((f) => f.endsWith('.json'));

  // golden index for patching
  const gPath = goldenPath(cfg);
  const goldenLines = fs.existsSync(gPath) ? fs.readFileSync(gPath, 'utf8').split('\n') : [];
  const toPatch: Array<{ file: string; query_text: string }> = [];

  for (const name of names) {
    const p = fs.existsSync(name) ? name : path.join(errDir, name);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const input: string = d.исходныйТекстЗапроса;
    const golden: string = d.текстВалидатора;
    const file: string = d.файл;
    let ours = '';
    try { ours = generateBatch(parseBatch(input, resolver)); }
    catch (e) { ours = `<<EXC ${e instanceof Error ? e.message : String(e)}>>`; }

    const r = await validateQuery(input, url);
    if (!r.valid) {
      console.log(`\n=== ${file}\n  LIVE: INVALID (${r.message ?? ''})`);
      continue;
    }
    const live = normalizeQueryText(r.query_text);
    const oursEqLive = ours === live;
    const goldenEqLive = golden === live;
    console.log(`\n=== ${file}`);
    console.log(`  ours==live: ${oursEqLive}   golden==live: ${goldenEqLive}   ours==golden: ${ours === golden}`);
    if (!oursEqLive) console.log('  ours-vs-live first diff:\n' + firstDiff(ours, live));
    if (oursEqLive && !goldenEqLive) {
      console.log('  -> GOLDEN STALE; ours matches live oracle.');
      toPatch.push({ file, query_text: live });
    }
  }

  if (patch && toPatch.length) {
    const map = new Map(toPatch.map((t) => [t.file, t.query_text]));
    const out = goldenLines.map((line) => {
      if (!line.trim()) return line;
      const o = JSON.parse(line);
      if (map.has(o.file)) { o.query_text = map.get(o.file); return JSON.stringify(o); }
      return line;
    });
    fs.writeFileSync(gPath, out.join('\n'));
    console.log(`\nPATCHED ${toPatch.length} golden entries with live oracle text: ${toPatch.map((t) => t.file).join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
