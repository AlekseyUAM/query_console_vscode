import type { QueryModel, SelectedTable } from './queryModel';

function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = t.alias ?? t.fullName.split('.')[1] ?? t.fullName;
    let alias = base;
    let counter = 1;
    while (seen.has(alias)) {
      alias = base + counter;
      counter++;
    }
    seen.add(alias);
    result.set(t.id, alias);
  }
  return result;
}

export function generate(model: QueryModel): string {
  if (model.tables.length === 0 || model.fields.length === 0) return '';

  const aliases = resolveAliases(model.tables);

  const fieldLines = model.fields.map((f, i) => {
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const fieldExpr = `${tableAlias}.${f.path}`;
    const withAlias = f.alias ? `${fieldExpr} КАК ${f.alias}` : fieldExpr;
    const comma = i < model.fields.length - 1 ? ',' : '';
    return `\t${withAlias}${comma}`;
  });

  const tableLines = model.tables.map((t, i) => {
    const alias = aliases.get(t.id) ?? t.id;
    const comma = i < model.tables.length - 1 ? ',' : '';
    return `\t${t.fullName} КАК ${alias}${comma}`;
  });

  return ['ВЫБРАТЬ', ...fieldLines, 'ИЗ', ...tableLines].join('\n');
}
