/**
 * Прогон корпуса против golden-эталонов: читает tmp/query1c/oracle/golden.jsonl,
 * применяет acceptAgainstOracle, пишет report.json/summary.json с бакетами.
 * Запуск: node out/cli/oracleAcceptCli.js
 */
import * as fs from 'fs';
import * as path from 'path';
import { acceptAgainstOracle } from './oracleAccept';

interface Golden { file: string; valid: boolean; input: string; query_text: string; }
interface ReportEntry { file: string; reason: string; detail?: string; }

function run(): void {
  const dir = path.resolve('tmp/query1c/oracle');
  const goldenPath = path.join(dir, 'golden.jsonl');
  if (!fs.existsSync(goldenPath)) { console.error(`Нет ${goldenPath} — сначала npm run harvest`); process.exit(1); }

  const golden: Golden[] = fs.readFileSync(goldenPath, 'utf8').split('\n')
    .filter((l) => l.trim()).map((l) => JSON.parse(l));

  const report: ReportEntry[] = [];
  const byReason: Record<string, number> = { 'parse-exception': 0, mismatch: 0 };
  const topMessages: Record<string, number> = {};
  const topDiffTokens: Record<string, number> = {};
  const mismatchExamples: ReportEntry[] = [];
  let accepted = 0, oracleInvalid = 0;

  for (const g of golden) {
    if (!g.valid) { oracleInvalid++; continue; }
    const res = acceptAgainstOracle(g.input, g.query_text);
    if (res.ok) { accepted++; continue; }
    const reason = res.reason ?? 'parse-exception';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    report.push({ file: g.file, reason, detail: res.detail });
    if (reason === 'parse-exception') {
      const k = (res.detail ?? '').slice(0, 80);
      topMessages[k] = (topMessages[k] ?? 0) + 1;
    } else {
      const m = (res.detail ?? '').match(/[\p{L}\p{N}_]+/u);
      if (m) topDiffTokens[m[0]] = (topDiffTokens[m[0]] ?? 0) + 1;
      if (mismatchExamples.length < 25) mismatchExamples.push({ file: g.file, reason, detail: res.detail });
    }
  }

  const sortTop = (o: Record<string, number>, n: number) =>
    Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));

  const summary = {
    total: golden.length,
    oracleInvalid,
    accepted,
    rejected: report.length,
    byReason,
    parseException: { topMessages: sortTop(topMessages, 25) },
    mismatch: { topFirstDiffTokens: sortTop(topDiffTokens, 25), examples: mismatchExamples },
  };

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('=== Приёмка против оракула-конструктора (6.7) ===');
  console.log(`Всего: ${summary.total} | oracle-invalid: ${oracleInvalid} | принято: ${accepted} | отклонено: ${summary.rejected}`);
  console.log(`  parse-exception: ${byReason['parse-exception']} | mismatch: ${byReason.mismatch}`);
}

if (require.main === module) run();
