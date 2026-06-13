/**
 * Приёмка одного запроса против оракула-конструктора (фаза 6.7).
 * Критерий: generateBatch(parseBatch(input)) === query_text конструктора.
 */
import { parseBatch } from '../core/query/sdblParser';
import { generateBatch } from '../core/query/sdblGenerator';
import type { MetadataResolver } from '../core/query/metadataResolver';

export type OracleReason = 'parse-exception' | 'mismatch';

export interface OracleAcceptResult {
  ok: boolean;
  reason?: OracleReason;
  detail?: string;
  ours?: string; // сгенерированный текст; '' если parse бросил до получения вывода
  errorClass?: string; // имя класса исключения для parse-exception; 'mismatch' для mismatch
  errorLine?: number; // 1-based первая расходящаяся строка для mismatch; best-effort для parse-exception, иначе 0
}

/** Best-effort извлечение номера строки из текста сообщения об ошибке. */
function parseErrorLine(message: string): number {
  const m = message.match(/стро[а-яё]*\s*№?\s*(\d+)|line\s*(\d+)|:(\d+):/iu);
  if (!m) return 0;
  const g = m[1] ?? m[2] ?? m[3];
  return g ? parseInt(g, 10) : 0;
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

export function acceptAgainstOracle(
  input: string,
  queryText: string,
  resolver?: MetadataResolver
): OracleAcceptResult {
  let ours: string;
  try {
    ours = generateBatch(parseBatch(input, resolver));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const errorClass = (e && (e as any).constructor && (e as any).constructor.name) || 'Error';
    return { ok: false, reason: 'parse-exception', detail: message, ours: '', errorClass, errorLine: parseErrorLine(message) };
  }
  if (ours === queryText) return { ok: true };
  const d = firstDiffLine(ours, queryText);
  return {
    ok: false,
    reason: 'mismatch',
    detail: `L${d.line}: ${JSON.stringify(d.a)} ¦ ${JSON.stringify(d.b)}`,
    ours,
    errorClass: 'mismatch',
    errorLine: d.line,
  };
}
