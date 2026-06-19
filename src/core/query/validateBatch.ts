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
import type { BatchDocument } from './batchModel';

export type ParseAttempt = { ok: true; doc: BatchDocument } | { ok: false; error: string };

/**
 * Единый разбор текста пакета — общий источник правды для открытия из текста
 * (`App.loadModel`) и проверки при «ОК» (`validateBatchText`). Успех → разобранный
 * документ; исключение лексера/парсера → текст ошибки.
 */
export function tryParseBatch(text: string): ParseAttempt {
  try {
    return { ok: true, doc: parseBatch(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Проверка при «ОК»: тот же критерий, что и открытие из текста (`tryParseBatch`).
 * Корректный (разбираемый) запрос → `ok:true`; иначе — сообщение парсера.
 */
export function validateBatchText(text: string): ValidationResult {
  const r = tryParseBatch(text);
  return r.ok ? { ok: true } : { ok: false, error: 'Запрос содержит ошибку: ' + r.error };
}
