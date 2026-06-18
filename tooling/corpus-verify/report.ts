import type { ClassInfo } from './classes';
import type { Violation } from './invariants';

export interface QueryResult { name: string; key: string; violations: Violation[] }

export function formatCoverageReport(input: {
  classes: ClassInfo[]; sampled: string[]; results: QueryResult[];
}): string {
  const { classes, sampled, results } = input;
  const sampledSet = new Set(sampled);
  const coveredKeys = new Set(classes.filter(c => c.members.some(m => sampledSet.has(m))).map(c => c.key));
  const uncovered = classes.filter(c => !coveredKeys.has(c.key));

  const byCode = new Map<string, number>();
  const failed = results.filter(r => r.violations.length > 0);
  for (const r of failed) for (const v of r.violations) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);

  const lines: string[] = [];
  lines.push('# Отчёт корпусной проверки UI', '');
  lines.push(`- Классов: ${classes.length}`);
  lines.push(`- Покрыто выборкой: ${coveredKeys.size}`);
  lines.push(`- Непокрытых классов: ${uncovered.length}`);
  lines.push(`- Прогнано: ${results.length}`);
  lines.push(`- Провалов (запросов): ${failed.length}`, '');
  lines.push('## Провалы по типам');
  if (byCode.size === 0) lines.push('- нет');
  else for (const [code, n] of [...byCode.entries()].sort()) lines.push(`- ${code}: ${n}`);
  lines.push('', '## Проваленные запросы');
  if (failed.length === 0) lines.push('- нет');
  else for (const r of failed) lines.push(`- \`${r.name}\` — ${r.violations.map(v => `${v.code}: ${v.detail}`).join('; ')}`);
  if (uncovered.length > 0) {
    lines.push('', '## Непокрытые классы (нет представителя в выборке)');
    for (const c of uncovered) lines.push(`- ${c.key} (${c.members.length} запр.)`);
  }
  return lines.join('\n') + '\n';
}
