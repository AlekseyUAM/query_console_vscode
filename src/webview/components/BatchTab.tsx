import * as React from 'react';

interface Props {
  names: string[];
  activeIndex: number;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove: (index: number, dir: 'up' | 'down') => void;
  onSetActive: (index: number) => void;
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

export function BatchTab({
  names, activeIndex, onAdd, onRemove, onMove, onSetActive,
}: Props): React.ReactElement {
  const [selectedRow, setSelectedRow] = React.useState(activeIndex);

  React.useEffect(() => {
    if (selectedRow >= names.length) setSelectedRow(names.length - 1);
  }, [names.length, selectedRow]);

  // Выделение следует за перемещаемой строкой, чтобы стрелки продолжали двигать её.
  function move(dir: 'up' | 'down') {
    const target = dir === 'up' ? selectedRow - 1 : selectedRow + 1;
    if (target < 0 || target >= names.length) return;
    onMove(selectedRow, dir);
    setSelectedRow(target);
  }

  return (
    <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
      <div style={{ ...PANEL, flex: 1, minWidth: 0 }}>
        <div style={SECTION_HEADER}>Запросы пакета</div>
        <div style={{ display: 'flex', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
          <button style={ICON_BTN} title="Добавить" onClick={onAdd}>⊕ Добавить</button>
          <button
            style={{ ...ICON_BTN, opacity: names.length > 1 ? 1 : 0.5 }}
            title="Удалить"
            disabled={names.length <= 1}
            onClick={() => onRemove(selectedRow)}
          >
            ✕ Удалить
          </button>
          <button style={ICON_BTN} title="Переместить вверх" onClick={() => move('up')}>↑</button>
          <button style={ICON_BTN} title="Переместить вниз" onClick={() => move('down')}>↓</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={TH}>Запрос</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name, i) => (
                <tr
                  key={i}
                  onClick={() => setSelectedRow(i)}
                  onDoubleClick={() => onSetActive(i)}
                  style={{
                    cursor: 'pointer',
                    background: i === activeIndex
                      ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                      : i === selectedRow
                        ? 'var(--vscode-list-inactiveSelectionBackground, #37373d)'
                        : 'transparent',
                  }}
                >
                  <td style={{
                    ...TD,
                    fontWeight: i === activeIndex ? 'bold' : 'normal',
                  }}>
                    {name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
