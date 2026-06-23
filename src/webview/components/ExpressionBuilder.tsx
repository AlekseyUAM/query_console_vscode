import * as React from 'react';
import { FUNCTION_CATALOG, type FunctionGroup, type FunctionLeaf } from '../../core/query/functionCatalog';
import { ResizeHandle } from './ResizeHandle';

interface Props {
  title?: string;
  availableFields: string[];
  initialText?: string;
  onOk: (text: string) => void;
  onCancel: () => void;
}

function isLeaf(n: FunctionGroup | FunctionLeaf): n is FunctionLeaf {
  return 'template' in n;
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

function FunctionTree({ node, depth, onPick }: { node: FunctionGroup | FunctionLeaf; depth: number; onPick: (template: string) => void }): React.ReactElement {
  const [open, setOpen] = React.useState(depth === 0);
  if (isLeaf(node)) {
    return (
      <div
        draggable
        onDragStart={e => { e.dataTransfer.setData('text/plain', node.template); e.dataTransfer.effectAllowed = 'copy'; }}
        onDoubleClick={() => onPick(node.template)}
        style={{ paddingLeft: 8 + depth * 14, paddingTop: 1, fontSize: 12, cursor: 'default', userSelect: 'none' }}
      >
        {node.label}
      </div>
    );
  }
  return (
    <div>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ paddingLeft: 8 + depth * 14, fontSize: 12, cursor: 'default', userSelect: 'none', display: 'flex', gap: 4 }}
      >
        <span style={{ width: 12 }}>{open ? '▼' : '▶'}</span>
        <span>{node.label}</span>
      </div>
      {open && node.children.map((c, i) => (
        <FunctionTree key={`${c.label}:${i}`} node={c} depth={depth + 1} onPick={onPick} />
      ))}
    </div>
  );
}

export function ExpressionBuilder({ title = 'Произвольное выражение', availableFields, initialText = '', onOk, onCancel }: Props): React.ReactElement {
  const [text, setText] = React.useState(initialText);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  // 8.3.7: перетаскиваемые границы — ширина списка «Поле» и высота поля ввода.
  const [fieldsWidth, setFieldsWidth] = React.useState(280);
  const [editorHeight, setEditorHeight] = React.useState(140);

  function insertAtCursor(snippet: string) {
    const ta = taRef.current;
    if (!ta) { setText(prev => prev + snippet); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(prev => prev.slice(0, start) + snippet + prev.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + snippet.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const snippet = e.dataTransfer.getData('text/plain');
    if (snippet) insertAtCursor(snippet);
  }

  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>{title}</div>
        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>
          <div style={{ width: fieldsWidth, flexShrink: 0, overflow: 'auto', border: '1px solid var(--vscode-panel-border, #444)' }}>
            <div style={{ fontSize: 11, padding: '2px 6px', opacity: 0.7 }}>Поле</div>
            {availableFields.map(f => (
              <div
                key={f}
                draggable
                onDragStart={e => { e.dataTransfer.setData('text/plain', f); e.dataTransfer.effectAllowed = 'copy'; }}
                onDoubleClick={() => insertAtCursor(f)}
                style={{ padding: '1px 8px', fontSize: 12, cursor: 'default', userSelect: 'none' }}
              >
                {f}
              </div>
            ))}
          </div>
          <ResizeHandle onResize={d => setFieldsWidth(w => Math.max(120, w + d))} />
          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', border: '1px solid var(--vscode-panel-border, #444)' }}>
            <FunctionTree node={FUNCTION_CATALOG} depth={0} onPick={insertAtCursor} />
          </div>
        </div>
        <ResizeHandle axis="y" onResize={d => setEditorHeight(h => Math.max(60, h - d))} />
        <textarea
          ref={taRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={handleDrop}
          style={{
            height: editorHeight,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: 13,
            resize: 'none',
            background: 'var(--vscode-input-background, #3c3c3c)',
            color: 'var(--vscode-input-foreground, #ccc)',
            border: '1px solid var(--vscode-input-border, #555)',
          }}
        />
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end' }}>
          <button data-testid="expr-ok" style={BTN} onClick={() => onOk(text)}>ОК</button>
          <button data-testid="expr-cancel" style={{ ...BTN, background: 'var(--vscode-button-secondaryBackground, #3a3d41)' }} onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
