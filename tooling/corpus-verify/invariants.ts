import type { FeatureVector, ActiveView } from './features';

const BASE_TABS = [
  'Таблицы и поля', 'Группировка', 'Условия', 'Дополнительно',
  'Объединения/Псевдонимы', 'Порядок', 'Итоги', 'Построитель', 'Пакет запросов',
];

export function expectedTabs(active: ActiveView): string[] {
  if (active.queryType === 'dropTemp') return ['Дополнительно', 'Пакет запросов'];
  let tabs = active.tableCount > 1 ? [BASE_TABS[0], 'Связи', ...BASE_TABS.slice(1)] : [...BASE_TABS];
  if (active.queryType === 'createTemp') {
    const i = tabs.indexOf('Дополнительно');
    tabs = [...tabs.slice(0, i + 1), 'Индексы', ...tabs.slice(i + 1)];
  }
  return tabs;
}

export interface UiSnapshot {
  tabs: string[];
  tableLabels: string[];
  fieldListGroups: { id: string; items: string[] }[];
  clipped: { text: string; hasTitle: boolean }[];
}

export interface Violation {
  code: 'TABS' | 'TABLE_COUNT' | 'DUP_FIELDS' | 'CLIP';
  detail: string;
}

/**
 * Структурные инварианты (набор вкладок, число таблиц) — зависят от ВСЕГО окна и
 * проверяются ОДИН раз на активной вкладке «Таблицы и поля» (где смонтирована панель
 * таблиц). На снимке другой вкладки бессмысленны (там нет `[data-table-id]`).
 */
export function checkStructure(snap: UiSnapshot, fv: FeatureVector): Violation[] {
  const out: Violation[] = [];
  const exp = expectedTabs(fv.active);
  if (JSON.stringify(snap.tabs) !== JSON.stringify(exp)) {
    out.push({ code: 'TABS', detail: `ожидалось [${exp.join(', ')}], получено [${snap.tabs.join(', ')}]` });
  }
  if (fv.active.queryType !== 'dropTemp' && snap.tableLabels.length !== fv.active.tableCount) {
    out.push({ code: 'TABLE_COUNT', detail: `таблиц в панели ${snap.tableLabels.length}, в модели ${fv.active.tableCount}` });
  }
  return out;
}

/**
 * Контентные инварианты (дубли полей, обрезка текста) — относятся к содержимому
 * КОНКРЕТНОЙ вкладки и запускаются на снимке КАЖДОЙ видимой вкладки при обходе
 * (драйвер аккумулирует и дедуплицирует нарушения). От fv не зависят.
 */
export function checkContent(snap: UiSnapshot): Violation[] {
  const out: Violation[] = [];
  for (const g of snap.fieldListGroups) {
    const seen = new Set<string>();
    for (const item of g.items) {
      if (seen.has(item)) { out.push({ code: 'DUP_FIELDS', detail: `${g.id}: дубль «${item}»` }); }
      seen.add(item);
    }
  }
  for (const c of snap.clipped) {
    if (!c.hasTitle) out.push({ code: 'CLIP', detail: `обрезка без тултипа: «${c.text}»` });
  }
  return out;
}

/** Все инварианты по одному снимку (структура + контент). */
export function checkInvariants(snap: UiSnapshot, fv: FeatureVector): Violation[] {
  return [...checkStructure(snap, fv), ...checkContent(snap)];
}
