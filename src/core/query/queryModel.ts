import type { QueryDocument } from './unionModel';

export interface VirtualParams {
  period?: string;       // срез РС, Остатки РН
  startPeriod?: string;  // НачалоПериода (Обороты, ОстаткиИОбороты)
  endPeriod?: string;    // КонецПериода
  periodicity?: string;  // Период|Запись|Регистратор|Секунда|…|Авто
  fillMethod?: string;   // Движения|ДвиженияИГраницыПериода (ОстаткиИОбороты)
  condition?: string;
  // регистр бухгалтерии:
  accountCondition?: string;     // УсловиеСчета
  corrAccountCondition?: string; // УсловиеКорСчета (Обороты corr)
  accountDtCondition?: string;   // УсловиеСчетаДт (ОборотыДтКт)
  accountKtCondition?: string;   // УсловиеСчетаКт (ОборотыДтКт)
  order?: string;                // Порядок (ДвиженияССубконто)
  top?: string;                  // Первые (ДвиженияССубконто)
  correspondence?: boolean;      // проброшен из метаданных при добавлении ВТ
}

export interface SelectedTable {
  id: string;
  fullName: string;
  alias?: string;
  virtual?: VirtualParams;
  /** Источник-подзапрос: `ИЗ (<подзапрос>) КАК <alias>`. Если задан — fullName/virtual
   *  игнорируются, источник рендерится как вложенный запрос; alias обязателен, fullName === ''. */
  subquery?: QueryDocument;
}

export interface SelectedField {
  tableId: string;
  path: string;
  alias?: string;
  expression?: string;
}

export interface SelectedTabSectionField {
  tableId: string;
  tsName: string;
  tsFullName: string;
  fields: string[];
}

export type AggregateFunction =
  | 'Сумма' | 'Количество' | 'КоличествоРазличных'
  | 'Максимум' | 'Минимум' | 'Среднее';

export interface FieldRef {
  tableId: string;
  path: string;
}

export interface SummableField extends FieldRef {
  func: AggregateFunction;
}

export interface Grouping {
  /** «Использовать несколько группировок». */
  multiple: boolean;
  /** Поля группировки (режим single), в порядке добавления. */
  groupFields: FieldRef[];
  /** Наборы группировки (режим multiple=true). */
  groupSets: FieldRef[][];
  /** Суммируемые поля с функцией агрегирования. */
  aggregates: SummableField[];
}

export type ConditionOperator = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'В' | 'МЕЖДУ' | 'ПОДОБНО';

export interface Condition {
  /** «П.» — произвольное выражение (а не простое условие поле/оператор/параметр). */
  custom: boolean;
  /** Простое условие: таблица поля. */
  tableId?: string;
  /** Простое условие: путь к полю. */
  path?: string;
  /** Оператор сравнения, по умолчанию '='. */
  operator?: ConditionOperator;
  /** Параметр, по умолчанию '&<ПоследнийСегментПути>'. */
  param?: string;
  /** Произвольное условие — полный текст выражения. */
  expression?: string;
}

/** Тип итогов группировочного поля. */
export type TotalKind = 'elements' | 'hierarchy' | 'onlyHierarchy';

export interface TotalGroupField {
  tableId: string;
  path: string;
  /** elements → нет; hierarchy → ИЕРАРХИЯ; onlyHierarchy → ТОЛЬКО ИЕРАРХИЯ. */
  kind: TotalKind;
  /** Псевдоним группировки (КАК …), опционально. */
  alias?: string;
}

export interface TotalField {
  tableId: string;
  path: string;
  /** Выражение агрегата; по умолчанию СУММА(<псевдоним>). */
  expression?: string;
}

export interface Totals {
  groupFields: TotalGroupField[];
  totalFields: TotalField[];
  /** «Общие итоги» → ОБЩИЕ первым элементом списка ПО. */
  grand: boolean;
}

/** Один индекс временной таблицы. Имя («Индекс N») производное от позиции, не хранится. */
export interface QueryIndex {
  /** Колонка «Уникальный» — индекс содержит только уникальные записи. */
  unique: boolean;
  /** Поля индекса в порядке; адресуются по (tableId, path), как Order/Totals. */
  fields: FieldRef[];
}

export interface Indexing {
  indexes: QueryIndex[];
}

/** Строка построителя: ссылка на поле + «использовать дочерние» (.*) + псевдоним. */
export interface BuilderField {
  /** Готовый текст ссылки: псевдоним выборки (Поля/Порядок/Итоги) или Алиас.Поле (Условия, «Все поля»). */
  ref: string;
  /** «Использовать дочерние» → суффикс `.*`. */
  child: boolean;
  /** Необязательный псевдоним → ` КАК <alias>`. */
  alias?: string;
}

export interface ReportBuilder {
  fields: BuilderField[];     // {ВЫБРАТЬ …}
  conditions: BuilderField[]; // {ГДЕ …}
  order: BuilderField[];      // {УПОРЯДОЧИТЬ ПО …}
  totals: BuilderField[];     // {ИТОГИ ПО …}
}

export type SortDirection = 'asc' | 'desc';

