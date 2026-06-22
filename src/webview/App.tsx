import * as React from 'react';
import { useReducer, useEffect, useState } from 'react';
import { ConstructorView } from './components/ConstructorView';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer, assembleBatch, stripBatchComments } from './state/queryStore';
import { generateBatch } from '../core/query/sdblGenerator';
import { tryParseBatch, validateBatchText } from '../core/query/validateBatch';
import { buildDiagram, type DiagramKind } from '../core/query/mermaidDiagram';

const BTN: React.CSSProperties = {
  padding: '4px 12px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

const DIAGRAM_ITEMS: { kind: DiagramKind; label: string }[] = [
  { kind: 'flowchart', label: 'Flowchart' },
  { kind: 'joinTree', label: 'Join Tree' },
];

type RefreshState = 'idle' | 'loading' | { ok: boolean; message: string };

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const [diagramOpen, setDiagramOpen] = useState(false);
  // 8.1: «Сохранять комментарии» — включено по умолчанию. Управляет и сбором
  // комментариев при открытии, и их печатью в итоговом тексте при сохранении.
  const [preserveComments, setPreserveComments] = useState(true);
  // 7.8.2: пока не пришли метаданные (и модель запроса, если открываем существующий
  // текст) — показываем индикатор загрузки, чтобы не мигать пустым конструктором.
  const [loading, setLoading] = useState(true);
  // 7.8.10: текст ошибки валидации при нажатии ОК (null = нет ошибки).
  const [okError, setOkError] = useState<string | null>(null);
  // Текст синтаксической ошибки при открытии из текста (null = нет): некорректный
  // запрос НЕ открывается пустым конструктором, а показывает ошибку с номером строки.
  const [loadError, setLoadError] = useState<string | null>(null);
  const expectModelRef = React.useRef(false);

  useEffect(() => {
    const unsub = onHostMessage(msg => {
      if (msg.type === 'init') {
        expectModelRef.current = msg.hasInitialQuery;
      } else if (msg.type === 'metadataTree') {
        dispatch({ type: 'SET_METADATA', tables: msg.tables });
        // Нет входного запроса — конструктор готов сразу после метаданных.
        if (!expectModelRef.current) setLoading(false);
      } else if (msg.type === 'refFields') {
        dispatch({ type: 'SET_REF_FIELDS', ref: msg.ref, fields: msg.fields });
      } else if (msg.type === 'refreshResult') {
        setRefreshState({ ok: msg.ok, message: msg.message });
      } else if (msg.type === 'loadModel') {
        // Открытие из текста и проверка при «ОК» (7.8.10) используют ЕДИНЫЙ разбор
        // `tryParseBatch`: текст разобрался — загружаем модель; иначе показываем
        // синтаксическую ошибку (с номером строки) вместо пустого конструктора. В
        // любом случае снимаем оверлей загрузки (7.8.2).
        const r = tryParseBatch(msg.text, { preserveComments: true });
        if (r.ok) { dispatch({ type: 'LOAD_BATCH', doc: r.doc }); setLoadError(null); }
        else setLoadError(r.error);
        setLoading(false);
      }
    });
    postToHost({ type: 'ready' });
    return unsub;
  }, []);

  function handleInsert(text: string) {
    postToHost({ type: 'insertText', text });
  }

  function handleCancel() {
    postToHost({ type: 'cancel' });
  }

  function handleRefreshCache() {
    setRefreshState('loading');
    postToHost({ type: 'refreshCache' });
  }

  function handleDiagram(kind: DiagramKind, label: string) {
    setDiagramOpen(false);
    const mermaid = buildDiagram(assembleBatch(state), kind, state.activeBatch);
    postToHost({ type: 'showDiagram', kind, mermaid, title: `Диаграмма: ${label}` });
  }

  // Готовый текст пакета запросов — для вставки и блокировки кнопки ОК.
  // 8.1: при снятой галочке «Сохранять комментарии» комментарии убираются из модели
  // перед генерацией (генератор печатает их только при наличии).
  const assembled = assembleBatch(state);
  const batchText = generateBatch(preserveComments ? assembled : stripBatchComments(assembled));

  const cacheToolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
      <button
        style={{ ...BTN, opacity: refreshState === 'loading' ? 0.6 : 1 }}
        onClick={handleRefreshCache}
        disabled={refreshState === 'loading'}
      >
        {refreshState === 'loading' ? 'Обновление...' : 'Обновить кэш'}
      </button>
      <div style={{ position: 'relative' }}>
        <button style={BTN} onClick={() => setDiagramOpen(o => !o)}>
          Диаграмма ▾
        </button>
        {diagramOpen && (
          <div
            style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 2,
              background: 'var(--vscode-menu-background, #252526)',
              border: '1px solid var(--vscode-menu-border, #454545)', borderRadius: 2,
              minWidth: 160,
            }}
          >
            {DIAGRAM_ITEMS.map(item => (
              <div
                key={item.kind}
                onClick={() => handleDiagram(item.kind, item.label)}
                style={{
                  padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                  color: 'var(--vscode-menu-foreground, #ccc)', whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-menu-selectionBackground, #094771)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {item.label}
              </div>
            ))}
          </div>
        )}
      </div>
      {typeof refreshState === 'object' && (
        <span style={{ fontSize: 12, color: refreshState.ok ? 'var(--vscode-terminal-ansiGreen, #4caf50)' : 'var(--vscode-errorForeground, #f44747)' }}>
          {refreshState.message}
        </span>
      )}
      {/* 8.1: галочка «Сохранять комментарии» (включена по умолчанию). */}
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', marginLeft: 'auto' }}>
        <input
          type="checkbox"
          checked={preserveComments}
          onChange={e => setPreserveComments(e.target.checked)}
        />
        Сохранять комментарии
      </label>
    </div>
  );

  return (
    <>
      <ConstructorView
        state={state}
        dispatch={dispatch}
        onExpandRef={ref => postToHost({ type: 'expandRef', ref })}
        toolbar={cacheToolbar}
        onOk={() => {
          const v = validateBatchText(batchText);
          if (!v.ok) { setOkError(v.error); return; }
          setOkError(null);
          handleInsert(batchText);
        }}
        onCancel={handleCancel}
        okDisabled={!batchText.trim()}
        okError={okError}
      />

      {/* Синтаксическая ошибка открытия из текста — поверх конструктора, с номером строки. */}
      {loadError != null && (
        <div
          data-testid="load-error"
          style={{
            position: 'fixed', inset: 0,
            background: 'var(--vscode-editor-background, #1e1e1e)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: 24, textAlign: 'center', zIndex: 400,
          }}
        >
          <div style={{ color: 'var(--vscode-errorForeground, #f44747)', fontSize: 14, fontWeight: 600 }}>
            Не удалось открыть запрос: синтаксическая ошибка
          </div>
          <div style={{ color: 'var(--vscode-errorForeground, #f44747)', fontSize: 13, whiteSpace: 'pre-wrap', maxWidth: 640 }}>
            {loadError}
          </div>
          <button style={BTN} onClick={handleCancel}>Закрыть</button>
        </div>
      )}

      {/* 7.8.2: loading overlay — covers the constructor until it is fully populated */}
      {loading && (
        <div
          data-testid="loading-overlay"
          style={{
            position: 'fixed', inset: 0,
            background: 'var(--vscode-editor-background, #1e1e1e)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 300,
            color: 'var(--vscode-descriptionForeground, #888)', fontSize: 14,
          }}
        >
          Загрузка конструктора…
        </div>
      )}
    </>
  );
}
