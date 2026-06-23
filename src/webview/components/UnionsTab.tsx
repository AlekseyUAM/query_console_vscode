import * as React from 'react';
import type { QueryMeta } from '../state/queryStore';
import type { UnionColumn } from '../../core/query/unionModel';
import { ResizeHandle } from './ResizeHandle';

const ALIAS_RE = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*$/;
const ALIAS_ERROR = "Псевдонимы полей должны начинаться с буквы и могут содержать только буквы, цифры, и символ '_'";

interface Props {
  queryList: QueryMeta[];
  activeQuery: number;
  columns: UnionColumn[];
  onAddQuery: () => void;
  onRemoveQuery: (index: number) => void;
  onSetActiveQuery: (index: number) => void;
  onRenameQuery: (index: number, name: string) => void;
  onSetQueryDistinct: (index: number, distinct: boolean) => void;
  onSetColumnAlias: (alias: string, newAlias: string) => void;
  onMoveColumn: (index: number, dir: 'up' | 'down') => void;
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 'bold',
  padding: '2px 6px',
  background: 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)',
  borderBottom: '1px solid var(--vscode-panel-border, #444)',
  color: 'var(--vscode-descriptionForeground, #aaa)',
};

const ICON_BTN: React.CSSProperties = {
  padding: '1px 6px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

const INPUT: React.CSSProperties = {
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
  borderRadius: 2,
  fontSize: 12,
  padding: '1px 4px',
  width: '100%',
  boxSizing: 'border-box',
};

const TH: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 'bold',
  padding: '3px 6px',
  background: 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)',
  borderBottom: '1px solid var(--vscode-panel-border, #444)',
  color: 'var(--vscode-descriptionForeground, #aaa)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  fontSize: 12,
  padding: '2px 6px',
  borderBottom: '1px solid var(--vscode-panel-border, #333)',
};

