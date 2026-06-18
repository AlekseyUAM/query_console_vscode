import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField, Totals, TotalGroupField, TotalField, TotalKind } from '../../core/query/queryModel';
import { defaultTableAlias } from '../../core/query/queryModel';
import { distinctFieldRefs } from '../fieldSource';
import { findMetaField, isNumericField, isRefField } from './GroupingTab';

interface Props {
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  metaTables: MetaTable[];
  totals: Totals;
  onAddGroupField: (tableId: string, path: string) => void;
  onRemoveGroupField: (tableId: string, path: string) => void;
  onSetGroupKind: (tableId: string, path: string, kind: TotalKind) => void;
  onSetGroupAlias: (tableId: string, path: string, alias: string) => void;
  onAddTotalField: (tableId: string, path: string) => void;
  onRemoveTotalField: (tableId: string, path: string) => void;
  onSetTotalFieldExpression: (tableId: string, path: string, expression: string) => void;
  onSetGrand: (grand: boolean) => void;
}

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

const KIND_OPTIONS: { value: TotalKind; label: string }[] = [
  { value: 'elements', label: 'Элементы' },
  { value: 'hierarchy', label: 'Элементы и иерархия' },
  { value: 'onlyHierarchy', label: 'Только иерархия' },
];

export function TotalsTab(props: Props): React.ReactElement {
  const {
    selectedTables, selectedFields, metaTables, totals,
    onAddGroupField, onRemoveGroupField, onSetGroupKind, onSetGroupAlias,
    onAddTotalField, onRemoveTotalField, onSetTotalFieldExpression, onSetGrand,
  } = props;

  // Источник: обычные поля выборки (не выражения, не ТЧ).
  const sourceFields = distinctFieldRefs(selectedFields);

  function labelFor(tableId: string, path: string): string {
    const table = selectedTables.find(t => t.id === tableId);
    return table ? `${defaultTableAlias(table)}.${path}` : path;
  }

  function dragStart(e: React.DragEvent, tableId: string, path: string) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ tableId, path }));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function parseDrop(e: React.DragEvent): { tableId: string; path: string } | null {
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data && typeof data.tableId === 'string' && typeof data.path === 'string') {
        return { tableId: data.tableId, path: data.path };
      }
    } catch { /* ignore */ }
    return null;
  }

  function allowDrop(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
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
    <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
      {/* Левый список: Поля */}
      <div style={{ ...panelBox, flex: 1, minWidth: 0 }}>
        <div style={SECTION_HEADER}>Поля</div>
        <div style={dropZone} data-field-source="totals-source">
          {sourceFields.map((f, i) => (
            <div
              key={`${f.tableId}:${f.path}:${i}`}
              data-field-item
              draggable
              onDragStart={e => dragStart(e, f.tableId, f.path!)}
              style={{ ...ROW, cursor: 'grab', justifyContent: 'flex-start' }}
            >
              <span>{labelFor(f.tableId, f.path!)}</span>
            </div>
          ))}
          {sourceFields.length === 0 && (
            <div style={{ padding: 6, color: 'var(--vscode-descriptionForeground, #888)', fontSize: 12 }}>
              Нет полей. Добавьте поля на вкладке «Таблицы и поля».
            </div>
          )}
        </div>
      </div>

      {/* Правая колонка */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 2, minWidth: 0, gap: 4 }}>
        {/* Группировочное поле | Тип итогов | Псевдоним */}
        <div style={{ ...panelBox, flex: 1 }}>
          <div style={{ display: 'flex' }}>
            <div style={{ ...SECTION_HEADER, flex: 1 }}>Группировочное поле</div>
            <div style={{ ...SECTION_HEADER, width: 180, flexShrink: 0 }}>Тип итогов</div>
            <div style={{ ...SECTION_HEADER, width: 160, flexShrink: 0 }}>Псевдоним</div>
          </div>
          <div
            style={dropZone}
            onDragOver={allowDrop}
            onDrop={e => {
              e.preventDefault();
              const d = parseDrop(e);
              if (d) onAddGroupField(d.tableId, d.path);
            }}
          >
            {totals.groupFields.map((g: TotalGroupField) => {
              const isRef = isRefField(findMetaField(metaTables, selectedTables, g.tableId, g.path));
              return (
                <div key={`${g.tableId}:${g.path}`} style={{ display: 'flex', alignItems: 'center', padding: '2px 6px', gap: 4 }}>
                  <span style={{ flex: 1 }}>{labelFor(g.tableId, g.path)}</span>
                  {isRef ? (
                    <select
                      value={g.kind}
                      onChange={e => onSetGroupKind(g.tableId, g.path, e.target.value as TotalKind)}
                      style={{ ...INPUT, width: 170 }}
                    >
                      {KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <span style={{ width: 170, flexShrink: 0, fontSize: 12, color: 'var(--vscode-descriptionForeground, #888)' }}>Элементы</span>
                  )}
                  <input
                    type="text"
                    value={g.alias ?? ''}
                    placeholder="Псевдоним"
                    onChange={e => onSetGroupAlias(g.tableId, g.path, e.target.value)}
                    style={{ ...INPUT, width: 150 }}
                  />
                  <button style={REMOVE_BTN} title="Убрать" onClick={() => onRemoveGroupField(g.tableId, g.path)}>✕</button>
                </div>
              );
            })}
          </div>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', padding: '4px 6px', borderTop: '1px solid var(--vscode-panel-border, #444)' }}>
            <input
              type="checkbox"
              checked={totals.grand}
              onChange={e => onSetGrand(e.target.checked)}
            />
            Общие итоги
          </label>
        </div>

        {/* Итоговое поле | Выражение */}
        <div style={{ ...panelBox, flex: 1 }}>
          <div style={{ display: 'flex' }}>
            <div style={{ ...SECTION_HEADER, flex: 1 }}>Итоговое поле</div>
            <div style={{ ...SECTION_HEADER, width: 220, flexShrink: 0 }}>Выражение</div>
          </div>
          <div
            style={dropZone}
            onDragOver={allowDrop}
            onDrop={e => {
              e.preventDefault();
              const d = parseDrop(e);
              if (!d) return;
              // Итоговые поля — только числовые.
              if (!isNumericField(findMetaField(metaTables, selectedTables, d.tableId, d.path))) return;
              onAddTotalField(d.tableId, d.path);
            }}
          >
            {totals.totalFields.map((f: TotalField) => (
              <div key={`${f.tableId}:${f.path}`} style={{ display: 'flex', alignItems: 'center', padding: '2px 6px', gap: 4 }}>
                <span style={{ flex: 1 }}>{labelFor(f.tableId, f.path)}</span>
                <input
                  type="text"
                  value={f.expression ?? ''}
                  onChange={e => onSetTotalFieldExpression(f.tableId, f.path, e.target.value)}
                  style={{ ...INPUT, width: 210 }}
                />
                <button style={REMOVE_BTN} title="Убрать" onClick={() => onRemoveTotalField(f.tableId, f.path)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
