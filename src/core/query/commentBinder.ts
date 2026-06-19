/**
 * Фаза 8.1 (шаг 3) — извлечение комментариев `//…` одного запроса-участника и
 * привязка их к якорям модели. Чистая функция: токенизирует исходный текст
 * участника (с комментариями), классифицирует каждый комментарий по 4 видам и
 * мутирует переданную `QueryModel` НА МЕСТЕ.
 *
 * Виды комментариев (терминология фазы 8.1):
 *   1) хвостовой `//…` после поля на ТОЙ ЖЕ строке      → field.commentTrailing
 *   2) `//…` отдельной строкой ПЕРЕД полем              → field.commentLeading[]
 *   3) `//…` перед `ВЫБРАТЬ` (без авто-разделителя)     → model.comments.beforeSelect[]
 *   4) `//…` после `ИЗ`, перед телом источника          → model.comments.afterFrom[]
 *
 * Функция НИКОГДА не бросает исключений: вся рискованная логика обёрнута, и при
 * неожиданной форме входа просто привязывается то, что удалось разобрать (или
 * ничего). Сопоставление сегментов выборки с полями модели — сперва по точному
 * совпадению синонима (`fieldAlias`), затем без учёта регистра (1С регистро-
 * независим), затем — позиционный фолбэк (k-й сегмент → model.fields[k]).
 */

import { tokenize, type Token } from './sdblLexer';
import type { QueryModel, SelectedField } from './queryModel';
import { fieldAlias } from './unionModel';

/** Авто-разделитель конструктора: `//` и далее ТОЛЬКО слеши (`////…`). */
function isAutoSeparator(text: string): boolean {
  return /^\/+$/.test(text);
}

/** Есть ли на строке `line` НЕ-комментарийный токен ЛЕВЕЕ позиции `pos`. */
function hasCodeBeforeOnLine(toks: Token[], line: number, pos: number): boolean {
  return toks.some(
    t => t.type !== 'comment' && t.type !== 'eof' && t.line === line && t.pos < pos
  );
}