const PANEL: React.CSSProperties = {
  border: '1px solid var(--vscode-panel-border, #444)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

export function UnionsTab({
  queryList, activeQuery, columns,
  onAddQuery, onRemoveQuery, onSetActiveQuery,
  onRenameQuery, onSetQueryDistinct, onSetColumnAlias, onMoveColumn,
}: Props): React.ReactElement {
  const [selectedRow, setSelectedRow] = React.useState(activeQuery);
  const [aliasError, setAliasError] = React.useState<string | null>(null);
  // 8.3.1: выбранная колонка (поле) в «Списке полей» — для кнопок Вверх/Вниз.
  const [selectedCol, setSelectedCol] = React.useState(0);
  // 8.3.7: перетаскиваемая граница ширины «Списка запросов».
  const [queryListWidth, setQueryListWidth] = React.useState(280);
  // Локальные значения полей ввода псевдонимов (по индексу колонки), чтобы при
  // невалидном вводе откатить отображаемый текст к исходному псевдониму.
  const [aliasDrafts, setAliasDrafts] = React.useState<Record<number, string>>({});

  React.useEffect(() => {
    if (selectedRow >= queryList.length) setSelectedRow(queryList.length - 1);
  }, [queryList.length, selectedRow]);

  React.useEffect(() => {
    if (selectedCol >= columns.length) setSelectedCol(Math.max(0, columns.length - 1));
  }, [columns.length, selectedCol]);

  // Выделение следует за перемещаемой колонкой, чтобы стрелки продолжали её двигать.
  function moveColumn(dir: 'up' | 'down') {
    const target = dir === 'up' ? selectedCol - 1 : selectedCol + 1;
    if (target < 0 || target >= columns.length) return;
    onMoveColumn(selectedCol, dir);
    setSelectedCol(target);
  }

  function selectRow(index: number) {
    setSelectedRow(index);
    onSetActiveQuery(index);
  }

  function commitAlias(colIdx: number, alias: string, draft: string) {
    const next = draft.trim();
    if (next === alias) {
      setAliasDrafts(d => { const { [colIdx]: _omit, ...rest } = d; return rest; });
      return;
    }
    if (!ALIAS_RE.test(next)) {
      setAliasError(ALIAS_ERROR);
      // Откатить отображаемый текст к исходному псевдониму.
      setAliasDrafts(d => { const { [colIdx]: _omit, ...rest } = d; return rest; });
      return;
    }
    onSetColumnAlias(alias, next);
    setAliasDrafts(d => { const { [colIdx]: _omit, ...rest } = d; return rest; });
  }

  return (
    <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
      {/* Список запросов */}
      <div style={{ ...PANEL, width: queryListWidth, flexShrink: 0 }}>
        <div style={SECTION_HEADER}>Список запросов</div>
        <div style={{ display: 'flex', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
          <button style={ICON_BTN} title="Добавить запрос" onClick={onAddQuery}>+</button>
          <button
            style={{ ...ICON_BTN, opacity: queryList.length > 1 ? 1 : 0.5 }}
            title="Удалить запрос"
            disabled={queryList.length <= 1}
            onClick={() => onRemoveQuery(selectedRow)}
          >
            ✕
          </button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={TH}>Имя</th>
                <th style={{ ...TH, width: 90, textAlign: 'center' }}>Без дупликатов</th>
              </tr>
            </thead>
            <tbody>
              {queryList.map((q, i) => (
                <tr
                  key={i}
                  onClick={() => selectRow(i)}
                  style={{
                    cursor: 'pointer',
                    background: i === selectedRow ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                  }}
                >
                  <td style={TD}>
                    <input
                      style={INPUT}
                      value={q.name}
                      onChange={e => onRenameQuery(i, e.target.value)}
                      onClick={e => e.stopPropagation()}
                    />
                  </td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={q.distinct}
                      onChange={e => onSetQueryDistinct(i, e.target.checked)}
                      onClick={e => e.stopPropagation()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ResizeHandle onResize={d => setQueryListWidth(w => Math.max(160, w + d))} />

      {/* Список полей */}
      <div style={{ ...PANEL, flex: 1, minWidth: 0 }}>
        <div style={SECTION_HEADER}>Список полей</div>
        <div style={{ display: 'flex', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
          <button
            style={{ ...ICON_BTN, opacity: selectedCol > 0 ? 1 : 0.5 }}
            title="Переместить вверх"
            disabled={selectedCol <= 0}
            onClick={() => moveColumn('up')}
          >
            ↑
          </button>
          <button
            style={{ ...ICON_BTN, opacity: selectedCol < columns.length - 1 ? 1 : 0.5 }}
            title="Переместить вниз"
            disabled={selectedCol >= columns.length - 1}
            onClick={() => moveColumn('down')}
          >
            ↓
          </button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={TH}>Имя поля</th>
                {queryList.map((q, i) => (
                  <th key={i} style={TH}>{q.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((col, colIdx) => {
                const draft = aliasDrafts[colIdx];
                const value = draft !== undefined ? draft : col.alias;
                return (
                  <tr
                    key={col.alias}
                    onClick={() => setSelectedCol(colIdx)}
                    style={{
                      cursor: 'pointer',
                      background: colIdx === selectedCol ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                    }}
                  >
                    <td style={TD}>
                      <input
                        style={INPUT}
                        value={value}
                        onChange={e => setAliasDrafts(d => ({ ...d, [colIdx]: e.target.value }))}
                        onBlur={() => commitAlias(colIdx, col.alias, value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          else if (e.key === 'Escape') {
                            setAliasDrafts(d => { const { [colIdx]: _omit, ...rest } = d; return rest; });
                          }
                        }}
                      />
                    </td>
                    {col.cells.map((cell, i) => (
                      <td key={i} style={{ ...TD, color: cell === null ? 'var(--vscode-descriptionForeground, #888)' : 'inherit', fontStyle: cell === null ? 'italic' : 'normal' }}>
                        {cell === null ? '<Отсутствует>' : cell}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Сообщение валидации псевдонима */}
      {aliasError !== null && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setAliasError(null)}
        >
          <div
            style={{
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-panel-border, #555)',
              borderRadius: 4,
              padding: 16,
              minWidth: 360,
              maxWidth: '60vw',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
            onClick={e => e.stopPropagation()}
          >
            <span style={{ fontSize: 13 }}>{aliasError}</span>
            <button style={{ ...ICON_BTN, alignSelf: 'center', padding: '4px 20px' }} onClick={() => setAliasError(null)}>ОК</button>
          </div>
        </div>
      )}
    </div>
  );
}
