import type { QueryModel, SelectedField, SelectedTable, Condition, Join } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaTable, MetaField } from '../metadata/types';

/**
 * Канонизация РЕГИСТРА сегментов пути поля выборки по метаданным (фаза 6.16.66).
 *
 * Конструктор 1С печатает имена реквизитов в каноническом написании метаданных
 * (`ДоНачислено` → `Доначислено`, `ШтрихКод` → `Штрихкод`, `ФизЛицо` → `Физлицо`),
 * тогда как во вводе сегмент может нести произвольный регистр. Канонизация имени
 * источника уже выполняется (`canonicalFullName`), но сегменты ПУТИ (реквизиты)
 * оставались как есть. Здесь идём по цепочке ссылок от таблицы источника и
 * заменяем КАЖДЫЙ сегмент на его каноническое имя из метаданных.
 *
 * Канонизируем ТОЛЬКО доказуемо резолвимые сегменты (по реальным метаданным
 * источника и навигации через ссылочные поля). При первой неопределённости
 * (нерезолвимый источник/реквизит, источник-параметр/ВТ/подзапрос) останавливаемся
 * — регистр оставшихся сегментов не трогаем (пробел метаданных не должен менять
 * вывод). Без резолвера — no-op (поведение webview/extension прежнее).
 */
export function canonicalizeFieldCasing(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  const aliasToTable = new Map<string, SelectedTable>();
  const idToTable = new Map<string, SelectedTable>();
  for (const t of model.tables) {
    if (t.alias) aliasToTable.set(t.alias.toUpperCase(), t);
    idToTable.set(t.id, t);
  }
  for (const f of model.fields) {
    canonField(f, aliasToTable, resolver);
  }
  // Сегменты пути СТРУКТУРНЫХ простых ссылок на поля в условиях ГДЕ/ИМЕЮЩИЕ и
  // соединениях ПО тоже печатаются конструктором 1С в каноническом регистре
  // метаданных (`Марки.ссылка` → `Марки.Ссылка`). Канонизируем ровно те же
  // доказуемо резолвимые сегменты, что и в выборке — только поля с известной
  // головой-источником и подтверждённым метаданными написанием. Произвольные
  // выражения (`custom`/`expression`/`leftExpr`) и подзапросы не трогаем.
  for (const c of model.conditions ?? []) canonCondition(c, idToTable, aliasToTable, resolver);
  for (const c of model.having ?? []) canonCondition(c, idToTable, aliasToTable, resolver);
  for (const j of model.joins ?? []) canonJoin(j, idToTable, aliasToTable, resolver);
}

/**
 * Канонизирует регистр сегментов ССЫЛОК НА ПОЛЯ внутри произвольного текста
 * выражения условия/соединения (`ДанныеМарок.АкцизнаяМарка = Марки.ссылка` →
 * `… Марки.Ссылка`). Находит цепочки `<голова>.<сегмент>[.<сегмент>…]` ВНЕ строковых
 * литералов; если голова — известный псевдоним источника, навигирует по метаданным и
 * заменяет КАЖДЫЙ доказуемо резолвимый сегмент на каноническое имя. Сама голова
 * (псевдоним) не трогается; нерезолвимые цепочки и литералы остаются как есть. Это
 * детерминированно и не выдумывает регистр (меняем сегмент лишь при подтверждении
 * метаданными).
 */
