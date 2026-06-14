import type { QueryModel, SelectedField, SelectedTabSectionField } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import { buildSelectAllModel } from './buildSelectAllModel';

/**
 * Развёртка `*` в списке выборки по метаданным (фаза 6.15.15).
 *
 * Конструктор 1С разворачивает звёздные поля выборки в ПОЛНЫЙ список колонок
 * таблицы:
 *   - `ВЫБРАТЬ *`            — звезда без префикса (единственный источник);
 *   - `Таблица.* КАК ПолеN`  — звезда с префиксом-псевдонимом источника.
 * Состав колонок берётся из `buildSelectAllModel` (тот же порядок, что у
 * конструктора: основные поля → табличные части → завершающие стандартные).
 *
 * Правила, выведенные по корпусу/оракулу:
 *  1. Источник-параметр (`&Имя`), временная таблица (`#Имя`) или таблица без
 *     метаданных — звезда НЕ разворачивается, а УДАЛЯЕТСЯ (раскрывается в ноль
 *     колонок). Если после удаления полей не осталось — весь запрос пуст.
 *  2. Поля вокруг звезды сохраняются на своих позициях; всё, что в исходном
 *     тексте идёт ПОСЛЕ звезды, выводится после завершающих полей развёртки
 *     (генератор печатает fields → табличные части → trailingFields).
 *  3. Дедуп псевдонимов: если псевдоним развёрнутой колонки уже занят явным
 *     полем выборки (или ранее развёрнутой колонкой), к нему добавляется числовой
 *     суффикс (`Наименование` → `Наименование1`). Явные поля приоритетнее.
 *
 * `Таблица.Поле.*` (звезда по реквизиту-ссылке) и звезда по неизвестному
 * псевдониму трактуются как неразрешимые — удаляются (правило 1). В корпусе таких
 * случаев нет; развёртка по типу реквизита потребовала бы обхода ссылок.
 */
export function expandStarFields(model: QueryModel, resolver?: MetadataResolver): void {
  // Без резолвера развёртка не выполняется: поведение прежнее (звезда остаётся
  // произвольным полем `* КАК ПолеN`). Так слой webview/extension без метаданных
  // не меняет вывод; развёртка включается только когда резолвер передан (приёмка).
  if (!resolver) return;
  // Объединение и прочие участники обрабатываются вызывающим по отдельности —
  // здесь работаем с одним QueryModel.
  if (!hasStar(model.fields)) return;

  // Псевдоним → fullName источника (регистронезависимо, как везде в 1С).
  const aliasToFull = new Map<string, string>();
  let soleFull: string | undefined;
  if (model.tables.length === 1 && !model.tables[0].subquery) {
    soleFull = model.tables[0].fullName;
  }
  for (const t of model.tables) {
    if (t.alias && !t.subquery) aliasToFull.set(t.alias.toUpperCase(), t.fullName);
  }

  // Зарезервированные псевдонимы — все ЯВНЫЕ (не-звёздные) поля выборки.
  // Конструктор переименовывает именно развёрнутую колонку при коллизии, явное
  // поле сохраняет свой псевдоним.
  const reserved = new Set<string>();
  for (const f of model.fields) {
    if (parseStar(f)) continue;
    const a = fieldAlias(f, model);
    if (a) reserved.add(a.toUpperCase());
  }

  const newFields: SelectedField[] = [];
  // Поля, выводимые после звёздной развёртки (табличные части + завершающие
  // стандартные + всё, что в тексте идёт после звезды). Накапливаются как только
  // встретилась хоть одна развёрнутая звезда.
  const tabSections: SelectedTabSectionField[] = [...(model.tabSectionFields ?? [])];
  const trailing: SelectedField[] = [];
  let sawExpandedStar = false;

  const pushAfter = (f: SelectedField): void => {
    if (sawExpandedStar) trailing.push(f);
    else newFields.push(f);
  };

  // Развёртка звезды по ОДНОМУ источнику (`<alias>.*` или один из источников голой
  // `*`): добавляет колонки/ТЧ/завершающие в накопители. Возвращает true, если
  // источник разрешён и хоть что-то развёрнуто (нужно для пометки sawExpandedStar).
  const expandOne = (fullName: string | undefined, tableId: string | undefined): boolean => {
    const meta = fullName ? resolver.tableByFullName(fullName) : undefined;
    if (!meta || tableId === undefined) return false;
    const expanded = buildSelectAllModel(meta);
    for (const ef of expanded.fields) newFields.push(makeField(ef, tableId, reserved));
    for (const ts of expanded.tabSectionFields ?? []) tabSections.push({ ...ts, tableId });
    for (const ef of expanded.trailingFields ?? []) trailing.push(makeField(ef, tableId, reserved));
    return true;
  };

  for (const f of model.fields) {
    const star = parseStar(f);
    if (!star) { pushAfter(f); continue; }

    // Звезда по реквизиту-ссылке (`alias.field.*`) неразрешима — удаляем (правило 1).
    if (star.viaAttribute) continue;

    if (star.alias) {
      // `<alias>.*` — разворачиваем единственный источник этого псевдонима.
      const fullName = aliasToFull.get(star.alias.toUpperCase());
      if (expandOne(fullName, findTableId(model, star.alias))) sawExpandedStar = true;
      continue;
    }

    // Голая `*` — конструктор разворачивает ВСЕ источники секции ИЗ по порядку
    // (MCP-проба: `* ИЗ ВТ КАК А ЛЕВОЕ СОЕДИНЕНИЕ ВТ КАК Б` → колонки А, затем Б
    // с дедуп-суффиксом). Единственный источник — частный случай. Если ни один
    // источник не разрешился (все параметры/нет метаданных) — звезда удаляется.
    if (soleFull !== undefined) {
      if (expandOne(soleFull, model.tables[0]?.id)) sawExpandedStar = true;
      continue;
    }
    for (const t of model.tables) {
      if (t.subquery) continue;
      if (expandOne(t.fullName, t.id)) sawExpandedStar = true;
    }
  }

  model.fields = newFields;
  if (tabSections.length) model.tabSectionFields = tabSections;
  if (trailing.length) {
    model.trailingFields = [...trailing, ...(model.trailingFields ?? [])];
  }
}

