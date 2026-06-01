#!/usr/bin/env bash
# Builds tree-sitter-sdbl.wasm from tmp/tree-sitter-bsl and vendors both
# tree-sitter-sdbl.wasm and tree-sitter.wasm into test/fixtures/.
# Run once (or when grammar changes). Requires: tree-sitter CLI, emscripten.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BSL_REPO="$REPO_ROOT/tmp/tree-sitter-bsl"
FIXTURES="$REPO_ROOT/test/fixtures"

echo "Building tree-sitter-sdbl.wasm from $BSL_REPO ..."
cd "$BSL_REPO"
npm install --silent
npm run build:wasm:sdbl

mkdir -p "$FIXTURES"
cp grammars/sdbl/tree-sitter-sdbl.wasm "$FIXTURES/tree-sitter-sdbl.wasm"

# Vendor the web-tree-sitter runtime WASM
WEB_TS_WASM="$REPO_ROOT/node_modules/web-tree-sitter/tree-sitter.wasm"
if [ -f "$WEB_TS_WASM" ]; then
  cp "$WEB_TS_WASM" "$FIXTURES/tree-sitter.wasm"
else
  echo "ERROR: web-tree-sitter not installed. Run npm install first."
  exit 1
fi

echo "Done. Vendored to $FIXTURES/"
