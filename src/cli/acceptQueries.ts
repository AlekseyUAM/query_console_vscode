/**
 * Приёмочный прогон корпуса запросов 1С (фаза 6, задача 6.3).
 *
 * Для каждого `tmp/query1c/*.txt`:
 *   1. out1 = generateBatch(parseBatch(t0))
 *   2. out2 = generateBatch(parseBatch(out1))
 *   3. ПРИНЯТО ⇔ не было исключения И out1 === out2 (каноническая форма —
 *      устойчивая неподвижная точка). Иначе — ОТКЛОНЕНО.
 *
 * Отклонённые оригиналы копируются в `tmp/query1c/errors/`, а в
 * `report.json` / `summary.json` собирается структурированная триажная сводка
 * для задачи 6.4. Чистая проверка одного текста вынесена в `acceptOne`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { parseBatch } from '../core/query/sdblParser';
import { generateBatch } from '../core/query/sdblGenerator';

/** Набор ключевых слов SDBL — копия из лексера для эвристики коллизий. */
const SDBL_KEYWORDS = new Set<string>([
  'ВЫБРАТЬ', 'РАЗРЕШЕННЫЕ', 'РАЗЛИЧНЫЕ', 'ПЕРВЫЕ', 'ИЗ', 'КАК',
  'СУММА', 'КОЛИЧЕСТВО', 'МАКСИМУМ', 'МИНИМУМ', 'СРЕДНЕЕ',
  'ГДЕ', 'И', 'В', 'МЕЖДУ', 'ПОДОБНО', 'СОЕДИНЕНИЕ', 'ВНУТРЕННЕЕ',
  'ЛЕВОЕ', 'ПРАВОЕ', 'ПОЛНОЕ', 'ПО', 'СГРУППИРОВАТЬ', 'ГРУППИРУЮЩИМ',
  'НАБОРАМ', 'ПОМЕСТИТЬ', 'ДОБАВИТЬ', 'УНИЧТОЖИТЬ', 'УПОРЯДОЧИТЬ', 'УБЫВ',
  'АВТОУПОРЯДОЧИВАНИЕ', 'ИТОГИ', 'ОБЩИЕ', 'ИЕРАРХИЯ', 'ТОЛЬКО',
  'ИНДЕКСИРОВАТЬ', 'УНИКАЛЬНО', 'ДЛЯ', 'ИЗМЕНЕНИЯ', 'ОБЪЕДИНИТЬ', 'ВСЕ',
]);

export interface AcceptResult {
  ok: boolean;
  /** 'parse-exception' | 'not-idempotent' — заполняется только при ok=false. */
  reason?: string;
  /** Сообщение исключения (parse-exception) или первая расходящаяся строка. */
  detail?: string;
}

/** Первая расходящаяся строка между двумя текстами (1-based номер + содержимое). */
function firstDiffLine(a: string, b: string): { line: number; aLine: string; bLine: string } {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    const x = la[i] ?? '';
    const y = lb[i] ?? '';
    if (x !== y) return { line: i + 1, aLine: x, bLine: y };
  }
  return { line: 0, aLine: '', bLine: '' };
}

/** Чистая проверка одного текста запроса (тестируема в изоляции). */
export function acceptOne(text: string): AcceptResult {
  let out1: string;
  try {
    out1 = generateBatch(parseBatch(text));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'parse-exception', detail: msg };
  }

  let out2: string;
  try {
    out2 = generateBatch(parseBatch(out1));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'parse-exception', detail: msg };
  }

  if (out1 !== out2) {
    const d = firstDiffLine(out1, out2);
    const detail = `L${d.line}: ${JSON.stringify(d.aLine)} -> ${JSON.stringify(d.bLine)}`;
    return { ok: false, reason: 'not-idempotent', detail };
  }

  return { ok: true };
}

/** Эвристика: расходится ли первая строка на токене-ключевом слове SDBL. */
function looksLikeKeywordCollision(detail: string): boolean {
  // detail формата `L<n>: "<out1Line>" -> "<out2Line>"`.
  const arrow = detail.indexOf(' -> ');
  if (arrow < 0) return false;
  const left = detail.slice(0, arrow);
  const right = detail.slice(arrow + 4);
  const tokensOf = (s: string): string[] => {
    const m = s.match(/[\p{L}\p{N}_]+/gu);
    return m ?? [];
  };
  const toksLeft = tokensOf(left);
  const toksRight = tokensOf(right);
  // Множество токенов, присутствующих ровно в одной из строк (расхождение).
  const setL = new Set(toksLeft);
  const setR = new Set(toksRight);
  const diff: string[] = [];
  for (const t of toksLeft) if (!setR.has(t)) diff.push(t);
  for (const t of toksRight) if (!setL.has(t)) diff.push(t);
  // Любой расходящийся токен совпадает (без учёта регистра) с ключевым словом.
  for (const t of diff) {
    if (SDBL_KEYWORDS.has(t.toUpperCase())) return true;
  }
  return false;
}

