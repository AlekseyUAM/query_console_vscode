import type { QueryModel, FieldRef, SelectedTable } from './queryModel';
import { defaultTableAlias } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaTable, MetaField } from '../metadata/types';
import { tokenize } from './sdblLexer';

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
  // Тексты НЕагрегатных выражений выборки: ссылка, чьё ЗНАЧЕНИЕ потребляется такой
  // выборкой (стоит в РЕЗУЛЬТАТЕ ТОГДА/ИНАЧЕ), оракулом СОХРАНЯЕТСЯ (Взаимозачет bsl_21).
  const nonAggSelectExprs: string[] = [];
  for (const f of [...model.fields, ...(model.trailingFields ?? [])]) {
    if (f.expression !== undefined) {
      if (f.func === undefined && !AGG_RE.test(f.expression)) nonAggSelectExprs.push(f.expression);
      continue;
    }
    if (f.func !== undefined) continue;
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
    // Ссылка, чьё ЗНАЧЕНИЕ стоит в РЕЗУЛЬТАТЕ (после ТОГДА/ИНАЧЕ) НЕагрегатного выражения
    // выборки, потребляется им — оракул её НЕ дропает (Взаимозачет bsl_21).
    {
      const t = aliasToTable.get(f.tableId);
      const rendered = (t ? defaultTableAlias(t) : f.tableId) + '.' + f.path;
      if (nonAggSelectExprs.some(e => derefInResultPosition(e, rendered))) continue;
    }
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

/** Нормализация выражения для сравнения «уже в группировке» (схлопывание пробелов). */
function normExpr(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/** `expr` содержит ссылку `rendered` (`Алиас.Путь`) как ЦЕЛУЮ токен-цепочку. */
function containsFieldRef(expr: string, rendered: string): boolean {
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_.]/u.test(c);
  let from = 0;
  for (;;) {
    const idx = expr.indexOf(rendered, from);
    if (idx < 0) return false;
    if (!isWordChar(expr[idx - 1]) && !isWordChar(expr[idx + rendered.length])) return true;
    from = idx + rendered.length;
  }
}

/**
 * Замена ПРОСТОГО поля группировки `Алиас.Имя` выражением-CASE выборки `ВЫБОР…КОНЕЦ
 * КАК Имя` (с переносом в КОНЕЦ явной части СГРУППИРОВАТЬ ПО). Конструктор 1С требует,
 * чтобы каждое НЕагрегатное выражение выборки присутствовало в группировке; когда
 * разработчик сгруппировал по ЛИСТУ выражения (`Алиас.Имя`), а не по самому выражению,
 * 1С заменяет лист выражением. Сверено живым оракулом (validate_query) и ПОЛНЫМ
 * корпусом accept:oracle (17933).
 *
 * ГЛАВНЫЙ различитель (0 регрессий на полном корпусе 17933): ТОЛЬКО во ВЛОЖЕННОМ
 * подзапросе-источнике `ИЗ (ВЫБРАТЬ …)` — ВЕРХНЕУРОВНЕВУЮ группировку конструктор 1С
 * сохраняет дословно (top-level лист НЕ заменяется: ЗаполнениеОбъектов, РаспределениеЗатрат,
 * АвансовыйОтчет — все сверены полным accept:oracle), а группировку подзапроса реконструирует
 * из схемы. Доп. узкий гейт: E — `ВЫБОР…КОНЕЦ` БЕЗ агрегата (агрегатный `ВЫБОР…СУММА…` сохраняет
 * лист, НаборыСервер bsl_5), псевдоним == пути поля, лист-вхождение `Алиас.Имя`, есть поле-якорь
 * раньше, и E ЕЩЁ НЕ в группировке (дубль не плодим). Заменяется РОВНО ОДНО поле.
 */
export function substituteGroupFieldWithSelectExpr(model: QueryModel, resolver?: MetadataResolver, isSubquery = false): void {
  if (!resolver) return;
  // ТОЛЬКО во вложенном подзапросе-источнике: верхнеуровневую группировку конструктор
  // 1С сохраняет дословно (ЗаполнениеОбъектов/РаспределениеЗатрат/АвансовыйОтчет —
  // top-level, лист НЕ заменяется), а в подзапросе — реконструирует из схемы.
  if (!isSubquery) return;
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length < 2) return;
  const explicitCount = grouping.explicitGroupCount ?? fields.length;
  if (explicitCount < 2) return;

  const aliasToTable = new Map<string, SelectedTable>();
  for (const t of model.tables) aliasToTable.set(t.id, t);

  const selectKeys = new Set<string>();
  const exprCols: { alias: string; expression: string }[] = [];
  for (const f of [...model.fields, ...(model.trailingFields ?? [])]) {
    if (f.expression !== undefined) {
      if (
        f.func === undefined && f.alias &&
        /^ВЫБОР(?![\p{L}\p{N}_])/iu.test(f.expression.trim()) &&
        !AGG_RE.test(f.expression)
      ) {
        exprCols.push({ alias: f.alias, expression: f.expression });
      }
      continue;
    }
    if (f.func !== undefined || !f.tableId || !f.path) continue;
    selectKeys.add(keyOf(f.tableId, f.path));
  }
  if (exprCols.length === 0) return;

  // Выражения, УЖЕ присутствующие в группировке (нормализованные) — лист не заменяем.
  const groupedExprNorm = new Set<string>();
  for (const g of fields) if (g.expression !== undefined) groupedExprNorm.add(normExpr(g.expression));

  const anchorBefore: boolean[] = [];
  let seenAnchor = false;
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    anchorBefore.push(seenAnchor);
    const f = fields[i];
    if (f.expression === undefined && f.tableId && f.path && selectKeys.has(keyOf(f.tableId, f.path))) {
      seenAnchor = true;
    }
  }

  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    if (selectKeys.has(keyOf(f.tableId, f.path))) continue; // backs колонку — сохраняем
    if (!anchorBefore[i]) continue;
    const table = aliasToTable.get(f.tableId);
    const nameUp = f.path.toUpperCase();
    const alias = table ? defaultTableAlias(table) : f.tableId;
    const rendered = alias + '.' + f.path;
    const expr = exprCols.find(
      e => e.alias.toUpperCase() === nameUp &&
        containsFieldRef(e.expression, rendered) &&
        !groupedExprNorm.has(normExpr(e.expression))
    );
    if (!expr) continue;
    const explicit = fields.slice(0, explicitCount);
    const rest = fields.slice(explicitCount);
    explicit.splice(i, 1);
    explicit.push({ tableId: '', path: '', expression: expr.expression });
    grouping.groupFields = [...explicit, ...rest];
    grouping.explicitGroupCount = explicitCount;
    return; // ровно одна замена
  }
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

