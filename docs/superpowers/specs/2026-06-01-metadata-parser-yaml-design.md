# Парсер метаданных → YAML: дизайн

Дата: 2026-06-01

## Цель

Переделать парсер метаданных 1С так, чтобы результатом был **каталог YAML-файлов на диске**
(структура `cf/<Тип>/<Имя>.yaml` + `cf/configuration.yaml`), а не только in-memory модель.

Мотивация (со слов пользователя):
1. Парсер переедет в другой проект — нужен переиспользуемый, развязанный артефакт
   (YAML на диске как контракт между парсером и потребителями).
2. Текущий парсер «безнадёжен» — нужен способ проверять его самостоятельно, иначе
   разработка затягивается. Человекочитаемый YAML — это и есть артефакт верификации.
3. Парсер — одна из сложнейших частей; делаем по частям, инкрементально.

См. также решение об источнике метаданных: `[[metadata-source-decision]]` — собственный
TS-парсер, без внешних инструментов (md-sparrow / tree-sitter-bsl).

## Границы

**В рамках этого спека:** парсер → YAML + CLI + тонкая VS Code команда.

**Вне рамок (отдельные задачи):**
- Перевод конструктора/webview на чтение YAML. Текущий путь (`cfParser.ts` →
  `cacheBuilder`/`cacheLoader` → `panel.ts` → webview) остаётся нетронутым и рабочим.
- Маппинг логических типов на физические SQL-типы и восстановление физических имён
  колонок СУБД (`_Reference123…`).

## Объём типов

Конвейер общий для всех типов. В этот спек входят 4 типа метаданных:
`Catalogs` (Справочник), `Documents` (Документ), `Constants` (Константа), `Enums`
(Перечисление). Архитектура рассчитана на добавление новых типов отдельными задачами.

План реализует типы фазами: сначала Справочник end-to-end (самый богатый — реквизиты,
табличные части, квалификаторы, ссылки) с прогоном и проверкой, затем Документ (почти
идентичен), затем Константа и Перечисление (другая форма).

## Уровень типов

Храним **логический тип 1С + квалификаторы** (всё берётся из XML, без догадок):
- Примитивы: `Строка | Число | Дата | Булево` + квалификаторы.
- Ссылки: `ref` на `<Тип>.<Имя>`.
- Никакого SQL-маппинга и физических имён колонок.

## Архитектура

### Модули

```
src/core/metadata/parser/        ← новое чистое ядро (без import vscode)
  dom.ts                 DOM-хелперы (childByLocalName / childrenByLocalName / nodeText,
                         перенос из cfParser; включая фикс UTF-8 BOM)
  typeParser.ts          <Type> → Type[] (логический тип + квалификаторы)
  attribute.ts           <Attribute> → Field
  catalog.ts             XML → ParsedObject (Справочник)
  document.ts            XML → ParsedObject (Документ)
  constant.ts            XML → ParsedObject (Константа)
  enum.ts                XML → ParsedObject (Перечисление)
  model.ts               TS-интерфейсы результата (ParsedObject, Field, Type,
                         TabularSection, ConfigurationIndex, ...)
  yamlWriter.ts          ParsedObject / ConfigurationIndex → YAML-файл
  parseConfiguration.ts  оркестратор: обход cf/, диспетч по типам, запись дерева
                         + configuration.yaml, сбор сводки

src/cli/parseMetadata.ts         ← CLI-вход (argv) → parseConfiguration
src/extension/parseCommand.ts    ← VS Code команда-обёртка 1c.parseMetadata → то же ядро
```

Подход **C (гибрид)**: общие примитивы (DOM-хелперы, `typeParser`, `attribute`) +
тонкие модули на тип, которые их компонуют. Каждый тип читается изолированно, общий
разбор не дублируется; новый тип = новый тонкий модуль + строка в диспетчере.

### Поток данных

```
CLI / VS Code команда
   → parseConfiguration(cfPath, outPath)
       → обход cf/Catalogs|Documents|Constants|Enums
       → диспетч каждого XML в модуль типа → ParsedObject
       → yamlWriter пишет cf/<Тип>/<Имя>.yaml
       → сбор configuration.yaml (имя конфигурации из Configuration.xml + индекс объектов)
       → сводка (счётчики по типам, число пропущенных)
```

Полная перегенерация при каждом прогоне: чистим `<out>/cf/`, пишем заново — детерминированно.
Ошибка парсинга отдельного файла не валит прогон: объект пропускается, увеличивается
счётчик пропущенных.

### Зависимости

Добавляем YAML-сериализатор — пакет `yaml` (детерминированный вывод, корректная кириллица).

## Схема YAML

Дерево вывода (`outPath`, по умолчанию `tmp/parser_data/`):

```
cf/
  configuration.yaml
  Catalogs/Валюты.yaml
  Documents/...
  Constants/...
  Enums/...
```

