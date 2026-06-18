import * as React from 'react';
import type { MetaTable, MetaField } from '../../core/metadata/types';
import type { SelectedTable, Join, JoinCondition, ConditionOperator } from '../../core/query/queryModel';
import { defaultTableAlias } from '../../core/query/queryModel';
import { accumPeriodFields } from '../../core/query/accumVirtualFields';

const OPERATORS: ConditionOperator[] = ['=', '<>', '>', '>=', '<', '<=', 'В', 'МЕЖДУ', 'ПОДОБНО'];

interface Props {
  selectedTables: SelectedTable[];
  metaTables: MetaTable[];
  joins: Join[];
  onAddJoin: () => void;
  onRemoveJoin: (index: number) => void;
  onAddJoinCondition: (index: number) => void;
  onRemoveJoinCondition: (index: number, condIndex: number) => void;
  onSetTable: (index: number, side: 'left' | 'right', tableId: string, condIndex: number) => void;
  onSetAll: (index: number, side: 'left' | 'right', value: boolean) => void;
  onSetCustom: (index: number, custom: boolean, condIndex: number) => void;
  onSetField: (index: number, side: 'left' | 'right', path: string, condIndex: number) => void;
  onSetOperator: (index: number, operator: ConditionOperator, condIndex: number) => void;
  onOpenExpressionBuilder: (index: number, currentText: string, condIndex: number) => void;
}

/**
 * Конъюнкты соединения для отрисовки: из `join.conditions[]` (фаза 6.13), либо —
 * для соединений из UI без поконъюнктной модели — один конъюнкт из
 * верхнеуровневых полей соединения (зеркало conditions[0]).
 */
function joinConjuncts(j: Join): JoinCondition[] {
  if (j.conditions && j.conditions.length > 0) return j.conditions;
  return [{
    custom: j.custom,
    leftTableId: j.leftTableId,
    leftPath: j.leftPath,
    operator: j.operator,
    rightTableId: j.rightTableId,
    rightPath: j.rightPath,
    expression: j.expression,
  }];
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 'bold',
  padding: '2px 6px',
  background: 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)',
  borderBottom: '1px solid var(--vscode-panel-border, #444)',
  color: 'var(--vscode-descriptionForeground, #aaa)',
};

const REMOVE_BTN: React.CSSProperties = {
  padding: '0 4px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  border: 'none',
  fontSize: 10,
  lineHeight: 1,
  flexShrink: 0,
};

const ICON_BTN: React.CSSProperties = {
  padding: '1px 6px',
  cursor: 'pointer',
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  border: 'none',
  borderRadius: 2,
  fontSize: 12,
};

const ROW: React.CSSProperties = {
  padding: '2px 6px',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  userSelect: 'none',
};

const INPUT: React.CSSProperties = {
  background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)',
  border: '1px solid var(--vscode-input-border, #555)',
  fontSize: 12,
};

const panelBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--vscode-panel-border, #444)',
  overflow: 'hidden',
};

const dropZone: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  fontSize: 13,
  minHeight: 40,
};

// Ширины колонок (px), кроме «Условие связи» (flex).
const W_NUM = 36;
const W_TABLE = 180;
const W_ALL = 30;
const W_CUSTOM = 24;

/** Поля выборки таблицы (с учётом виртуальных полей периода). */
function tableFields(meta: MetaTable, sel: SelectedTable): MetaField[] {
  const periodFields: MetaField[] =
    meta.virtual && ['Обороты', 'ОборотыДтКт', 'ОстаткиИОбороты'].includes(meta.virtual.slice)
      ? accumPeriodFields(sel.virtual?.periodicity)
      : [];
  return [...periodFields, ...meta.fields];
}

