import type { QueryModel, FieldRef, SelectedTable } from './queryModel';
import { defaultTableAlias } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaTable, MetaField } from '../metadata/types';

const AGG_RE = /(?:^|[^\p{L}])(СУММА|КОЛИЧЕСТВО|МАКСИМУМ|МИНИМУМ|СРЕДНЕЕ|SUM|COUNT|MAX|MIN|AVG)\s*\(/iu;

/**
 * Тихий дроп ИЗБЫТОЧНОЙ многосегментной ссылки `Алиас.A.B…` из СГРУППИРОВАТЬ ПО
 * (фаза 6.18, по метаданным). Подтверждено живым оракулом (mcp validate_query) и
 * корпусом «другой конфигурации» (accept:oracle): элемент группировки `Алиас.A.B`
 * (навигация ЧЕРЕЗ ссылочное поле `A`) конструктор 1С ОТБРАСЫВАЕТ тогда и только
 * тогда, когда:
 *   1) в той же группировке РАНЬШЕ него присутствует элемент `Алиас.P`, где `P` —
 *      СОБСТВЕННЫЙ ПРЕФИКС пути `A.B…` (любой, не обязательно непосредственный) —
 *      группировка по префиксу-ссылке функционально определяет навигацию через неё.
 *      Порядок важен: при `Алиас.A.B` ПЕРЕД `Алиас.A` оракул СОХРАНЯЕТ оба (корпус
 *      ФормированиеПартийЗЕРНО bsl_5, сверено validate_query);
 *   2) `Алиас.A.B` НЕ присутствует отдельной колонкой в ВЫБРАТЬ (выбранное поле
 *      backs колонку результата и сохраняется в группировке);
 *   3) ПРЕФИКС `P` ДОКАЗУЕМО резолвится по метаданным в ССЫЛОЧНЫЙ РЕКВИЗИТ источника
 *      (`attribute`/`standard`-ссылка). Источник — реальная таблица метаданных, а не
 *      ВТ/подзапрос/параметр. При нерезолвимом источнике (ВТ `ВТСтрокиДоходов`,
 *      подзапрос, параметр `&Имя`) оракул не знает типов и элемент СОХРАНЯЕТ.
 *      Головной сегмент-ИЗМЕРЕНИЕ/РЕСУРС регистра — НЕ дропается (см.
 *      prefixResolvesToReference).
 *
 * Без резолвера правило не применяется (поведение webview/extension без метаданных
 * прежнее). Дроп затрагивает ТОЛЬКО ЯВНУЮ часть `groupFields`; граница
 * `explicitGroupCount` пересчитывается.
 */
export function dropRedundantGroupDerefs(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length === 0) return;

  const explicitCount = grouping.explicitGroupCount ?? fields.length;
  const aliasToTable = new Map<string, SelectedTable>();
  for (const t of model.tables) aliasToTable.set(t.id, t);

  // Ключи простых полей группировки → САМЫЙ РАННИЙ индекс (для поиска префиксов).
  const groupKeyIdx = new Map<string, number>();
  for (let gi = 0; gi < fields.length; gi++) {
    const f = fields[gi];
    if (f.expression !== undefined) continue;
    if (!f.tableId || !f.path) continue;
    const gk = keyOf(f.tableId, f.path);
    if (!groupKeyIdx.has(gk)) groupKeyIdx.set(gk, gi);
  }
  // Ключи простых НЕагрегатных полей ВЫБРАТЬ (выбранное поле сохраняется в группировке).
  const selectKeys = new Set<string>();
  for (const f of [...model.fields, ...(model.trailingFields ?? [])]) {
    if (f.expression !== undefined || f.func !== undefined) continue;
    if (!f.tableId || !f.path) continue;
    selectKeys.add(keyOf(f.tableId, f.path));
  }

  const dropIdx = new Set<number>();
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    if (selectKeys.has(keyOf(f.tableId, f.path))) continue; // выбранное поле — сохраняем
    const segs = f.path.split('.');
    if (segs.length < 2) continue; // не многосегментная навигация
    // Ищем СОБСТВЕННЫЙ префикс пути среди ПРЕДШЕСТВУЮЩИХ элементов группировки.
    let prefixGrouped = '';
    for (let k = segs.length - 1; k >= 1; k--) {
      const prefix = segs.slice(0, k).join('.');
      const pidx = groupKeyIdx.get(keyOf(f.tableId, prefix));
      if (pidx !== undefined && pidx < i) { prefixGrouped = prefix; break; }
    }
    if (!prefixGrouped) continue;
    // Префикс должен ДОКАЗУЕМО резолвиться по метаданным в ссылочный реквизит.
    if (!prefixResolvesToReference(aliasToTable.get(f.tableId), prefixGrouped, resolver)) continue;
    dropIdx.add(i);
  }

  if (dropIdx.size === 0) return;
  const kept: FieldRef[] = [];
  let droppedBeforeExplicit = 0;
  for (let i = 0; i < fields.length; i++) {
    if (dropIdx.has(i)) { if (i < explicitCount) droppedBeforeExplicit++; continue; }
    kept.push(fields[i]);
  }
  grouping.groupFields = kept;
  grouping.explicitGroupCount = explicitCount - droppedBeforeExplicit;
}

