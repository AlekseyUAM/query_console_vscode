import * as React from 'react';
import type { MetaTable } from '../../core/metadata/types';
import type { SelectedTable, SelectedField } from '../../core/query/queryModel';

interface Props {
  metaTables: MetaTable[];
  selectedTables: SelectedTable[];
  selectedFields: SelectedField[];
  focusedSelectedFieldIdx: number | null;
  generatedText: string;
  onAddField: (tableId: string, fieldPath: string) => void;
  onRemoveField: (fieldIdx: number) => void;
  onFocusField: (idx: number) => void;
  onGenerate: () => void;
  onInsert: (text: string) => void;
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

export function FieldsPanel({ metaTables, selectedTables, selectedFields, focusedSelectedFieldIdx, generatedText, onAddField, onRemoveField, onFocusField, onGenerate, onInsert }: Props): React.ReactElement {
  const [isDragOver, setIsDragOver] = React.useState(false);

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
      if (data.kind === 'field') {
        const tableInQuery = selectedTables.find(t => t.fullName === data.tableFullName);
        if (tableInQuery) {
          onAddField(tableInQuery.id, data.fieldPath);
        }
      }
    } catch {
      // ignore malformed drag data
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 4, gap: 4 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>Поля</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          style={BTN}
          title="Убрать поле"
          disabled={focusedSelectedFieldIdx === null}
          onClick={() => focusedSelectedFieldIdx !== null && onRemoveField(focusedSelectedFieldIdx)}
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
        {selectedFields.length === 0 && (
          <div style={{ color: 'var(--vscode-descriptionForeground, #888)', padding: 6, fontSize: 11 }}>
            Перетащите поле сюда
          </div>
        )}
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
      {generatedText && (
        <div style={{ fontSize: 11, fontFamily: 'var(--vscode-editor-font-family, monospace)', background: 'var(--vscode-editor-background, #1e1e1e)', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 2, padding: 6, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', color: 'var(--vscode-foreground, #ccc)' }}>
          {generatedText}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 4 }}>
        <button
          data-testid="btn-generate"
          style={{ ...BTN, padding: '6px 12px' }}
          onClick={onGenerate}
        >
          Сгенерировать
        </button>
        {generatedText && (
          <button
            data-testid="btn-ok"
            style={{ ...BTN, padding: '6px 12px', background: 'var(--vscode-button-prominentBackground, #1177bb)' }}
            onClick={() => onInsert(generatedText)}
          >
            ОК
          </button>
        )}
      </div>
    </div>
  );
}