/** Создаёт развёрнутое поле с дедупом псевдонима против `reserved`. */
function makeField(src: SelectedField, tableId: string, reserved: Set<string>): SelectedField {
  const base = src.alias ?? src.path;
  let alias = base;
  let n = 0;
  while (reserved.has(alias.toUpperCase())) {
    alias = `${base}${++n}`;
  }
  reserved.add(alias.toUpperCase());
  return { tableId, path: src.path, alias };
}

function hasStar(fields: SelectedField[]): boolean {
  return fields.some(f => parseStar(f) !== null);
}

interface StarInfo {
  /** Префикс-псевдоним источника (`Таблица.*`); undefined — голая `*`. */
  alias?: string;
  /** Звезда по реквизиту-ссылке (`Таблица.Поле.*`) — неразрешима. */
  viaAttribute: boolean;
}

/**
 * Распознаёт звёздное поле выборки. Звезда хранится в модели как произвольное
 * выражение (`expression`): `*`, `Алиас.*`, `Алиас.Поле.*`. Возвращает null,
 * если поле не звёздное.
 */
function parseStar(f: SelectedField): StarInfo | null {
  if (f.expression === undefined) return null;
  const e = f.expression.trim();
  if (e === '*') return { viaAttribute: false };
  // <head>(.<seg>)*.* — последний сегмент «*».
  if (!e.endsWith('*')) return null;
  const segs = e.split('.').map(s => s.trim());
  if (segs.length < 2 || segs[segs.length - 1] !== '*') return null;
  // Любой сегмент кроме последнего — идентификатор (без пробелов/скобок).
  const head = segs.slice(0, -1);
  if (head.some(s => s === '' || /[^\wА-Яа-яЁё]/.test(s))) return null;
  return { alias: head[0], viaAttribute: head.length > 1 };
}

/** Псевдоним (или авто-псевдоним) явного поля для резервирования. */
function fieldAlias(f: SelectedField): string | undefined {
  if (f.alias !== undefined) return f.alias;
  if (f.expression !== undefined) return undefined; // авто `ПолеN` назначится позже
  return f.path.split('.').pop() ?? f.path;
}

function findTableId(model: QueryModel, alias: string): string | undefined {
  const up = alias.toUpperCase();
  return model.tables.find(t => t.alias?.toUpperCase() === up)?.id;
}