// ── FD-минимизация GROUP BY (CASE-вид-движения): фаза 6.19, Взаимозачет ──
// CASE-вид-движения = выражение, РЕЗУЛЬТАТ которого (после ТОГДА/ИНАЧЕ) —
// `ЗНАЧЕНИЕ(ВидДвиженияНакопления/Бухгалтерии.…)`. CASE, лишь СРАВНИВАЮЩИЙ поле с видом
// движения в УСЛОВИИ (`КОГДА X.ВидДвижения = ЗНАЧЕНИЕ(…) ТОГДА <другое>`), сюда НЕ
// относится — иначе оверфайр (УчетНДФЛ bsl_65/66, ФормаРасшифровкиПлатежа, РаботаСПодарочными).
const MOVEMENT_RE = /(?:^|[^\p{L}\p{N}_])(?:ТОГДА|ИНАЧЕ)\s+(?:-\s*)?ЗНАЧЕНИЕ\s*\(\s*ВИДДВИЖЕНИЯ(?:НАКОПЛЕНИЯ|БУХГАЛТЕРИИ)\s*\./iu;
const META_FUNCS = new Set(['ЗНАЧЕНИЕ', 'ТИП', 'ПРЕДСТАВЛЕНИЕ', 'ПРЕДСТАВЛЕНИЕССЫЛКИ']);

/**
 * Извлекает множество ссылок-цепочек `Алиас.путь` (в исходном написании), реально
 * читающих ДАННЫЕ, из произвольного выражения. НЕ считаются полями: содержимое
 * мета-вызовов `ЗНАЧЕНИЕ/ТИП/ПРЕДСТАВЛЕНИЕ(…)`, имена функций (за идентификатором
 * сразу `(`). Голова цепочки должна быть известным псевдонимом источника.
 */
function extractFieldRefs(expr: string, aliasUp: Set<string>): Set<string> {
  let toks;
  try { toks = tokenize(expr); } catch { return new Set(); }
  const sig = toks.filter(t => t.type !== 'eof');
  const refs = new Set<string>();
  let depth = 0;
  const metaDepths: number[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type === 'punct' && t.value === '(') {
      const head = sig[i - 1];
      const hv = head ? (head.text ?? head.value).toUpperCase() : '';
      depth++;
      if (META_FUNCS.has(hv)) metaDepths.push(depth);
      continue;
    }
    if (t.type === 'punct' && t.value === ')') {
      if (metaDepths.length && metaDepths[metaDepths.length - 1] === depth) metaDepths.pop();
      depth--;
      continue;
    }
    if (metaDepths.length) continue; // внутри ЗНАЧЕНИЕ/ТИП/ПРЕДСТАВЛЕНИЕ — не поле
    if (t.type === 'ident' || t.type === 'keyword') {
      let j = i;
      const parts = [sig[j].value];
      while (
        j + 2 < sig.length &&
        sig[j + 1].type === 'punct' && sig[j + 1].value === '.' &&
        (sig[j + 2].type === 'ident' || sig[j + 2].type === 'keyword')
      ) {
        parts.push(sig[j + 2].value);
        j += 2;
      }
      const after = sig[j + 1];
      const isCall = after && after.type === 'punct' && after.value === '(';
      if (parts.length >= 2 && !isCall && aliasUp.has(parts[0].toUpperCase())) {
        refs.add(parts.join('.'));
      }
      i = j;
    }
  }
  return refs;
}

