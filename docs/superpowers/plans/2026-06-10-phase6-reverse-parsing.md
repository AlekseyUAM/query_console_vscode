# Фаза 6 — Обратный разбор текста запроса. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax. TDD обязателен. После каждой задачи —
> зелёные `npm run test:unit` и `npm run build`, затем коммит в `master`.

**Goal:** Восстанавливать визуальную модель конструктора из текста запроса SDBL и
открывать существующий запрос из `.bsl` для редактирования с сохранением назад.

**Architecture:** Pure-TS лексер + рекурсивный парсер (`src/core/query/sdblLexer.ts`,
`sdblParser.ts`), инверсия `sdblGenerator`. Метаданные не требуются (`tableId` —
синтетические из алиасов `ИЗ`). Интеграция VS Code — отдельная команда ПКМ.

**Tech Stack:** TypeScript, vitest, esbuild, VS Code API. Референс синтаксиса —
`tmp/tree-sitter-bsl/grammars/sdbl`. Спек: `docs/superpowers/specs/2026-06-10-phase6-reverse-parsing-design.md`.

---

## Задача 6.1 — CLI извлечения корпуса запросов

**Files:**
- Create: `src/cli/extractQueries.ts`
- Build: переиспользовать esbuild (как `build:cli`)

**Что делает:** рекурсивно обходит `src/cf/**/*.bsl`; находит строковые литералы 1С
(двойные кавычки, многострочные с префиксом продолжения `|`), в которых первый значимый
токен — `ВЫБРАТЬ` или `УНИЧТОЖИТЬ` (регистронезависимо); снимает обрамляющие `"` и
префиксы `|` (инверсия `formatAsBslString`: первая строка без `|`, последующие — срезать
ведущие пробелы+`|`); каждый кандидат валидирует MCP `validate_query`; валидные пишет в
`tmp/query1c/<rel>_<N>.txt`, где `<rel>` — путь от `src/cf/` с `/`→`-`, `<N>` — порядковый
номер запроса в файле (с 1). Пример: `Catalogs/Валюты/Ext/ObjectModule.bsl` →
`tmp/query1c/Catalogs-Валюты-Ext-ObjectModule.bsl_1.txt`.

**Замечания по лексике BSL-строк:** литерал 1С — `"…"`, удвоенная кавычка `""` внутри.
Многострочный литерал: каждая визуальная строка-продолжение начинается с `|`
(возможны ведущие пробелы/табы до `|`). Конкатенация `"…" + "…"` — обрабатывать как
отдельные литералы (брать только тот, что начинается с ВЫБРАТЬ). Игнорировать
комментарии `//` и однокавычные даты.

- [ ] **Шаг 1.** Реализовать чистую функцию `extractQueryStrings(bslSource: string):
  {text: string; lineStart: number}[]` (экспортировать для теста) — без MCP, без fs.
- [ ] **Шаг 2 (TDD).** `test/unit/extractQueries.test.ts`: на фрагменте BSL с одним и с
  двумя запросами проверить снятие `|`, нумерацию, что не-запросные строки игнорируются.
- [ ] **Шаг 3.** Обёртка CLI: обход `src/cf`, вызов MCP-валидатора недоступен из Node —
  поэтому валидация делается так: CLI пишет **всех** кандидатов в `tmp/query1c/`, а
  фильтрацию по `validate_query` выполняет оператор/субагент отдельным проходом (см.
  ниже «прогон»). Альтернатива: если в окружении есть `tmp/query1c` уже отфильтрованный —
  не трогать валидные. Главное — детерминированный набор `.txt`.
- [ ] **Шаг 4.** Прогон: `npx esbuild src/cli/extractQueries.ts --bundle --platform=node
  --outfile=out/cli/extractQueries.js && node out/cli/extractQueries.js`. Затем субагент
  валидирует каждый `.txt` через MCP `validate_query`; невалидные удаляет. Залогировать
  счётчики (найдено/валидно/отброшено).
- [ ] **Шаг 5.** `npm run test:unit`, `npm run build` зелёные. Commit:
  `feat(phase6): задача 6.1 — CLI извлечения корпуса запросов из .bsl`.