export interface OrderField {
  tableId: string;
  path: string;
  /** asc → без суффикса; desc → УБЫВ. */
  direction: SortDirection;
  /**
   * Поле задано как `<псевдонимТаблицы>.<path>` (ссылка на поле таблицы) — генератор
   * выводит его квалифицированно `Псевдоним.path`, как конструктор 1С. Если не задано,
   * поле адресуется по псевдониму выборки (вычисляемые колонки).
   */
  qualified?: boolean;
}

export interface Order {
  fields: OrderField[];
  /** «Автоупорядочивание» → ключевое слово АВТОУПОРЯДОЧИВАНИЕ. */
  auto: boolean;
}

/** Вид соединения после нормализации (правое сводится к левому перестановкой). */
export type JoinKind = 'inner' | 'left' | 'full';

export interface Join {
  /** Таблица 1 (слева в UI). */
  leftTableId: string;
  /** Таблица 2 (справа в UI). */
  rightTableId: string;
  /** «Все» у таблицы 1 — все элементы таблицы 1 сохраняются. */
  leftAll: boolean;
  /** «Все» у таблицы 2 — все элементы таблицы 2 сохраняются. */
  rightAll: boolean;
  /** «П.» — произвольное условие связи. */
  custom: boolean;
  /** Простое условие: поле таблицы 1. */
  leftPath?: string;
  /** Оператор сравнения, по умолчанию '='. */
  operator?: ConditionOperator;
  /** Простое условие: поле таблицы 2. */
  rightPath?: string;
  /** Произвольное условие — полный текст выражения. */
  expression?: string;
  /**
   * Разработчик во ВВОДЕ обернул всё условие `ПО` в одну сбалансированную внешнюю
   * пару скобок (`ПО (a = b)`). Конструктор 1С сохраняет это решение, поэтому флаг
   * управляет внешними скобками одиночного условия при рендере (фаза 6.12). НЕ
   * относится к составным условиям с верхнеуровневым И/ИЛИ (там скобки вокруг
   * подконъюнктов, а не вокруг всего выражения).
   */
  parenthesized?: boolean;
}

/** Модификаторы выборки записей (ВЫБРАТЬ ...). */
export interface Selection {
  /** ПЕРВЫЕ N — ограничение количества первых записей. */
  top?: number;
  /** РАЗЛИЧНЫЕ — без повторяющихся. */
  distinct?: boolean;
  /** РАЗРЕШЕННЫЕ — только разрешённые данные. */
  allowed?: boolean;
}

/** Тип запроса: обычная выборка или работа с временной таблицей. */
export type QueryType = 'select' | 'createTemp' | 'appendTemp' | 'dropTemp';

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
  tabSectionFields?: SelectedTabSectionField[];
  /** Поля, которые должны быть отрисованы ПОСЛЕ табличных частей (Предопределенный, ИмяПредопределенныхДанных). */
  trailingFields?: SelectedField[];
  grouping?: Grouping;
  /** Условия отбора (секция ГДЕ). */
  conditions?: Condition[];
  /** Условия отбора по агрегатам после группировки (секция ИМЕЮЩИЕ). */
  having?: Condition[];
  /** Соединения между таблицами (секция ИЗ). */
  joins?: Join[];
  /** Модификаторы выборки записей (ПЕРВЫЕ/РАЗЛИЧНЫЕ/РАЗРЕШЕННЫЕ). */
  selection?: Selection;
  /** Тип запроса (по умолчанию обычная выборка). */
  queryType?: QueryType;
  /** Имя временной таблицы для ПОМЕСТИТЬ/ДОБАВИТЬ/УНИЧТОЖИТЬ. */
  tempTableName?: string;
  /** Таблицы для секции ДЛЯ ИЗМЕНЕНИЯ (полные имена). */
  lockForUpdate?: string[];
  /** Порядок сортировки (секция УПОРЯДОЧИТЬ ПО / АВТОУПОРЯДОЧИВАНИЕ). */
  order?: Order;
  /** Итоги (секция ИТОГИ … ПО …). */
  totals?: Totals;
  /** Построитель отчётов: динамические блоки {…}. */
  builder?: ReportBuilder;
  /** Индексы временной таблицы (секция ИНДЕКСИРОВАТЬ ПО / ПО НАБОРАМ). */
  indexing?: Indexing;
}

/**
 * Псевдоним по умолчанию для таблицы выборки. Явный `alias` имеет приоритет.
 * Для всех таблиц (реальных и виртуальных) возвращает имя объекта — 2-й
 * сегмент `fullName`. Конкатенация имени объекта с видом ВТ (например,
 * `ИмяСрезПоследних`) была убрана: 1С использует только имя объекта.
 * Используется и генератором SDBL, и webview (списки полей), чтобы префиксы
 * полей совпадали с псевдонимом в тексте запроса.
 */
export function defaultTableAlias(t: SelectedTable): string {
  if (t.alias) return t.alias;
  const parts = t.fullName.split('.');
  // Виртуальная таблица (Тип.Имя.ВТ): псевдоним по умолчанию в 1С — склейка имени
  // таблицы и имени ВТ без разделителя, напр. АрхивСообщенийОбменовСрезПоследних.
  if (parts.length > 2) return parts[1] + parts.slice(2).join('');
  return parts[1] ?? t.fullName;
}