export function extractComments(memberText: string, model: QueryModel): void {
  try {
    const toks = tokenize(memberText, { comments: true });

    // --- 1. Поиск ключевых точек на глубине 0 -------------------------------
    let depth = 0;
    let selectIdx = -1;
    let fromIdx = -1;
    let placeIdx = -1;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'punct') {
        if (t.value === '(' || t.value === '[') depth++;
        else if (t.value === ')' || t.value === ']') depth = Math.max(0, depth - 1);
        continue;
      }
      if (t.type !== 'keyword' || depth !== 0) continue;
      if (selectIdx < 0 && t.value === 'ВЫБРАТЬ') selectIdx = i;
      else if (selectIdx >= 0 && fromIdx < 0 && t.value === 'ИЗ') fromIdx = i;
      else if (
        selectIdx >= 0 &&
        placeIdx < 0 &&
        (t.value === 'ПОМЕСТИТЬ' || t.value === 'ДОБАВИТЬ')
      ) {
        placeIdx = i;
      }
    }
    if (selectIdx < 0) return; // без ВЫБРАТЬ привязывать не к чему

    // Конец региона списка выборки — первый из {ПОМЕСТИТЬ/ДОБАВИТЬ, ИЗ, конец}.
    const candidates = [placeIdx, fromIdx].filter(x => x >= 0);
    const regionEnd = candidates.length ? Math.min(...candidates) : toks.length;

    // --- 2. Разбиение региона выборки на сегменты по запятым глубины 0 -------
    // Каждый сегмент — это {startPos, endPos} в исходном тексте + найденный синоним.
    interface Segment {
      startTok: number; // индекс первого токена сегмента (внутри региона)
      endTok: number;   // индекс последнего токена сегмента (включительно)
      synonym?: string;
    }
    const segments: Segment[] = [];
    {
      let segDepth = 0;
      let segStart = selectIdx + 1;
      const pushSeg = (endExclusive: number) => {
        // Последний значимый токен сегмента (без хвостовых комментариев/eof).
        let last = endExclusive - 1;
        while (last >= segStart && (toks[last].type === 'comment' || toks[last].type === 'eof')) {
          last--;
        }
        let first = segStart;
        while (first <= last && (toks[first].type === 'comment' || toks[first].type === 'eof')) {
          first++;
        }
        if (first > last) return; // пустой сегмент (например, висячая запятая)
        const seg: Segment = { startTok: first, endTok: last };
        // Синоним: токен после ключевого `КАК` внутри сегмента (на глубине 0 сегмента).
        let d = 0;
        for (let j = first; j <= last; j++) {
          const tk = toks[j];
          if (tk.type === 'punct') {
            if (tk.value === '(' || tk.value === '[') d++;
            else if (tk.value === ')' || tk.value === ']') d = Math.max(0, d - 1);
            continue;
          }
          if (d === 0 && tk.type === 'keyword' && tk.value === 'КАК') {
            const next = toks[j + 1];
            if (next && (next.type === 'ident' || next.type === 'keyword')) {
              seg.synonym = next.text;
            }
            break;
          }
        }
        segments.push(seg);
      };
      for (let i = selectIdx + 1; i < regionEnd; i++) {
        const t = toks[i];
        if (t.type === 'punct') {
          if (t.value === '(' || t.value === '[') segDepth++;
          else if (t.value === ')' || t.value === ']') segDepth = Math.max(0, segDepth - 1);
          else if (t.value === ',' && segDepth === 0) {
            pushSeg(i);
            segStart = i + 1;
          }
        }
      }
      pushSeg(regionEnd);
    }

    // --- 3. Сопоставление сегментов с полями модели ------------------------
    const usedFields = new Set<SelectedField>();
    const fieldForSegment = (segIdx: number): SelectedField | undefined => {
      const seg = segments[segIdx];
      const syn = seg?.synonym;
      if (syn) {
        // Точное совпадение синонима.
        let f = model.fields.find(fl => !usedFields.has(fl) && fieldAlias(fl, model) === syn);
        // Без учёта регистра (1С регистро-независим).
        if (!f) {
          const synLow = syn.toLowerCase();
          f = model.fields.find(
            fl => !usedFields.has(fl) && fieldAlias(fl, model).toLowerCase() === synLow
          );
        }
        if (f) {
          usedFields.add(f);
          return f;
        }
      }
      // Позиционный фолбэк.
      const f = model.fields[segIdx];
      if (f) usedFields.add(f);
      return f;
    };
    // Сопоставляем все сегменты заранее (стабильный позиционный фолбэк).
    const segField: (SelectedField | undefined)[] = segments.map((_, k) => fieldForSegment(k));

    // --- 4. Классификация и привязка комментариев --------------------------
    const beforeSelect: string[] = [];
    const afterFrom: string[] = [];

    for (let ci = 0; ci < toks.length; ci++) {
      const c = toks[ci];
      if (c.type !== 'comment') continue;
      const text = c.value;

      // (3) beforeSelect — до ВЫБРАТЬ; авто-разделители отбрасываем.
      if (ci < selectIdx) {
        if (!isAutoSeparator(text)) beforeSelect.push(text);
        continue;
      }

      // Регион списка выборки (между ВЫБРАТЬ и regionEnd).
      if (ci > selectIdx && ci < regionEnd) {
        const trailing = hasCodeBeforeOnLine(toks, c.line, c.pos);
        if (trailing) {
          // (1) Хвостовой — поле сегмента, на чьей последней строке стоит комментарий.
          const segIdx = segments.findIndex(s => toks[s.endTok].line === c.line);
          const fld = segIdx >= 0 ? segField[segIdx] : undefined;
          if (fld) {
            fld.commentTrailing = fld.commentTrailing
              ? `${fld.commentTrailing} ${text}`
              : text;
          }
        } else {
          // (2) Полностью-строчный — commentLeading СЛЕДУЮЩЕГО сегмента
          // (первый сегмент, начинающийся ПОСЛЕ позиции комментария).
          const segIdx = segments.findIndex(s => toks[s.startTok].pos > c.pos);
          const fld = segIdx >= 0 ? segField[segIdx] : undefined;
          // Нет следующего поля → комментарий «висит» в конце списка → отбрасываем.
          if (fld) {
            (fld.commentLeading ??= []).push(text);
          }
        }
        continue;
      }

      // (4) afterFrom — после ИЗ, отдельной строкой.
      if (fromIdx >= 0 && ci > fromIdx) {
        if (!hasCodeBeforeOnLine(toks, c.line, c.pos)) afterFrom.push(text);
        continue;
      }

      // Прочее — отбрасываем.
    }

    // --- 5. Запись контейнерных комментариев (только при наличии) ----------
    if (beforeSelect.length || afterFrom.length) {
      model.comments ??= {};
      if (beforeSelect.length) model.comments.beforeSelect = beforeSelect;
      if (afterFrom.length) model.comments.afterFrom = afterFrom;
    }
  } catch {
    // Никогда не бросаем: при неожиданной форме входа оставляем модель как есть.
  }
}
