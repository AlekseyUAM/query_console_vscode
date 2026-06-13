import type { QueryModel, Condition } from './queryModel';
import type { MetadataResolver } from './metadataResolver';

/**
 * Тихий дроп конъюнкта ГДЕ, навигирующего через ссылку на пользователя к
 * «идентификационным» реквизитам ИБ (фаза 6.15.23).
 *
 * Конструктор 1С МОЛЧА удаляет условие отбора вида
 *   `<Алиас>.<СсылочноеПоле>.<СпециальныйРеквизит> <оператор> …`
 * где `<СсылочноеПоле>` — реквизит таблицы-источника с типом
 * `Справочник.Пользователи`/`Справочник.ВнешниеПользователи`, а
 * `<СпециальныйРеквизит>` — один из непригодных к навигации реквизитов
 * идентификации пользователя в ИБ:
 *   ИдентификаторПользователяИБ, ИдентификаторПользователяСервиса,
 *   УдалитьСвойстваПользователяИБ.
 *
 * Поведение подтверждено живым оракулом (mcp validate_query):
 *  - прямое обращение `Пользователи.ИдентификаторПользователяИБ` — СОХРАНЯЕТСЯ;
 *  - навигация `Автор.ИдентификаторПользователяИБ` (Автор → Пользователи) —
 *    УДАЛЯЕТСЯ, даже будучи единственным/первым конъюнктом;
 *  - навигация к ОБЫЧНОМУ реквизиту (`Автор.Наименование`) — сохраняется;
 *  - навигация через поле БЕЗ такого реквизита (`Отчет.ИдентификаторПользователяИБ`)
 *    — ошибка «поле не найдено» (тут не наступает: проверяем тип ссылки).
 *
 * Без резолвера дроп не выполняется (поведение прежнее). Различить эти реквизиты
 * по доступным метаданным иначе нельзя (загрузчик YAML не несёт их типы), поэтому
 * список имён фиксирован — это платформенные служебные реквизиты Пользователей.
 */
const USER_IB_ATTRS = new Set<string>([
  'ИДЕНТИФИКАТОРПОЛЬЗОВАТЕЛЯИБ',
  'ИДЕНТИФИКАТОРПОЛЬЗОВАТЕЛЯСЕРВИСА',
  'УДАЛИТЬСВОЙСТВАПОЛЬЗОВАТЕЛЯИБ',
]);

const USER_REF_TABLES = new Set<string>([
  'СПРАВОЧНИК.ПОЛЬЗОВАТЕЛИ',
  'СПРАВОЧНИК.ВНЕШНИЕПОЛЬЗОВАТЕЛИ',
]);

export function dropUserIBConditions(model: QueryModel, resolver?: MetadataResolver): void {
  if (!resolver) return;
  if (!model.conditions || model.conditions.length === 0) return;

  // id таблицы → fullName (исключая подзапросы).
  const idToFull = new Map<string, string>();
  for (const t of model.tables) {
    if (!t.subquery) idToFull.set(t.id, t.fullName);
  }

  const isUserNavDrop = (c: Condition): boolean => {
    if (c.custom) return false;            // только структурные условия
    if (!c.path || c.tableId === undefined) return false;
    const segs = c.path.split('.');
    if (segs.length !== 2) return false;   // ровно `СсылочноеПоле.Реквизит`
    if (!USER_IB_ATTRS.has(segs[1].toUpperCase())) return false;
    const full = idToFull.get(c.tableId);
    if (!full) return false;
    const meta = resolver.tableByFullName(full);
    if (!meta) return false;
    const field = meta.fields.find(f => f.name.toUpperCase() === segs[0].toUpperCase());
    if (!field) return false;
    // Тип ссылочного поля должен указывать на (Внешние)Пользователей.
    return field.types.some(t =>
      t.ref !== undefined && USER_REF_TABLES.has(`${t.ref.kind}.${t.ref.name}`.toUpperCase())
    );
  };

  const kept = model.conditions.filter(c => !isUserNavDrop(c));
  if (kept.length === model.conditions.length) return;
  if (kept.length === 0) delete model.conditions;
  else model.conditions = kept;
}
