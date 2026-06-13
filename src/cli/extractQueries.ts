import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './corpusConfig';

export interface ExtractedQuery {
  text: string;
  lineStart: number;
}

const QUERY_KEYWORDS = ['ВЫБРАТЬ', 'УНИЧТОЖИТЬ'];

function startsWithQueryKeyword(text: string): boolean {
  const trimmed = text.replace(/^[\s﻿]+/, '');
  const upper = trimmed.toUpperCase();
  return QUERY_KEYWORDS.some((kw) => {
    if (!upper.startsWith(kw)) return false;
    // Граница: после ключевого слова либо конец, либо не буква/цифра.
    const next = trimmed.charAt(kw.length);
    return next === '' || !/[\p{L}\p{N}_]/u.test(next);
  });
}

/**
 * Восстанавливает текст запроса из тела BSL-литерала, убирая ведущие
 * пробелы и символ `|` со строк-продолжений (инверсия formatAsBslString).
 */
function unpipe(rawBody: string): string {
  const lines = rawBody.split('\n');
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      // Убираем ведущие пробелы вплоть до первого `|` включительно.
      const m = line.match(/^[ \t]*\|/);
      return m ? line.slice(m[0].length) : line;
    })
    .join('\n');
}

/**
 * Сканирует исходник BSL, находит все строковые литералы в двойных кавычках
 * (с учётом экранирования `""` и продолжений `|`), восстанавливает их текст
 * и оставляет только те, что начинаются с ВЫБРАТЬ/УНИЧТОЖИТЬ.
 */
export function extractQueryStrings(bslSource: string): ExtractedQuery[] {
  const result: ExtractedQuery[] = [];
  const n = bslSource.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const ch = bslSource[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Комментарий до конца строки.
    if (ch === '/' && bslSource[i + 1] === '/') {
      while (i < n && bslSource[i] !== '\n') i++;
      continue;
    }

    // Одинарные кавычки — литералы дат, пропускаем целиком.
    if (ch === "'") {
      i++;
      while (i < n && bslSource[i] !== "'" && bslSource[i] !== '\n') i++;
      if (i < n && bslSource[i] === "'") i++;
      continue;
    }

    // Двойная кавычка — начало строкового литерала.
    if (ch === '"') {
      const lineStart = line;
      i++; // пропускаем открывающую кавычку
      let raw = '';
      while (i < n) {
        const c = bslSource[i];
        if (c === '"') {
          if (bslSource[i + 1] === '"') {
            // Экранированная кавычка.
            raw += '"';
            i += 2;
            continue;
          }
          // Закрывающая кавычка.
          i++;
          break;
        }
        if (c === '\n') line++;
        raw += c;
        i++;
      }
      const text = unpipe(raw);
      if (startsWithQueryKeyword(text)) {
        result.push({ text, lineStart });
      }
      continue;
    }

    i++;
  }

  return result;
}

// ---- CLI ----

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, ext));
    } else if (entry.isFile() && full.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

export function run(): void {
  const cfg = getConfig();
  const cfRoot = cfg.configDir;
  const outDir = cfg.queryCorpusDir;

  if (!fs.existsSync(cfRoot)) {
    console.error(`Каталог не найден: ${cfRoot}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const files = walk(cfRoot, '.bsl').sort();
  const seen = new Set<string>();
  let found = 0;
  let uniqueWritten = 0;

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const queries = extractQueryStrings(source);
    const rel = path.relative(cfRoot, file).split(path.sep).join('-');
    queries.forEach((q, idx) => {
      found++;
      if (seen.has(q.text)) return;
      seen.add(q.text);
      uniqueWritten++;
      const outFile = path.join(outDir, `${rel}_${idx + 1}.txt`);
      fs.writeFileSync(outFile, q.text, 'utf8');
    });
  }

  console.log(`found=${found} uniqueWritten=${uniqueWritten}`);
}

if (require.main === module) {
  run();
}
