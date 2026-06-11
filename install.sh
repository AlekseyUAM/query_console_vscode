#!/usr/bin/env bash
# install.sh — подготовка окружения для сборки и тестов 1C: Query Constructor.
#
# Что делает (по шагам):
#   1. Проверяет Node.js (>= 20; рекомендуется 22) и npm.
#   2. При наличии apt доустанавливает системные пакеты для node-gyp
#      (build-essential, python3, git) — нужны нативному биндингу tree-sitter.
#   3. npm install — зависимости расширения и тестов.
#   4. npm run build — сборка extension + webview в out/.
#   5. (--e2e)  ставит браузеры Playwright для e2e-тестов.
#   6. (--wasm) пересобирает tree-sitter-sdbl.wasm из tmp/tree-sitter-bsl
#               (нужно только при изменении грамматики; требует emscripten).
#   7. (--docker) ставит Docker Engine (+ buildx/compose) и devcontainers CLI —
#               хост-окружение для разработки в контейнере (DevContainer).
#
# Использование:
#   ./install.sh              # системные пакеты (если apt) + npm install + build
#   ./install.sh --e2e        # то же + браузеры Playwright
#   ./install.sh --wasm       # то же + пересборка SDBL-грамматики в .wasm
#   ./install.sh --docker     # то же + Docker Engine и devcontainers CLI (DevContainer)
#   ./install.sh --no-system  # пропустить установку системных пакетов
#   ./install.sh --e2e --wasm
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

WITH_E2E=0
WITH_WASM=0
WITH_SYSTEM=1
WITH_DOCKER=0

for arg in "$@"; do
  case "$arg" in
    --e2e)        WITH_E2E=1 ;;
    --wasm)       WITH_WASM=1 ;;
    --docker)     WITH_DOCKER=1 ;;
    --no-system)  WITH_SYSTEM=0 ;;
    -h|--help)
      # Печатаем шапку-комментарий (со строки 2 до первой не-комментной строки).
      awk 'NR>=2 && /^#/ { sub(/^# ?/, ""); print; next } NR>=2 { exit }' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *)
      echo "Неизвестный аргумент: $arg (см. --help)" >&2
      exit 1 ;;
  esac
done

log() { echo "[install] $*"; }

# sudo, если мы не root и sudo доступен; иначе пусто (команды идут как есть).
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# --- 1. Node.js / npm -------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[install] ОШИБКА: Node.js не найден. Установите Node.js >= 20 (рекомендуется 22)." >&2
  echo "          https://nodejs.org/  или  nvm install 22" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
log "Node.js $(node --version), npm $(npm --version)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[install] ОШИБКА: нужна Node.js >= 20 (текущая major: $NODE_MAJOR)." >&2
  exit 1
fi

