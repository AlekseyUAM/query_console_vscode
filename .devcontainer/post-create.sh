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

echo "[devcontainer] Claude Code configured: bypassPermissions (container-only)."
echo "[devcontainer] Sibling repos: ./tmp/tree-sitter-bsl, ./tmp/vscode-1c-platform-tools"
echo "[devcontainer] Start with:  claude"