interface ReportEntry {
  file: string;
  reason: string;
  detail?: string;
}

function run(): void {
  const corpusDir = path.resolve('tmp/query1c');
  const errorsDir = path.join(corpusDir, 'errors');

  if (!fs.existsSync(corpusDir)) {
    console.error(`Каталог корпуса не найден: ${corpusDir}`);
    process.exit(1);
  }
  fs.mkdirSync(errorsDir, { recursive: true });

  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => f.endsWith('.txt'))
    .sort();

  const report: ReportEntry[] = [];
  const byReason: Record<string, number> = { 'parse-exception': 0, 'not-idempotent': 0 };
  const topMessages: Record<string, number> = {};
  const notIdempotentExamples: Array<{ file: string; detail: string }> = [];
  let keywordCollisionCount = 0;
  let otherNotIdempotent = 0;
  let accepted = 0;

  for (const file of files) {
    const full = path.join(corpusDir, file);
    let res: AcceptResult;
    try {
      const t0 = fs.readFileSync(full, 'utf8');
      res = acceptOne(t0);
    } catch (e) {
      // Любой сбой на уровне файла (чтение и т.п.) — не валим прогон.
      const msg = e instanceof Error ? e.message : String(e);
      res = { ok: false, reason: 'parse-exception', detail: `harness: ${msg}` };
    }

    if (res.ok) {
      accepted++;
      continue;
    }

    const reason = res.reason ?? 'parse-exception';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    report.push({ file, reason, detail: res.detail });

    // Копируем оригинал в errors/.
    try {
      fs.copyFileSync(full, path.join(errorsDir, file));
    } catch {
      /* ignore copy failure */
    }

    if (reason === 'parse-exception') {
      const prefix = (res.detail ?? '').slice(0, 80);
      topMessages[prefix] = (topMessages[prefix] ?? 0) + 1;
    } else if (reason === 'not-idempotent') {
      const detail = res.detail ?? '';
      if (looksLikeKeywordCollision(detail)) keywordCollisionCount++;
      else otherNotIdempotent++;
      if (notIdempotentExamples.length < 15) {
        notIdempotentExamples.push({ file, detail });
      }
    }
  }

  const rejected = report.length;

  // top-N сообщений по убыванию.
  const topMessagesSorted: Record<string, number> = {};
  Object.entries(topMessages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([k, v]) => {
      topMessagesSorted[k] = v;
    });

  const summary = {
    total: files.length,
    accepted,
    rejected,
    byReason: {
      'parse-exception': byReason['parse-exception'] ?? 0,
      'not-idempotent': byReason['not-idempotent'] ?? 0,
    },
    parseException: {
      topMessages: topMessagesSorted,
    },
    notIdempotent: {
      keywordCollision: keywordCollisionCount,
      other: otherNotIdempotent,
      examples: notIdempotentExamples,
    },
  };

  fs.writeFileSync(
    path.join(errorsDir, 'report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(errorsDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );

  console.log('=== Приёмочный прогон корпуса 1С (задача 6.3) ===');
  console.log(`Всего файлов:   ${summary.total}`);
  console.log(`Принято:        ${summary.accepted}`);
  console.log(`Отклонено:      ${summary.rejected}`);
  console.log(`  parse-exception: ${summary.byReason['parse-exception']}`);
  console.log(`  not-idempotent:  ${summary.byReason['not-idempotent']}`);
  console.log(`    из них коллизия ключевых слов: ${keywordCollisionCount}`);
  console.log(`    прочие:                        ${otherNotIdempotent}`);
  console.log('Топ сообщений parse-exception:');
  for (const [k, v] of Object.entries(topMessagesSorted)) {
    console.log(`  [${v}] ${k}`);
  }
  console.log(`Отчёты: ${path.join(errorsDir, 'report.json')}, ${path.join(errorsDir, 'summary.json')}`);
}

if (require.main === module) {
  run();
}
