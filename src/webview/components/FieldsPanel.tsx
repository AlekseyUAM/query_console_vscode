import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  focusedDbTableFullName: string | null;
  focusedDbFieldPath: string | null;
  focusedSelectedFieldIdx: number | null;
  onAddField: (tableId: string, fieldPath: string) => void;
  onRemoveField: (fieldIdx: number) => void;
  onFocusField: (idx: number) => void;
  onGenerate: () => void;
}

const BTN: React.CSSProperties = {
  padding: '2px 8px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

export function FieldsPanel({ metaTables, selectedTables, selectedFields, focusedDbTableFullName, focusedDbFieldPath, focusedSelectedFieldIdx, onAddField, onRemoveField, onFocusField, onGenerate }: Props): React.ReactElement {
  function handleAddField() {
    if (!focusedDbTableFullName || !focusedDbFieldPath) return;
    // Find or auto-add table
    const tableInQuery = selectedTables.find(t => t.fullName === focusedDbTableFullName);
    if (!tableInQuery) {
      // Can't add field without table — noop (user should add table first)
      return;
    }
    onAddField(tableInQuery.id, focusedDbFieldPath);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Поля</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Добавить поле"
          disabled={!focusedDbFieldPath || !selectedTables.some(t => t.fullName === focusedDbTableFullName)}
          onClick={handleAddField}
        >
          &gt;
        </button>
        <button
          style={BTN}
          title="Убрать поле"
          disabled={focusedSelectedFieldIdx === null}
          onClick={() => focusedSelectedFieldIdx !== null && onRemoveField(focusedSelectedFieldIdx)}
        >
          &lt;
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', fontSize: 13 }}>
        {selectedFields.map((f, i) => {
          const table = selectedTables.find(t => t.id === f.tableId);
          const label = table ? `${table.fullName.split('.')[1]}.${f.path}` : f.path;
          return (
            <div
              key={`${f.tableId}:${f.path}`}
              data-field-idx={i}
              onClick={() => onFocusField(i)}
              style={{
                padding: '2px 6px',
                cursor: 'default',
                background: focusedSelectedFieldIdx === i ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                color: focusedSelectedFieldIdx === i ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
                userSelect: 'none',
              }}
            >
              {label}
            </div>
          );
        })}
      </div>
      <button
        data-testid="btn-generate"
        style={{ ...BTN, padding: '6px 12px', alignSelf: 'flex-end', marginTop: 4 }}
        onClick={onGenerate}
      >
        Запрос
      </button>
    </div>
  );
}
