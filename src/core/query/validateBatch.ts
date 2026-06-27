/**
 * 7.8.10 — Проверка запроса при нажатии «ОК».
 *
 * Критерий корректности РОВНО ТАКОЙ ЖЕ, как при открытии конструктором из текста:
 * webview-обработчик `loadModel` разбирает входной текст через `parseBatch` и
 * открывает запрос, если разбор удался. Поэтому и открытие из текста, и проверка
 * при «ОК» используют ЕДИНУЮ функцию `tryParseBatch`: запрос корректен тогда и
 * только тогда, когда `parseBatch` его разбирает (не бросает исключение).
 */

import { parseBatch } from './sdblParser';
import type { ParseOptions } from './sdblParser';
import type { BatchDocument } from './batchModel';
import type { MetadataResolver } from './metadataResolver';
import { validateBatchSemantics } from './semanticValidator';

export type ParseAttempt = { ok: true; doc: BatchDocument } | { ok: false; error: string };

/**
 * Единый разбор текста пакета — общий источник правды для открытия из текста
 * (`App.loadModel`) и проверки при «ОК» (`validateBatchText`). Успех → разобранный
 * документ; исключение лексера/парсера → текст ошибки.
 *
 * Фаза 8.1: при открытии из текста передаётся `{ preserveComments: true }`, чтобы
 * собрать комментарии `//…`. Для проверки при «ОК» опция не нужна (валидируется лишь
 * разбираемость; сгенерированный текст с комментариями обязан парситься).
 */
export function tryParseBatch(text: string, opts?: ParseOptions): ParseAttempt {
  try {
    return { ok: true, doc: parseBatch(text, undefined, opts) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Фаза 8.4 — открытие запроса из текста с локальной семантической проверкой.
 * Сначала синтаксис (`tryParseBatch`); при успехе и НАЛИЧИИ резолвера — проверка
 * существования таблиц / повтора псевдонимов (`validateBatchSemantics`). Первая
 * семантическая ошибка → `{ ok:false }`. Без резолвера поведение совпадает с
 * `tryParseBatch` (синтаксис-only, обратная совместимость, fail-open).
 */
export function tryOpenBatch(
  text: string,
  resolver?: MetadataResolver,
  opts?: ParseOptions,
): ParseAttempt {
  const r = tryParseBatch(text, opts);
  if (!r.ok) return r;
  const errors = validateBatchSemantics(r.doc, resolver, text);
  if (errors.length > 0) return { ok: false, error: errors[0].message };
  return r;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Проверка при «ОК»: тот же критерий, что и открытие из текста. Синтаксическая
 * ошибка → сообщение парсера с префиксом; при наличии резолвера и корректном
 * синтаксисе — семантическая проверка (сообщение в стиле эталона, без префикса).
 * Без резолвера поведение прежнее (синтаксис-only).
 */
export function validateBatchText(text: string, resolver?: MetadataResolver): ValidationResult {
  const r = tryParseBatch(text);
  if (!r.ok) return { ok: false, error: 'Запрос содержит ошибку: ' + r.error };
  const errors = validateBatchSemantics(r.doc, resolver, text);
  if (errors.length > 0) return { ok: false, error: errors[0].message };
  return { ok: true };
}
