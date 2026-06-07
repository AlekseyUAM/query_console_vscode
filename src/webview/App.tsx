import * as React from 'react';
import { useReducer, useEffect, useState } from 'react';
import { TabsBar } from './components/TabsBar';
import { DbTreePanel } from './components/DbTreePanel';
import { TablesPanel } from './components/TablesPanel';
import { FieldsPanel } from './components/FieldsPanel';
import { GroupingTab } from './components/GroupingTab';
import { ConditionsTab } from './components/ConditionsTab';
import { AdditionalTab } from './components/AdditionalTab';
import { UnionsTab } from './components/UnionsTab';
import { VirtualTableParamsDialog } from './components/VirtualTableParamsDialog';
import { ExpressionBuilder } from './components/ExpressionBuilder';
import type { VirtualParams } from '../core/query/queryModel';
import { defaultTableAlias } from '../core/query/queryModel';
import type { MetaField, MetaTable } from '../core/metadata/types';
import { accumPeriodFields } from '../core/query/accumVirtualFields';
import { postToHost, onHostMessage } from './bridge';
import { initialState, reducer, assembleMembers } from './state/queryStore';
import { generateDocument } from '../core/query/sdblGenerator';
import { deriveUnionColumns } from '../core/query/unionModel';

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
  const [activeTab, setActiveTab] = useState('Таблицы и поля');
  const [queryModalText, setQueryModalText] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const [vtDialogTableId, setVtDialogTableId] = useState<string | null>(null);
  const [exprBuilder, setExprBuilder] = useState<null | {
    fields: string[];
    initial: string;
    onOk: (text: string) => void;
  }>(null);

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
    const text = generateDocument({ members: assembleMembers(state) });
    setQueryModalText(text || '-- нет полей для генерации запроса');
  }

  function handleRefreshCache() {
    setRefreshState('loading');
    postToHost({ type: 'refreshCache' });
  }

  // qualified=true → 'Alias.Поле' (для произвольного поля в SELECT);
  // qualified=false → 'Поле' (для условия внутри скобок виртуальной таблицы).
  function fieldsForTable(tableId: string, qualified: boolean): string[] {
    const sel = state.selectedTables.find(t => t.id === tableId);
    if (!sel) return [];
    const meta: MetaTable | undefined = state.tables.find(m => m.fullName === sel.fullName);
    if (!meta) return [];
    const alias = defaultTableAlias(sel);
    const periodFields: MetaField[] =
      meta.virtual && ['Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты'].includes(meta.virtual.slice)
        ? accumPeriodFields(sel.virtual?.periodicity)
        : [];
    return [...periodFields, ...meta.fields].map((f: MetaField) => qualified ? `${alias}.${f.name}` : f.name);
  }

  // Квалифицированные поля (Alias.Поле) по всем выбранным таблицам — для
  // конструктора произвольного условия.
  function qualifiedFieldsAllTables(): string[] {
    return state.selectedTables.flatMap(t => fieldsForTable(t.id, true));
  }

  // Выбранная таблица для окна «Параметры виртуальной таблицы» (null, если строка
  // уже удалена из выборки, пока окно было открыто).
  const vtSel = vtDialogTableId !== null
    ? state.selectedTables.find(t => t.id === vtDialogTableId) ?? null
    : null;
  const vtMeta = vtSel ? state.tables.find(m => m.fullName === vtSel.fullName) : undefined;
  const vtSlice = vtMeta?.virtual?.slice ?? 'СрезПоследних';
  const vtKind = vtMeta?.kind ?? 'РегистрСведений';
  const vtCorr = vtMeta?.virtual?.correspondence ?? false;

  const panelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid var(--vscode-panel-border, #444)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  // Участники объединения и производные колонки — общий источник для генерации
  // и вкладки «Объединения/Псевдонимы».
  const members = assembleMembers(state);
  const unionColumns = deriveUnionColumns(members);

  // Вертикальная полоса боковых вкладок запросов (только если запросов > 1 и
  // активна одна из конструкторских вкладок, кроме «Объединения/Псевдонимы»).
  const showSideTabs = state.queryList.length > 1 && activeTab !== 'Объединения/Псевдонимы';
  const sideTabsStrip = showSideTabs ? (
    <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--vscode-panel-border, #444)', background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)' }}>
      {state.queryList.map((q, i) => {
        const isActive = i === state.activeQuery;
        return (
          <div
            key={i}
            onClick={() => dispatch({ type: 'SET_ACTIVE_QUERY', index: i })}
            title={q.name}
            style={{
              writingMode: 'vertical-rl',
              padding: '12px 6px',
              cursor: 'pointer',
              borderLeft: isActive ? '2px solid var(--vscode-focusBorder, #007fd4)' : '2px solid transparent',
              color: isActive ? 'var(--vscode-tab-activeForeground, #fff)' : 'var(--vscode-tab-inactiveForeground, #999)',
              background: isActive ? 'var(--vscode-tab-activeBackground, #1e1e1e)' : 'transparent',
              fontSize: 13,
              userSelect: 'none',
            }}
          >
            {q.name}
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--vscode-foreground, #ccc)', background: 'var(--vscode-editor-background, #1e1e1e)', fontFamily: 'var(--vscode-font-family, sans-serif)', overflow: 'hidden' }}>
      <TabsBar active={activeTab} onSelect={setActiveTab} />
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
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}>
      {activeTab === 'Таблицы и поля' && (
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
            onOpenVirtualParams={tableId => setVtDialogTableId(tableId)}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
            selectedTables={state.selectedTables}
            selectedFields={state.selectedFields}
            tabSectionFields={state.tabSectionFields}
            members={members}
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
            canAddExpression={state.focusedSelectedTableId !== null}
            onAddExpression={() => {
              const tableId = state.focusedSelectedTableId;
              if (!tableId) return;
              setExprBuilder({
                fields: fieldsForTable(tableId, true),
                initial: '',
                onOk: text => {
                  if (text.trim()) dispatch({ type: 'ADD_EXPRESSION_FIELD', tableId, expression: text.trim() });
                  setExprBuilder(null);
                },
              });
            }}
          />
        </div>
      </div>
      )}

      {activeTab === 'Группировка' && (
        <GroupingTab
          selectedTables={state.selectedTables}
          selectedFields={state.selectedFields}
          metaTables={state.tables}
          grouping={state.grouping}
          onSetMultiple={multiple => dispatch({ type: 'SET_GROUPING_MULTIPLE', multiple })}
          onAddGroupField={(tableId, path) => dispatch({ type: 'ADD_GROUP_FIELD', tableId, path })}
          onRemoveGroupField={(tableId, path) => dispatch({ type: 'REMOVE_GROUP_FIELD', tableId, path })}
          onAddSummableField={(tableId, path, func) => dispatch({ type: 'ADD_SUMMABLE_FIELD', tableId, path, func })}
          onRemoveSummableField={(tableId, path) => dispatch({ type: 'REMOVE_SUMMABLE_FIELD', tableId, path })}
          onSetSummableFunc={(tableId, path, func) => dispatch({ type: 'SET_SUMMABLE_FUNC', tableId, path, func })}
          onAddGroupSet={() => dispatch({ type: 'ADD_GROUP_SET' })}
          onRemoveGroupSet={index => dispatch({ type: 'REMOVE_GROUP_SET', index })}
          onAddFieldToSet={(index, tableId, path) => dispatch({ type: 'ADD_FIELD_TO_SET', index, tableId, path })}
          onRemoveFieldFromSet={(index, tableId, path) => dispatch({ type: 'REMOVE_FIELD_FROM_SET', index, tableId, path })}
        />
      )}

      {activeTab === 'Условия' && (
        <ConditionsTab
          selectedTables={state.selectedTables}
          metaTables={state.tables}
          conditions={state.conditions}
          onAddCondition={(tableId, path) => dispatch({ type: 'ADD_CONDITION', tableId, path })}
          onRemoveCondition={index => dispatch({ type: 'REMOVE_CONDITION', index })}
          onSetCustom={(index, custom) => dispatch({ type: 'SET_CONDITION_CUSTOM', index, custom })}
          onSetOperator={(index, operator) => dispatch({ type: 'SET_CONDITION_OPERATOR', index, operator })}
          onSetParam={(index, param) => dispatch({ type: 'SET_CONDITION_PARAM', index, param })}
          onOpenExpressionBuilder={(index, currentText) => {
            setExprBuilder({
              fields: qualifiedFieldsAllTables(),
              initial: currentText,
              onOk: text => {
                dispatch({ type: 'SET_CONDITION_EXPRESSION', index, expression: text });
                setExprBuilder(null);
              },
            });
          }}
        />
      )}

      {activeTab === 'Дополнительно' && (
        <AdditionalTab
          selectedTables={state.selectedTables}
          selection={state.selection}
          queryType={state.queryType}
          tempTableName={state.tempTableName}
          lockForUpdate={state.lockForUpdate}
          lockEnabled={state.lockEnabled}
          onSetTop={top => dispatch({ type: 'SET_SELECTION_TOP', top })}
          onSetDistinct={distinct => dispatch({ type: 'SET_SELECTION_DISTINCT', distinct })}
          onSetAllowed={allowed => dispatch({ type: 'SET_SELECTION_ALLOWED', allowed })}
          onSetQueryType={qt => dispatch({ type: 'SET_QUERY_TYPE', queryType: qt })}
          onSetTempTableName={name => dispatch({ type: 'SET_TEMP_TABLE_NAME', name })}
          onSetLockEnabled={enabled => dispatch({ type: 'SET_LOCK_ENABLED', enabled })}
          onAddLockTable={fullName => dispatch({ type: 'ADD_LOCK_TABLE', fullName })}
          onRemoveLockTable={fullName => dispatch({ type: 'REMOVE_LOCK_TABLE', fullName })}
        />
      )}

      {activeTab === 'Объединения/Псевдонимы' && (
        <UnionsTab
          queryList={state.queryList}
          activeQuery={state.activeQuery}
          columns={unionColumns}
          onAddQuery={() => dispatch({ type: 'ADD_QUERY' })}
          onRemoveQuery={index => dispatch({ type: 'REMOVE_QUERY', index })}
          onSetActiveQuery={index => dispatch({ type: 'SET_ACTIVE_QUERY', index })}
          onRenameQuery={(index, name) => dispatch({ type: 'RENAME_QUERY', index, name })}
          onSetQueryDistinct={(index, distinct) => dispatch({ type: 'SET_QUERY_DISTINCT', index, distinct })}
          onSetColumnAlias={(alias, newAlias) => dispatch({ type: 'SET_COLUMN_ALIAS', alias, newAlias })}
        />
      )}

      {activeTab !== 'Таблицы и поля' && activeTab !== 'Группировка' && activeTab !== 'Условия' && activeTab !== 'Дополнительно' && activeTab !== 'Объединения/Псевдонимы' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground, #888)', fontSize: 13 }}>
          Вкладка в разработке
        </div>
      )}
      </div>
      {sideTabsStrip}
      </div>

      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', borderTop: '1px solid var(--vscode-panel-border, #444)' }}>
        <button style={BTN} onClick={handleShowQuery}>Запрос</button>
      </div>

      {/* Virtual table params modal */}
      {vtDialogTableId !== null && vtSel && (
        <VirtualTableParamsDialog
          slice={vtSlice}
          kind={vtKind}
          correspondence={vtCorr}
          initial={vtSel.virtual ?? {}}
          onOpenConditionBuilder={(current, apply) => {
            setExprBuilder({
              fields: fieldsForTable(vtDialogTableId, false),
              initial: current,
              onOk: text => { apply(text); setExprBuilder(null); },
            });
          }}
          onOk={(params: VirtualParams) => {
            dispatch({ type: 'SET_VIRTUAL_PARAMS', tableId: vtDialogTableId, params });
            setVtDialogTableId(null);
          }}
          onCancel={() => setVtDialogTableId(null)}
        />
      )}

      {/* Expression builder modal */}
      {exprBuilder && (
        <ExpressionBuilder
          availableFields={exprBuilder.fields}
          initialText={exprBuilder.initial}
          onOk={exprBuilder.onOk}
          onCancel={() => setExprBuilder(null)}
        />
      )}

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
