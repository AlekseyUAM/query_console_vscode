# Фаза 1. Парсер метаданных → YAML

← [Дорожная карта](ROADMAP.md)

✅ Готово.

Парсер выгрузки 1С в каталог YAML-файлов (`cf/<Тип>/<Имя>.yaml` + `configuration.yaml`)
как переиспользуемый артефакт и контракт между парсером и потребителями. Типы:
Справочники, Документы, Константы, Перечисления. CLI `npm run parse` + команда
`1С: Распарсить метаданные в YAML`.

- Спек: [`specs/2026-06-01-metadata-parser-yaml-design.md`](superpowers/specs/2026-06-01-metadata-parser-yaml-design.md)
- План: [`plans/2026-06-01-metadata-parser-yaml.md`](superpowers/plans/2026-06-01-metadata-parser-yaml.md)
- Решение об источнике метаданных (свой TS-парсер, без md-sparrow / tree-sitter-bsl): `[[metadata-source-decision]]`
