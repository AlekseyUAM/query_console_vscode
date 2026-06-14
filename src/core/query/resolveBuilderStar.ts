import type { QueryModel, SelectedField, SelectedTable } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaTable, MetaField } from '../metadata/types';

/**
 * Суффикс `.*` («использовать дочерние») в блоках построителя `{ВЫБРАТЬ}`/`{ГДЕ}`/
 * `{УПОРЯДОЧИТЬ}`/`{ИТОГИ}` конструктор 1С сохраняет, пока поле может быть ссылкой
 * на объект (чьи реквизиты разворачивает СКД). Суффикс ОТБРАСЫВАЕТСЯ, когда поле
 * заведомо НЕ ссылочное.
 *
 * Поведение подтверждено живым оракулом (mcp validate_query):
 *  - `Т.Ссылка.* КАК А` (Ссылка — ссылочное) — `.*` СОХРАНЯЕТСЯ (с псевдонимом и
 *    без; и в `{ВЫБРАТЬ}`, и в `{ГДЕ}`);
 *  - `Т.Код.* КАК А` (Код — строка) — `.*` ОТБРАСЫВАЕТСЯ;
 *  - источник-параметр `&ИмяТаблицы` (поле нерезолвимо в принципе) — ОТБРАСЫВАЕТСЯ
 *    (корпус: КонвертацияОбъектовИнформационныхБаз bsl_5).
 *
 * Суффикс снимается ТОЛЬКО когда нессылочность ДОКАЗАНА: поле резолвится по
 * метаданным в нессылочный тип (`Код` — строка) ЛИБО источник — параметр `&Имя`
 * (поле нерезолвимо в принципе, корпус: КонвертацияОбъектов bsl_5). При любой иной
 * неопределённости (пробел в метаданных, нерезолвимая ВТ/представление/регистр)
 * `.*` СОХРАНЯЕТСЯ — чтобы неполнота YAML-метаданных не роняла корректные суффиксы
 * (register-измерения `Регистр.Организация.*` сохраняются). Без резолвера флаг не
 * трогаем (поведение webview/extension без метаданных прежнее, как у
 * `expandStarFields`).
 */
export function resolveBuilderStar(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  if (!model.builder) return;

  const ctx = new ResolveCtx(model, resolver);
  for (const group of [model.builder.fields, model.builder.conditions, model.builder.order, model.builder.totals]) {
    for (const f of group) {
      if (!f.child) continue;
      // Скобочная форма `(выражение).*` (condition): тип выражения по метаданным
      // не выводим — `.*` оставляем (корпус: ЕСТЬNULL(…).*, ЗНАЧЕНИЕ(…).*).
      if (f.condition) continue;
      const cls = ctx.classify(f.ref);
      if (cls === 'scalar' || cls === 'parameter') f.child = false;
    }
  }
}

/** Резолвер цепочки ссылки `Голова.Сегмент…` для решения о суффиксе `.*`. */
class ResolveCtx {
  private aliasToTable = new Map<string, SelectedTable>();
  private selectAlias = new Map<string, SelectedField>();

  constructor(private model: QueryModel, private resolver: MetadataResolver) {
    for (const t of model.tables) {
      if (t.alias) this.aliasToTable.set(t.alias.toUpperCase(), t);
    }
    for (const f of model.fields) {
      const a = f.alias ?? f.path;
      if (a) this.selectAlias.set(a.toUpperCase(), f);
    }
  }

