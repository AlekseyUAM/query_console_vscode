import type { MetaField } from '../metadata/types';

/** Значения параметра `Периодичность` ВТ Обороты/ОстаткиИОбороты (порядок — как в конструкторе 1С). */
export const PERIODICITY_VALUES = [
  'Период', 'Запись', 'Регистратор',
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год',
  'Декада', 'Полугодие', 'Авто',
] as const;

/** Значения параметра `МетодДополнения` ВТ ОстаткиИОбороты. */
export const FILL_METHOD_VALUES = ['Движения', 'ДвиженияИГраницыПериода'] as const;

const date = (name: string): MetaField => ({ name, kind: 'standard', types: [{ primitive: 'Дата' }] });
const num = (name: string): MetaField => ({ name, kind: 'standard', types: [{ primitive: 'Число' }] });
const recorder = (): MetaField => ({ name: 'Регистратор', kind: 'standard', types: [{}] });

const TIME_UNITS: ReadonlySet<string> = new Set([
  'Секунда', 'Минута', 'Час', 'День', 'Неделя', 'Месяц', 'Квартал', 'Год', 'Декада', 'Полугодие',
]);

/**
 * Период-зависимые поля виртуальных таблиц Обороты/ОстаткиИОбороты по выбранной
 * периодичности. Прибавляются к измерениям/развёрнутым ресурсам на слое webview.
 * Для пустого значения и `Период` дополнительных полей нет.
 */
export function accumPeriodFields(periodicity: string | undefined): MetaField[] {
  if (!periodicity) return [];
  if (periodicity === 'Запись') return [date('Период'), recorder(), num('НомерСтроки')];
  if (periodicity === 'Регистратор') return [date('Период'), recorder()];
  if (TIME_UNITS.has(periodicity)) return [date('Период')];
  if (periodicity === 'Авто') {
    return [
      date('ПериодСекунда'), date('ПериодМинута'), date('ПериодЧас'), date('ПериодДень'),
      date('ПериодНеделя'), date('ПериодДекада'), date('ПериодМесяц'), date('ПериодКвартал'),
      date('ПериодПолугодие'), date('ПериодГод'), recorder(), num('НомерСтроки'),
    ];
  }
  return []; // 'Период' и неизвестные значения
}
