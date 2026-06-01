import * as React from 'react';
import { useReducer, useEffect } from 'react';
import { TabsBar } from './components/TabsBar';
import { DbTreePanel } from './components/DbTreePanel';
import { TablesPanel } from './components/TablesPanel';
import { FieldsPanel } from './components/FieldsPanel';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer } from './state/queryStore';
import type { QueryModel } from '../core/query/queryModel';

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    const unsub = onHostMessage(msg => {
      if (msg.type === 'metadataTree') {
        dispatch({ type: 'SET_METADATA', tables: msg.tables });
      } else if (msg.type === 'refFields') {
        dispatch({ type: 'SET_REF_FIELDS', ref: msg.ref, fields: msg.fields });
      } else if (msg.type === 'generatedText') {
        dispatch({ type: 'SET_GENERATED_TEXT', text: msg.text });
      }
    });
    postToHost({ type: 'ready' });
    return unsub;
  }, []);

  function handleGenerate() {
    const model: QueryModel = {
      tables: state.selectedTables,
      fields: state.selectedFields,
    };
    postToHost({ type: 'generate', model });
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
          />
        </div>
        <div style={panelStyle}>
          <TablesPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            focusedDbTableFullName={state.focusedDbTableFullName}
            focusedSelectedTableId={state.focusedSelectedTableId}
            onAddTable={table => dispatch({ type: 'ADD_TABLE', table })}
            onRemoveTable={tableId => dispatch({ type: 'REMOVE_TABLE', tableId })}
            onFocusTable={id => dispatch({ type: 'FOCUS_SELECTED_TABLE', id })}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
            metaTables={state.tables}
            selectedTables={state.selectedTables}
            selectedFields={state.selectedFields}
            focusedDbTableFullName={state.focusedDbTableFullName}
            focusedDbFieldPath={state.focusedDbFieldPath}
            focusedSelectedFieldIdx={state.focusedSelectedFieldIdx}
            onAddField={(tableId, fieldPath) => dispatch({ type: 'ADD_FIELD', tableId, fieldPath })}
            onRemoveField={idx => dispatch({ type: 'REMOVE_FIELD', fieldIdx: idx })}
            onFocusField={idx => dispatch({ type: 'FOCUS_SELECTED_FIELD', idx })}
            onGenerate={handleGenerate}
          />
        </div>
      </div>
    </div>
  );
}
