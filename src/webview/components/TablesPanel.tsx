import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
  focusedDbTableFullName: string | null;
  focusedSelectedTableId: string | null;
  onAddTable: (table: MetaTable) => void;
  onRemoveTable: (tableId: string) => void;
  onFocusTable: (id: string) => void;
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

export function TablesPanel({ metaTables, selectedTables, focusedDbTableFullName, focusedSelectedTableId, onAddTable, onRemoveTable, onFocusTable }: Props): React.ReactElement {
  const focusedMeta = metaTables.find(t => t.fullName === focusedDbTableFullName);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Таблицы</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Добавить таблицу"
          disabled={!focusedMeta}
          onClick={() => focusedMeta && onAddTable(focusedMeta)}
        >
          &gt;
        </button>
        <button
          style={BTN}
          title="Убрать таблицу"
          disabled={!focusedSelectedTableId}
          onClick={() => focusedSelectedTableId && onRemoveTable(focusedSelectedTableId)}
        >
          &lt;
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', fontSize: 13 }}>
        {selectedTables.map(t => (
          <div
            key={t.id}
            data-table-id={t.id}
            onClick={() => onFocusTable(t.id)}
            style={{
              padding: '2px 6px',
              cursor: 'default',
              background: focusedSelectedTableId === t.id ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
              color: focusedSelectedTableId === t.id ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
              userSelect: 'none',
            }}
          >
            {t.fullName}
          </div>
        ))}
      </div>
    </div>
  );
}
