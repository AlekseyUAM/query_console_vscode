#!/usr/bin/env bash
# Runs on the HOST (devcontainer initializeCommand), before the container starts.
# Copies the sibling repos the project depends on into ./tmp so they are available
# inside the container workspace. tmp/ is gitignored.
set -euo pipefail

SIBLINGS=("tree-sitter-bsl" "vscode-1c-platform-tools")
# Parent dir of this project (e.g. ~/projects).
PROJECTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p tmp

for repo in "${SIBLINGS[@]}"; do
    src="${PROJECTS_DIR}/${repo}"
    if [ -d "${src}" ]; then
        echo "[devcontainer] Copying ${repo} -> tmp/${repo}"
        if command -v rsync >/dev/null 2>&1; then
            rsync -a --delete \
                --exclude '.git' \
                --exclude 'node_modules' \
                --exclude 'target' \
                --exclude 'out' \
                --exclude 'dist' \
                "${src}/" "tmp/${repo}/"
        else
            rm -rf "tmp/${repo}"
            cp -r "${src}" "tmp/${repo}"
        fi
    else
        echo "[devcontainer] WARN: ${src} not found, skipping"
    fi
done

echo "[devcontainer] Sibling repos ready in ./tmp"
