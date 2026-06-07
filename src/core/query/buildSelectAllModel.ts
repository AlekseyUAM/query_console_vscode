import type { MetaTable } from '../metadata/types';
import type { QueryModel, SelectedField, SelectedTabSectionField } from './queryModel';
import { accumPeriodFields } from './accumVirtualFields';

/** Стандартные поля, которые 1С переносит в конец (после табличных частей). */
const TRAILING_STD = ['Предопределенный', 'ИмяПредопределенныхДанных'];

/**
 * Разбивает поля реального объекта на «основные» и «завершающие».
 * Порядок по конструктору 1С:
 *   основные = [стандартные, кроме TRAILING_STD] + [нестандартные (атрибуты, …)]
 *   завершающие = [TRAILING_STD] — идут ПОСЛЕ табличных частей
 */
function splitRealObjectFields(t: MetaTable): { main: SelectedField[]; trailing: SelectedField[] } {
  const std = t.fields.filter(f => f.kind === 'standard' && !TRAILING_STD.includes(f.name));
  const trailingMeta = t.fields.filter(f => f.kind === 'standard' && TRAILING_STD.includes(f.name));
  const rest = t.fields.filter(f => f.kind !== 'standard');
  const toField = (f: { name: string }) => ({ tableId: 't1', path: f.name, alias: f.name });
  return {
    main: [...std, ...rest].map(toField),
    trailing: trailingMeta.map(toField),
  };
}

/**
 * Строит список полей для виртуальной таблицы РегистраНакопления
 * (Остатки / Обороты / ОстаткиИОбороты):
 *   измерения + период-поля (если нужны) + ресурсы.
 */
function accumVtFields(t: MetaTable, periodicity?: string): SelectedField[] {
  const dims = t.fields.filter(f => f.kind === 'dimension');
  const resources = t.fields.filter(f => f.kind === 'resource');
  const slice = t.virtual?.slice;
  const periods = (slice === 'Обороты' || slice === 'ОстаткиИОбороты')
    ? accumPeriodFields(periodicity) : [];
  return [...dims, ...periods, ...resources].map(f => ({ tableId: 't1', path: f.name, alias: f.name }));
}

/**
 * Строит QueryModel «выбрать все поля» для таблицы метаданных `t`.
 * Порядок полей соответствует конструктору 1С.
 *
 * @param t          - описатор таблицы из MetadataModel
 * @param periodicity - периодичность (для ВТ РегистраНакопления)
 */
/**
 * Строит QueryModel «выбрать все поля» для таблицы метаданных `t`.
 * Порядок полей соответствует конструктору 1С:
 *   основные поля → табличные части → завершающие стандартные (Предопределенный, ИмяПредопределенныхДанных).
 *
 * @param t          - описатор таблицы из MetadataModel
 * @param periodicity - периодичность (для ВТ РегистраНакопления)
 */
export function buildSelectAllModel(t: MetaTable, periodicity?: string): QueryModel {
  const isAccumVt = !!t.virtual && (
    ['Остатки', 'Обороты', 'ОстаткиИОбороты'].includes(t.virtual.slice)
  );

  let fields: SelectedField[];
  let trailingFields: SelectedField[] | undefined;

  if (isAccumVt) {
    fields = accumVtFields(t, periodicity);
  } else {
    const split = splitRealObjectFields(t);
    fields = split.main;
    trailingFields = split.trailing.length ? split.trailing : undefined;
  }

  // Конструктор 1С дважды включает поля ТЧ в выборку (1С-особенность):
  // первый раз — без суффикса, второй раз — с числовым суффиксом (Ссылка → Ссылка1).
  // Дедупликация псевдонимов выполняется внутри generate().
  const tabSectionFields: SelectedTabSectionField[] = (t.tabularSections ?? []).map(ts => {
    const names = ts.fields.map(f => f.name);
    return {
      tableId: 't1',
      tsName: ts.name,
      tsFullName: ts.fullName,
      fields: [...names, ...names],
    };
  });

  return {
    tables: [{ id: 't1', fullName: t.fullName, ...(t.virtual ? { virtual: {} } : {}) }],
    fields,
    ...(tabSectionFields.length ? { tabSectionFields } : {}),
    ...(trailingFields ? { trailingFields } : {}),
  };
}