/**
 * Перенос в КОНЕЦ явного списка СГРУППИРОВАТЬ ПО многосегментной ссылки `Алиас.A.B`,
 * которая стоит ПЕРЕД своим префиксом `Алиас.A` (тоже сгруппированным ссылочным
 * реквизитом) и НЕ выбрана отдельной колонкой, НО участвует в АГРЕГАТНОМ выражении
 * выборки (`ВЫБОР … СУММА(…) … ИНАЧЕ Алиас.A.B КОНЕЦ`). Сверено живым оракулом
 * (validate_query) и корпусом (ФормированиеПартийЗЕРНО bsl_5):
 *   - `Алиас.A.B` ПЕРЕД `Алиас.A`, `A` — ссылочный реквизит, `Алиас.A.B` не в ВЫБРАТЬ,
 *     но текст `Алиас.A.B` есть внутри агрегатного выражения выборки → элемент
 *     СОХРАНЯЕТСЯ и СТАВИТСЯ ПОСЛЕДНИМ в явной части (после префикса).
 * Без агрегатного выражения-потребителя оракул такую ссылку отбрасывает (этот
 * подслучай корпусом не затронут и здесь НЕ трогается — нулевые регрессии).
 *
 * Применяется ПОСЛЕ dropRedundantGroupDerefs. Без резолвера не работает.
 */