# --- 2. Системные пакеты (для node-gyp / нативного tree-sitter) -------------
if [ "$WITH_SYSTEM" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  PKGS=(build-essential python3 git)
  MISSING=()
  for p in "${PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    log "Доустанавливаю системные пакеты: ${MISSING[*]}"
    $SUDO apt-get update
    $SUDO apt-get install -y --no-install-recommends "${MISSING[@]}"
  else
    log "Системные пакеты уже установлены: ${PKGS[*]}"
  fi
elif [ "$WITH_SYSTEM" -eq 1 ]; then
  log "apt не найден — пропускаю системные пакеты (убедитесь, что есть compiler toolchain + python3 для node-gyp)."
fi

# --- 3. npm install ---------------------------------------------------------
log "npm install ..."
npm install

# --- 4. Сборка --------------------------------------------------------------
log "npm run build (extension + webview) ..."
npm run build
log "Сборка готова: out/extension/extension.js, out/webview/main.js"

# --- 5. Playwright (e2e) ----------------------------------------------------
if [ "$WITH_E2E" -eq 1 ]; then
  log "Установка браузеров Playwright (chromium) ..."
  if command -v apt-get >/dev/null 2>&1; then
    npx playwright install --with-deps chromium
  else
    npx playwright install chromium
  fi
  log "Playwright готов — запуск: npm run test:e2e"
fi

# --- 6. Пересборка SDBL-грамматики в WASM (опционально) ---------------------
if [ "$WITH_WASM" -eq 1 ]; then
  if [ -d "tmp/tree-sitter-bsl" ]; then
    log "Пересборка tree-sitter-sdbl.wasm (scripts/build-wasm.sh) ..."
    bash scripts/build-wasm.sh
  else
    echo "[install] ПРОПУСК --wasm: нет tmp/tree-sitter-bsl." >&2
    echo "          Скопируйте sibling-репо (см. .devcontainer/copy-sibling-repos.sh) и нужен emscripten." >&2
  fi
fi

# --- 7. Docker + devcontainers CLI (для DevContainer, опционально) ----------
if [ "$WITH_DOCKER" -eq 1 ]; then
  # 7a. Docker Engine.
  if command -v docker >/dev/null 2>&1; then
    log "Docker уже установлен: $(docker --version)"
  else
    if ! command -v curl >/dev/null 2>&1; then
      echo "[install] ОШИБКА --docker: нужен curl для установки Docker." >&2
      echo "          Установите Docker вручную: https://docs.docker.com/engine/install/" >&2
      exit 1
    fi
    log "Установка Docker Engine (официальный скрипт get.docker.com) ..."
    # Convenience-скрипт сам подбирает apt/dnf-репозиторий по дистрибутиву
    # и ставит docker-ce, CLI, containerd, buildx и compose-плагины.
    TMP_GET_DOCKER="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$TMP_GET_DOCKER"
    $SUDO sh "$TMP_GET_DOCKER"
    rm -f "$TMP_GET_DOCKER"
    log "Docker установлен: $(docker --version)"
  fi

  # 7b. Демон: включаем и запускаем (если systemd доступен).
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl enable --now docker >/dev/null 2>&1 \
      && log "Docker-демон включён (systemctl enable --now docker)." \
      || log "Не удалось управлять docker через systemctl — запустите демон вручную."
  fi

  # 7c. Группа docker — чтобы работать без sudo (нужен перелогин/newgrp).
  TARGET_USER="${SUDO_USER:-${USER:-$(id -un)}}"
  if [ "$TARGET_USER" != "root" ]; then
    if ! id -nG "$TARGET_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      log "Добавляю '$TARGET_USER' в группу docker ..."
      $SUDO usermod -aG docker "$TARGET_USER" \
        && log "Готово. Перелогиньтесь (или 'newgrp docker'), чтобы группа применилась." \
        || log "Не удалось добавить в группу docker — используйте 'sudo docker'."
    else
      log "Пользователь '$TARGET_USER' уже в группе docker."
    fi
  fi

  # 7d. devcontainers CLI — поднимать контейнер из терминала (devcontainer up).
  if command -v devcontainer >/dev/null 2>&1; then
    log "devcontainers CLI уже установлен: $(devcontainer --version 2>/dev/null)"
  else
    log "Установка @devcontainers/cli (npm -g) ..."
    if npm install -g @devcontainers/cli >/dev/null 2>&1; then
      log "devcontainers CLI установлен: $(devcontainer --version 2>/dev/null)"
    elif [ -n "$SUDO" ] && $SUDO npm install -g @devcontainers/cli >/dev/null 2>&1; then
      log "devcontainers CLI установлен (через sudo): $(devcontainer --version 2>/dev/null)"
    else
      echo "[install] ПРЕДУПРЕЖДЕНИЕ: не удалось поставить @devcontainers/cli глобально." >&2
      echo "          Поставьте вручную: npm install -g @devcontainers/cli" >&2
    fi
  fi
fi

echo
log "Готово. Дальше:"
echo "    npm run dev        # сборка + запуск VS Code с расширением"
echo "    npm run test:unit  # юнит-тесты (Vitest)"
[ "$WITH_E2E" -eq 1 ] && echo "    npm run test:e2e   # e2e-тесты (Playwright)"
echo "    npm run parse -- --cf <путь-к-cf> --out <вывод>   # CLI-парсер метаданных"
if [ "$WITH_DOCKER" -eq 1 ]; then
  echo
  echo "    Разработка в контейнере (DevContainer):"
  echo "      • VS Code: команда «Dev Containers: Reopen in Container»"
  echo "      • Терминал: devcontainer up --workspace-folder .   (затем devcontainer exec ... )"
  echo "    Проверка Docker: docker run --rm hello-world  (если 'permission denied' — перелогиньтесь)"
fi
