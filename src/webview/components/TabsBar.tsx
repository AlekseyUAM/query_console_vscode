import * as React from 'react';

const TABS = ['Таблицы и поля'];

export function TabsBar(): React.ReactElement {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border, #444)', background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)' }}>
      {TABS.map(tab => (
        <div
          key={tab}
          style={{
            padding: '6px 16px',
            cursor: 'default',
            borderBottom: '2px solid var(--vscode-focusBorder, #007fd4)',
            color: 'var(--vscode-tab-activeForeground, #fff)',
            fontSize: 13,
          }}
        >
          {tab}
        </div>
      ))}
    </div>
  );
}
