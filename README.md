# 1C: Query Constructor

Визуальный конструктор запросов 1С в виде расширения (VSIX) для VS Code — аналог
«Конструктора запроса» из Конфигуратора/EDT. Работает с конфигурацией 1С,
выгруженной в файлы (`*.xml` — метаданные, `*.bsl` — код): строит дерево «таблицы →
поля → типы → связи», даёт собрать запрос мышью и генерирует текст на языке запросов
1С (SDBL).

> **Статус:** MVP-каркас (вертикальный срез сквозь все слои) + парсер метаданных в
> YAML — готовы. Дорожная карта и фазы — в [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Архитектура

Проект разбит на 4 изолированные подсистемы. Логика живёт в `core` (pure-TS, без
зависимости от `vscode`/React — тестируется в Node), webview — «тонкий» UI, контракт
между слоями сосредоточен в `src/shared/messages.ts`.

| Слой | Каталог | Роль |
|---|---|---|
| Метаданные | `src/core/metadata` | Парсинг выгрузки `cf` → модель/YAML «таблицы → поля → типы» |
| Запрос (SDBL) | `src/core/query` | Модель конструктора → текст запроса 1С |
| UI конструктора | `src/webview` | React-панели: База данных / Таблицы / Поля |
| Интеграция VS Code | `src/extension` | Команды, webview-панель, вставка результата в редактор |

## Структура каталогов

```
query_console_vscode/
├── src/
│   ├── extension/            # СЛОЙ VS Code (тонкий, зависит от vscode)
│   │   ├── extension.ts      #   activate(): регистрация команд
│   │   ├── panel.ts          #   WebviewPanel, мост postMessage
│   │   ├── parseCommand.ts   #   команда 1c.parseMetadata (обёртка над ядром)
│   │   ├── resolveCfPath.ts  #   поиск каталога выгрузки cf
│   │   └── insertResult.ts   #   вставка текста в активный редактор
│   ├── core/                 # PURE-TS ядро (без vscode/React, тестируется в Node)
│   │   ├── metadata/
│   │   │   ├── parser/        #   парсер выгрузки → YAML (см. ниже)
│   │   │   ├── cfParser.ts    #   XML → MetadataModel (старый путь конструктора)
│   │   │   ├── cacheBuilder.ts / cacheLoader.ts   # JSON-кэш модели
│   │   │   └── types.ts       #   модель метаданных
│   │   └── query/
│   │       ├── queryModel.ts      # модель выбора пользователя
│   │       └── sdblGenerator.ts   # QueryModel → текст SDBL
│   ├── webview/              # СЛОЙ UI (React + TypeScript)
│   │   ├── App.tsx, main.tsx, bridge.ts
│   │   ├── components/        #   DbTreePanel / TablesPanel / FieldsPanel / TabsBar
│   │   └── state/queryStore.ts
│   ├── shared/
│   │   └── messages.ts       # контракт сообщений host ↔ webview
│   ├── cli/
│   │   └── parseMetadata.ts  # CLI-вход парсера метаданных
│   └── cf/                   # пример выгрузки конфигурации 1С (в .gitignore)
├── docs/
│   ├── ROADMAP.md            # общий план проекта (фазы и статусы)
│   └── superpowers/
│       ├── specs/            #   дизайн-документы (спеки) по итерациям
│       └── plans/            #   планы реализации
├── test/
│   ├── unit/                 # юнит-тесты ядра (Vitest)
│   ├── e2e/                  # Playwright e2e для webview
│   ├── fixtures/             # мини-выгрузка cf + tree-sitter.wasm
│   └── helpers/              # assertValidSdbl (валидатор SDBL на tree-sitter)
├── tasks/                    # описания отдельных задач
├── .devcontainer/           # dev-контейнер (node:22 + Claude Code CLI)
├── package.json             # манифест расширения + npm-скрипты
├── tsconfig*.json, vitest.config.ts, playwright.config.ts
└── DESCRIPTION.md           # исходное описание требований
```

### `src/core/metadata/parser/` — парсер метаданных в YAML

```
dom.ts                 DOM-хелперы (childByLocalName / nodeText, фикс UTF-8 BOM)
typeParser.ts          <Type> → Type[] (логический тип 1С + квалификаторы)
attribute.ts           <Attribute> → Field
catalog.ts             XML Справочника  → ParsedObject
document.ts            XML Документа    → ParsedObject
constant.ts            XML Константы    → ParsedObject
enum.ts                XML Перечисления → ParsedObject
model.ts               TS-интерфейсы результата (ParsedObject, Field, Type, …)
yamlWriter.ts          ParsedObject / индекс → YAML-файл
parseConfiguration.ts  оркестратор: обход cf/, диспетч по типам, запись дерева
```

## Сборка и запуск

```bash
npm install
npm run build          # сборка extension + webview в out/
npm run dev            # build + запуск VS Code с расширением (--extensionDevelopmentPath)
```

Команды расширения (палитра команд VS Code):

- **`1С: Конструктор запроса`** (`1c.queryConstructor`) — открывает webview-панель.
- **`1С: Распарсить метаданные в YAML`** (`1c.parseMetadata`) — парсит выгрузку в YAML.

Настройки (`contributes.configuration`):

- `queryConsole.metadataPath` — путь к каталогу выгрузки `cf` (пусто → автоопределение).
- `queryConsole.parserOutputPath` — каталог результата парсинга (по умолчанию `tmp/parser_data`).

## Парсер метаданных (CLI)

```bash
npm run parse -- --cf <путь-к-cf> --out <путь-вывода>
```

- `--cf` — каталог выгрузки (где `Catalogs/`, `Documents/`, …). По умолчанию — автоопределение `src/cf`.
- `--out` — каталог вывода. По умолчанию `tmp/parser_data`.

На выходе — дерево YAML (полная перегенерация при каждом прогоне):

```
cf/
  configuration.yaml          # имя конфигурации + индекс всех объектов
  Catalogs/<Имя>.yaml         # Справочники
  Documents/<Имя>.yaml        # Документы
  Constants/<Имя>.yaml        # Константы
  Enums/<Имя>.yaml            # Перечисления
```

Каждый YAML содержит исчерпывающую информацию о таблице: свойства, стандартные поля,
реквизиты с типами и квалификаторами, табличные части, ссылку на исходный XML.
Подробности схемы — в [спеке парсера](docs/superpowers/specs/2026-06-01-metadata-parser-yaml-design.md).

## Тесты

Разработка ведётся по **TDD** (см. `DESCRIPTION.md`).

```bash
npm run test:unit      # юнит-тесты ядра (Vitest): cfParser, sdblGenerator, typeParser, cache
npm run test:e2e       # Playwright e2e для webview
```

Генератор SDBL дополнительно проверяется тест-оракулом `assertValidSdbl` —
сгенерированный текст парсится через `tree-sitter-sdbl` (WASM) без ошибок.

## Документация

- [`docs/1c-query-language.md`](docs/1c-query-language.md) — **справочник по языку запросов 1С (SDBL)**: синтаксис, секции (`ВЫБРАТЬ`/`ИЗ`/`ГДЕ`/`СГРУППИРОВАТЬ`/`ИТОГИ`), соединения, временные таблицы, встроенные и агрегатные функции, операторы условий, таблица ключевых слов рус/англ, именование таблиц. Конспект [Главы 8 документации 1С:Предприятие 8.3.27](https://its.1c.ru/db/v8327doc).
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — общий план проекта, фазы и статусы.
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — дизайн-документы (спеки) по итерациям.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — планы реализации.
- [`DESCRIPTION.md`](DESCRIPTION.md) — исходные требования и контекст.