/**
 * Ссылка `rendered` стоит в РЕЗУЛЬТАТЕ выражения: непосредственно после `ТОГДА`/`ИНАЧЕ`,
 * как ЦЕЛАЯ токен-цепочка. Условие `КОГДА … rendered …` под предикат НЕ подпадает.
 */
function derefInResultPosition(expr: string, rendered: string): boolean {
  const re = new RegExp(
    '(?:^|[^\\p{L}\\p{N}_.])(?:ТОГДА|ИНАЧЕ)\\s+' +
      rendered.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') +
      '(?![\\p{L}\\p{N}_.])',
    'u'
  );
  return re.test(expr);
}

/**
 * Минимизация GROUP BY конструктором 1С: НЕагрегатное выражение-CASE с результатом-
 * ВИДОМ-ДВИЖЕНИЯ регистра (`ЗНАЧЕНИЕ(ВидДвиженияНакопления/Бухгалтерии.…)`), которое
 * функционально определено остальными полями группировки, конструктор 1С ОТБРАСЫВАЕТ —
 * НО только когда определимость НЕ опирается на сгруппированную САМУ ссылку (`Алиас.Ссылка`).
 * Сверено живым оракулом validate_query на корпусе Взаимозачет bsl_21 (члены 185/729) и
 * серии минимальных проб: при сгруппированной `Алиас.Ссылка` тот же CASE СОХРАНЯЕТСЯ
 * (член-185), без неё — ДРОПАЕТСЯ (член-729, минимальные пробы).
 *
 * Условие дропа выражения E:
 *   (a) КАЖДАЯ ссылка-поле внутри E присутствует ОТДЕЛЬНЫМ полем группировки;
 *   (b) НИ ОДНА dereference `Алиас.A.B…` внутри E не навигирует через сгруппированный
 *       префикс `Алиас.A` (если навигирует — определимость идёт через ссылку и E СОХРАНЯЕТСЯ).
 * Ограничено выражениями-ВИДА-ДВИЖЕНИЯ (как существующий moveLeadingMovementCaseToEnd):
 * `ВЫБОР` с результатом-`Перечисление.X`/булевым оракул сохраняет (член-729: ТипРасчетов).
 * Без резолвера/при группировке-наборах правило не применяется.
 */
export function dropFunctionallyDeterminedMovementCase(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length < 2) return;
  const explicitCount = grouping.explicitGroupCount ?? fields.length;

  const aliasUp = new Set<string>();
  for (const t of model.tables) aliasUp.add(defaultTableAlias(t).toUpperCase());

  // Отрендеренные ключи (UPPER) простых полей группировки в ЯВНОЙ части.
  const groupedUp = new Set<string>();
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    const t = model.tables.find(tb => tb.id === f.tableId);
    groupedUp.add(((t ? defaultTableAlias(t) : f.tableId) + '.' + f.path).toUpperCase());
  }

  const dropIdx = new Set<number>();
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression === undefined) continue;
    if (!MOVEMENT_RE.test(f.expression)) continue; // только вид-движения
    const refs = extractFieldRefs(f.expression, aliasUp);
    if (refs.size === 0) continue;
    let allGrouped = true;
    let navThroughGroupedRef = false;
    for (const r of refs) {
      if (!groupedUp.has(r.toUpperCase())) { allGrouped = false; break; }
      const segs = r.split('.');
      // префиксы длиной >= 2 сегментов и короче полного пути
      for (let k = 2; k < segs.length; k++) {
        if (groupedUp.has(segs.slice(0, k).join('.').toUpperCase())) { navThroughGroupedRef = true; break; }
      }
    }
    if (allGrouped && !navThroughGroupedRef) dropIdx.add(i);
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
 * Перенос в КОНЕЦ явной части GROUP BY СОХРАНённого выражения-CASE вида-движения и
 * следующих за ним (в исходном порядке) СОХРАНённых ссылок-навигаций `Алиас.A.B`,
 * чей префикс `Алиас.A` тоже сгруппирован (т.е. «избыточных, но потребляемых выборкой»
 * ссылок — их не отбросил keep-guard dropRedundantGroupDerefs). Сверено живым оракулом
 * (Взаимозачет bsl_21, член-185): хвост `… A, CASE-вид-движения, Ссылка.ДокументРасчетов,
 * B → … A, B, CASE, Ссылка.ДокументРасчетов` (CASE и навигация уезжают в конец, голое
 * поле остаётся). Применяется ПОСЛЕ dropFunctionallyDeterminedMovementCase.
 */
