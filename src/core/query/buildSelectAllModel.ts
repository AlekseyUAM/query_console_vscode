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
 * Строит список полей для виртуальной таблицы РегистраБухгалтерии.
 * Для Обороты/ОстаткиИОбороты/ОборотыДтКт: период-поля ПЕРЕД остальными полями ВТ.
 * Для Остатки/ДвиженияССубконто: поля ВТ в естественном порядке (t.fields as-is).
 */
function accountingVtFields(t: MetaTable, periodicity?: string): SelectedField[] {
  const toField = (f: { name: string }) => ({ tableId: 't1', path: f.name, alias: f.name });
  const slice = t.virtual?.slice;
  const needsPeriod = slice === 'Обороты' || slice === 'ОстаткиИОбороты' || slice === 'ОборотыДтКт';
  if (needsPeriod) {
    const periods = accumPeriodFields(periodicity);
    return [...periods, ...t.fields].map(toField);
  }
  return t.fields.map(toField);
}

/**
 * Строит QueryModel «выбрать все поля» для таблицы метаданных `t`.
 * Порядок полей соответствует конструктору 1С:
 *   основные поля → табличные части → завершающие стандартные (Предопределенный, ИмяПредопределенныхДанных).
 *
 * @param t          - описатор таблицы из MetadataModel
 * @param periodicity - периодичность (для ВТ РегистраНакопления и РегистраБухгалтерии)
 */
export function buildSelectAllModel(t: MetaTable, periodicity?: string): QueryModel {
  const isAccumVt = !!t.virtual && t.kind === 'РегистрНакопления' && (
    ['Остатки', 'Обороты', 'ОстаткиИОбороты'].includes(t.virtual.slice)
  );
  const isAccountingVt = !!t.virtual && t.kind === 'РегистрБухгалтерии';

  let fields: SelectedField[];
  let trailingFields: SelectedField[] | undefined;

  if (isAccumVt) {
    fields = accumVtFields(t, periodicity);
  } else if (isAccountingVt) {
    fields = accountingVtFields(t, periodicity);
  } else {
    const split = splitRealObjectFields(t);
    fields = split.main;
    trailingFields = split.trailing.length ? split.trailing : undefined;
  }

  // Поля табличной части — по одному разу, как в конструкторе 1С.
  // Виртуальные таблицы не имеют табличных частей.
  const tabSectionFields: SelectedTabSectionField[] = (t.tabularSections ?? []).map(ts => ({
    tableId: 't1',
    tsName: ts.name,
    tsFullName: ts.fullName,
    fields: ts.fields.map(f => f.name),
  }));

  // Для ВТ Обороты/ОстаткиИОбороты/ОборотыДтКт периодичность идёт в источник (3-я позиция),
  // поэтому прокидываем её в параметры виртуальной таблицы. Для остальных ВТ
  // параметры пустые (источник без скобок).
  const slice = t.virtual?.slice;
  const sliceNeedsPeriodicity = slice === 'Обороты' || slice === 'ОстаткиИОбороты' || slice === 'ОборотыДтКт';
  const passPeriodicity = sliceNeedsPeriodicity && !!periodicity;

  let virtual: Record<string, unknown> | undefined;
  if (t.virtual) {
    const params: Record<string, unknown> = {};
    if (passPeriodicity) params.periodicity = periodicity;
    // Необоротные ВТ: первый параметр-период по умолчанию &Период (как в конструкторе 1С),
    // чтобы текст «выбрать все» был полным. Для ДвиженияССубконто период — это НачалоПериода.
    if (slice === 'Остатки' || slice === 'СрезПервых' || slice === 'СрезПоследних') {
      params.period = '&Период';
    } else if (slice === 'ДвиженияССубконто') {
      params.startPeriod = '&Период';
    }
    // Для РегистраБухгалтерии прокидываем correspondence — генератор использует его
    // для выбора арности источника (Обороты corr vs non-corr).
    if (isAccountingVt && t.virtual.correspondence !== undefined) {
      params.correspondence = t.virtual.correspondence;
    }
    virtual = params;
  }

  return {
    tables: [{ id: 't1', fullName: t.fullName, ...(virtual ? { virtual } : {}) }],
    fields,
    ...(tabSectionFields.length ? { tabSectionFields } : {}),
    ...(trailingFields ? { trailingFields } : {}),
  };
}