function canonExprText(
  expr: string,
  aliasToTable: Map<string, SelectedTable>,
  resolver: MetadataResolver,
): string {
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  let out = '';
  let inStr = false;
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const c = expr[i];
    if (inStr) { out += c; if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    // Начало идентификатора (не часть предыдущего слова, не после точки —
    // т.е. это ГОЛОВА цепочки `<алиас>.<сегменты>`).
    if (/[\p{L}_]/u.test(c) && !isWord(expr[i - 1]) && expr[i - 1] !== '.') {
      let j = i;
      while (j < n && isWord(expr[j])) j++;
      // Накапливаем `.<идентификатор>` цепочки.
      const segs: string[] = [expr.slice(i, j)];
      while (j < n && expr[j] === '.' && j + 1 < n && /[\p{L}_]/u.test(expr[j + 1])) {
        const s = j + 1;
        let e = s;
        while (e < n && isWord(expr[e])) e++;
        segs.push(expr.slice(s, e));
        j = e;
      }
      // За цепочкой не должно идти `(` — это вызов функции, а не ссылка на поле.
      if (segs.length >= 2 && expr[j] !== '(') {
        const head = aliasToTable.get(segs[0].toUpperCase());
        if (head && !head.subquery && head.fullName && !head.fullName.startsWith('&')) {
          const meta = resolver.tableByFullName(head.fullName);
          if (meta) {
            const tailCanon = canonicalizeSegments(meta, segs.slice(1), resolver);
            if (tailCanon) {
              // Перестраиваем цепочку: голова дословно + канонический хвост.
              out += segs[0] + '.' + tailCanon.join('.');
              i = j;
              continue;
            }
          }
        }
      }
      // Не ссылка на известный источник — копируем как есть до конца цепочки.
      out += expr.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Канонизирует путь простой ссылки на поле по голове-источнику (id таблицы). */
function canonPath(
  tableId: string | undefined,
  path: string | undefined,
  idToTable: Map<string, SelectedTable>,
  resolver: MetadataResolver,
): string | undefined {
  if (!tableId || !path) return undefined;
  const src = idToTable.get(tableId);
  if (!src || src.subquery || !src.fullName) return undefined;
  if (src.fullName.startsWith('&')) return undefined;
  const meta = resolver.tableByFullName(src.fullName);
  if (!meta) return undefined;
  const canon = canonicalizeSegments(meta, path.split('.'), resolver);
  return canon ? canon.join('.') : undefined;
}

function canonCondition(
  c: Condition,
  idToTable: Map<string, SelectedTable>,
  aliasToTable: Map<string, SelectedTable>,
  resolver: MetadataResolver,
): void {
  if (c.leftExpr !== undefined) return;
  if (c.custom) {
    // Произвольное условие хранит ПОЛНЫЙ текст выражения — канонизируем сегменты
    // ссылок на поля прямо в нём (по псевдонимам источников). Подзапросы (другой
    // фрейм псевдонимов) обрабатываются своим проходом, текст условия их не несёт.
    if (c.expression !== undefined && !c.subquery) {
      c.expression = canonExprText(c.expression, aliasToTable, resolver);
    }
    return;
  }
  if (c.expression !== undefined) return;
  const np = canonPath(c.tableId, c.path, idToTable, resolver);
  if (np) c.path = np;
}

function canonJoin(
  j: Join,
  idToTable: Map<string, SelectedTable>,
  aliasToTable: Map<string, SelectedTable>,
  resolver: MetadataResolver,
): void {
  // Поконъюнктная форма (фаза 6.13) — рендерится из conditions[]; верхнеуровневые
  // leftPath/rightPath — её зеркало. Канонизируем оба, чтобы охватить обе ветки
  // рендера.
  if (j.custom) {
    if (j.expression !== undefined) j.expression = canonExprText(j.expression, aliasToTable, resolver);
  } else if (j.expression === undefined) {
    const nl = canonPath(j.leftTableId, j.leftPath, idToTable, resolver);
    if (nl) j.leftPath = nl;
    const nr = canonPath(j.rightTableId, j.rightPath, idToTable, resolver);
    if (nr) j.rightPath = nr;
  }
  for (const cc of j.conditions ?? []) {
    if (cc.custom) {
      if (cc.expression !== undefined) cc.expression = canonExprText(cc.expression, aliasToTable, resolver);
      continue;
    }
    if (cc.expression !== undefined) continue;
    const nl = canonPath(cc.leftTableId, cc.leftPath, idToTable, resolver);
    if (nl) cc.leftPath = nl;
    const nr = canonPath(cc.rightTableId, cc.rightPath, idToTable, resolver);
    if (nr) cc.rightPath = nr;
  }
}

function canonField(
  f: SelectedField,
  aliasToTable: Map<string, SelectedTable>,
  resolver: MetadataResolver,
): void {
  if (f.expression !== undefined) return;
  if (!f.qualified) return; // голову-таблицу определяем только у квалифицированного поля
  // Голова поля — псевдоним источника f.tableId; путь f.path целиком из реквизитов.
  const src = [...aliasToTable.values()].find(x => x.id === f.tableId);
  if (!src || src.subquery || !src.fullName) return;
  // Источник-параметр (`&Имя`) или односегментная ВТ — навигацию по метаданным не
  // выводим, регистр сегментов не трогаем.
  if (src.fullName.startsWith('&')) return;
  const meta = resolver.tableByFullName(src.fullName);
  if (!meta) return;
  const segs = f.path.split('.');
  const canon = canonicalizeSegments(meta, segs, resolver);
  if (canon) f.path = canon.join('.');
}

/**
 * Возвращает сегменты с канонизированным регистром, идя от `meta` по ссылочной
 * цепочке. Останавливается (возвращает уже накопленное) на первом нерезолвимом
 * сегменте — оставшиеся берёт как есть. `undefined`, если ничего не изменилось.
 */
function canonicalizeSegments(
  meta: MetaTable,
  segs: string[],
  resolver: MetadataResolver,
): string[] | undefined {
  const out: string[] = [];
  let cur: MetaTable | undefined = meta;
  let changed = false;
  for (let i = 0; i < segs.length; i++) {
    if (!cur) { out.push(...segs.slice(i)); break; }
    const field = findField(cur, segs[i]);
    if (!field) { out.push(...segs.slice(i)); break; }
    if (field.name !== segs[i]) changed = true;
    out.push(field.name);
    if (i === segs.length - 1) break;
    const ref = firstRef(field);
    if (!ref) { out.push(...segs.slice(i + 1)); break; }
    cur = resolver.tableByFullName(`${ref.kind}.${ref.name}`);
  }
  return changed ? out : undefined;
}

function findField(meta: MetaTable, name: string): MetaField | undefined {
  const up = name.toUpperCase();
  return meta.fields.find(f => f.name.toUpperCase() === up);
}

function firstRef(field: MetaField): { kind: string; name: string } | undefined {
  for (const t of field.types) if (t.ref) return t.ref;
  return undefined;
}
