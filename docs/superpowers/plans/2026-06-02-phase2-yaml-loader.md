# Phase 2: YAML Loader for Metadata

## Summary

Switched the metadata loading layer in the query constructor from direct XML parsing to reading pre-generated YAML artifacts, with XML parsing retained as a fallback.

## Files

- `src/core/metadata/yamlLoader.ts` — new module: reads `configuration.yaml` index, loads per-object YAML files, converts `ParsedObject` → `MetaTable`, returns `MetadataModel`
- `test/unit/yamlLoader.test.ts` — 13 unit tests (TDD, all passing)
- `src/extension/panel.ts` — `loadMetadata` now checks for `<parserOutputPath>/cf/configuration.yaml` first; uses YAML path if present, falls back to XML + cache otherwise

## Key Decisions

- **YAML-first, XML-fallback**: if `configuration.yaml` exists in the configured output dir, YAML wins; otherwise the existing `parseCf` + cache path runs unchanged.
- **Type mapping**: `ParsedType.kind` primitives → `MetaType.primitive`; `ref` with `Справочник.*`/`Документ.*` prefix → `MetaType.ref`; all other kinds (`timestamp`, `unknown`, unsupported refs) → `{}`.
- **Graceful skips**: missing YAML files, parse errors, and unsupported object types (`Перечисление`, `Константа`) are silently skipped — no crash, just omitted tables.
- **No type changes**: `types.ts`, `messages.ts`, webview files untouched.