---

## Задача 6.2.A — Лексер + парсер: ВЫБРАТЬ/ИЗ (скелет)

**Files:**
- Create: `src/core/query/sdblLexer.ts`, `src/core/query/sdblParser.ts`
- Test: `test/unit/sdblParser.test.ts`

**Лексер.** `Token = {type, value, line, col}`; типы: `keyword`, `ident`, `string`,
`number`, `date`, `param`(&Имя), `punct`(`.,()=<>{}*;` и составные `<>`,`>=`,`<=`),
`comment`. Ключевые слова — фиксированный регистронезависимый набор (см. §4 спека).
`tokenize(text)` пропускает пробелы и комментарии (но хранит позиции для 6.6).

**Парсер.** Рекурсивный спуск с курсором по токенам. На этом шаге — минимум:
`parseQuery`: `ВЫБРАТЬ` [модификаторы] список-полей `ИЗ` список-источников. Поле:
`Алиас.Путь [КАК Псевдоним]` либо агрегат `ФУНКЦИЯ(Алиас.Путь)` либо произвольное
выражение (всё до запятой/ключевого слова) → `{expression}`. Источник: `ПолноеИмя
[(параметры)] КАК Алиас`. Сборка `tables` с `id='t'+i`, `fullName`, `alias`; `fields`
с резолвом префикса по карте alias→id.

- [ ] **Шаг 1 (TDD).** Тест round-trip: для минимального эталона
  `ВЫБРАТЬ\n\tВалюты.Наименование КАК СимвольныйКод\nИЗ\n\tСправочник.Валюты КАК Валюты`
  ожидать `generate(parseQuery(text)) === text`. Запустить — упасть.
- [ ] **Шаг 2.** Лексер + минимальный парсер до прохождения теста.
- [ ] **Шаг 3 (TDD).** Добавить: модификаторы РАЗРЕШЕННЫЕ/РАЗЛИЧНЫЕ/ПЕРВЫЕ N; агрегаты
  (все 6, включая `КОЛИЧЕСТВО(РАЗЛИЧНЫЕ …)`); несколько таблиц через запятую; поле без
  псевдонима; произвольное выражение-поле `Поле1`. Round-trip на каждом.
- [ ] **Шаг 4.** Реализовать, тесты зелёные. `npm run test:unit`,`npm run build`. Commit:
  `feat(phase6): задача 6.2.A — лексер и парсер ВЫБРАТЬ/ИЗ`.

---

## Задача 6.2.B — Виртуальные таблицы, ГДЕ, соединения, группировка

**Files:** `src/core/query/sdblParser.ts`, `test/unit/sdblParser.test.ts`

- [ ] **Шаг 1 (TDD).** Round-trip эталонов с виртуальными таблицами всех видов
  (взять эталоны из существующих тестов генератора как источник истины: РН Остатки/
  Обороты/ОстаткиИОбороты, РС срез, РБ Остатки/Обороты/ОборотыДтКт/ОстаткиИОбороты/
  ДвиженияССубконто). Парсер источника `Имя.Срез(п1, п2, …)` восстанавливает
  `SelectedTable.virtual` по тем же позиционным правилам, что печатает `renderSource`
  (см. `accountingPositions` и ветки `renderSource`). Пустые позиции (`, ,`) → undefined.
- [ ] **Шаг 2.** Реализовать разбор `virtual` (инверсия `renderSource`). `correspondence`
  определяется по числу позиций в РБ-Обороты.
- [ ] **Шаг 3 (TDD).** ГДЕ: простое `Алиас.Путь <оп> &Параметр` (все операторы, включая
  `В`,`МЕЖДУ`,`ПОДОБНО`) → `Condition{custom:false,…}`; цепочка `И` → несколько условий;
  всё, что не матчит шаблон простого условия → `Condition{custom:true, expression}`
  (текст между `ГДЕ`/`И` и следующим разделителем). Round-trip против `renderConditions`.
