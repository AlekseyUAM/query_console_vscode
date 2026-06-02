import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
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

export function TablesPanel({ metaTables, selectedTables, focusedSelectedTableId, onAddTable, onRemoveTable, onFocusTable }: Props): React.ReactElement {
  const [expandedTableIds, setExpandedTableIds] = React.useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = React.useState(false);

  function toggleExpand(id: string) {
    setExpandedTableIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.kind === 'table') {
        const meta = metaTables.find(t => t.fullName === data.tableFullName);
        if (meta) onAddTable(meta);
      }
    } catch {
      // ignore malformed drag data
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Таблицы</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Убрать таблицу"
          disabled={!focusedSelectedTableId}
          onClick={() => focusedSelectedTableId && onRemoveTable(focusedSelectedTableId)}
        >
          ✕
        </button>
      </div>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          flex: 1,
          overflowY: 'auto',
          fontSize: 13,
          border: isDragOver ? '1px dashed var(--vscode-focusBorder, #007fd4)' : '1px dashed transparent',
          borderRadius: 2,
          transition: 'border-color 0.1s',
          minHeight: 40,
        }}
      >
        {selectedTables.length === 0 && (
          <div style={{ color: 'var(--vscode-descriptionForeground, #888)', padding: 6, fontSize: 11 }}>
            Перетащите таблицу сюда
          </div>
        )}
        {selectedTables.map(t => {
          const isSelected = focusedSelectedTableId === t.id;
          const isExpanded = expandedTableIds.has(t.id);
          const meta = metaTables.find(m => m.fullName === t.fullName);
          return (
            <div key={t.id}>
              <div
                data-table-id={t.id}
                onClick={() => { onFocusTable(t.id); toggleExpand(t.id); }}
                style={{
                  padding: '2px 6px',
                  cursor: 'default',
                  background: isSelected ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                  color: isSelected ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span style={{ fontSize: 10 }}>{isExpanded ? '▼' : '▶'}</span>
                <span>{t.fullName}</span>
              </div>
              {isExpanded && meta && meta.fields.map(field => (
                <div
                  key={field.name}
                  style={{
                    paddingLeft: 24,
                    paddingTop: 1,
                    paddingBottom: 1,
                    fontSize: 12,
                    color: 'var(--vscode-descriptionForeground, #aaa)',
                    userSelect: 'none',
                  }}
                >
                  {field.name}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
