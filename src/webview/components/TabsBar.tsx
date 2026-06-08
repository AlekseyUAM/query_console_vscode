import * as React from 'react';

export const TABS = ['Таблицы и поля', 'Группировка', 'Условия', 'Дополнительно', 'Объединения/Псевдонимы', 'Порядок', 'Итоги', 'Пакет запросов'];

interface Props {
  /** Видимые вкладки (вычисляются в App в зависимости от состояния). */
  tabs: string[];
  active: string;
  onSelect: (tab: string) => void;
}

export function TabsBar({ tabs, active, onSelect }: Props): React.ReactElement {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border, #444)', background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)' }}>
      {tabs.map(tab => {
        const isActive = tab === active;
        return (
          <div
            key={tab}
            onClick={() => onSelect(tab)}
            style={{
              padding: '6px 16px',
              cursor: 'pointer',
              borderBottom: isActive ? '2px solid var(--vscode-focusBorder, #007fd4)' : '2px solid transparent',
              color: isActive ? 'var(--vscode-tab-activeForeground, #fff)' : 'var(--vscode-tab-inactiveForeground, #999)',
              fontSize: 13,
            }}
          >
            {tab}
          </div>
        );
      })}
    </div>
  );
}
