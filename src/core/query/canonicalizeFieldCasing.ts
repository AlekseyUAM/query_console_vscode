import type { QueryModel, SelectedField, SelectedTable } from './queryModel';
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
  for (const t of model.tables) {
    if (t.alias) aliasToTable.set(t.alias.toUpperCase(), t);
  }
  for (const f of model.fields) {
    canonField(f, aliasToTable, resolver);
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
