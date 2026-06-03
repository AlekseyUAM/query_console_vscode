# Кнопка «Обновить кэш» и авто-парсинг при запуске: дизайн

**Дата:** 2026-06-03  
**Статус:** утверждён

---

## 1. Цель

1. Добавить кнопку **«Обновить кэш»** в верхнюю панель конструктора запросов — при нажатии запускает `parseConfiguration` и обновляет YAML-файлы на диске.
2. Текущая открытая сессия конструктора **не получает обновлённых данных** — пользователю показывается сообщение «Перезапустите конструктор для применения изменений».
3. При открытии конструктора **без сохранённого YAML-кэша** — автоматически выполнить попытку `parseConfiguration` перед загрузкой метаданных.

---

## 2. Контракт сообщений (`src/shared/messages.ts`)

Добавить в объединения:

```ts
// WebviewMsg — webview → extension
| { type: 'refreshCache' }

// HostMsg — extension → webview
| { type: 'refreshResult'; ok: boolean; message: string }
```

---

## 3. Extension (`src/extension/panel.ts`)

### 3.1 Обработка `refreshCache`

В `onDidReceiveMessage` добавить ветку:

```
if msg.type === 'refreshCache':
  if !cfPath:
    send refreshResult(ok=false, 'Не найден путь к выгрузке конфигурации')
    return
  try:
    parseConfiguration(cfPath, outPath)
    send refreshResult(ok=true, 'Кэш обновлён. Перезапустите конструктор для применения изменений.')
  catch e:
    send refreshResult(ok=false, `Ошибка парсинга: ${e}`)
```

`outPath` вычисляется так же, как в `parseCommand.ts` — из настройки `queryConsole.parserOutputPath`.

### 3.2 Авто-парсинг при открытии (`loadMetadata`)

Перед fallback на старый XML-кэш:

```
if !fs.existsSync(configYaml) && cfPath:
  try parseConfiguration(cfPath, outPath)
  catch: // игнорировать — продолжить с fallback
  if fs.existsSync(configYaml):
    load from YAML and return
// иначе — продолжить старый путь (XML-кэш)
```

Авто-парсинг не выбрасывает ошибку пользователю — только логирует в `channel`.

---

## 4. Webview (`src/webview/App.tsx`)

### 4.1 Состояние кнопки

```ts
type RefreshState = 'idle' | 'loading' | { ok: boolean; message: string };
const [refreshState, setRefreshState] = useState<RefreshState>('idle');
```

### 4.2 Логика

- **Нажатие:** `setRefreshState('loading')`, `postToHost({ type: 'refreshCache' })`
- **Получение `refreshResult`:** `setRefreshState({ ok: msg.ok, message: msg.message })`
- Следующее нажатие сбрасывает предыдущее сообщение.

### 4.3 Расположение

Строка между `TabsBar` и тремя панелями:

```
[TabsBar]
[Обновить кэш]  [статусное сообщение]    ← новая строка
[DbPanel | TablesPanel | FieldsPanel]
[Запрос]
```

### 4.4 Визуальное поведение

| Состояние | Кнопка | Сообщение |
|---|---|---|
| `idle` | «Обновить кэш», активна | — |
| `loading` | «Обновление...», заблокирована | — |
| `{ok:true, …}` | «Обновить кэш», активна | зелёный текст |
| `{ok:false, …}` | «Обновить кэш», активна | красный текст |

---

## 5. Что не входит

- Обновление живой модели текущей сессии конструктора при нажатии кнопки.
- Индикатор прогресса парсинга (только два состояния: загрузка / готово).
- Watch-режим (автоматическое отслеживание изменений файлов).
