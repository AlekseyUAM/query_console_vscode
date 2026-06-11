/**
 * Приёмка одного запроса против оракула-конструктора (фаза 6.7).
 * Критерий: generateBatch(parseBatch(input)) === query_text конструктора.
 */
import { parseBatch } from '../core/query/sdblParser';
import { generateBatch } from '../core/query/sdblGenerator';

export type OracleReason = 'parse-exception' | 'mismatch';

export interface OracleAcceptResult {
  ok: boolean;
  reason?: OracleReason;
  detail?: string;
}

export function firstDiffLine(a: string, b: string): { line: number; a: string; b: string } {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    const x = la[i] ?? '';
    const y = lb[i] ?? '';
    if (x !== y) return { line: i + 1, a: x, b: y };
  }
  return { line: 0, a: '', b: '' };
}

export function acceptAgainstOracle(input: string, queryText: string): OracleAcceptResult {
  let ours: string;
  try {
    ours = generateBatch(parseBatch(input));
  } catch (e) {
    return { ok: false, reason: 'parse-exception', detail: e instanceof Error ? e.message : String(e) };
  }
  if (ours === queryText) return { ok: true };
  const d = firstDiffLine(ours, queryText);
  return { ok: false, reason: 'mismatch', detail: `L${d.line}: ${JSON.stringify(d.a)} ¦ ${JSON.stringify(d.b)}` };
}