- [ ] **Шаг 4 (TDD).** Соединения: `ИЗ A КАК a ВНУТРЕННЕЕ/ЛЕВОЕ/ПОЛНОЕ СОЕДИНЕНИЕ B КАК b
  ПО <условие>` → `joins[]` + `tables[]`. Восстановить `leftAll/rightAll` из ключевого
  слова (ВНУТРЕННЕЕ→оба false; ЛЕВОЕ→leftAll true,rightAll false; ПОЛНОЕ→оба true).
  Условие ПО: простое `a.p = b.p` → структурное; иначе `custom`. Хвостовые таблицы после
  цепочки (через запятую) — обычные `tables`. Round-trip против `renderFrom`.
  ⚠ Нормализация ПРАВОЕ→ЛЕВОЕ в генераторе односторонняя: тест round-trip строить на
  выводе генератора (канонический), не на ПРАВОЕ.
- [ ] **Шаг 5 (TDD).** СГРУППИРОВАТЬ ПО (поля) и ГРУППИРУЮЩИМ НАБОРАМ → `grouping`.
  Агрегаты в полях выборки уже дают `grouping.aggregates` — согласовать: при разборе
  агрегатного поля добавлять в `grouping.aggregates`. Round-trip против `renderGrouping`.
- [ ] **Шаг 6.** Тесты зелёные, `build`. Commit:
  `feat(phase6): задача 6.2.B — виртуальные таблицы, ГДЕ, соединения, группировка`.

---

## Задача 6.2.C — ПОРЯДОК, ИТОГИ, ИНДЕКС, temp/lock, построитель

**Files:** `src/core/query/sdblParser.ts`, `test/unit/sdblParser.test.ts`

Адресация по псевдониму выборки: хелпер `resolveSelectAlias(model, alias)` —
обратный к `selectAliasFor`: найти поле `model.fields` с этим псевдонимом (или последним
сегментом пути) → `(tableId,path)`; не нашёл → оставить `path=alias`, `tableId=''`.

- [ ] **Шаг 1 (TDD).** ПОМЕСТИТЬ/ДОБАВИТЬ `<ВТ>` (между полями и ИЗ) → `queryType`+
  `tempTableName`; `УНИЧТОЖИТЬ <ВТ>` (самостоятельный) → `queryType:'dropTemp'`.
  Round-trip против `generate` (createTemp/appendTemp/dropTemp).
- [ ] **Шаг 2 (TDD).** УПОРЯДОЧИТЬ ПО (+УБЫВ) и АВТОУПОРЯДОЧИВАНИЕ → `order`. Round-trip
  против `renderOrder`.
- [ ] **Шаг 3 (TDD).** ИТОГИ: `ИТОГИ [агрегаты] ПО [ОБЩИЕ] группы` → `totals`. Суффиксы
  ИЕРАРХИЯ/ТОЛЬКО ИЕРАРХИЯ → `kind`; `КАК` → `alias`; агрегаты → `totalFields`
  (`expression`); `ОБЩИЕ` → `grand`. Round-trip против `renderTotals`.
- [ ] **Шаг 4 (TDD).** ИНДЕКСИРОВАТЬ ПО / ПО НАБОРАМ (УНИКАЛЬНО) → `indexing`. Round-trip
  против `renderIndex` (только при `createTemp`).
- [ ] **Шаг 5 (TDD).** ДЛЯ ИЗМЕНЕНИЯ `<таблицы>` → `lockForUpdate`. Round-trip.
- [ ] **Шаг 6 (TDD).** Построитель `{ВЫБРАТЬ…}/{ГДЕ…}/{УПОРЯДОЧИТЬ ПО…}/{ИТОГИ ПО…}`,
  суффикс `.*`, `КАК` → `builder`. Round-trip против `builderBlock`.
- [ ] **Шаг 7 (TDD).** Вложенные табличные части `Алиас.ТЧ.(п1 КАК п1, …) КАК ТЧ` →
  `tabSectionFields`. Round-trip против соответствующей ветки `buildFieldLines`.
- [ ] **Шаг 8.** Тесты зелёные, `build`. Commit:
  `feat(phase6): задача 6.2.C — порядок, итоги, индекс, ВТ, построитель`.