export function moveBeforePrefixGroupDerefToEnd(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length < 2) return;
  const explicitCount = grouping.explicitGroupCount ?? fields.length;
  if (explicitCount < 2) return;

  const aliasToTable = new Map<string, SelectedTable>();
  for (const t of model.tables) aliasToTable.set(t.id, t);

  // Самый РАННИЙ индекс каждого простого поля группировки (для поиска префикса).
  const groupKeyIdx = new Map<string, number>();
  for (let gi = 0; gi < explicitCount && gi < fields.length; gi++) {
    const f = fields[gi];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    const gk = keyOf(f.tableId, f.path);
    if (!groupKeyIdx.has(gk)) groupKeyIdx.set(gk, gi);
  }
  // Выбранные простые поля — сохраняются как есть (отдельная колонка результата).
  const selectKeys = new Set<string>();
  for (const f of [...model.fields, ...(model.trailingFields ?? [])]) {
    if (f.expression !== undefined || f.func !== undefined) continue;
    if (!f.tableId || !f.path) continue;
    selectKeys.add(keyOf(f.tableId, f.path));
  }
  // Тексты агрегатных выражений выборки (для проверки «потребителя» ссылки).
  const aggExprTexts: string[] = [];
  for (const f of [...model.fields, ...(model.trailingFields ?? [])]) {
    if (f.expression !== undefined && AGG_RE.test(f.expression)) aggExprTexts.push(f.expression);
  }
  if (aggExprTexts.length === 0) return;

  let moveIdx = -1;
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    if (selectKeys.has(keyOf(f.tableId, f.path))) continue;
    const segs = f.path.split('.');
    if (segs.length < 2) continue;
    // Префикс должен быть сгруппирован ПОЗЖЕ (ссылка стоит ПЕРЕД префиксом).
    let prefixGrouped = '';
    for (let k = segs.length - 1; k >= 1; k--) {
      const prefix = segs.slice(0, k).join('.');
      const pidx = groupKeyIdx.get(keyOf(f.tableId, prefix));
      if (pidx !== undefined && pidx > i) { prefixGrouped = prefix; break; }
    }
    if (!prefixGrouped) continue;
    if (!prefixResolvesToReference(aliasToTable.get(f.tableId), prefixGrouped, resolver)) continue;
    // Ссылка должна употребляться в каком-либо агрегатном выражении выборки.
    const table = aliasToTable.get(f.tableId);
    const alias = table ? defaultTableAlias(table) : f.tableId;
    const rendered = alias + '.' + f.path;
    const used = aggExprTexts.some(t => t.includes(rendered));
    if (!used) continue;
    moveIdx = i;
    break; // переносим ровно одну такую ссылку (корпус: единственный случай)
  }
  if (moveIdx < 0) return;

  const moved = fields[moveIdx];
  const explicit = fields.slice(0, explicitCount);
  const rest = fields.slice(explicitCount);
  explicit.splice(moveIdx, 1);
  explicit.push(moved);
  grouping.groupFields = [...explicit, ...rest];
  // explicitGroupCount не меняется — перестановка внутри явной части.
}

function keyOf(tableId: string, path: string): string {
  return tableId + '' + path;
}

/**
 * Перенос ВЕДУЩЕГО элемента группировки `ВЫБОР…КОНЕЦ` в КОНЕЦ списка, когда его
 * результат — системное перечисление вида движения регистра (`ЗНАЧЕНИЕ(
 * ВидДвиженияНакопления.…)` / `ЗНАЧЕНИЕ(ВидДвиженияБухгалтерии.…)`). Сверено живым
 * оракулом (validate_query) и корпусом accept:oracle (ПеремещениеЗапасов bsl_6,
 * ВводНачальныхОстатков bsl_16): ведущий `ВЫБОР`, возвращающий ЗНАЧЕНИЕ системного
 * вида движения, конструктор 1С ставит ПОСЛЕДНИМ в СГРУППИРОВАТЬ ПО, тогда как
 * `ВЫБОР` с результатом-`Перечисление.X` или булевым (`ЛОЖЬ/ИСТИНА`) — ОСТАЁТСЯ на
 * месте (ПроизводствоСервер bsl_9, БольничныйЛист bsl_2 — проходят). Различитель —
 * ссылка на системный вид движения в тексте выражения. Переносится РОВНО ОДИН
 * ведущий такой элемент; при отсутствии — список не меняется (байт-в-байт).
 */
export function moveLeadingMovementCaseToEnd(model: QueryModel): void {
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length < 2) return;
  const explicitCount = grouping.explicitGroupCount ?? fields.length;
  if (explicitCount < 2) return;
  const head = fields[0];
  if (head.expression === undefined) return;
  if (!isMovementCaseExpr(head.expression)) return;
  const moved = fields[0];
  const rest = fields.slice(1, explicitCount);
  const appended = fields.slice(explicitCount);
  grouping.groupFields = [...rest, moved, ...appended];
  grouping.explicitGroupCount = explicitCount;
}

/**
 * Выражение — `ВЫБОР`, результат которого ссылается на системный вид движения
 * регистра (`ВидДвиженияНакопления`/`ВидДвиженияБухгалтерии`) через `ЗНАЧЕНИЕ(…)`.
 */
