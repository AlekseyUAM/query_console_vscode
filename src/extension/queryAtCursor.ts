/**
 * Чистый помощник для команды расширения «открыть запрос под курсором»: находит
 * строковый литерал запроса 1С в исходнике `.bsl` по символьному смещению курсора.
 *
 * Лексические правила совпадают с `extractQueryStrings` (src/cli/extractQueries.ts):
 * экранирование `""`, продолжения `|`, пропуск комментариев `//` и литералов дат
 * `'…'`. В отличие от него, здесь дополнительно отслеживаются символьные смещения
 * открывающей/закрывающей кавычек, чтобы команда могла заменить литерал при сохранении.
 *
 * Модуль ДОЛЖЕН оставаться чистым (без `import vscode`/`fs`) — он юнит-тестируется.
 * Привязка к команде vscode — отдельная задача (6.6.B).
 */

export interface QueryHit {
  /** Восстановленный (de-piped) текст запроса — то, что передаётся в `parseBatch`. */
  text: string;
  /** Смещение открывающей кавычки. */
  start: number;
  /** Смещение за закрывающей кавычкой: `[start, end)` охватывает кавычки литерала. */
  end: number;
}

const QUERY_KEYWORDS = ['ВЫБРАТЬ', 'УНИЧТОЖИТЬ'];

/**
 * Снимает ведущую «тривию» — пробелы (включая BOM) И строки-комментарии `//…` — до
 * первого значимого токена. 1С открывает конструктором запрос, начинающийся с
 * комментария (`// …` перед ВЫБРАТЬ), поэтому распознавание ключевого слова не должно
 * спотыкаться о ведущие комментарии (фаза 8.1).
 */
function stripLeadingTrivia(text: string): string {
  let s = text;
  for (;;) {
    const before = s;
    s = s.replace(/^[\s﻿]+/, '');
    if (s.startsWith('//')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    }
    if (s === before) break;
  }
  return s;
}

function startsWithQueryKeyword(text: string): boolean {
  const trimmed = stripLeadingTrivia(text);
  const upper = trimmed.toUpperCase();
  return QUERY_KEYWORDS.some((kw) => {
    if (!upper.startsWith(kw)) return false;
    const next = trimmed.charAt(kw.length);
    return next === '' || !/[\p{L}\p{N}_]/u.test(next);
  });
}

/**
 * Восстанавливает текст запроса из тела BSL-литерала: убирает ведущие пробелы и
 * символ `|` на строках-продолжениях (инверсия formatAsBslString).
 */
function unpipe(rawBody: string): string {
  const lines = rawBody.split('\n');
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      const m = line.match(/^[ \t]*\|/);
      return m ? line.slice(m[0].length) : line;
    })
    .join('\n');
}

/**
 * Сканирует `source`, находит строковый литерал-запрос, в чьих границах кавычек
 * (включительно) лежит `offset`, и возвращает его восстановленный текст с границами
 * `[openQuotePos, closeQuotePos+1)`. Если такого литерала нет — `null`.
 */
export function findQueryAt(source: string, offset: number): QueryHit | null {
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i];

    // Комментарий до конца строки.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Литерал даты в одинарных кавычках — пропускаем целиком.
    if (ch === "'") {
      i++;
      while (i < n && source[i] !== "'" && source[i] !== '\n') i++;
      if (i < n && source[i] === "'") i++;
      continue;
    }

    // Строковый литерал в двойных кавычках.
    if (ch === '"') {
      const openPos = i;
      i++; // пропускаем открывающую кавычку
      let raw = '';
      let closePos = -1;
      while (i < n) {
        const c = source[i];
        if (c === '"') {
          if (source[i + 1] === '"') {
            raw += '"';
            i += 2;
            continue;
          }
          closePos = i;
          i++; // пропускаем закрывающую кавычку
          break;
        }
        raw += c;
        i++;
      }
      const text = unpipe(raw);
      if (startsWithQueryKeyword(text)) {
        // Конец диапазона — за закрывающей кавычкой (или за концом строки, если её нет).
        const endExclusive = closePos === -1 ? n : closePos + 1;
        // offset внутри `[openPos, closePos]` включительно (т.е. < endExclusive).
        if (offset >= openPos && offset < endExclusive) {
          return { text, start: openPos, end: endExclusive };
        }
      }
      continue;
    }

    i++;
  }

  return null;
}
