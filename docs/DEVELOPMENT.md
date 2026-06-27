# Разработка

Документация для разработчиков: архитектура, структура кода, сборка, тесты и релизы.
Пользовательское описание расширения — в корневом [`README.md`](../README.md).

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
├── .devcontainer/           # dev-контейнер (node:22 + Claude Code CLI)
├── package.json             # манифест расширения + npm-скрипты
└── tsconfig*.json, vitest.config.ts, playwright.config.ts
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

Быстрый старт — скрипт [`install.sh`](../install.sh) (проверка Node, системные пакеты
для node-gyp, `npm install` и сборка одной командой):

```bash
./install.sh           # окружение + npm install + build
./install.sh --e2e     # + браузеры Playwright для e2e-тестов
./install.sh --docker  # + Docker Engine и devcontainers CLI (для DevContainer)
./install.sh --help     # все опции (--wasm, --no-system)
```

Для разработки в контейнере (`.devcontainer/`) нужен Docker на хосте: `./install.sh
--docker` ставит Docker Engine (buildx/compose), добавляет пользователя в группу
`docker` и `@devcontainers/cli`. Дальше — «Dev Containers: Reopen in Container» в VS
Code или `devcontainer up --workspace-folder .` из терминала.

Требуется **Node.js ≥ 20** (рекомендуется 22) и npm. Вручную то же самое:

```bash
npm install
npm run build          # сборка extension + webview в out/
npm run dev            # build + запуск VS Code с расширением (--extensionDevelopmentPath)
```

## Релизы (VSIX)

Готовый `.vsix` собирается автоматически в GitHub Actions по git-тегу и
прикладывается к GitHub Release — в репозитории файл не хранится.

```bash
npm version 0.1.0        # version в package.json + коммит + тег v0.1.0
git push --follow-tags   # пуш тега запускает workflow .github/workflows/release.yml
```

Workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) на пуше
тега `v*` ставит зависимости, упаковывает расширение через `@vscode/vsce` и создаёт
Release с файлом `query-console-1c-<тег>.vsix` в Assets. Локально собрать пакет можно
командой `npm run package`.

### Установка VSIX

Скачайте `query-console-1c-<тег>.vsix` со страницы
[Releases](https://github.com/AlekseyUAM/query_console_vscode/releases) и установите
одним из способов.

Через UI VS Code: панель **Extensions** (`Ctrl+Shift+X`) → меню «**...**» →
**Install from VSIX...** → выбрать файл.

Через командную строку (`--force` — для обновления поверх установленной версии):

```bash
code --install-extension query-console-1c-<тег>.vsix
code --install-extension query-console-1c-<тег>.vsix --force
```

Скачать и установить одной командой:

```bash
curl -L -o qc.vsix \
  https://github.com/AlekseyUAM/query_console_vscode/releases/latest/download/query-console-1c-<тег>.vsix
code --install-extension qc.vsix
```

Для VS Code Insiders используйте `code-insiders`, для VSCodium — `codium`. После
установки при необходимости перезагрузите окно (`Ctrl+Shift+P` → **Reload Window**).

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
Подробности схемы — в [спеке парсера](superpowers/specs/2026-06-01-metadata-parser-yaml-design.md).

## Тесты

Разработка ведётся по **TDD**.

```bash
npm run test:unit      # юнит-тесты ядра (Vitest): cfParser, sdblGenerator, typeParser, cache
npm run test:e2e       # Playwright e2e для webview
```

Генератор SDBL дополнительно проверяется тест-оракулом `assertValidSdbl` —
сгенерированный текст парсится через `tree-sitter-sdbl` (WASM) без ошибок.

## Тестирование на другой конфигурации

Парсер запроса можно прогнать против произвольной конфигурации 1С: из базы выгружаются
эталонные запросы и тексты запросов из кода, валидируются через MCP-оракул `1c-md`,
прогоняются через конструктор, и на каждое расхождение пишется отдельный JSON-файл с
ошибкой. Механизм конфигурируется через `.env` (см. [`.env.example`](../.env.example)),
запускается одной командой `npm run corpus:test`.

Полная пошаговая инструкция — в [`docs/corpus-testing.md`](corpus-testing.md);
1С-сторона (внешняя обработка выгрузки запросов) — в
[`tooling/1c-export/`](../tooling/1c-export/README.md).

## Документация

- [`docs/ROADMAP.md`](ROADMAP.md) — общий план проекта, фазы и статусы.
- [`docs/superpowers/specs/`](superpowers/specs/) — дизайн-документы (спеки) по итерациям.
- [`docs/superpowers/plans/`](superpowers/plans/) — планы реализации.