  /**
   * true — ссылка `ref` ДОКАЗУЕМО резолвится в ссылочное поле (суффикс `.*`
   * сохраняется). При любой неопределённости (нерезолвимый источник/поле) — false.
   */
  /**
   * Решение о суффиксе `.*` для простой ссылки построителя. Возвращает:
   *  - 'reference'    — цепочка ДОКАЗУЕМО резолвится в ссылочное поле → сохранить;
   *  - 'scalar'       — цепочка резолвится в НЕссылочное поле → снять;
   *  - 'parameter'    — источник-параметр `&Имя` → снять (поле нерезолвимо в принципе);
   *  - 'unknown'      — нерезолвимо по иным причинам (ВТ/представление/пробел в
   *                     метаданных) → консервативно сохранить.
   * Снимаем `.*` только при ДОКАЗАННОЙ нессылочности либо источнике-параметре —
   * чтобы пробелы метаданных (нерезолвимые ВТ/регистры) не роняли корректные `.*`.
   */
  classify(ref: string): 'reference' | 'scalar' | 'parameter' | 'unknown' {
    const segs = ref.split('.');
    if (segs.length === 0) return 'unknown';
    const head = segs[0].toUpperCase();

    const t = this.aliasToTable.get(head);
    if (t) {
      if (t.subquery) {
        const sub = t.subquery.members[0]?.model;
        return sub ? this.fromSubquery(sub, segs.slice(1)) : 'unknown';
      }
      if (t.fullName.startsWith('&')) return 'parameter';
      const meta = this.metaFor(t.fullName);
      return meta ? this.walk(meta, segs.slice(1)) : 'unknown';
    }

    // Голая голова — псевдоним поля выборки этого же запроса (форма `{ВЫБРАТЬ}`).
    const sel = this.selectAlias.get(head);
    if (sel && !sel.expression) {
      return this.fromSelectField(sel, segs.slice(1));
    }
    return 'unknown';
  }

  private fromSelectField(sel: SelectedField, rest: string[]): 'reference' | 'scalar' | 'parameter' | 'unknown' {
    const src = this.model.tables.find(x => x.id === sel.tableId);
    if (!src) return 'unknown';
    if (src.subquery) {
      const sub = src.subquery.members[0]?.model;
      return sub ? this.fromSubquery(sub, [...sel.path.split('.'), ...rest]) : 'unknown';
    }
    if (src.fullName.startsWith('&')) return 'parameter';
    const meta = this.metaFor(src.fullName);
    return meta ? this.walk(meta, [...sel.path.split('.'), ...rest]) : 'unknown';
  }

  /** Резолв сегментов относительно выходных полей подзапроса. */
  private fromSubquery(subModel: QueryModel, segs: string[]): 'reference' | 'scalar' | 'parameter' | 'unknown' {
    if (segs.length === 0) return 'unknown';
    const ctx = new ResolveCtx(subModel, this.resolver);
    const out = ctx.selectAlias.get(segs[0].toUpperCase());
    if (!out || out.expression) return 'unknown';
    return ctx.fromSelectField(out, segs.slice(1));
  }

  /** Идёт по сегментам от таблицы через ссылочные поля до финального типа. */
  private walk(meta: MetaTable, segs: string[]): 'reference' | 'scalar' | 'unknown' {
    if (segs.length === 0) return hasReference(meta) ? 'reference' : 'scalar';
    let cur: MetaTable | undefined = meta;
    for (let i = 0; i < segs.length; i++) {
      if (!cur) return 'unknown';
      const field = findField(cur, segs[i]);
      if (!field) return 'unknown';
      const ref = firstRef(field);
      if (i === segs.length - 1) return ref !== undefined ? 'reference' : 'scalar';
      if (!ref) return 'scalar';         // навигация через нессылочное — невозможна
      cur = this.resolver.tableByFullName(`${ref.kind}.${ref.name}`);
    }
    return 'unknown';
  }

  /** Метаданные таблицы по fullName с учётом среза виртуальной таблицы регистра. */
  private metaFor(fullName: string): MetaTable | undefined {
    const direct = this.resolver.tableByFullName(fullName);
    if (direct) return direct;
    // `РегистрX.Имя.СрезПоследних|Остатки|Обороты|…` → базовый регистр.
    const m = fullName.match(/^(Регистр\p{L}+\.[^.]+)\.\p{L}+$/u);
    return m ? this.resolver.tableByFullName(m[1]) : undefined;
  }
}

function findField(meta: MetaTable, name: string): MetaField | undefined {
  const up = name.toUpperCase();
  return meta.fields.find(f => f.name.toUpperCase() === up);
}

function firstRef(field: MetaField): { kind: string; name: string } | undefined {
  for (const t of field.types) if (t.ref) return t.ref;
  return undefined;
}

function hasReference(meta: MetaTable): boolean {
  const ssylka = findField(meta, 'Ссылка');
  return ssylka !== undefined && firstRef(ssylka) !== undefined;
}
