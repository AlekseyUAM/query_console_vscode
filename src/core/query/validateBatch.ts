/**
 * 7.8.10 — Валидация сгенерированного текста пакета запросов при нажатии «ОК».
 *
 * Чистый хелпер: лексирует+парсит текст (`parseBatch`); исключение лексера/парсера
 * → `ok:false` с сообщением. Пустой текст → `ok:false`. Перехватывает основной
 * вектор некорректности (сломанное произвольное выражение → несбалансированные
 * кавычки/скобки → бросок лексера/парсера). Глубокая семантическая валидация имён
 * полей по метаданным — вне скоупа.
 */

import { parseBatch } from './sdblParser';

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateBatchText(text: string): ValidationResult {
  if (text.trim() === '') {
    return { ok: false, error: 'Пустой запрос' };
  }
  try {
    parseBatch(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Запрос содержит ошибку: ' + (e as Error).message };
  }
}
