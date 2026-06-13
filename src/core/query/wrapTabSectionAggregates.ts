import type { QueryModel, SelectedField, SelectedTabSectionField } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import { tokenize } from './sdblLexer';

/**
 * Обёртка поля выборки с АГРЕГАТОМ НАД КОЛОНКОЙ ТАБЛИЧНОЙ ЧАСТИ в проекцию этой ТЧ
 * (фаза 6.15.26, MCP-пробы).
 *
 * Конструктор 1С: поле выборки, чьё выражение содержит агрегат (`КОЛИЧЕСТВО`/`СУММА`/…)
 * над колонкой табличной части (`КОЛИЧЕСТВО(Алиас.ТЧ.Колонка)`), заворачивается в
 * проекцию табличной части:
 *   `ВЫБОР КОГДА КОЛИЧЕСТВО(Алиас.ТЧ.Колонка) > 0 ТОГДА … КОНЕЦ КАК Имя`
 *     → `Алиас.ТЧ.(ВЫБОР … КОНЕЦ КАК Поле1) КАК Имя`
 * где внутренний псевдоним — синтетический `Поле{n}` (сквозная нумерация внутри одной
 * проекции), а внешний псевдоним проекции — псевдоним ИСХОДНОГО поля. Несколько
 * подряд идущих полей с агрегатами над колонками ОДНОЙ И ТОЙ ЖЕ ТЧ сливаются в одну
 * проекцию (псевдоним проекции = псевдоним первого поля; псевдонимы остальных полей
 * конструктор отбрасывает) — подтверждено MCP validate_query.
 *
 * Только для СПИСКА ВЫБОРКИ (`model.fields`): агрегат над колонкой ТЧ в условии
 * ГДЕ/ИМЕЮЩИЕ конструктор НЕ заворачивает (bsl_4/bsl_5 корпуса). Применяется только
 * к простой, точно распознаваемой форме (ровно один агрегат над колонкой ТЧ в поле,
 * выражение без переноса проекции/подзапросов); прочее не трогаем.
 *
 * Без резолвера метаданных проход не выполняется (webview/extension без метаданных).
 */
