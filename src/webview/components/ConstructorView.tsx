import * as React from 'react';
import { useEffect, useState } from 'react';
import { TabsBar, TABS } from './TabsBar';
import { DbTreePanel } from './DbTreePanel';
import { TablesPanel } from './TablesPanel';
import { FieldsPanel } from './FieldsPanel';
import { GroupingTab } from './GroupingTab';
import { ConditionsTab } from './ConditionsTab';
import { ConnectionsTab } from './ConnectionsTab';
import { AdditionalTab } from './AdditionalTab';
import { IndexTab } from './IndexTab';
import { UnionsTab } from './UnionsTab';
import { OrderTab } from './OrderTab';
import { TotalsTab } from './TotalsTab';
import { BuilderTab } from './BuilderTab';
import { BatchTab } from './BatchTab';
import { VirtualTableParamsDialog } from './VirtualTableParamsDialog';
import { ExpressionBuilder } from './ExpressionBuilder';
import { SubqueryDialog } from './SubqueryDialog';
import { TempTableDialog } from './TempTableDialog';
import type { VirtualParams } from '../../core/query/queryModel';
import { defaultTableAlias } from '../../core/query/queryModel';
import type { MetaField, MetaTable } from '../../core/metadata/types';
import type { RefId } from '../../shared/messages';
import { accumPeriodFields } from '../../core/query/accumVirtualFields';
import type { QueryState, QueryAction } from '../state/queryStore';
import { assembleMembers, assembleBatch, batchMemberName } from '../state/queryStore';
import { generateBatch } from '../../core/query/sdblGenerator';
import { parseBatch } from '../../core/query/sdblParser';
import { deriveUnionColumns } from '../../core/query/unionModel';

