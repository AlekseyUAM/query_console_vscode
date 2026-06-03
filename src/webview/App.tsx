import * as React from 'react';
import { useReducer, useEffect, useState } from 'react';
import { TabsBar } from './components/TabsBar';
import { DbTreePanel } from './components/DbTreePanel';
import { TablesPanel } from './components/TablesPanel';
import { FieldsPanel } from './components/FieldsPanel';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer } from './state/queryStore';
import { generate } from '../core/query/sdblGenerator';

const BTN: React.CSSProperties = {
  padding: '4px 12px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

type RefreshState = 'idle' | 'loading' | { ok: boolean; message: string };

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [queryModalText, setQueryModalText] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');

  useEffect(() => {
    const unsub = onHostMessage(msg => {
      if (msg.type === 'metadataTree') {
        dispatch({ type: 'SET_METADATA', tables: msg.tables });
      } else if (msg.type === 'refFields') {
        dispatch({ type: 'SET_REF_FIELDS', ref: msg.ref, fields: msg.fields });
      } else if (msg.type === 'refreshResult') {
        setRefreshState({ ok: msg.ok, message: msg.message });
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

  function handleShowQuery() {
    const text = generate({
      tables: state.selectedTables,
      fields: state.selectedFields,
      tabSectionFields: state.tabSectionFields,
    });
    setQueryModalText(text || '-- нет полей для генерации запроса');
  }

  function handleRefreshCache() {
    setRefreshState('loading');
    postToHost({ type: 'refreshCache' });
  }

  const panelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid var(--vscode-panel-border, #444)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--vscode-foreground, #ccc)', background: 'var(--vscode-editor-background, #1e1e1e)', fontFamily: 'var(--vscode-font-family, sans-serif)', overflow: 'hidden' }}>
      <TabsBar />
      {/* Cache toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
        <button
          style={{ ...BTN, opacity: refreshState === 'loading' ? 0.6 : 1 }}
          onClick={handleRefreshCache}
          disabled={refreshState === 'loading'}
        >
          {refreshState === 'loading' ? 'Обновление...' : 'Обновить кэш'}
        </button>
        {typeof refreshState === 'object' && (
          <span style={{ fontSize: 12, color: refreshState.ok ? 'var(--vscode-terminal-ansiGreen, #4caf50)' : 'var(--vscode-errorForeground, #f44747)' }}>
            {refreshState.message}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
        <div style={panelStyle}>
          <DbTreePanel
            tables={state.tables}
            expandedRefs={state.expandedRefs}
            focusedTableFullName={state.focusedDbTableFullName}
            focusedFieldPath={state.focusedDbFieldPath}
            onFocusTable={fullName => dispatch({ type: 'FOCUS_DB_TABLE', fullName })}
            onFocusField={(tableFullName, fieldPath) => dispatch({ type: 'FOCUS_DB_FIELD', tableFullName, fieldPath })}
            onExpandRef={ref => postToHost({ type: 'expandRef', ref })}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onAddField={(_tableFullName, _fieldPath) => { /* drag to FieldsPanel instead */ }}
          />
        </div>
        <div style={panelStyle}>
          <TablesPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            focusedSelectedTableId={state.focusedSelectedTableId}
            expandedRefs={state.expandedRefs}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onRemoveTable={tableId => dispatch({ type: 'REMOVE_TABLE', tableId })}
            onFocusTable={id => dispatch({ type: 'FOCUS_SELECTED_TABLE', id })}
            onExpandRef={ref => postToHost({ type: 'expandRef', ref })}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            selectedFields={state.selectedFields}
            tabSectionFields={state.tabSectionFields}
            focusedSelectedFieldIdx={state.focusedSelectedFieldIdx}
            onDropField={(tableFullName, fieldPath) => dispatch({ type: 'ADD_FIELD_WITH_TABLE', tableFullName, fieldPath })}
            onDropTabSection={(parentTableFullName, tsName, tsFullName, tsFields) =>
              dispatch({ type: 'ADD_TAB_SECTION_WITH_TABLE', parentTableFullName, tsName, tsFullName, tsFields })
            }
            onRemoveField={idx => dispatch({ type: 'REMOVE_FIELD', fieldIdx: idx })}
            onRemoveTabSection={(tableId, tsName) => dispatch({ type: 'REMOVE_TAB_SECTION', tableId, tsName })}
            onRemoveTabSectionSubField={(tableId, tsName, fieldName) =>
              dispatch({ type: 'REMOVE_TAB_SECTION_SUB_FIELD', tableId, tsName, fieldName })
            }
            onFocusField={idx => dispatch({ type: 'FOCUS_SELECTED_FIELD', idx })}
            onInsert={handleInsert}
            onCancel={handleCancel}
          />
        </div>
      </div>
      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', borderTop: '1px solid var(--vscode-panel-border, #444)' }}>
        <button style={BTN} onClick={handleShowQuery}>Запрос</button>
      </div>

      {/* Query preview modal */}
      {queryModalText !== null && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setQueryModalText(null)}
        >
          <div
            style={{
              background: 'var(--vscode-editor-background, #1e1e1e)',
              border: '1px solid var(--vscode-panel-border, #555)',
              borderRadius: 4,
              padding: 16,
              minWidth: 400,
              maxWidth: '70vw',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 'bold', fontSize: 13 }}>Текст запроса</span>
              <button
                onClick={() => setQueryModalText(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--vscode-foreground, #ccc)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
            <pre style={{
              margin: 0,
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              overflowY: 'auto',
              maxHeight: 'calc(70vh - 60px)',
              color: 'var(--vscode-foreground, #ccc)',
            }}>
              {queryModalText}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