export function relocateKeptMovementCase(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  const grouping = model.grouping;
  if (!grouping || grouping.multiple) return;
  const fields = grouping.groupFields;
  if (fields.length < 2) return;
  const explicitCount = grouping.explicitGroupCount ?? fields.length;
  if (explicitCount < 2) return;

  // Префиксы-ссылки, сгруппированные отдельным полем (для «навигации через ссылку»).
  const groupedUp = new Set<string>();
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    const t = model.tables.find(tb => tb.id === f.tableId);
    groupedUp.add(((t ? defaultTableAlias(t) : f.tableId) + '.' + f.path).toUpperCase());
  }

  const aliasUp = new Set<string>();
  for (const t of model.tables) aliasUp.add(defaultTableAlias(t).toUpperCase());
  // Переносим ТОЛЬКО CASE-вид-движения, СОХРАНённый из-за навигации через сгруппированную
  // ссылку (условие keep члена-185 Взаимозачета): ВСЕ его поля сгруппированы И есть
  // навигация `Алиас.A.B` со сгруппированным префиксом `Алиас.A`. Если поля НЕ все
  // сгруппированы (РасходнаяНакладная: `ВидОперации` не в группировке) — CASE остаётся
  // на месте (оракул его НЕ двигает), переноса НЕ делаем.
  let caseIdx = -1;
  for (let i = 0; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression === undefined || !MOVEMENT_RE.test(f.expression)) continue;
    const refs = extractFieldRefs(f.expression, aliasUp);
    if (refs.size === 0) continue;
    let allGrouped = true, navThroughGroupedRef = false;
    for (const r of refs) {
      if (!groupedUp.has(r.toUpperCase())) { allGrouped = false; break; }
      const segs = r.split('.');
      for (let k = 2; k < segs.length; k++) {
        if (groupedUp.has(segs.slice(0, k).join('.').toUpperCase())) { navThroughGroupedRef = true; break; }
      }
    }
    if (allGrouped && navThroughGroupedRef) { caseIdx = i; break; }
  }
  if (caseIdx < 0) return;

  // Собираем переносимые: сам CASE + последующие навигации `Алиас.A.B` (префикс сгруппирован).
  const moveIdx: number[] = [caseIdx];
  for (let i = caseIdx + 1; i < explicitCount && i < fields.length; i++) {
    const f = fields[i];
    if (f.expression !== undefined || !f.tableId || !f.path) continue;
    const segs = f.path.split('.');
    if (segs.length < 2) continue;
    const t = model.tables.find(tb => tb.id === f.tableId);
    const alias = t ? defaultTableAlias(t) : f.tableId;
    let prefixGrouped = false;
    for (let k = 1; k < segs.length; k++) {
      if (groupedUp.has((alias + '.' + segs.slice(0, k).join('.')).toUpperCase())) { prefixGrouped = true; break; }
    }
    if (prefixGrouped) moveIdx.push(i);
  }
  if (moveIdx.length === 0) return;

  const moveSet = new Set(moveIdx);
  const explicit = fields.slice(0, explicitCount);
  const rest = fields.slice(explicitCount);
  const head = explicit.filter((_, i) => !moveSet.has(i));
  const moved = moveIdx.map(i => explicit[i]);
  // Перенос ВНУТРИ явной части — explicitGroupCount не меняется.
  grouping.groupFields = [...head, ...moved, ...rest];
  grouping.explicitGroupCount = explicitCount;
}
