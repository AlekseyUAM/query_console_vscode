#!/usr/bin/env bash
# Runs INSIDE the container (devcontainer postCreateCommand) as the `node` user.
# Configures Claude Code to take all actions without prompting. This is safe here
# because the container is isolated: only this workspace (and ./tmp) are mounted.
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_DIR}"

# bypassPermissions: Claude performs every action without asking for confirmation.
# Scoped to the container's user config, so the host Claude setup is untouched.
cat > "${CLAUDE_DIR}/settings.json" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
JSON

# Expose the bind-mounted host 1C `rac` on PATH for cluster session admin
# (kill hung sessions via RAS on host.docker.internal:1545). The whole platform
# tree is bind-mounted read-only from the host (see devcontainer.json "mounts").
# Choose the concrete platform version:
#   1. ONEC_PLATFORM_DIR from the project .env, if set there;
#   2. otherwise auto-detect the newest installed version under /opt/1cv8/x86_64.
PLATFORM_ROOT="/opt/1cv8/x86_64"
PROJECT_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
if [ -f "${PROJECT_ENV}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${PROJECT_ENV}"
    set +a
fi
if [ -z "${ONEC_PLATFORM_DIR:-}" ]; then
    ONEC_PLATFORM_DIR="$(ls -d "${PLATFORM_ROOT}"/*/ 2>/dev/null | sort -V | tail -n1)"
    ONEC_PLATFORM_DIR="${ONEC_PLATFORM_DIR%/}"
    echo "[devcontainer] ONEC_PLATFORM_DIR not set in .env; auto-detected ${ONEC_PLATFORM_DIR:-<none>}"
else
    echo "[devcontainer] ONEC_PLATFORM_DIR from .env: ${ONEC_PLATFORM_DIR}"
fi
RAC_BIN="${ONEC_PLATFORM_DIR}/rac"
if [ -x "${RAC_BIN}" ]; then
    sudo ln -sf "${RAC_BIN}" /usr/local/bin/rac
    echo "[devcontainer] rac linked: /usr/local/bin/rac -> ${RAC_BIN}"
else
    echo "[devcontainer] WARN: ${RAC_BIN} not found (host 1C platform not mounted?)."
fi

# Microsoft Core Fonts (Times New Roman / Arial / Courier New / …). The 1C web
# client renders tabular documents (Консоль запросов, Конструктор запроса) using
# fonts available to the BROWSER; without these the web client shows a blocking
# startup dialog «на сервере отсутствуют шрифты из состава Microsoft Core Fonts»,
# which also wedges the Playwright recon driver (tooling/real-constructor/).
# The package lives in Debian `contrib`; its EULA must be pre-accepted to install
# non-interactively. Best-effort: never fail container create over fonts.
if ! fc-list 2>/dev/null | grep -qi 'Times New Roman'; then
    echo "[devcontainer] Installing Microsoft Core Fonts for the 1C web client…"
    sudo sed -i '0,/^Components: main$/s//Components: main contrib/' \
        /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
    echo ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true \
        | sudo debconf-set-selections
    if sudo apt-get update -o Acquire::Check-Valid-Until=false \
        && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
            ttf-mscorefonts-installer fontconfig; then
        sudo fc-cache -f
        echo "[devcontainer] MS Core Fonts installed."
    else
        echo "[devcontainer] WARN: MS Core Fonts install failed (web client may warn about fonts)."
    fi
fi

echo "[devcontainer] Claude Code configured: bypassPermissions (container-only)."
echo "[devcontainer] Sibling repos: ./tmp/tree-sitter-bsl, ./tmp/vscode-1c-platform-tools"
echo "[devcontainer] RAS admin: rac cluster list host.docker.internal:1545"
echo "[devcontainer] Start with:  claude"