### `configuration.yaml` — индекс

```yaml
version: 1
name: БиблиотекаСтандартныхПодсистем     # из Configuration.xml <Name>
synonym: ...                              # из <Synonym> (ru), если есть
objects:
  - { type: Справочник,    name: Валюты,  fullName: Справочник.Валюты,  file: Catalogs/Валюты.yaml }
  - { type: Документ,      name: Встреча, fullName: Документ.Встреча,    file: Documents/Встреча.yaml }
  - { type: Константа,     name: ...,     fullName: Константа....,        file: Constants/....yaml }
  - { type: Перечисление,  name: ...,     fullName: Перечисление....,     file: Enums/....yaml }
```

### Справочник / Документ

```yaml
version: 1
kind: Справочник                  # или Документ
name: Валюты
fullName: Справочник.Валюты
uuid: 1d6b8425-360c-4ab1-9bab-cc9a3b590bb2
source: Catalogs/Валюты.xml        # относительно cf-корня
properties:                         # отобранные свойства, влияющие на состав таблицы
  hierarchical: false
  codeLength: 3
  codeType: String
  descriptionLength: 10
fields:                             # стандартные + реквизиты
  - { name: Ссылка,             category: standard,  types: [{ kind: ref, ref: Справочник.Валюты }] }
  - { name: ВерсияДанных,       category: standard,  types: [{ kind: timestamp }] }
  - { name: ПометкаУдаления,    category: standard,  types: [{ kind: Булево }] }
  - { name: Предопределённый,   category: standard,  types: [{ kind: Булево }] }
  - { name: ИмяПредопределённыхДанных, category: standard, types: [{ kind: Строка, length: 255 }] }
  - { name: Код,                category: standard,  types: [{ kind: Строка, length: 3, allowedLength: Variable }] }
  - { name: Наименование,       category: standard,  types: [{ kind: Строка, length: 10 }] }
  - { name: НаименованиеПолное, category: attribute, types: [{ kind: Строка, length: 50, allowedLength: Variable }] }
  - { name: Наценка,            category: attribute, types: [{ kind: Число, digits: 10, fractionDigits: 2, allowedSign: Any }] }
  - { name: ОсновнаяВалюта,     category: attribute, types: [{ kind: ref, ref: Справочник.Валюты }] }
  - { name: СпособУстановкиКурса, category: attribute, types: [{ kind: ref, ref: Перечисление.СпособыУстановкиКурсаВалюты }] }
tabularSections:
  - name: Представления
    uuid: f3ae1a2c-...
    fields:
      - { name: НомерСтроки, category: standard, types: [{ kind: Число, digits: 5, fractionDigits: 0 }] }
      - { name: КодЯзыка,    category: attribute, types: [{ kind: Строка, length: 10, allowedLength: Variable }] }
```

### Константа

```yaml
version: 1
kind: Константа
name: ВерсияДатЗапретаИзменения
fullName: Константа.ВерсияДатЗапретаИзменения
uuid: ...
source: Constants/ВерсияДатЗапретаИзменения.xml
types: [{ kind: Число, digits: 10, fractionDigits: 0 }]   # одно значение, без полей/ТЧ
```

### Перечисление

```yaml
version: 1
kind: Перечисление
name: СпособыУстановкиКурсаВалюты
fullName: Перечисление.СпособыУстановкиКурсаВалюты
uuid: ...
source: Enums/СпособыУстановкиКурсаВалюты.xml
fields:
  - { name: Ссылка,  category: standard, types: [{ kind: ref, ref: Перечисление.СпособыУстановкиКурсаВалюты }] }
  - { name: Порядок, category: standard, types: [{ kind: Число }] }
values:                             # члены перечисления (ChildObjects/EnumValue)
  - { name: ПоФормуле }
  - { name: РучнойВвод }
```

### Решения по схеме

- `types` **всегда список** — составной тип 1С даёт несколько элементов.
- Примитивы: `kind: Строка|Число|Дата|Булево` + квалификаторы из XML:
  - Строка: `length`, `allowedLength` (`StringQualifiers`).
  - Число: `digits`, `fractionDigits`, `allowedSign` (`NumberQualifiers`).
  - Дата: `dateFractions` (`DateQualifiers`, напр. `Date` / `Time` / `DateTime`).
- Ссылки: `kind: ref, ref: <Тип>.<Имя>`. Маппинг: `CatalogRef`→Справочник,
  `DocumentRef`→Документ, `EnumRef`→Перечисление (и далее по мере добавления типов).
- `kind: timestamp` — служебный платформенный тип `ВерсияДанных` (на уровне СУБД —
  `timestamp`/rowversion). В XML квалификаторов нет, тип фиксирован парсером.
- Неизвестный/непримитивный XS-тип → `kind: unknown, raw: <строка>` — данные не теряем,
  пробелы парсера видны глазами.

