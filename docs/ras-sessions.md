# Снятие зависших сессий 1С через RAS

Как из dev-контейнера управлять сессиями кластера 1С: найти и принудительно
завершить зависшую сессию через сервер администрирования `ras` и клиент `rac`.

## Как это устроено

- На хосте работает `ras cluster --port=1545`, слушает `0.0.0.0:1545`.
- Клиент `rac` ходит **только** на `ras` (порт `1545`). Связь `ras` с менеджером
  кластера (`rmngr`, порт `1541`) и агентом (`ragent`, порт `1540`) происходит
  локально на хосте — контейнеру эти порты не нужны.
- Контейнер резолвит хост через `host.docker.internal` (`--add-host=...:host-gateway`
  в `.devcontainer/devcontainer.json`).
- Бинарник `rac` в образе `node:22-bookworm` отсутствует, поэтому каталог установки
  платформы 1С пробрасывается с хоста read-only (блок `mounts` в
  `devcontainer.json`), а `post-create.sh` делает симлинк `/usr/local/bin/rac`.

```
контейнер: rac ──TCP 1545──▶ host.docker.internal (ras) ──локально──▶ rmngr/ragent
```

## Предусловия

- Контейнер пересобран после правок (`Dev Containers: Rebuild Container`), иначе
  bind-mount платформы и симлинк `rac` не подхватятся.
- В `.env` заданы креды администратора кластера: `CLUSTER_USER` и `CLUSTER_PWD`
  (нужны, только если у кластера заданы администраторы).

Проверка доступа:

```bash
rac cluster list host.docker.internal:1545
```

Команда должна вернуть описание кластера с его `cluster` (UUID). Если она висит или
отказывает — см. раздел «Если не соединяется».

## Снятие зависшей сессии

Везде ниже `$RAS` — адрес сервера администрирования, а `<uuid>` — UUID кластера из
`rac cluster list`.

```bash
RAS=host.docker.internal:1545

# 1. UUID кластера
rac cluster list $RAS

# 2. Список сессий (найти зависшую: по базе, пользователю, времени старта)
rac session list \
    --cluster=<uuid> \
    --cluster-user=admin --cluster-pwd=*** \
    $RAS

# 3. Завершить конкретную сессию по её UUID
rac session terminate \
    --cluster=<uuid> \
    --session=<session-uuid> \
    --cluster-user=admin --cluster-pwd=*** \
    $RAS
```

Полезные срезы при поиске зависшей сессии:

```bash
# Сессии конкретной информационной базы
rac infobase summary list --cluster=<uuid> --cluster-user=admin --cluster-pwd=*** $RAS   # узнать infobase UUID
rac session list --cluster=<uuid> --infobase=<infobase-uuid> --cluster-user=admin --cluster-pwd=*** $RAS

# Активные соединения (если сессию нужно рвать по соединению)
rac connection list --cluster=<uuid> --cluster-user=admin --cluster-pwd=*** $RAS
```

`--cluster-user` / `--cluster-pwd` обязательны только если у кластера настроены
администраторы. Если администраторов нет — параметры можно опустить.

## Если не соединяется

`ras` слушает `0.0.0.0:1545`, поэтому обычно всё работает сразу после ребилда.
Если `rac cluster list` висит или выдаёт ошибку соединения:

- Убедитесь, что на хосте жив процесс `ras`: `ps -ef | grep '[r]as cluster'`.
- Проверьте, что порт слушается на всех интерфейсах:
  `ss -ltnp | grep 1545` → должно быть `0.0.0.0:1545`.
- Проверьте файрвол хоста (ufw/iptables) — не блокирует ли он docker-подсеть до
  порта `1545` (правится с правами root).

## Обслуживание

Версия платформы больше не зашита в коде. `.devcontainer/devcontainer.json`
монтирует весь каталог `/opt/1cv8/x86_64` (read-only, тем же путём), а конкретную
версию выбирает `.devcontainer/post-create.sh`:

1. `ONEC_PLATFORM_DIR` из `.env`, если задана там;
2. иначе — самая свежая установленная версия из `/opt/1cv8/x86_64/` (автоопределение).

При обновлении платформы 1С обычно ничего править не нужно — после ребилда
подхватится новейшая версия. Чтобы зафиксировать конкретную версию, раскомментируйте
и пропишите `ONEC_PLATFORM_DIR` в `.env`.
