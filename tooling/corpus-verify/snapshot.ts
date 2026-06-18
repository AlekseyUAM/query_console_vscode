// tooling/corpus-verify/snapshot.ts
// Тело функции, исполняемой в браузере через page.evaluate(SNAPSHOT_FN).
// Возвращает UiSnapshot (структура из invariants.ts), сериализуемый в Node.
export const SNAPSHOT_FN = `() => {
  const tabs = Array.from(document.querySelectorAll('[data-testid="tabsbar"] [data-tab]'))
    .map(e => e.getAttribute('data-tab') || '');
  const tableLabels = Array.from(document.querySelectorAll('[data-table-id]'))
    .map(e => (e.textContent || '').trim());
  const groups = {};
  Array.from(document.querySelectorAll('[data-field-source]')).forEach(el => {
    const id = el.getAttribute('data-field-source') || 'unknown';
    const items = Array.from(el.querySelectorAll('[data-field-item]')).map(i => (i.textContent || '').trim());
    groups[id] = (groups[id] || []).concat(items);
  });
  const fieldListGroups = Object.keys(groups).map(id => ({ id, items: groups[id] }));
  const clipped = [];
  Array.from(document.querySelectorAll('span')).forEach(s => {
    if (s.scrollWidth > s.clientWidth + 1 && (s.textContent || '').trim()) {
      clipped.push({ text: (s.textContent || '').trim(), hasTitle: !!s.getAttribute('title') });
    }
  });
  return { tabs, tableLabels, fieldListGroups, clipped };
}`;