## Стандартные поля по типам

Парсер вычисляет условные поля, читая `<Properties>` объекта.

### Справочник

| Поле | Тип | Условие |
|---|---|---|
| `Ссылка` | ref → Справочник.X | всегда |
| `ВерсияДанных` | timestamp | всегда |
| `ПометкаУдаления` | Булево | всегда |
| `Предопределённый` | Булево | всегда |
| `ИмяПредопределённыхДанных` | Строка(255) | всегда |
| `Код` | `CodeType=String`→Строка(`CodeLength`, allowedLength=`CodeAllowedLength`); `Number`→Число(`CodeLength`) | `CodeLength` > 0 |
| `Наименование` | Строка(`DescriptionLength`) | `DescriptionLength` > 0 |
| `Родитель` | ref → Справочник.X | `Hierarchical=true` |
| `ЭтоГруппа` | Булево | `Hierarchical=true` И `HierarchyType=HierarchyFoldersAndItems` |
| `Владелец` | ref (составной из `Owners`) | `Owners` не пуст |

### Документ

| Поле | Тип | Условие |
|---|---|---|
| `Ссылка` | ref → Документ.X | всегда |
| `ВерсияДанных` | timestamp | всегда |
| `ПометкаУдаления` | Булево | всегда |
| `Дата` | Дата (dateFractions=DateTime) | всегда |
| `Номер` | `NumberType=String`→Строка(`NumberLength`); `Number`→Число(`NumberLength`) | `NumberLength` > 0 |
| `Проведён` | Булево | `Posting=Allow` |

### Перечисление

| Поле | Тип | Условие |
|---|---|---|
| `Ссылка` | ref → Перечисление.X | всегда |
| `Порядок` | Число | всегда |

Плюс блок `values` — члены из `ChildObjects/EnumValue`.

### Константа

Стандартных полей нет — одно значение, только `types`.

### Табличные части (Справочник/Документ)

Стандартное поле `НомерСтроки` (Число, `digits` = `LineNumberLength` из свойств ТЧ,
по умолчанию 5; `fractionDigits` всегда 0) — всегда, плюс реквизиты ТЧ из XML.

### Заметки

- `Представление` намеренно **не включаем** — вычисляемое (виртуальное) поле запроса,
  в таблице СУБД его нет.

## CLI

- Вход: `src/cli/parseMetadata.ts` → esbuild → `out/cli/parseMetadata.js`.
- npm-скрипты:
  - `"build:cli": "esbuild src/cli/parseMetadata.ts --bundle --outfile=out/cli/parseMetadata.js --platform=node --format=cjs"`
  - `"parse": "npm run build:cli && node out/cli/parseMetadata.js"`
- Использование:
  ```
  npm run parse -- --cf <путь-к-cf> --out <путь-вывода>
  ```
  - `--cf` — каталог выгрузки (где `Catalogs/`, `Documents/`, …). По умолчанию автоопределение
    `src/cf` (как в текущем `resolveCfPath`).
  - `--out` — каталог вывода. По умолчанию `tmp/parser_data`.
- Поведение: чистит `<out>/cf/`, парсит, пишет дерево YAML + `configuration.yaml`,
  печатает сводку в stdout:
  ```
  Справочники: 250  Документы: 180  Константы: 90  Перечисления: 120
  Пропущено (ошибки парсинга): 3
  → tmp/parser_data/cf
  ```
- Ненулевой exit code, если каталог `cf` не найден или распарсено 0 объектов.

## VS Code команда (тонкая обёртка)

- Команда `1c.parseMetadata`, title «1С: Распарсить метаданные в YAML».
- Берёт `cfPath` через существующий `resolveCfPath()`, `outPath` — из настройки,
  зовёт `parseConfiguration`, пишет сводку в OutputChannel «1C Query Constructor»,
  по завершении — `showInformationMessage` с числом объектов и путём.
- Никакой логики парсинга в обёртке — только склейка путей и вызов ядра.

## Настройки

Добавляем в `contributes.configuration`:

```jsonc
"queryConsole.parserOutputPath": {
  "type": "string",
  "default": "tmp/parser_data",
  "description": "Каталог для результата парсинга метаданных (YAML). Относительный путь резолвится от корня workspace."
}
```

`queryConsole.metadataPath` (вход) остаётся как есть.

## Верификация

Основной способ — **прогон CLI на реальной конфигурации + просмотр YAML глазами**
(golden-тесты пока не делаем). Сводка CLI (счётчики по типам, число пропущенных) даёт
быстрый сигнал о покрытии и проблемах. Проверяем на выгрузке в `src/cf`.

## Что не трогаем

`cfParser.ts`, `cacheBuilder.ts`, `cacheLoader.ts`, `panel.ts`, webview — работают на
старом пути. Перевод конструктора на YAML — отдельная задача.
