import type { QueryModel, SelectedTable } from './queryModel';

function defaultAlias(t: SelectedTable): string {
  if (t.alias) return t.alias;
  const parts = t.fullName.split('.');
  if (t.virtual && parts.length >= 3) return parts[1] + parts[2];
  // Невиртуальные таблицы имеют двусегментный fullName (Вид.Имя); табличные части
  // идут отдельным путём (tabSectionFields), а не через model.tables.
  return parts[1] ?? t.fullName;
}

function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = defaultAlias(t);
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

function renderSource(t: SelectedTable): string {
  if (!t.virtual) return t.fullName;
  const { period = '', condition = '' } = t.virtual;
  if (!period && !condition) return t.fullName;
  // Параметры позиционные: при заданном только условии остаётся ведущая запятая
  // `(, Условие)`; при заданном только периоде — `(Период)`.
  return `${t.fullName}(${period}${condition ? ', ' + condition : ''})`;
}

export function generate(model: QueryModel): string {
  if (model.tables.length === 0) return '';
  const hasFields = model.fields.length > 0 || (model.tabSectionFields?.length ?? 0) > 0;
  if (!hasFields) return '';

  const aliases = resolveAliases(model.tables);

  const allLines: string[] = [];
  // Счётчик автопсевдонимов произвольных полей. Не проверяет коллизии с явными
  // псевдонимами — допустимо для фазы 4.2 (UI не смешивает их с полями «Поле{n}»).
  let exprCounter = 0;

  for (const f of model.fields) {
    if (f.expression) {
      const alias = f.alias ?? `Поле${++exprCounter}`;
      allLines.push(`\t${f.expression} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const expr = f.alias ? `${tableAlias}.${f.path} КАК ${f.alias}` : `${tableAlias}.${f.path}`;
    allLines.push(`\t${expr}`);
  }

  for (const tsf of model.tabSectionFields ?? []) {
    const tableAlias = aliases.get(tsf.tableId) ?? tsf.tableId;
    const subLines = tsf.fields.map((f, i) =>
      `\t\t${f} КАК ${f}${i < tsf.fields.length - 1 ? ',' : ''}`
    );
    allLines.push(`\t${tableAlias}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t) КАК ${tsf.tsName}`);
  }

  const fieldLines = allLines.map((l, i) => i < allLines.length - 1 ? l + ',' : l);

  const tableLines = model.tables.map((t, i) => {
    const alias = aliases.get(t.id) ?? t.id;
    const comma = i < model.tables.length - 1 ? ',' : '';
    return `\t${renderSource(t)} КАК ${alias}${comma}`;
  });

  return ['ВЫБРАТЬ', ...fieldLines, 'ИЗ', ...tableLines].join('\n');
}

export function formatAsBslString(text: string): string {
  const lines = text.split('\n');
  const body = lines[0] + (lines.length > 1 ? '\n' + lines.slice(1).map(l => `|${l}`).join('\n') : '');
  return `"${body}"`;
}
