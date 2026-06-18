import * as React from 'react';

interface Props {
  /** Текст ошибки разбора (если предыдущий ОК не распарсился). */
  parseError?: string | null;
  onOk: (name: string, text: string) => void;
  onCancel: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const PANEL: React.CSSProperties = {
  background: 'var(--vscode-editor-background, #1e1e1e)',
  border: '1px solid var(--vscode-panel-border, #555)',
  borderRadius: 4, padding: 12, width: '70vw', height: '70vh',
  display: 'flex', flexDirection: 'column', gap: 8,
};
const BTN: React.CSSProperties = {
  padding: '4px 12px', cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none', borderRadius: 2, fontSize: 12,
};
const INPUT: React.CSSProperties = {
  fontSize: 12, padding: '2px 4px',
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
};

/**
 * Окно «Вложенный запрос» (7.8.8): отдельный конструктор вложенного запроса. В MVP —
 * редактор текста подзапроса (тот же язык запросов). После ОК текст разбирается
 * обратным парсером, его колонки становятся полями источника «Вложенный запрос».
 */
export function SubqueryDialog({ parseError, onOk, onCancel }: Props): React.ReactElement {
  const [name, setName] = React.useState('ВложенныйЗапрос');
  const [text, setText] = React.useState('');

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>Вложенный запрос</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12 }}>Имя источника</label>
          <input data-testid="sq-name" style={{ ...INPUT, width: 220 }} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <textarea
          data-testid="sq-text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'ВЫБРАТЬ\n\t...\nИЗ\n\t...'}
          style={{
            flex: 1,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: 13,
            resize: 'none',
            background: 'var(--vscode-input-background, #3c3c3c)',
            color: 'var(--vscode-input-foreground, #ccc)',
            border: '1px solid var(--vscode-input-border, #555)',
          }}
        />
        {parseError && (
          <div style={{ fontSize: 12, color: 'var(--vscode-errorForeground, #f44747)' }}>{parseError}</div>
        )}
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end' }}>
          <button
            data-testid="sq-ok"
            style={{ ...BTN, opacity: text.trim() ? 1 : 0.5 }}
            disabled={!text.trim()}
            onClick={() => onOk(name.trim(), text)}
          >
            ОК
          </button>
          <button
            data-testid="sq-cancel"
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
