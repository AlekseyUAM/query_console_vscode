# Development Environment Design

## Архитектура

```
┌──────────────────────────────────────────────────────────┐
│  Devcontainer (node:22-bookworm)                         │
│                                                          │
│  • Claude Code (bypassPermissions)                       │
│  • npm build / vitest / playwright                       │
│  • code CLI → remote-cli → host VS Code                  │
└───────────────────────┬──────────────────────────────────┘
                        │  Remote Containers IPC
                        ▼
┌──────────────────────────────────────────────────────────┐
│  Host machine (VS Code + Remote Containers extension)    │
│                                                          │
│  • Extension Development Host — открывается командой    │
│    code --extensionDevelopmentPath=...                   │
│  • Пользователь видит и тестирует UI расширения         │
└──────────────────────────────────────────────────────────┘
```

**Ключевой факт:** `code` CLI внутри контейнера — это remote-cli, который
посылает команды в VS Code на хост-машине. Это значит, что ИИ может открыть
Extension Development Host на машине пользователя.

---

## Три уровня тестирования

### Уровень 1: Unit + Webview E2E (полностью автономно, ИИ)

| Что тестируется | Команда | Кто запускает |
|---|---|---|
| Типы, парсер, кэш, генератор | `npm test` (= `npm run test:unit`) | ИИ |
| Webview UI (Playwright, headless) | `npm run test:e2e` | ИИ |

Это **две отдельные команды**: `npm test` запускает только unit (vitest),
webview E2E запускается отдельно через `npm run test:e2e`. Обе работают
в контейнере без VS Code и без пользователя.

### Уровень 2: Extension Development Host (ИИ запускает, пользователь видит)

ИИ собирает и открывает расширение на хост-машине:

```bash
npm run build && code --extensionDevelopmentPath=/workspaces/query_console_vscode
```

Открывается **новое окно `[Extension Development Host]`** на хосте с уже
загруженным расширением. Пользователь переключается в это окно и тестирует.

После каждого rebuild ИИ может переоткрыть окно или попросить пользователя
нажать `Ctrl+Shift+P` → `Developer: Reload Window` в этом окне.

### Уровень 3: VS Code Integration Tests (будущее, ИИ автономно)

`@vscode/test-electron` запускает Extension Development Host headless:

```bash
npm run test:integration   # TODO: добавить
```

ИИ получает полный feedback по циклу activate → command → webview без
пользователя. Это заменит ручную проверку для регрессий.

---

## Workflow для ИИ-разработки

```
1. Редактирование исходников в контейнере
2. npm run test:unit                ← unit (vitest, pass/fail)
3. npm run test:e2e                 ← webview E2E (Playwright, headless)
4. npm run build                    ← сборка extension host + webview
5. code --extensionDevelopmentPath=/workspaces/query_console_vscode
                                    ← Extension Dev Host открывается на хосте
6. Пользователь тестирует           ← даёт feedback ИИ
7. Goto 1
```

Не нужно упаковывать .vsix при разработке — Extension Development Host
читает файлы напрямую из контейнера.

---

## Script: `npm run dev`

Добавить в `package.json`:

```json
"dev": "npm run build && code --extensionDevelopmentPath=/workspaces/query_console_vscode"
```

ИИ запускает `npm run dev` — пользователь получает свежую версию в новом окне.

---

## Workflow для пользователя (без ИИ, локальная разработка)

Если пользователь хочет разрабатывать локально (не в контейнере):

```
1. git clone + npm install (локально)
2. Открыть папку в VS Code
3. F5 → Extension Development Host открывается автоматически
4. Изменения → Ctrl+Shift+P → Developer: Reload Window
```

`.vscode/launch.json` и `tasks.json` уже настроены.

---

## .vsix — только для внешней дистрибуции

| Сценарий | Метод |
|---|---|
| Разработка | Extension Dev Host (F5 или `npm run dev`) |
| Тестирование ИИ | Unit + E2E + Dev Host |
| Передать кому-то / установить без контейнера | `npx vsce package` → .vsix |

---

## Текущие ограничения и план устранения

| Ограничение | Решение |
|---|---|
| ИИ не видит что происходит в Dev Host | Добавить `test:integration` с @vscode/test-electron |
| После rebuild нужно вручную Reload Window | Пользователь нажимает Ctrl+R; или исследовать `code --reuse-window` |
| tree-sitter-sdbl.wasm не собирается (нет emcc/docker) | Собрать на хосте → закоммитить бинарник |

---

## Что нужно добавить в devcontainer.json

Для доступа к display (если потребуется headed Playwright):

```json
"runArgs": ["--add-host=host.docker.internal:host-gateway"],
"containerEnv": {
  "DISPLAY": ":0"
}
```

Уже частично сделано (`DISPLAY=:0` доступен в контейнере).