const BTN: React.CSSProperties = {
  padding: '4px 12px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

export interface ConstructorViewProps {
  state: QueryState;
  dispatch: React.Dispatch<QueryAction>;
  onExpandRef: (ref: RefId) => void;
  toolbar?: React.ReactNode;
  onOk: () => void;
  onCancel: () => void;
  okDisabled?: boolean;
}

export function ConstructorView(props: ConstructorViewProps): React.ReactElement {
  const { state, dispatch, onExpandRef, toolbar, onOk, onCancel, okDisabled } = props;
  const [activeTab, setActiveTab] = useState('Таблицы и поля');
  const [queryModalText, setQueryModalText] = useState<string | null>(null);
  const [vtDialogTableId, setVtDialogTableId] = useState<string | null>(null);
  const [exprBuilder, setExprBuilder] = useState<null | {
    fields: string[];
    initial: string;
    onOk: (text: string) => void;
  }>(null);
  // 7.8.8 / 7.8.9: модальные окна «Вложенный запрос» / «Временная таблица».
  const [subqueryDialog, setSubqueryDialog] = useState<{ error: string | null } | null>(null);
  // 7.8.9 / 7.8.14: окно «Временная таблица» — null закрыто; tableId=null режим создания,
  // иначе режим правки существующей ВТ.
  const [tempTableDialog, setTempTableDialog] = useState<null | { tableId: string | null }>(null);

  function handleShowQuery() {
    const text = generateBatch(assembleBatch(state));
    setQueryModalText(text || '-- нет полей для генерации запроса');
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

  // Готовый текст пакета запросов — для предпросмотра и вставки.
  const batchText = generateBatch(assembleBatch(state));

  // Имена запросов пакета — для вкладки «Пакет запросов» и боковой полосы.
  const batchNames = state.batchSaved.map((_, i) => batchMemberName(state, i));

  // Видимые вкладки: «Связи» — сразу после «Таблицы и поля» и только при > 1 таблице.
  // При типе dropTemp видны только «Дополнительно» и «Пакет запросов».
  // «Индексы» — только для типа «Создание ВТ»; базовый список всегда без неё,
  // вставляем ниже в finalTabs сразу после «Дополнительно».
  const showIndexTab = state.queryType === 'createTemp';
  const showJoinsTab = state.selectedTables.length > 1;
  const baseTabs = TABS.filter(t => t !== 'Индексы');
  const visibleTabs = state.queryType === 'dropTemp'
    ? ['Дополнительно', 'Пакет запросов']
    : showJoinsTab
      ? [baseTabs[0], 'Связи', ...baseTabs.slice(1)]
      : baseTabs;

  // Вставка вкладки «Индексы» сразу после «Дополнительно» при типе «Создание ВТ».
  let finalTabs = visibleTabs;
  if (showIndexTab && finalTabs.includes('Дополнительно') && !finalTabs.includes('Индексы')) {
    const i = finalTabs.indexOf('Дополнительно');
    finalTabs = [...finalTabs.slice(0, i + 1), 'Индексы', ...finalTabs.slice(i + 1)];
  }

  // Если активная вкладка «Связи» скрылась (удалили таблицу) — вернуться к «Таблицы и поля».
  useEffect(() => {
    if (!showJoinsTab && activeTab === 'Связи') {
      setActiveTab('Таблицы и поля');
    }
  }, [showJoinsTab, activeTab]);

  // Если активная вкладка «Индексы» скрылась (сменили тип запроса) — на «Дополнительно».
  useEffect(() => {
    if (!showIndexTab && activeTab === 'Индексы') {
      setActiveTab('Дополнительно');
    }
  }, [showIndexTab, activeTab]);

  // Если активная вкладка скрылась из-за переключения на dropTemp — на «Дополнительно».
  useEffect(() => {
    if (!finalTabs.includes(activeTab)) {
      setActiveTab('Дополнительно');
    }
  }, [finalTabs, activeTab]);

  // Вертикальная полоса боковых вкладок запросов пакета (только если запросов
  // пакета > 1 и активна не сама вкладка «Пакет запросов»).
  const showSideTabs = state.batchSaved.length > 1 && activeTab !== 'Пакет запросов';
  const sideTabsStrip = showSideTabs ? (
    <div data-testid="side-strip" style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', maxHeight: '100%', borderLeft: '1px solid var(--vscode-panel-border, #444)', background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)' }}>
      {state.batchSaved.map((_, i) => {
        const name = batchNames[i];
        const isActive = i === state.activeBatch;
        return (
          <div
            key={i}
            onClick={() => dispatch({ type: 'SET_ACTIVE_BATCH', index: i })}
            title={name}
            style={{
              writingMode: 'vertical-rl',
              flexShrink: 0,
              padding: '12px 6px',
              cursor: 'pointer',
              borderLeft: isActive ? '2px solid var(--vscode-focusBorder, #007fd4)' : '2px solid transparent',
              color: isActive ? 'var(--vscode-tab-activeForeground, #fff)' : 'var(--vscode-tab-inactiveForeground, #999)',
              background: isActive ? 'var(--vscode-tab-activeBackground, #1e1e1e)' : 'transparent',
              fontSize: 13,
              userSelect: 'none',
            }}
          >
            {name}
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--vscode-foreground, #ccc)', background: 'var(--vscode-editor-background, #1e1e1e)', fontFamily: 'var(--vscode-font-family, sans-serif)', overflow: 'hidden' }}>
      <TabsBar tabs={finalTabs} active={activeTab} onSelect={setActiveTab} />
      {toolbar}
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
            onExpandRef={ref => onExpandRef(ref)}
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
            onExpandRef={ref => onExpandRef(ref)}
            onOpenVirtualParams={tableId => setVtDialogTableId(tableId)}
            onAddSubquery={() => setSubqueryDialog({ error: null })}
            onAddTempTable={() => setTempTableDialog({ tableId: null })}
            onActivateTable={id => {
              // 7.8.14: двойной клик ветвится по типу источника.
              const sel = state.selectedTables.find(t => t.id === id);
              if (sel?.tempTable) {
                setTempTableDialog({ tableId: id });
              } else {
                // (источник-подзапрос обрабатывается в следующем шаге) 7.8.16: все поля с дублями.
                dispatch({ type: 'ADD_ALL_FIELDS_DUP', tableId: id });
              }
            }}
          />
        </div>
        <div style={panelStyle}>
          <FieldsPanel
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
            canAddExpression={state.selectedTables.length > 0}
            onAddExpression={() => {
              // 7.8.4: «+» открывает «Произвольное выражение» с полями всех таблиц;
              // результат — новое поле. Привязываем к фокусной (или первой) таблице.
              const tableId = state.focusedSelectedTableId ?? state.selectedTables[0]?.id;
              if (!tableId) return;
              setExprBuilder({
                fields: qualifiedFieldsAllTables(),
                initial: '',
                onOk: text => {
                  if (text.trim()) dispatch({ type: 'ADD_EXPRESSION_FIELD', tableId, expression: text.trim() });
                  setExprBuilder(null);
                },
              });
            }}
            onEditField={idx => {
              // 7.8.5: двойной клик — править поле как произвольное выражение.
              const f = state.selectedFields[idx];
              if (!f) return;
              const table = state.selectedTables.find(t => t.id === f.tableId);
              const initial = f.expression ?? (table ? `${defaultTableAlias(table)}.${f.path}` : f.path);
              setExprBuilder({
                fields: qualifiedFieldsAllTables(),
                initial,
                onOk: text => {
                  if (text.trim()) dispatch({ type: 'SET_FIELD_EXPRESSION', fieldIdx: idx, expression: text.trim() });
                  setExprBuilder(null);
                },
              });
            }}
            onDropTable={tableFullName => {
              // 7.8.6: таблица брошена в «Поля» → добавить все её поля.
              const meta = state.tables.find(m => m.fullName === tableFullName);
              if (!meta) return;
              dispatch({ type: 'ADD_ALL_FIELDS_WITH_TABLE', tableFullName, fieldPaths: meta.fields.map(f => f.name) });
            }}
          />
        </div>
      </div>
      )}

      {activeTab === 'Связи' && (
        <ConnectionsTab
          selectedTables={state.selectedTables}
          metaTables={state.tables}
          joins={state.joins}
          onAddJoin={() => dispatch({ type: 'ADD_JOIN' })}
          onRemoveJoin={index => dispatch({ type: 'REMOVE_JOIN', index })}
          onAddJoinCondition={index => dispatch({ type: 'ADD_JOIN_CONDITION', index })}
          onRemoveJoinCondition={(index, condIndex) => dispatch({ type: 'REMOVE_JOIN_CONDITION', index, condIndex })}
          onSetTable={(index, side, tableId, condIndex) => dispatch({ type: 'SET_JOIN_TABLE', index, side, tableId, condIndex })}
          onSetAll={(index, side, value) => dispatch({ type: 'SET_JOIN_ALL', index, side, value })}
          onSetCustom={(index, custom, condIndex) => dispatch({ type: 'SET_JOIN_CUSTOM', index, custom, condIndex })}
          onSetField={(index, side, path, condIndex) => dispatch({ type: 'SET_JOIN_FIELD', index, side, path, condIndex })}
          onSetOperator={(index, operator, condIndex) => dispatch({ type: 'SET_JOIN_OPERATOR', index, operator, condIndex })}
          onOpenExpressionBuilder={(index, currentText, condIndex) => {
            setExprBuilder({
              fields: qualifiedFieldsAllTables(),
              initial: currentText,
              onOk: text => {
                dispatch({ type: 'SET_JOIN_EXPRESSION', index, expression: text, condIndex });
                setExprBuilder(null);
              },
            });
          }}
        />
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

      {activeTab === 'Индексы' && (
        <IndexTab
          selectedFields={state.selectedFields}
          indexing={state.indexing}
          onAddIndex={() => dispatch({ type: 'ADD_INDEX' })}
          onCopyIndex={index => dispatch({ type: 'COPY_INDEX', index })}
          onRemoveIndex={index => dispatch({ type: 'REMOVE_INDEX', index })}
          onMoveIndex={(index, dir) => dispatch({ type: 'MOVE_INDEX', index, dir })}
          onSetUnique={(index, unique) => dispatch({ type: 'SET_INDEX_UNIQUE', index, unique })}
          onAddField={(index, tableId, path) => dispatch({ type: 'ADD_INDEX_FIELD', index, tableId, path })}
          onAddAllFields={(index, fields) => dispatch({ type: 'ADD_ALL_INDEX_FIELDS', index, fields })}
          onRemoveField={(index, tableId, path) => dispatch({ type: 'REMOVE_INDEX_FIELD', index, tableId, path })}
          onClearFields={index => dispatch({ type: 'CLEAR_INDEX_FIELDS', index })}
          onMoveField={(index, tableId, path, dir) => dispatch({ type: 'MOVE_INDEX_FIELD', index, tableId, path, dir })}
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

      {activeTab === 'Порядок' && (
        <OrderTab
          selectedTables={state.selectedTables}
          selectedFields={state.selectedFields}
          order={state.order}
          onAddOrderField={(tableId, path) => dispatch({ type: 'ADD_ORDER_FIELD', tableId, path })}
          onRemoveOrderField={(tableId, path) => dispatch({ type: 'REMOVE_ORDER_FIELD', tableId, path })}
          onSetOrderDirection={(tableId, path, direction) => dispatch({ type: 'SET_ORDER_DIRECTION', tableId, path, direction })}
          onSetOrderAuto={auto => dispatch({ type: 'SET_ORDER_AUTO', auto })}
        />
      )}

      {activeTab === 'Итоги' && (
        <TotalsTab
          selectedTables={state.selectedTables}
          selectedFields={state.selectedFields}
          metaTables={state.tables}
          totals={state.totals}
          onAddGroupField={(tableId, path) => dispatch({ type: 'ADD_TOTAL_GROUP_FIELD', tableId, path })}
          onRemoveGroupField={(tableId, path) => dispatch({ type: 'REMOVE_TOTAL_GROUP_FIELD', tableId, path })}
          onSetGroupKind={(tableId, path, kind) => dispatch({ type: 'SET_TOTAL_GROUP_KIND', tableId, path, kind })}
          onSetGroupAlias={(tableId, path, alias) => dispatch({ type: 'SET_TOTAL_GROUP_ALIAS', tableId, path, alias })}
          onAddTotalField={(tableId, path) => dispatch({ type: 'ADD_TOTAL_FIELD', tableId, path })}
          onRemoveTotalField={(tableId, path) => dispatch({ type: 'REMOVE_TOTAL_FIELD', tableId, path })}
          onSetTotalFieldExpression={(tableId, path, expression) => dispatch({ type: 'SET_TOTAL_FIELD_EXPRESSION', tableId, path, expression })}
          onSetGrand={grand => dispatch({ type: 'SET_TOTAL_GRAND', grand })}
        />
      )}

      {activeTab === 'Построитель' && (
        <BuilderTab
          selectedTables={state.selectedTables}
          selectedFields={state.selectedFields}
          metaTables={state.tables}
          builder={state.builder}
          onAdd={(section, field) => dispatch({ type: 'ADD_BUILDER_FIELD', section, field })}
          onRemove={(section, index) => dispatch({ type: 'REMOVE_BUILDER_FIELD', section, index })}
          onSetChild={(section, index, child) => dispatch({ type: 'SET_BUILDER_FIELD_CHILD', section, index, child })}
          onSetAlias={(section, index, alias) => dispatch({ type: 'SET_BUILDER_FIELD_ALIAS', section, index, alias })}
        />
      )}

      {activeTab === 'Пакет запросов' && (
        <BatchTab
          names={batchNames}
          activeIndex={state.activeBatch}
          onAdd={() => dispatch({ type: 'ADD_BATCH_QUERY' })}
          onRemove={index => dispatch({ type: 'REMOVE_BATCH_QUERY', index })}
          onMove={(index, dir) => dispatch({ type: 'MOVE_BATCH_QUERY', index, dir })}
          onSetActive={index => dispatch({ type: 'SET_ACTIVE_BATCH', index })}
        />
      )}

      {activeTab !== 'Таблицы и поля' && activeTab !== 'Связи' && activeTab !== 'Группировка' && activeTab !== 'Условия' && activeTab !== 'Дополнительно' && activeTab !== 'Индексы' && activeTab !== 'Объединения/Псевдонимы' && activeTab !== 'Порядок' && activeTab !== 'Итоги' && activeTab !== 'Построитель' && activeTab !== 'Пакет запросов' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground, #888)', fontSize: 13 }}>
          Вкладка в разработке
        </div>
      )}
      </div>
      {sideTabsStrip}
      </div>

      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderTop: '1px solid var(--vscode-panel-border, #444)' }}>
        <button style={BTN} onClick={handleShowQuery}>Запрос</button>
        <div style={{ flex: 1 }} />
        <button style={{ ...BTN, opacity: okDisabled ? 0.5 : 1 }} disabled={okDisabled} onClick={onOk}>ОК</button>
        <button style={BTN} onClick={onCancel}>Отмена</button>
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

      {/* 7.8.8: nested subquery dialog */}
      {subqueryDialog && (
        <SubqueryDialog
          parseError={subqueryDialog.error}
          onCancel={() => setSubqueryDialog(null)}
          onOk={(name, text) => {
            let doc;
            try {
              doc = parseBatch(text).members[0];
            } catch (e) {
              setSubqueryDialog({ error: `Не удалось разобрать запрос: ${(e as Error).message}` });
              return;
            }
            if (!doc || doc.members.length === 0) {
              setSubqueryDialog({ error: 'Пустой запрос' });
              return;
            }
            const columns = deriveUnionColumns(doc.members).map(c => c.alias);
            dispatch({ type: 'ADD_SUBQUERY_TABLE', name, subquery: doc, columns });
            setSubqueryDialog(null);
          }}
        />
      )}

      {/* 7.8.9 / 7.8.14: temp table description dialog (create / edit) */}
      {tempTableDialog && (() => {
        const editId = tempTableDialog.tableId;
        const sel = editId ? state.selectedTables.find(t => t.id === editId) : undefined;
        const meta = sel ? state.tables.find(t => t.fullName === sel.fullName) : undefined;
        const initial = sel && meta
          ? { name: defaultTableAlias(sel), fields: meta.fields.map(f => ({ name: f.name })) }
          : undefined;
        return (
          <TempTableDialog
            initial={initial}
            onCancel={() => setTempTableDialog(null)}
            onOk={(name, fields) => {
              if (editId) {
                dispatch({ type: 'UPDATE_TEMP_TABLE', tableId: editId, name, fields });
              } else {
                dispatch({ type: 'ADD_TEMP_TABLE', name, fields });
              }
              setTempTableDialog(null);
            }}
          />
        );
      })()}

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
