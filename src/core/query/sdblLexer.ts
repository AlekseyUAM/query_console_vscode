/**
 * Лексер SDBL (язык запросов 1С) — фаза 6 (обратный разбор текста запроса в
 * QueryModel). Чистый токенизатор: без зависимостей от vscode/React/fs.
 *
 * Позиции (pos/line/col) сохраняются точно (включая пропущенные пробелы и
 * комментарии), чтобы последующие подзадачи могли извлекать сырые срезы
 * исходного текста (произвольные выражения, параметры виртуальных таблиц).
 */

export type TokenType =
  | 'keyword'
  | 'ident'
  | 'string'
  | 'number'
  | 'date'
  | 'param'
  | 'punct'
  | 'comment'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Для keyword — канонический верхний регистр; для остальных — исходный текст. */
  value: string;
  /**
   * Исходный текст лексемы (всегда оригинальный регистр). Совпадает с `value`
   * для не-ключевых токенов; для keyword хранит исходное написание (например,
   * `Количество`), чтобы парсер мог восстановить идентификатор без искажения
   * регистра, когда ключевое слово используется как ИМЯ (поле/псевдоним/сегмент пути).
   */
  text: string;
  /** Смещение начала токена в исходной строке (0-based). */
  pos: number;
  /** Номер строки (1-based). */
  line: number;
  /** Номер колонки (1-based). */
  col: number;
}

/**
 * Фиксированный набор ключевых слов (регистронезависимый). Канонический вид —
 * верхний регистр. По мере расширения парсера (WHERE/JOIN/GROUP/…) сюда
 * добавляются новые слова. На текущем слое (6.2.A) достаточно ВЫБРАТЬ/ИЗ-набора,
 * но включаем заранее распространённые ключевые слова, чтобы они не разбирались
 * как идентификаторы при частичном вводе.
 */
const KEYWORDS = new Set<string>([
  'ВЫБРАТЬ',
  'РАЗРЕШЕННЫЕ',
  'РАЗЛИЧНЫЕ',
  'ПЕРВЫЕ',
  'ИЗ',
  'КАК',
  'СУММА',
  'КОЛИЧЕСТВО',
  'МАКСИМУМ',
  'МИНИМУМ',
  'СРЕДНЕЕ',
  // 6.2.B: ГДЕ / соединения / группировка.
  'ГДЕ',
  'И',
  'В',
  'МЕЖДУ',
  'ПОДОБНО',
  'СОЕДИНЕНИЕ',
  'ВНУТРЕННЕЕ',
  'ЛЕВОЕ',
  'ПРАВОЕ',
  'ПОЛНОЕ',
  'ПО',
  'СГРУППИРОВАТЬ',
  'ГРУППИРУЮЩИМ',
  'НАБОРАМ',
  'ИМЕЮЩИЕ',
  // 6.2.C: временные таблицы, порядок, итоги, индекс, построитель.
  'ПОМЕСТИТЬ',
  'ДОБАВИТЬ',
  'УНИЧТОЖИТЬ',
  'УПОРЯДОЧИТЬ',
  'УБЫВ',
  'АВТОУПОРЯДОЧИВАНИЕ',
  'ИТОГИ',
  'ОБЩИЕ',
  'ИЕРАРХИЯ',
  'ТОЛЬКО',
  'ИНДЕКСИРОВАТЬ',
  'УНИКАЛЬНО',
  'ДЛЯ',
  'ИЗМЕНЕНИЯ',
  // 6.2.D: объединения.
  'ОБЪЕДИНИТЬ',
  'ВСЕ',
]);

/** Двухсимвольные операторы (жадно). */
const TWO_CHAR = new Set(['<=', '>=', '<>']);
/**
 * Односимвольная пунктуация. Помимо синтаксических разделителей запроса
 * (`. , ( ) { } ; = < >`) и `*` (звёздочка ВЫБРАТЬ/умножение), включает
 * операторы выражений, которые реально встречаются в телах запросов типовых
 * конфигураций 1С (фаза 6.4): арифметика `+ - / %`, нуль-безопасный доступ `?.`
 * (символ `?`), подстановки/шаблоны `@` и индексация `[` `]`. Парсер захватывает
 * такие выражения как сырые срезы исходного текста (`custom`-условия,
 * произвольные поля-выражения, условия соединений), поэтому лексеру достаточно
 * не бросать на этих символах — он выдаёт их как `punct`, а срез по позициям
 * восстанавливает выражение дословно.
 */
const ONE_CHAR = new Set([
  '.', ',', '(', ')', '*', '{', '}', ';', '=', '<', '>',
  '+', '-', '/', '%', '?', '@', '[', ']',
]);

