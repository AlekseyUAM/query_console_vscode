import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from './corpusConfig';

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Декодирует XML-сущности в тексте за один проход слева направо.
 * Обрабатывает именованные (&lt; &gt; &amp; &quot; &apos;) и числовые
 * (&#nn; / &#xHH;) сущности. Проход слева направо корректно разбирает
 * `&amp;lt;` → литерал `&lt;` (а не `<`).
 */
export function unescapeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#[xX][0-9a-fA-F]+|#[0-9]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    return NAMED_XML_ENTITIES[ent];
  });
}

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

/**
 * Извлекает запросы из XML-макета СКД: каждый блок <query>…</query>.
 * Безопасно регэкспом — внутри текста запроса любой `<` экранирован как
 * `&lt;`, поэтому `</query>` в теле встретиться не может. Тело декодируется
 * из XML-сущностей и фильтруется по тому же критерию, что и BSL-литералы
 * (начинается с ВЫБРАТЬ/УНИЧТОЖИТЬ). Тело отдаётся дословно (без trim).
 */
export function extractQueriesFromXml(xmlSource: string): ExtractedQuery[] {
  const result: ExtractedQuery[] = [];
  const re = /<query>([\s\S]*?)<\/query>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xmlSource)) !== null) {
    const lineStart = xmlSource.slice(0, m.index).split('\n').length;
    const text = unescapeXmlEntities(m[1]);
    if (startsWithQueryKeyword(text)) {
      result.push({ text, lineStart });
    }
  }
  return result;
}

/**
 * Имя файла корпуса для запроса `idx` из источника `rel`. Обычно
 * `${rel}_${idx+1}.txt`, но длинные пути (глубокая вложенность форм) могут дать имя
 * длиннее лимита файловой системы (255 байт). В этом случае префикс пути
 * усекается по границе символов до бюджета, а уникальность сохраняет короткий
 * sha1-хэш полного `rel`: `${усечённый}-${hash8}_${idx+1}.txt`.
 */
export function corpusFileName(rel: string, idx: number): string {
  const MAX_NAME_BYTES = 255;
  const suffix = `_${idx + 1}.txt`;
  const base = `${rel}${suffix}`;
  if (Buffer.byteLength(base, 'utf8') <= MAX_NAME_BYTES) return base;
  const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 8);
  const tail = `-${hash}${suffix}`;
  const budget = MAX_NAME_BYTES - Buffer.byteLength(tail, 'utf8');
  let truncated = '';
  let used = 0;
  for (const chunk of rel) {
    const b = Buffer.byteLength(chunk, 'utf8');
    if (used + b > budget) break;
    truncated += chunk;
    used += b;
  }
  return `${truncated}${tail}`;
}

// ---- CLI ----

function readSource(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

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

  const seen = new Set<string>();
  let found = 0;
  let uniqueWritten = 0;

  const writeQuery = (q: ExtractedQuery, rel: string, idx: number): void => {
    found++;
    if (seen.has(q.text)) return;
    seen.add(q.text);
    uniqueWritten++;
    const outFile = path.join(outDir, corpusFileName(rel, idx));
    fs.writeFileSync(outFile, q.text, 'utf8');
  };

  // .bsl: код модулей по всему CONFIG_DIR.
  const bslFiles = walk(cfRoot, '.bsl').sort();
  for (const file of bslFiles) {
    const source = readSource(file);
    if (source === null) continue;
    const rel = path.relative(cfRoot, file).split(path.sep).join('-');
    extractQueryStrings(source).forEach((q, idx) => writeQuery(q, rel, idx));
  }

  // .xml: макеты СКД — только поддерево Reports/ (см. spec 2026-06-13).
  const reportsDir = path.join(cfRoot, 'Reports');
  if (fs.existsSync(reportsDir)) {
    const xmlFiles = walk(reportsDir, '.xml').sort();
    for (const file of xmlFiles) {
      const source = readSource(file);
      if (source === null) continue;
      const rel = path.relative(cfRoot, file).split(path.sep).join('-');
      extractQueriesFromXml(source).forEach((q, idx) => writeQuery(q, rel, idx));
    }
  }

  console.log(`found=${found} uniqueWritten=${uniqueWritten}`);
}

if (require.main === module) {
  run();
}
