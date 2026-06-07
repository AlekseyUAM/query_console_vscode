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

export interface QueryModel {
  tables: SelectedTable[];
  fields: SelectedField[];
  tabSectionFields?: SelectedTabSectionField[];
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
  return parts[1] ?? t.fullName;
}
