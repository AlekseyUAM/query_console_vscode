import type { QueryModel, Condition, ConditionOperator } from './queryModel';
import type { MetadataResolver } from './metadataResolver';
import type { MetaField, MetaType } from '../metadata/types';

/**
 * Тихий дроп конъюнкта ГДЕ, сравнивающего ПОЛЕ НЕОГРАНИЧЕННОЙ ДЛИНЫ оператором,
 * который платформа 1С на таких полях не поддерживает (фаза 6.17).
 *
 * Поведение подтверждено живым оракулом (mcp validate_query):
 *  - поле типа `Строка` неограниченной длины (length 0, allowedLength Variable):
 *      `=`, `<>`, `>`, `<`, `>=`, `<=`, `МЕЖДУ` — МОЛЧА удаляются;
 *      `ПОДОБНО`, `ЕСТЬ NULL` — сохраняются; `В (…)` — это ОШИБКА (не дроп);
 *  - поле составного типа (несколько типов, среди которых есть нестроковый):
 *      `ПОДОБНО` — МОЛЧА удаляется (сравнение строкой невозможно по всему составу),
 *      тогда как `=`/`<>` по составному типу СОХРАНЯЮТСЯ.
 *
 * Дроп выполняется только для простых структурных условий `<алиас>.<реквизит>
 * <оператор> …`, где `<реквизит>` — реквизит таблицы-источника (одно-сегментный
 * путь). Без резолвера дроп не выполняется (поведение прежнее).
 */

// Операторы сравнения/упорядочения, недопустимые на полях неограниченной длины.
const UNLIMITED_DROP_OPS = new Set<ConditionOperator>(['=', '<>', '>', '<', '>=', '<=', 'МЕЖДУ']);

function isUnlimitedString(t: MetaType): boolean {
  return t.primitive === 'Строка' && t.allowedLength === 'Variable' && t.length === 0;
}

function isStringType(t: MetaType): boolean {
  return t.primitive === 'Строка';
}

/** Поле — единственный неограниченный строковый тип. */
function isUnlimitedStringField(field: MetaField): boolean {
  return field.types.length === 1 && isUnlimitedString(field.types[0]);
}

/** Поле — составной тип (≥2 типа), среди которых есть нестроковый. */
function isCompositeWithNonString(field: MetaField): boolean {
  return field.types.length >= 2 && field.types.some(t => !isStringType(t));
}

export function dropUnlimitedStringConditions(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  if (!model.conditions || model.conditions.length === 0) return;

  const idToFull = new Map<string, string>();
  for (const t of model.tables) {
    if (!t.subquery) idToFull.set(t.id, t.fullName);
  }

  const fieldOf = (c: Condition): MetaField | undefined => {
    if (c.custom || !c.path || c.tableId === undefined || !c.operator) return undefined;
    // Только прямой реквизит источника (одно-сегментный путь, без навигации).
    if (c.path.includes('.')) return undefined;
    const full = idToFull.get(c.tableId);
    if (!full) return undefined;
    const meta = resolver.tableByFullName(full);
    if (!meta) return undefined;
    return meta.fields.find(f => f.name.toUpperCase() === c.path!.toUpperCase());
  };

  const shouldDrop = (c: Condition): boolean => {
    const field = fieldOf(c);
    if (!field) return false;
    const op = c.operator!;
    // Подзапрос `В (…)` сюда не попадает (operator='В' исключён ниже + subquery).
    if (c.subquery) return false;
    if (op === 'ПОДОБНО') {
      return isCompositeWithNonString(field);
    }
    if (UNLIMITED_DROP_OPS.has(op)) {
      return isUnlimitedStringField(field);
    }
    return false;
  };

  const kept = model.conditions.filter(c => !shouldDrop(c));
  if (kept.length === model.conditions.length) return;
  if (kept.length === 0) delete model.conditions;
  else model.conditions = kept;
}
