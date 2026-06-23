import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField, ReportBuilder, BuilderField } from '../../core/query/queryModel';
import { defaultTableAlias } from '../../core/query/queryModel';
import { isRefField } from './GroupingTab';
import { ResizeHandle } from './ResizeHandle';

type Section = 'fields' | 'conditions' | 'order' | 'totals';

interface Props {
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  metaTables: MetaTable[];
  builder: ReportBuilder;
  onAdd: (section: Section, field: BuilderField) => void;
  onRemove: (section: Section, index: number) => void;
  onSetChild: (section: Section, index: number, child: boolean) => void;
  onSetAlias: (section: Section, index: number, alias: string) => void;
}

const SUB_TABS: { key: Section; label: string }[] = [
  { key: 'fields', label: 'Поля' },
  { key: 'conditions', label: 'Условия' },
  { key: 'order', label: 'Порядок' },
  { key: 'totals', label: 'Итоги' },
];

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 'bold',
  padding: '2px 6px',
  background: 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)',
  borderBottom: '1px solid var(--vscode-panel-border, #444)',
  color: 'var(--vscode-descriptionForeground, #aaa)',
};

const REMOVE_BTN: React.CSSProperties = {
  padding: '0 4px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  border: 'none',
  fontSize: 10,
  lineHeight: 1,
  flexShrink: 0,
};

const ROW: React.CSSProperties = {
  padding: '2px 6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  userSelect: 'none',
};

const INPUT: React.CSSProperties = {
  flexShrink: 0,
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
  fontSize: 12,
};

const ADD_BTN: React.CSSProperties = {
  padding: '0 6px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  border: 'none',
  fontSize: 12,
  lineHeight: 1,
  flexShrink: 0,
};

/** Последний сегмент составного пути (Поле.Подполе → Подполе). */
function lastSegment(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] || path;
}

interface DragData {
  ref: string;
  /** Является ли поле ссылочным (для доступности галочки И.). */
  isRef: boolean;
}