export function wrapTabSectionAggregates(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  if (model.fields.length === 0) return;
  // Уже есть проекции ТЧ (явные / из expandTabSectionFields) — смешение двух схем
  // нумерации selectOrder; такие случаи в корпусе не пересекаются с этим правилом.
  if (model.tabSectionFields && model.tabSectionFields.length > 0) return;

  // Псевдоним источника (как написан, регистронезависимо) → fullName. Подзапросы — нет.
  const aliasToFull = new Map<string, string>();
  for (const t of model.tables) {
    if (t.subquery) continue;
    const a = t.alias ?? t.fullName.split('.').pop() ?? t.fullName;
    aliasToFull.set(a.toUpperCase(), t.fullName);
  }

  // Имена табличных частей таблицы по fullName (верхний регистр).
  const tsNamesOf = (fullName: string): Set<string> => {
    const meta = resolver.tableByFullName(fullName);
    const set = new Set<string>();
    for (const ts of meta?.tabularSections ?? []) set.add(ts.name.toUpperCase());
    return set;
  };

  const AGG = new Set(['КОЛИЧЕСТВО', 'СУММА', 'МАКСИМУМ', 'МИНИМУМ', 'СРЕДНЕЕ']);

  /**
   * Если выражение поля содержит РОВНО ОДИН агрегат над колонкой ТЧ и эта ТЧ —
   * единственная ТЧ-цель в выражении, вернуть { prefix, tsName, tableId }.
   * prefix = `<АлиасКакНаписан>.<ТЧ>` (берётся из исходного текста выражения).
   */
  const detect = (expr: string): { prefix: string; tsName: string; tableId: string } | undefined => {
    let toks;
    try {
      toks = tokenize(expr).filter(t => t.type !== 'eof');
    } catch {
      return undefined;
    }
    const hits: { prefix: string; tsName: string; tableId: string }[] = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      const isAgg = (t.type === 'keyword' || t.type === 'ident') && AGG.has(t.value.toUpperCase());
      if (!isAgg) continue;
      if (toks[k + 1]?.value !== '(') continue;
      // Аргумент агрегата: `<алиас> . <сегмент2> . <колонка> [...]` сразу после `(`.
      // (РАЗЛИЧНЫЕ перед путём в этой форме корпуса не встречается — bail при нём.)
      const a = toks[k + 2];
      if (!a || a.type !== 'ident') continue;
      if (toks[k + 3]?.value !== '.') continue;
      const seg2 = toks[k + 4];
      if (!seg2 || seg2.type !== 'ident') continue;
      if (toks[k + 5]?.value !== '.') continue; // должна быть и колонка ТЧ
      const full = aliasToFull.get(a.value.toUpperCase());
      if (!full) continue;
      if (!tsNamesOf(full).has(seg2.value.toUpperCase())) continue;
      // tableId источника по алиасу.
      const tbl = model.tables.find(tt => {
        const al = tt.alias ?? tt.fullName.split('.').pop() ?? tt.fullName;
        return al.toUpperCase() === a.value.toUpperCase();
      });
      if (!tbl) continue;
      hits.push({ prefix: `${a.value}.${seg2.value}`, tsName: seg2.value, tableId: tbl.id });
    }
    // Ровно одна ТЧ-цель (и все агрегаты ведут к ней) — иначе форма неоднозначна.
    if (hits.length === 0) return undefined;
    const uniq = new Set(hits.map(h => h.prefix.toUpperCase()));
    if (uniq.size !== 1) return undefined;
    return hits[0];
  };

  // Распознаём для каждого поля: цель проекции (или нет).
  type Tagged = { f: SelectedField; target?: { prefix: string; tsName: string; tableId: string } };
  const tagged: Tagged[] = model.fields.map(f => ({
    f,
    target: f.expression !== undefined ? detect(f.expression) : undefined,
  }));
  if (!tagged.some(t => t.target)) return;

  // Перестроить список выборки: поля до первой обёртки остаются в model.fields;
  // обёртки (слитые по соседней одинаковой ТЧ) и прочие поля — в rest со selectOrder.
  const firstIdx = tagged.findIndex(t => t.target);
  const head = model.fields.slice(0, firstIdx);
  const tabSections: SelectedTabSectionField[] = [];
  const trailing: SelectedField[] = [];

  let order = firstIdx;
  let i = firstIdx;
  while (i < tagged.length) {
    const cur = tagged[i];
    if (!cur.target) {
      trailing.push({ ...cur.f, selectOrder: order++ });
      i++;
      continue;
    }
    // Слить подряд идущие поля с той же ТЧ-целью в одну проекцию.
    const groupPrefix = cur.target.prefix.toUpperCase();
    const exprFields: { expression: string; alias: string }[] = [];
    const groupOrder = order++;
    let n = 0;
    while (i < tagged.length && tagged[i].target && tagged[i].target!.prefix.toUpperCase() === groupPrefix) {
      exprFields.push({ expression: tagged[i].f.expression!, alias: `Поле${++n}` });
      i++;
    }
    tabSections.push({
      tableId: cur.target.tableId,
      tsName: cur.target.tsName,
      tsFullName: `${aliasToFull.get(cur.target.prefix.split('.')[0].toUpperCase())}.${cur.target.tsName}`,
      fields: [],
      exprFields,
      // Псевдоним проекции = псевдоним ПЕРВОГО исходного поля группы.
      alias: cur.f.alias ?? cur.target.tsName,
      selectOrder: groupOrder,
    });
  }

  model.fields = head;
  model.tabSectionFields = tabSections;
  if (trailing.length) model.trailingFields = [...trailing, ...(model.trailingFields ?? [])];
}
