import * as React from 'react';
import { TEMP_TABLE_TYPES } from '../state/queryStore';

export interface TempTableField {
  name: string;
  type: string;
}

interface Props {
  onOk: (name: string, fields: TempTableField[]) => void;
  onCancel: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const PANEL: React.CSSProperties = {
  background: 'var(--vscode-editor-background, #1e1e1e)',
  border: '1px solid var(--vscode-panel-border, #555)',
  borderRadius: 4, padding: 16, width: 460,
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

/** Окно «Временная таблица» (7.8.9): имя ВТ + список полей с типами значений. */
export function TempTableDialog({ onOk, onCancel }: Props): React.ReactElement {
  const [name, setName] = React.useState('ВТ');
  const [fields, setFields] = React.useState<TempTableField[]>([{ name: '', type: TEMP_TABLE_TYPES[0] }]);

  function setField(i: number, patch: Partial<TempTableField>) {
    setFields(prev => prev.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  }
  function addRow() {
    setFields(prev => [...prev, { name: '', type: TEMP_TABLE_TYPES[0] }]);
  }
  function removeRow(i: number) {
    setFields(prev => (prev.length > 1 ? prev.filter((_, k) => k !== i) : prev));
  }

  const validFields = fields.filter(f => f.name.trim());
  const canOk = name.trim() !== '' && validFields.length > 0;

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Временная таблица</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ width: 90, fontSize: 12 }}>Имя таблицы</label>
          <input data-testid="tt-name" style={INPUT} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 'bold' }}>Поля</span>
          <button data-testid="tt-add-row" style={{ ...BTN, padding: '2px 8px' }} title="Добавить поле" onClick={addRow}>+</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '40vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 8, fontSize: 11, opacity: 0.7 }}>
            <span style={{ flex: 1 }}>Имя поля</span>
            <span style={{ width: 120 }}>Тип значения</span>
            <span style={{ width: 20 }} />
          </div>
          {fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                data-testid={`tt-field-name-${i}`}
                style={INPUT}
                value={f.name}
                onChange={e => setField(i, { name: e.target.value })}
              />
              <select
                data-testid={`tt-field-type-${i}`}
                style={{ ...INPUT, flex: 'none', width: 120 }}
                value={f.type}
                onChange={e => setField(i, { type: e.target.value })}
              >
                {TEMP_TABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                style={{ ...BTN, padding: '0 6px', background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }}
                title="Убрать поле"
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end', marginTop: 6 }}>
          <button
            data-testid="tt-ok"
            style={{ ...BTN, opacity: canOk ? 1 : 0.5 }}
            disabled={!canOk}
            onClick={() => onOk(name.trim(), validFields)}
          >
            ОК
          </button>
          <button
            data-testid="tt-cancel"
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
