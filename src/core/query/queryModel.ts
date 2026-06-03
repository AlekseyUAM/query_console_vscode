export interface VirtualParams {
  period?: string;       // срез РС, Остатки РН
  startPeriod?: string;  // НачалоПериода (Обороты, ОстаткиИОбороты)
  endPeriod?: string;    // КонецПериода
  periodicity?: string;  // Период|Запись|Регистратор|Секунда|…|Авто
  fillMethod?: string;   // Движения|ДвиженияИГраницыПериода (ОстаткиИОбороты)
  condition?: string;
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
 * Для виртуальной таблицы-среза с трёхсегментным fullName
 * (`РегистрСведений.Имя.СрезПоследних`) склеивает 2-й и 3-й сегменты
 * (`ИмяСрезПоследних`); иначе — 2-й сегмент (имя объекта).
 * Используется и генератором SDBL, и webview (списки полей), чтобы префиксы
 * полей совпадали с псевдонимом в тексте запроса.
 */
export function defaultTableAlias(t: SelectedTable): string {
  if (t.alias) return t.alias;
  const parts = t.fullName.split('.');
  if (t.virtual && parts.length >= 3) return parts[1] + parts[2];
  return parts[1] ?? t.fullName;
}