export function ConnectionsTab(props: Props): React.ReactElement {
  const {
    selectedTables, metaTables, joins,
    onAddJoin, onRemoveJoin, onAddJoinCondition, onRemoveJoinCondition,
    onSetTable, onSetAll, onSetCustom, onSetField,
    onSetOperator, onOpenExpressionBuilder,
  } = props;

  /** Список полей таблицы по её id (имена полей, без префикса). */
  function fieldNames(tableId: string): string[] {
    const sel = selectedTables.find(t => t.id === tableId);
    if (!sel) return [];
    const meta = metaTables.find(m => m.fullName === sel.fullName);
    if (!meta) return [];
    return tableFields(meta, sel).map(f => f.name);
  }

  const tableSelect = (index: number, condIndex: number, side: 'left' | 'right', value: string) => {
    const sel = selectedTables.find(t => t.id === value);
    const label = sel ? defaultTableAlias(sel) : '';
    return (
      <select
        value={value}
        title={label}
        onChange={e => onSetTable(index, side, e.target.value, condIndex)}
        style={{ ...INPUT, width: W_TABLE, flexShrink: 0 }}
      >
        {selectedTables.map(t => (
          <option key={t.id} value={t.id}>{defaultTableAlias(t)}</option>
        ))}
      </select>
    );
  };

  const fieldSelect = (index: number, condIndex: number, side: 'left' | 'right', tableId: string, value: string) => (
    <select
      value={value}
      onChange={e => onSetField(index, side, e.target.value, condIndex)}
      style={{ ...INPUT, flex: 1, minWidth: 0 }}
    >
      <option value=""></option>
      {fieldNames(tableId).map(name => (
        <option key={name} value={name}>{name}</option>
      ))}
    </select>
  );

  return (
    <div style={{ display: 'flex', flex: 1, gap: 4, padding: 4, overflow: 'hidden' }}>
      <div style={{ ...panelBox, flex: 1, minWidth: 0 }}>
        {/* Тулбар */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderBottom: '1px solid var(--vscode-panel-border, #444)' }}>
          <span style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--vscode-descriptionForeground, #aaa)', flex: 1 }}>Связи</span>
          <button style={ICON_BTN} title="Добавить связь" onClick={onAddJoin}>+</button>
        </div>
        {/* Заголовок столбцов */}
        <div style={{ display: 'flex', ...SECTION_HEADER, padding: 0 }}>
          <div style={{ width: W_NUM, padding: '2px 6px', flexShrink: 0, textAlign: 'right' }}>№</div>
          <div style={{ width: W_TABLE, padding: '2px 6px', flexShrink: 0 }}>Таблица 1</div>
          <div style={{ width: W_ALL, padding: '2px 2px', flexShrink: 0 }} title="Все (таблица 1)">Все</div>
          <div style={{ width: W_TABLE, padding: '2px 6px', flexShrink: 0 }}>Таблица 2</div>
          <div style={{ width: W_ALL, padding: '2px 2px', flexShrink: 0 }} title="Все (таблица 2)">Все</div>
          <div style={{ width: W_CUSTOM, padding: '2px 2px', flexShrink: 0 }} title="Произвольное условие">П.</div>
          <div style={{ flex: 1, padding: '2px 6px' }}>Условие связи</div>
        </div>
        <div style={dropZone}>
          {joins.map((j, i) => {
            const conjuncts = joinConjuncts(j);
            const multi = conjuncts.length > 1;
            return conjuncts.map((c, ci) => {
              // Таблицы конъюнкта: для стандартного — из leftTableId/rightTableId
              // конъюнкта (с откатом на верхнеуровневые поля соединения).
              const leftTableId = c.leftTableId ?? j.leftTableId;
              const rightTableId = c.rightTableId ?? j.rightTableId;
              return (
                <div key={`${i}.${ci}`} style={{ ...ROW, borderBottom: '1px solid var(--vscode-panel-border, #333)' }}>
                  <span style={{ width: W_NUM, flexShrink: 0, textAlign: 'right', paddingRight: 8 }}>
                    {ci === 0 ? i + 1 : ''}
                  </span>
                  {tableSelect(i, ci, 'left', leftTableId)}
                  <input
                    type="checkbox"
                    title="Все (таблица 1)"
                    checked={j.leftAll}
                    onChange={e => onSetAll(i, 'left', e.target.checked)}
                    style={{ width: W_ALL, flexShrink: 0 }}
                  />
                  {tableSelect(i, ci, 'right', rightTableId)}
                  <input
                    type="checkbox"
                    title="Все (таблица 2)"
                    checked={j.rightAll}
                    onChange={e => onSetAll(i, 'right', e.target.checked)}
                    style={{ width: W_ALL, flexShrink: 0 }}
                  />
                  <input
                    type="checkbox"
                    title="Произвольное условие"
                    checked={c.custom}
                    onChange={e => onSetCustom(i, e.target.checked, ci)}
                    style={{ width: W_CUSTOM, flexShrink: 0 }}
                  />
                  {!c.custom ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                      {fieldSelect(i, ci, 'left', leftTableId, c.leftPath ?? '')}
                      <select
                        value={c.operator ?? '='}
                        onChange={e => onSetOperator(i, e.target.value as ConditionOperator, ci)}
                        style={{ ...INPUT, width: 60, flexShrink: 0 }}
                      >
                        {OPERATORS.map(op => <option key={op} value={op}>{op}</option>)}
                      </select>
                      {fieldSelect(i, ci, 'right', rightTableId, c.rightPath ?? '')}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                      <span
                        title={c.expression || 'Произвольное условие…'}
                        style={{
                          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: c.expression ? 'inherit' : 'var(--vscode-descriptionForeground, #888)',
                        }}
                      >
                        {c.expression || 'Произвольное условие…'}
                      </span>
                      <button
                        style={ICON_BTN}
                        title="Открыть конструктор выражения"
                        onClick={() => onOpenExpressionBuilder(i, c.expression ?? '', ci)}
                      >
                        …
                      </button>
                    </div>
                  )}
                  <button
                    style={ICON_BTN}
                    title="Добавить условие к связи"
                    onClick={() => onAddJoinCondition(i)}
                  >
                    +
                  </button>
                  <button
                    style={REMOVE_BTN}
                    title={multi ? 'Удалить условие' : 'Удалить связь'}
                    onClick={() => multi ? onRemoveJoinCondition(i, ci) : onRemoveJoin(i)}
                  >
                    ✕
                  </button>
                </div>
              );
            });
          })}
          {joins.length === 0 && (
            <div style={{ padding: 6, color: 'var(--vscode-descriptionForeground, #888)', fontSize: 12 }}>
              Нажмите «+», чтобы добавить связь между таблицами.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