function isMovementCaseExpr(expr: string): boolean {
  const up = expr.toUpperCase();
  if (!up.includes('ВЫБОР')) return false;
  return /ЗНАЧЕНИЕ\s*\(\s*ВИДДВИЖЕНИЯ(НАКОПЛЕНИЯ|БУХГАЛТЕРИИ)\s*\./u.test(up);
}

/**
 * ДОКАЗУЕМО ли путь `path` (от таблицы-источника `table`) резолвится в ССЫЛОЧНЫЙ
 * реквизит по метаданным. false при нерезолвимом источнике (ВТ/подзапрос/параметр/
 * пробел метаданных) — тогда дроп не делаем.
 *
 * ВАЖНО: дроп НЕ применяется, когда головной сегмент пути — ИЗМЕРЕНИЕ/РЕСУРС
 * регистра (`dimension`/`resource`). Сверено корпусом accept:oracle: навигация через
 * измерение регистра (`СведенияОДоходахНДФЛ.КодДохода.СтавкаНалога…` над
 * РегистрНакопления, `ДвиженияТоваров.Номенклатура.ВидАлкогольнойПродукции` над
 * РегистрНакопления.Запасы) оракулом СОХРАНЯЕТСЯ, тогда как навигация через РЕКВИЗИТ
 * табличной части/справочника (`СпецификацииСостав.Номенклатура.ЕдиницаИзмерения`,
 * `…Сотрудники.Ссылка.ОтчетныйПериод`) — отбрасывается. Различитель — категория
 * головного поля источника.
 */
function prefixResolvesToReference(
  table: SelectedTable | undefined,
  path: string,
  resolver: MetadataResolver
): boolean {
  if (!table || table.subquery) return false;
  if (!table.fullName || table.fullName.startsWith('&')) return false;
  let cur = metaFor(table.fullName, resolver);
  if (!cur) return false;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    if (!cur) return false;
    const field = findField(cur, segs[i]);
    if (!field) return false;
    // Головной сегмент-измерение/ресурс регистра: навигацию через него оракул
    // сохраняет — дроп не делаем (только реквизит/стандартное ссылочное поле).
    if (i === 0 && (field.kind === 'dimension' || field.kind === 'resource')) return false;
    const ref = firstRef(field);
    if (i === segs.length - 1) return ref !== undefined;
    if (!ref) return false; // нессылочный промежуточный сегмент — навигация невозможна
    cur = resolver.tableByFullName(ref.kind + '.' + ref.name);
  }
  return false;
}

function metaFor(fullName: string, resolver: MetadataResolver): MetaTable | undefined {
  const direct = resolver.tableByFullName(fullName);
  if (direct) return direct;
  // Источник-табличная часть `Тип.Объект.ТЧ` (`Справочник.Спецификации.Состав`):
  // состав колонок — `tabularSections[].fields` родительской таблицы.
  const parts = fullName.split('.');
  if (parts.length === 3 && !parts[0].startsWith('Регистр')) {
    const owner = resolver.tableByFullName(parts[0] + '.' + parts[1]);
    const ts = owner?.tabularSections?.find(s => s.name.toUpperCase() === parts[2].toUpperCase());
    if (ts) return ts;
  }
  // Срез виртуальной таблицы регистра → базовый регистр.
  const m = fullName.match(/^(Регистр\p{L}+\.[^.]+)\.\p{L}+$/u);
  return m ? resolver.tableByFullName(m[1]) : undefined;
}

function findField(meta: MetaTable, name: string): MetaField | undefined {
  const up = name.toUpperCase();
  return meta.fields.find(f => f.name.toUpperCase() === up);
}

function firstRef(field: MetaField): { kind: string; name: string } | undefined {
  for (const t of field.types) if (t.ref) return t.ref;
  return undefined;
}