export function BuilderTab(props: Props): React.ReactElement {
  const {
    selectedTables, selectedFields, metaTables, builder,
    onAdd, onRemove, onSetChild, onSetAlias,
  } = props;

  const [active, setActive] = React.useState<Section>('fields');
  const [expandAll, setExpandAll] = React.useState(false);
  const [expandedTables, setExpandedTables] = React.useState<Record<string, boolean>>({});
  // 8.3.7: перетаскиваемая граница ширины левого списка «Поля».
  const [leftWidth, setLeftWidth] = React.useState(260);

  const rows = builder[active];

  // Источник: обычные поля выборки (не выражения, не ТЧ).
  const sourceFields = selectedFields.filter(f => !f.expression && f.path);

  function metaForTable(t: SelectedTable): MetaTable | undefined {
    return metaTables.find(m => m.fullName === t.fullName);
  }

  /** MetaField исходного поля выборки (верхний сегмент пути). */
  function metaFieldFor(t: SelectedTable, path: string) {
    const meta = metaForTable(t);
    if (!meta) return undefined;
    const top = path.split('.')[0];
    return meta.fields.find(f => f.name === top);
  }

  /** Подпись поля выборки слева в зависимости от режима адресации под-вкладки. */
  function selectFieldLabel(t: SelectedTable, f: SelectedField): string {
    if (active === 'conditions') {
      return `${defaultTableAlias(t)}.${f.path}`;
    }
    return f.alias || lastSegment(f.path);
  }

  /** ref поля выборки в зависимости от режима адресации. */
  function selectFieldRef(t: SelectedTable, f: SelectedField): string {
    if (active === 'conditions') {
      return `${defaultTableAlias(t)}.${f.path}`;
    }
    return f.alias || lastSegment(f.path);
  }

  function addSelectField(f: SelectedField) {
    const t = selectedTables.find(s => s.id === f.tableId);
    if (!t) return;
    onAdd(active, { ref: selectFieldRef(t, f), child: false });
  }

  function addAllField(t: SelectedTable, fieldName: string) {
    onAdd(active, { ref: `${defaultTableAlias(t)}.${fieldName}`, child: false });
  }

  function dragStart(e: React.DragEvent, data: DragData) {
    e.dataTransfer.setData('text/plain', JSON.stringify(data));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function parseDrop(e: React.DragEvent): DragData | null {
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data && typeof data.ref === 'string') {
        return { ref: data.ref, isRef: !!data.isRef };
      }
    } catch { /* ignore */ }
    return null;
  }

  function allowDrop(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  /** Является ли строка построителя ссылочной (по совпадению ref с метаданными). */
  function rowIsRef(ref: string): boolean {
    // ref выборки (без точки) — ищем по псевдониму/последнему сегменту поля выборки.
    if (!ref.includes('.')) {
      for (const f of sourceFields) {
        const t = selectedTables.find(s => s.id === f.tableId);
        if (!t) continue;
        const alias = f.alias || lastSegment(f.path);
        if (alias === ref) return isRefField(metaFieldFor(t, f.path));
      }
      return false;
    }
    // Квалифицированный ref Алиас.Поле — ищем таблицу по псевдониму и поле по имени.
    const [alias, ...rest] = ref.split('.');
    const fieldName = rest[0];
    const t = selectedTables.find(s => defaultTableAlias(s) === alias);
    if (!t) return false;
    const meta = metaForTable(t);
    const mf = meta?.fields.find(f => f.name === fieldName);
    return isRefField(mf);
  }

  const dropZone: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    fontSize: 13,
    minHeight: 40,
  };

  const panelBox: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--vscode-panel-border, #444)',
    overflow: 'hidden',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: 4, gap: 4, overflow: 'hidden' }}>
      {/* Полоса под-вкладок */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border, #444)', flexShrink: 0 }}>
        {SUB_TABS.map(st => {
          const isActive = st.key === active;
          return (
            <div
              key={st.key}
              onClick={() => setActive(st.key)}
              style={{
                padding: '4px 14px',
                cursor: 'pointer',
                borderBottom: isActive ? '2px solid var(--vscode-focusBorder, #007fd4)' : '2px solid transparent',
                color: isActive ? 'var(--vscode-tab-activeForeground, #fff)' : 'var(--vscode-tab-inactiveForeground, #999)',
                fontSize: 13,
              }}
            >
              {st.label}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 4, overflow: 'hidden' }}>
        {/* Левый список: Поля */}
        <div style={{ ...panelBox, width: leftWidth, flexShrink: 0 }}>
          <div style={SECTION_HEADER}>Поля</div>
          <div style={dropZone}>
            {/* Группа 1: текущие поля выборки */}
            {sourceFields.map((f, i) => {
              const t = selectedTables.find(s => s.id === f.tableId);
              if (!t) return null;
              const ref = selectFieldRef(t, f);
              const isRef = isRefField(metaFieldFor(t, f.path));
              return (
                <div
                  key={`sel:${f.tableId}:${f.path}:${i}`}
                  draggable
                  onDragStart={e => dragStart(e, { ref, isRef })}
                  style={{ ...ROW, cursor: 'grab' }}
                >
                  <span>{selectFieldLabel(t, f)}</span>
                  <button style={ADD_BTN} title="Добавить" onClick={() => addSelectField(f)}>&gt;</button>
                </div>
              );
            })}

            {/* Группа 2: Все поля */}
            <div
              style={{ ...ROW, cursor: 'pointer', fontWeight: 'bold' }}
              onClick={() => setExpandAll(v => !v)}
            >
              <span>{expandAll ? '▾' : '▸'} Все поля</span>
            </div>
            {expandAll && selectedTables.map(t => {
              const meta = metaForTable(t);
              const alias = defaultTableAlias(t);
              const open = !!expandedTables[t.id];
              return (
                <div key={`all:${t.id}`}>
                  <div
                    style={{ ...ROW, cursor: 'pointer', paddingLeft: 18 }}
                    onClick={() => setExpandedTables(s => ({ ...s, [t.id]: !s[t.id] }))}
                  >
                    <span>{open ? '▾' : '▸'} {alias}</span>
                  </div>
                  {open && (meta?.fields ?? []).map(mf => {
                    const ref = `${alias}.${mf.name}`;
                    const isRef = isRefField(mf);
                    return (
                      <div
                        key={`all:${t.id}:${mf.name}`}
                        draggable
                        onDragStart={e => dragStart(e, { ref, isRef })}
                        style={{ ...ROW, cursor: 'grab', paddingLeft: 34 }}
                      >
                        <span>{ref}</span>
                        <button style={ADD_BTN} title="Добавить" onClick={() => addAllField(t, mf.name)}>&gt;</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {sourceFields.length === 0 && !expandAll && (
              <div style={{ padding: 6, color: 'var(--vscode-descriptionForeground, #888)', fontSize: 12 }}>
                Нет полей. Добавьте поля на вкладке «Таблицы и поля» или раскройте «Все поля».
              </div>
            )}
          </div>
        </div>

        <ResizeHandle onResize={d => setLeftWidth(w => Math.max(140, w + d))} />

        {/* Правый список: строки построителя */}
        <div style={{ ...panelBox, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex' }}>
            <div style={{ ...SECTION_HEADER, flex: 1 }}>Поле</div>
            <div style={{ ...SECTION_HEADER, width: 40, flexShrink: 0, textAlign: 'center' }}>И.</div>
            <div style={{ ...SECTION_HEADER, width: 160, flexShrink: 0 }}>Псевдоним</div>
            <div style={{ ...SECTION_HEADER, width: 28, flexShrink: 0 }} />
          </div>
          <div
            style={dropZone}
            onDragOver={allowDrop}
            onDrop={e => {
              e.preventDefault();
              const d = parseDrop(e);
              if (d) onAdd(active, { ref: d.ref, child: false });
            }}
          >
            {rows.map((row: BuilderField, idx) => {
              const isRef = rowIsRef(row.ref);
              return (
                <div key={`${active}:${idx}:${row.ref}`} style={{ display: 'flex', alignItems: 'center', padding: '2px 6px', gap: 4 }}>
                  <span style={{ flex: 1 }}>{row.ref}{row.child ? '.*' : ''}</span>
                  <span style={{ width: 40, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                    <input
                      type="checkbox"
                      checked={row.child}
                      disabled={!isRef}
                      title={isRef ? 'Использовать дочерние' : 'Доступно только для ссылочных полей'}
                      onChange={e => onSetChild(active, idx, e.target.checked)}
                    />
                  </span>
                  <input
                    type="text"
                    value={row.alias ?? ''}
                    placeholder="Псевдоним"
                    onChange={e => onSetAlias(active, idx, e.target.value)}
                    style={{ ...INPUT, width: 150 }}
                  />
                  <button style={REMOVE_BTN} title="Убрать" onClick={() => onRemove(active, idx)}>✕</button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