---

## Задача 6.2.D — Объединения и пакеты

**Files:** `src/core/query/sdblParser.ts`, `test/unit/sdblParser.test.ts`

- [ ] **Шаг 1 (TDD).** `parseDocument`: разбить текст по `ОБЪЕДИНИТЬ [ВСЕ]` на верхнем
  уровне (не внутри скобок/построителя), каждый блок → `parseQuery`; `distinct` участника
  i>0 = пришёл `ОБЪЕДИНИТЬ` без `ВСЕ`. ⚠ Поля участников i>0 в каноническом выводе идут
  БЕЗ `КАК` — псевдонимы восстанавливаются из участника 0 по позиции (см. `deriveUnionColumns`/
  `generateDocument`). Имя участника — синтетическое (`Запрос N`). Round-trip против
  `generateDocument` (1 участник → как `generate`; ≥2 → объединение).
- [ ] **Шаг 2 (TDD).** `parseBatch`: разбить по разделителю пакета (`;` + строка из 80
  `/`), каждый → `parseDocument`. Round-trip против `generateBatch`.
- [ ] **Шаг 3.** Тесты зелёные, `build`. Commit:
  `feat(phase6): задача 6.2.D — объединения и пакеты запросов`.

---

## Задача 6.3 — Приёмочный прогон по корпусу

**Files:**
- Create: `src/cli/acceptQueries.ts`
- Output: `tmp/query1c/errors/` (копии проблемных), `tmp/query1c/errors/report.json`

**Что делает:** для каждого `tmp/query1c/*.txt`: `t0=read`; `m=parseBatch(t0)`;
`out=generateBatch(m)`; `m2=parseBatch(out)`; критерий приёмки — `generateBatch(m2)===out`
(идемпотентность канонизации) И отсутствиеброска исключения. Несоответствие/исключение →
копировать исходный файл в `tmp/query1c/errors/` и записать причину в `report.json`.
Печатает сводку «ok/errors/total».

- [ ] **Шаг 1.** Реализовать CLI.
- [ ] **Шаг 2.** Прогон через esbuild+node. Зафиксировать сводку.
- [ ] **Шаг 3.** `npm run test:unit`,`build`. Commit:
  `feat(phase6): задача 6.3 — приёмочный прогон корпуса, проблемные → errors/`.

---

## Задача 6.4 — Починка по корпусу ошибок

**Files:** `src/core/query/sdblParser.ts` (+лексер), `test/unit/sdblParser.test.ts`

- [ ] **Шаг 1.** Сгруппировать `tmp/query1c/errors/` по типу причины (из `report.json`).
- [ ] **Шаг 2 (TDD).** На каждый класс ошибок — добавить минимальный фикстур-тест в
  `sdblParser.test.ts` (вырезка реальной конструкции), починить парсер. При сомнении в
  синтаксисе — MCP `validate_query`.
- [ ] **Шаг 3.** Повторный прогон 6.3 до минимизации `errors/`. Остаточные принципиально
  неподдерживаемые (выходят за §4 спека) — описать в `tmp/query1c/errors/README.md`.
- [ ] **Шаг 4.** `npm run test:unit`,`build`. Commit:
  `fix(phase6): задача 6.4 — разбор реальных запросов из корпуса`.

---

## Задача 6.5 — Фикстуры и 100% покрытие парсера

**Files:**
- Create: `test/fixtures/queries/*.sdbl` (репрезентативные тексты), `test/unit/sdblParser.coverage.test.ts`

- [ ] **Шаг 1.** Отобрать ~15–25 ключевых текстов из `tmp/query1c` (по одному на класс
  конструкций §4) → `test/fixtures/queries/`.
- [ ] **Шаг 2 (TDD).** Параметризованный тест: для каждого фикстура round-trip
  идемпотентность + `assertValidSdbl` (если грамматика есть). Плюс прицельные тесты на
  ветки, не покрытые фикстурами (ошибки лексера, пустой ввод, только `УНИЧТОЖИТЬ`).
