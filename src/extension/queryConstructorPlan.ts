/**
 * Чистый планировщик команды «1С: Конструктор запроса»: по исходнику `.bsl` и
 * смещению курсора решает, открыть ли конструктор с текстом литерала под курсором
 * (`open`), либо запросить у пользователя создание нового запроса (`prompt`).
 *
 * Модуль ДОЛЖЕН оставаться чистым (без `import vscode`/`fs`) — он юнит-тестируется.
 * Привязка к команде vscode живёт в extension.ts.
 */

import { findQueryAt } from './queryAtCursor';

export type OpenPlan =
  | { kind: 'open'; queryText: string; queryRange: { start: number; end: number } }
  | { kind: 'prompt'; offset: number };

export function planQueryConstructor(source: string, offset: number): OpenPlan {
  const hit = findQueryAt(source, offset);
  if (hit) {
    return {
      kind: 'open',
      queryText: hit.text,
      queryRange: { start: hit.start, end: hit.end },
    };
  }
  return { kind: 'prompt', offset };
}