function isIdentStart(ch: string): boolean {
  // \p{L} (буква, включая кириллицу) или подчёркивание.
  return ch === '_' || /\p{L}/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  return ch === '_' || /[\p{L}\p{N}]/u.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

export function tokenize(text: string, opts?: { comments?: boolean }): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (text[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const push = (type: TokenType, value: string, pos: number, l: number, c: number, text?: string): void => {
    tokens.push({ type, value, text: text ?? value, pos, line: l, col: c });
  };

  while (i < text.length) {
    const ch = text[i];

    // Пробелы.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // Комментарий до конца строки.
    if (ch === '/' && text[i + 1] === '/') {
      const startPos = i;
      const startLine = line;
      const startCol = col;
      while (i < text.length && text[i] !== '\n') advance();
      if (opts?.comments) {
        const value = text.slice(startPos, i);
        push('comment', value, startPos, startLine, startCol);
      }
      continue;
    }

    const startPos = i;
    const startLine = line;
    const startCol = col;

    // Подстановочное имя временной таблицы: # + идентификатор. В реальных
    // запросах типовых подсистем 1С (обмен данными, управление доступом) `#Имя`
    // выступает ИМЕНЕМ источника в `ИЗ` (текстовая подстановка перед выполнением;
    // в позиции источника принимается синтаксисом запроса 1С). Лексим как
    // идентификатор с префиксом `#`, чтобы парсер принял его в parseDottedName.
    // Допускается обрамляющая форма `#Имя#` (имя между парой `#`); завершающий `#`
    // включаем в текст токена, чтобы round-trip сохранил подстановку (фаза 6.16).
    if (ch === '#') {
      advance();
      const nameStart = i;
      while (i < text.length && isIdentPart(text[i])) advance();
      if (i === nameStart) {
        throw lexError('ожидалось имя после "#"', startLine, startCol);
      }
      let name = '#' + text.slice(nameStart, i);
      if (text[i] === '#') { advance(); name += '#'; }
      push('ident', name, startPos, startLine, startCol);
      continue;
    }

    // Параметр: & + идентификатор.
    if (ch === '&') {
      advance();
      const nameStart = i;
      while (i < text.length && isIdentPart(text[i])) advance();
      if (i === nameStart) {
        throw lexError('ожидалось имя параметра после "&"', startLine, startCol);
      }
      push('param', '&' + text.slice(nameStart, i), startPos, startLine, startCol);
      continue;
    }

    // Строка в двойных кавычках с экранированием "".
    if (ch === '"') {
      advance();
      let value = '"';
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '""';
            advance(2);
            continue;
          }
          value += '"';
          advance();
          break;
        }
        value += text[i];
        advance();
      }
      push('string', value, startPos, startLine, startCol);
      continue;
    }

    // Дата в одинарных кавычках.
    if (ch === "'") {
      advance();
      let value = "'";
      while (i < text.length && text[i] !== "'") {
        value += text[i];
        advance();
      }
      if (text[i] === "'") {
        value += "'";
        advance();
      }
      push('date', value, startPos, startLine, startCol);
      continue;
    }

    // Число.
    if (isDigit(ch)) {
      let value = '';
      while (i < text.length && isDigit(text[i])) {
        value += text[i];
        advance();
      }
      if (text[i] === '.' && isDigit(text[i + 1])) {
        value += '.';
        advance();
        while (i < text.length && isDigit(text[i])) {
          value += text[i];
          advance();
        }
      }
      push('number', value, startPos, startLine, startCol);
      continue;
    }

    // Идентификатор / ключевое слово.
    if (isIdentStart(ch)) {
      let value = '';
      while (i < text.length && isIdentPart(text[i])) {
        value += text[i];
        advance();
      }
      const upper = value.toUpperCase();
      if (KEYWORDS.has(upper)) {
        // value — канонический верхний регистр (для логики парсера),
        // text — исходное написание (для восстановления имени).
        push('keyword', upper, startPos, startLine, startCol, value);
      } else {
        push('ident', value, startPos, startLine, startCol);
      }
      continue;
    }

    // Двухсимвольные операторы (жадно).
    const two = text.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      advance(2);
      push('punct', two, startPos, startLine, startCol);
      continue;
    }

    // Односимвольная пунктуация.
    if (ONE_CHAR.has(ch)) {
      advance();
      push('punct', ch, startPos, startLine, startCol);
      continue;
    }

    throw lexError(`неожиданный символ ${JSON.stringify(ch)}`, startLine, startCol);
  }

  push('eof', '', i, line, col);
  return tokens;
}

function lexError(message: string, line: number, col: number): Error {
  return new Error(`Лексическая ошибка ${line}:${col} — ${message}`);
}