- [ ] **Шаг 3.** `npx vitest run --coverage src/core/query/sdblParser.ts
  src/core/query/sdblLexer.ts` → 100% строк/веток. Дописать тесты до 100%.
- [ ] **Шаг 4.** `npm run test:unit`,`build`. Commit:
  `test(phase6): задача 6.5 — фикстуры и 100% покрытие разбора`.

---

## Задача 6.6 — Открытие запроса из .bsl и сохранение назад

**Files:**
- Modify: `src/shared/messages.ts`, `src/extension/extension.ts`, `src/extension/panel.ts`,
  `src/webview/App.tsx`, `src/webview/state/queryStore.ts`, `package.json` (вклад команды+меню)
- Create: `src/extension/queryAtCursor.ts`, `test/unit/queryAtCursor.test.ts`,
  `src/webview/state/applyModel.ts`, `test/unit/applyModel.test.ts`

**Контракт.** В `messages.ts`: `HostMsg |= {type:'loadModel'; doc: BatchDocument}`.
Webview по `loadModel` диспатчит восстановление стора из модели.

- [ ] **Шаг 1 (TDD).** `queryAtCursor.ts`: чистая функция `findQueryAt(source: string,
  offset: number): {text: string; range:[number,number]} | null` — найти строковый
  литерал-запрос, охватывающий `offset` (переиспользовать лексику из 6.1
  `extractQueryStrings`, добавив диапазоны смещений). Тест `queryAtCursor.test.ts`.
- [ ] **Шаг 2 (TDD).** `applyModel.ts`: `applyBatchToState(doc: BatchDocument): QueryState`
  — инверсия `buildModelFromFlat`/`assembleMembers` из `queryStore.ts`. Покрыть тестами
  ключевые секции (таблицы/поля/условия/порядок/объединение). Изучить `queryStore.ts`
  снапшот/restore — переиспользовать формат `SavedQuery`/flat-state.
- [ ] **Шаг 3.** Команда `1c.queryConstructorFromCursor` в `package.json` (`contributes.
  commands` + `menus.editor/context` с `when: resourceExtname == .bsl`). В `extension.ts`
  зарегистрировать: взять активный редактор, offset курсора, `findQueryAt`; если найдено —
  `createPanel(..., {document, range})` и после `ready` отправить `loadModel`
  (`parseBatch(text)`); если нет — `showWarningMessage(...,'Да','Нет')` «Не найден текст
  запроса. Создать новый запрос?»; Да → пустая панель.
- [ ] **Шаг 4.** `panel.ts`: расширить `SavedEditorState`/`insertResult` — при наличии
  `range` заменять именно диапазон литерала результатом `formatAsBslString(text)` (а не
  `selection`). Передавать восстановленную модель в webview по `ready`.
- [ ] **Шаг 5.** `App.tsx`/`queryStore.ts`: обработать `loadModel` → `applyBatchToState`,
  установить стор, перерисовать вкладки.
- [ ] **Шаг 6.** `npm run test:unit`,`build`. Ручная проверка сценария описана в спеке §5.
  Commit: `feat(phase6): задача 6.6 — открытие запроса из .bsl с сохранением назад`.

---

## Финал

- [ ] Обновить `docs/ROADMAP.md`: Фаза 6 → ✅ со ссылками на спек/план, краткое резюме.
- [ ] Финальные `npm run test:unit` и `npm run build` зелёные. Commit:
  `docs: ROADMAP — Фаза 6 закрыта (обратный разбор)`.

## Self-review заметки

- Покрытие §4 спека ↔ задачи: ВЫБРАТЬ/ИЗ→6.2.A; виртуальные/ГДЕ/соединения/группировка→
  6.2.B; порядок/итоги/индекс/temp/построитель/ТЧ→6.2.C; объединения/пакет→6.2.D; .bsl→6.6.
- Источник эталонов round-trip — существующие тесты `sdblGenerator.test.ts` (канонический
  вывод), чтобы не выдумывать форматирование.
- Риск 6.6 (инверсия стора) — самый высокий; держать `applyModel` строго по формату
  `SavedQuery` стора, опираясь на снапшот/restore.
