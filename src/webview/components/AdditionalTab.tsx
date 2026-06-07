import * as React from 'react';
import type { SelectedTable, Selection, QueryType } from '../../core/query/queryModel';

interface Props {
  selectedTables: SelectedTable[];
  selection: Selection;
  queryType: QueryType;
  tempTableName: string;
  lockForUpdate: string[];
  lockEnabled: boolean;
  onSetTop: (top: number | undefined) => void;
  onSetDistinct: (distinct: boolean) => void;
  onSetAllowed: (allowed: boolean) => void;
  onSetQueryType: (queryType: QueryType) => void;
  onSetTempTableName: (name: string) => void;
  onSetLockEnabled: (enabled: boolean) => void;
  onAddLockTable: (fullName: string) => void;
  onRemoveLockTable: (fullName: string) => void;
}

const FIELDSET: React.CSSProperties = {
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 3,
  padding: '8px 10px',
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const LEGEND: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 'bold',
  color: 'var(--vscode-descriptionForeground, #aaa)',
  padding: '0 4px',
};

const CHECK_LABEL: React.CSSProperties = {
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
};

const RADIO_LABEL: React.CSSProperties = {
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
};

const INPUT: React.CSSProperties = {
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
  fontSize: 12,
  padding: '2px 4px',
};

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

const panelBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--vscode-panel-border, #444)',
  overflow: 'hidden',
  flex: 1,
  minWidth: 0,
};

const dropZone: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  fontSize: 13,
  minHeight: 80,
};

const QUERY_TYPES: { value: QueryType; label: string }[] = [
  { value: 'select', label: 'Выборка данных' },
  { value: 'createTemp', label: 'Создание временной таблицы' },
  { value: 'appendTemp', label: 'Добавление во временную таблицу' },
  { value: 'dropTemp', label: 'Уничтожение временной таблицы' },
];

function objectName(fullName: string): string {
  return fullName.split('.')[1] ?? fullName;
}

export function AdditionalTab(props: Props): React.ReactElement {
  const {
    selectedTables, selection, queryType, tempTableName, lockForUpdate, lockEnabled,
    onSetTop, onSetDistinct, onSetAllowed, onSetQueryType, onSetTempTableName,
    onSetLockEnabled, onAddLockTable, onRemoveLockTable,
  } = props;

  const topEnabled = selection.top !== undefined;
  const tempNameEnabled = queryType !== 'select';

  // Таблицы выборки, ещё не добавленные в «для изменения».
  const availableTables = selectedTables.filter(t => !lockForUpdate.includes(t.fullName));

  function dragStart(e: React.DragEvent, fullName: string) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ fullName }));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function parseDrop(e: React.DragEvent): string | null {
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data && typeof data.fullName === 'string') return data.fullName;
    } catch { /* ignore */ }
    return null;
  }

  function allowDrop(e: React.DragEvent) {
    if (!lockEnabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 8, padding: 8, overflow: 'auto' }}>
      {/* Выборка записей */}
      <fieldset style={FIELDSET}>
        <legend style={LEGEND}>Выборка записей</legend>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={CHECK_LABEL}>
            <input
              type="checkbox"
              checked={topEnabled}
              onChange={e => onSetTop(e.target.checked ? (selection.top ?? 1) : undefined)}
            />
            Первые
          </label>
          <input
            type="number"
            min={1}
            disabled={!topEnabled}
            value={topEnabled ? selection.top : ''}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              onSetTop(Number.isNaN(n) ? undefined : n);
            }}
            style={{ ...INPUT, width: 80, opacity: topEnabled ? 1 : 0.5 }}
          />
        </div>
        <label style={CHECK_LABEL}>
          <input
            type="checkbox"
            checked={selection.distinct ?? false}
            onChange={e => onSetDistinct(e.target.checked)}
          />
          Без повторяющихся
        </label>
        <label style={CHECK_LABEL}>
          <input
            type="checkbox"
            checked={selection.allowed ?? false}
            onChange={e => onSetAllowed(e.target.checked)}
          />
          Разрешенные
        </label>
      </fieldset>

      {/* Тип запроса */}
      <fieldset style={FIELDSET}>
        <legend style={LEGEND}>Тип запроса</legend>
        {QUERY_TYPES.map(qt => (
          <label key={qt.value} style={RADIO_LABEL}>
            <input
              type="radio"
              name="query-type"
              checked={queryType === qt.value}
              onChange={() => onSetQueryType(qt.value)}
            />
            {qt.label}
          </label>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 13, opacity: tempNameEnabled ? 1 : 0.5 }}>Имя временной таблицы:</span>
          <input
            type="text"
            disabled={!tempNameEnabled}
            value={tempTableName}
            onChange={e => onSetTempTableName(e.target.value)}
            style={{ ...INPUT, flex: 1, minWidth: 0, opacity: tempNameEnabled ? 1 : 0.5 }}
          />
        </div>
      </fieldset>

      {/* Блокировка */}
      <fieldset style={FIELDSET}>
        <label style={CHECK_LABEL}>
          <input
            type="checkbox"
            checked={lockEnabled}
            onChange={e => onSetLockEnabled(e.target.checked)}
          />
          Блокировать получаемые данные для последующего изменения
        </label>
        <div style={{ display: 'flex', gap: 8, opacity: lockEnabled ? 1 : 0.5, pointerEvents: lockEnabled ? 'auto' : 'none' }}>
          {/* Таблицы */}
          <div style={panelBox}>
            <div style={SECTION_HEADER}>Таблицы</div>
            <div style={dropZone}>
              {availableTables.map(t => (
                <div
                  key={t.id}
                  draggable={lockEnabled}
                  onDragStart={e => dragStart(e, t.fullName)}
                  style={{ ...ROW, cursor: lockEnabled ? 'grab' : 'default', justifyContent: 'flex-start' }}
                >
                  <span>{objectName(t.fullName)}</span>
                </div>
              ))}
              {availableTables.length === 0 && (
                <div style={{ padding: 6, color: 'var(--vscode-descriptionForeground, #888)', fontSize: 12 }}>
                  Нет доступных таблиц.
                </div>
              )}
            </div>
          </div>

          {/* Таблицы для изменения */}
          <div
            style={panelBox}
            onDragOver={allowDrop}
            onDrop={e => {
              if (!lockEnabled) return;
              e.preventDefault();
              const fullName = parseDrop(e);
              if (fullName) onAddLockTable(fullName);
            }}
          >
            <div style={SECTION_HEADER}>Таблицы для изменения</div>
            <div style={dropZone}>
              {lockForUpdate.map(fullName => (
                <div key={fullName} style={ROW}>
                  <span>{objectName(fullName)}</span>
                  <button
                    style={REMOVE_BTN}
                    title="Убрать"
                    onClick={() => onRemoveLockTable(fullName)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {lockForUpdate.length === 0 && (
                <div style={{ padding: 6, color: 'var(--vscode-descriptionForeground, #888)', fontSize: 12 }}>
                  Перетащите таблицу сюда.
                </div>
              )}
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
