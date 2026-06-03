import * as React from 'react';
import type { VirtualParams } from '../../core/query/queryModel';

interface Props {
  initial: VirtualParams;
  onOpenConditionBuilder: (current: string, apply: (text: string) => void) => void;
  onOk: (params: VirtualParams) => void;
  onCancel: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 150,
};

const PANEL: React.CSSProperties = {
  background: 'var(--vscode-editor-background, #1e1e1e)',
  border: '1px solid var(--vscode-panel-border, #555)',
  borderRadius: 4, padding: 16, minWidth: 420,
  display: 'flex', flexDirection: 'column', gap: 10,
};

const BTN: React.CSSProperties = {
  padding: '4px 12px', cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none', borderRadius: 2, fontSize: 12,
};

const INPUT: React.CSSProperties = {
  flex: 1, fontSize: 12, padding: '2px 4px',
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
};

export function VirtualTableParamsDialog({ initial, onOpenConditionBuilder, onOk, onCancel }: Props): React.ReactElement {
  const [period, setPeriod] = React.useState(initial.period ?? '');
  const [condition, setCondition] = React.useState(initial.condition ?? '');

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Параметры виртуальной таблицы</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ width: 80, fontSize: 12 }}>Период</label>
          <input data-testid="vt-period" style={INPUT} value={period} onChange={e => setPeriod(e.target.value)} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ width: 80, fontSize: 12 }}>Условие</label>
          <input data-testid="vt-condition" style={INPUT} value={condition} onChange={e => setCondition(e.target.value)} />
          <button
            style={{ ...BTN, padding: '2px 8px' }}
            title="Произвольное выражение"
            onClick={() => onOpenConditionBuilder(condition, setCondition)}
          >
            …
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button
            data-testid="vt-ok"
            style={BTN}
            onClick={() => onOk({ ...(period ? { period } : {}), ...(condition ? { condition } : {}) })}
          >
            ОК
          </button>
          <button
            data-testid="vt-cancel"
            style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }}
            onClick={onCancel}
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
