import type { QueryModel, SelectedTable } from './queryModel';
import { defaultTableAlias } from './queryModel';

function resolveAliases(tables: SelectedTable[]): Map<string, string> {
  const seen = new Set<string>();
  const result = new Map<string, string>();
  for (const t of tables) {
    const base = defaultTableAlias(t);
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

function accountingPositions(slice: string, v: SelectedTable['virtual'] & {}): string[] {
  const s = (x?: string) => x ?? '';
  switch (slice) {
    case 'Остатки':
      return [s(v.period), s(v.accountCondition), '', s(v.condition)];
    case 'Обороты':
      return v.correspondence
        ? [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountCondition), '', s(v.condition), s(v.corrAccountCondition), '']
        : [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountCondition), '', s(v.condition)];
    case 'ОборотыДтКт':
      return [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.accountDtCondition), '', s(v.accountKtCondition), '', s(v.condition)];
    case 'ОстаткиИОбороты':
      return [s(v.startPeriod), s(v.endPeriod), s(v.periodicity), s(v.fillMethod), s(v.accountCondition), '', s(v.condition)];
    case 'ДвиженияССубконто':
      return [s(v.startPeriod), s(v.endPeriod), s(v.condition), s(v.order), s(v.top)];
    default:
      return [];
  }
}

function renderSource(t: SelectedTable): string {
  if (!t.virtual) return t.fullName;
  const v = t.virtual;
  const parts = t.fullName.split('.');
  const kind = parts[0];
  const slice = parts[2];

  // Регистр бухгалтерии: фиксированная арность, хвостовые пустые позиции сохраняются,
  // скобки — только если задан хоть один параметр.
  if (kind === 'РегистрБухгалтерии') {
    const positions = accountingPositions(slice, v);
    if (!positions.some(p => p !== '')) return t.fullName;
    return `${t.fullName}(${positions.join(', ')})`;
  }

  // Регистры сведений/накопления: хвостовые пустые позиции отбрасываются.
  let positions: string[];
  if (slice === 'Обороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.condition ?? ''];
  } else if (slice === 'ОстаткиИОбороты') {
    positions = [v.startPeriod ?? '', v.endPeriod ?? '', v.periodicity ?? '', v.fillMethod ?? '', v.condition ?? ''];
  } else {
    positions = [v.period ?? '', v.condition ?? ''];
  }
  let last = positions.length - 1;
  while (last >= 0 && positions[last] === '') last--;
  if (last < 0) return t.fullName;
  return `${t.fullName}(${positions.slice(0, last + 1).join(', ')})`;
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
    // Дедупликация псевдонимов: если поле встречается повторно — добавляем числовой суффикс
    // (пример: Ссылка → Ссылка1). Это воспроизводит поведение конструктора 1С,
    // который может дважды включить одноимённые поля ТЧ.
    const usedAliases = new Map<string, number>();
    const subLines = tsf.fields.map((f, i) => {
      const count = usedAliases.get(f) ?? 0;
      usedAliases.set(f, count + 1);
      const alias = count === 0 ? f : `${f}${count}`;
      return `\t\t${f} КАК ${alias}${i < tsf.fields.length - 1 ? ',' : ''}`;
    });
    allLines.push(`\t${tableAlias}.${tsf.tsName}.(\n${subLines.join('\n')}\n\t) КАК ${tsf.tsName}`);
  }

  // Поля, которые должны появляться после табличных частей (Предопределенный, ИмяПредопределенныхДанных).
  for (const f of model.trailingFields ?? []) {
    if (f.expression) {
      const alias = f.alias ?? `Поле${++exprCounter}`;
      allLines.push(`\t${f.expression} КАК ${alias}`);
      continue;
    }
    const tableAlias = aliases.get(f.tableId) ?? f.tableId;
    const expr = f.alias ? `${tableAlias}.${f.path} КАК ${f.alias}` : `${tableAlias}.${f.path}`;
    allLines.push(`\t${expr}`);
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
