# Фаза 7. Единая команда — план реализации

← [Спек](../specs/2026-06-17-phase7-single-command-design.md) · [PHASE_7](../../PHASE_7.md)

TDD. Ядро решения — pure-TS, юнит-тестируется; обвязка vscode — без тестов (нет мока).

## Шаг 1. Pure-планнер `planQueryConstructor` (TDD)

- Тест `test/unit/queryConstructorPlan.test.ts`:
  - offset внутри литерала-запроса → `{ kind: 'open', queryText, queryRange }`
    (значения из `findQueryAt`).
  - offset вне литерала → `{ kind: 'prompt', offset }`.
- Реализация `src/extension/queryConstructorPlan.ts`: тонкая обёртка над `findQueryAt`.
- `npm run test:unit` — зелёный (RED → GREEN).

## Шаг 2. Слить логику в `1c.queryConstructor` (extension.ts)

- Обработчик `1c.queryConstructor` становится `async`:
  - нет активного редактора → `showWarningMessage('Откройте .bsl файл')`, выход.
  - `planQueryConstructor(source, offset)`:
    - `open` → `createPanel(context, cfPath, channel, { document, selection,
      queryRange, wrapAsBslString: true }, queryText)`.
    - `prompt` → модал «Не найден текст запроса. Создать новый запрос?» (`Да`/`Нет`);
      при `Да` → `createPanel(..., { ..., queryRange: {start: offset, end: offset},
      wrapAsBslString: true })` без `initialQueryText`.
- Удалить регистрацию и обработчик `1c.queryConstructorFromCursor`; убрать его из
  `context.subscriptions.push(...)`.

## Шаг 3. Подчистить `package.json`

- Удалить из `contributes.commands[]` запись `1c.queryConstructorFromCursor`.
- Удалить из `contributes.menus.editor/context[]` пункт `1c.queryConstructorFromCursor`.
- Оставить единственный пункт меню `1c.queryConstructor`.

## Шаг 4. Верификация

- `npm run test:unit` — зелёный (новый тест + существующие, в т.ч. `findQueryAt`).
- `npm run build:extension` — бандл собирается без ошибок (проверяет, что extension.ts
  валиден и нет битых импортов на удалённую команду).
- `grep -r queryConstructorFromCursor src package.json` — пусто.

## Шаг 5. Документация и коммит

- PHASE_7.md: пометить подфазу 1 закрытой (✅), сослаться на спек/план.
- ROADMAP.md: статус Фазы 7 ⬜ → ✅ (или 🚧, если это единственная подфаза — ✅).
- Коммит в master локально.
