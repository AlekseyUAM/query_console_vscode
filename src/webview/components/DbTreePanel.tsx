import * as React from 'react';
import type { MetaTable, MetaField, TableKind } from '../../core/metadata/types';
import type { RefId } from '../../shared/messages';

interface Props {
  tables: MetaTable[];
  expandedRefs: Map<string, MetaField[]>;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusTable: (fullName: string) => void;
  onFocusField: (tableFullName: string, fieldPath: string) => void;
  onExpandRef: (ref: RefId) => void;
  onAddTable: (table: MetaTable) => void;
  onAddField: (tableFullName: string, fieldPath: string) => void;
  /** 7.8.17: временные таблицы, доступные активному запросу пакета (отдельная группа). */
  tempTables?: MetaTable[];
}

const GROUP_KINDS: TableKind[] = [
  'Справочник', 'Документ',
  'ПланОбмена', 'ПланВидовХарактеристик', 'ПланСчетов', 'ПланВидовРасчета',
  'БизнесПроцесс', 'Задача',
  'РегистрСведений', 'РегистрНакопления', 'РегистрБухгалтерии', 'РегистрРасчета',
  'Последовательность', 'ЖурналДокументов', 'КритерийОтбора',
  'Константа', 'Перечисление',
];
const GROUP_LABELS: Record<string, string> = {
  'Справочник': 'Справочники',
  'Документ': 'Документы',
  'ПланОбмена': 'Планы обмена',
  'ПланВидовХарактеристик': 'Планы видов характеристик',
  'ПланСчетов': 'Планы счетов',
  'ПланВидовРасчета': 'Планы видов расчета',
  'БизнесПроцесс': 'Бизнес-процессы',
  'Задача': 'Задачи',
  'РегистрСведений': 'Регистры сведений',
  'РегистрНакопления': 'Регистры накопления',
  'РегистрБухгалтерии': 'Регистры бухгалтерии',
  'РегистрРасчета': 'Регистры расчета',
  'Последовательность': 'Последовательности',
  'ЖурналДокументов': 'Журналы документов',
  'КритерийОтбора': 'Критерии отбора',
  'Константа': 'Константы',
  'Перечисление': 'Перечисления',
};

function FieldNode({ tableFullName, fieldPath, field, expandedRefs, collapsedRefs, onToggleCollapse, focusedTableFullName, focusedFieldPath, onFocusField, onExpandRef, onAddField, depth }: {
  tableFullName: string;
  fieldPath: string;
  field: MetaField;
  expandedRefs: Map<string, MetaField[]>;
  collapsedRefs: Set<string>;
  onToggleCollapse: (key: string) => void;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusField: (t: string, p: string) => void;
  onExpandRef: (ref: RefId) => void;
  onAddField: (tableFullName: string, fieldPath: string) => void;
  depth: number;
}): React.ReactElement {
  const ref = field.types.find(t => t.ref)?.ref ?? null;
  const refKey = ref ? `${ref.kind}.${ref.name}` : null;
  const fetched = refKey ? expandedRefs.has(refKey) : false;
  const expanded = fetched && refKey ? !collapsedRefs.has(refKey) : false;
  const isFocused = focusedTableFullName === tableFullName && focusedFieldPath === fieldPath;

  function handleExpandToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!ref || !refKey) return;
    if (!fetched) {
      onExpandRef(ref);
    } else {
      onToggleCollapse(refKey);
    }
  }

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'field', tableFullName, fieldPath }));
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <>
      <div
        data-field-path={fieldPath}
        draggable
        onDragStart={handleDragStart}
        onClick={() => onFocusField(tableFullName, fieldPath)}
        style={{
          paddingLeft: 8 + depth * 16,
          paddingTop: 2,
          paddingBottom: 2,
          cursor: 'default',
          background: isFocused ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
          color: isFocused ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          userSelect: 'none',
        }}
      >
        {ref && (
          <span
            onClick={handleExpandToggle}
            style={{ cursor: 'pointer', fontSize: 10, width: 12, flexShrink: 0 }}
          >
            {expanded ? '▼' : '▶'}
          </span>
        )}
        {!ref && <span style={{ width: 12, flexShrink: 0 }} />}
        <span>{field.name}</span>
      </div>
      {expanded && refKey && expandedRefs.get(refKey)?.map(subField => (
        <FieldNode
          key={`${fieldPath}.${subField.name}`}
          tableFullName={tableFullName}
          fieldPath={`${fieldPath}.${subField.name}`}
          field={subField}
          expandedRefs={expandedRefs}
          collapsedRefs={collapsedRefs}
          onToggleCollapse={onToggleCollapse}
          focusedTableFullName={focusedTableFullName}
          focusedFieldPath={focusedFieldPath}
          onFocusField={onFocusField}
          onExpandRef={onExpandRef}
          onAddField={onAddField}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function TabularSectionNode({ ts, expandedRefs, collapsedRefs, onToggleCollapse, focusedTableFullName, focusedFieldPath, onFocusField, onExpandRef, onAddField, depth }: {
  ts: MetaTable;
  expandedRefs: Map<string, MetaField[]>;
  collapsedRefs: Set<string>;
  onToggleCollapse: (key: string) => void;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusField: (t: string, p: string) => void;
  onExpandRef: (ref: RefId) => void;
  onAddField: (tableFullName: string, fieldPath: string) => void;
  depth: number;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);

  function handleDragStart(e: React.DragEvent) {
    const parentFullName = ts.fullName.split('.').slice(0, 2).join('.');
    e.dataTransfer.setData('text/plain', JSON.stringify({
      kind: 'tabularsection',
      parentTableFullName: parentFullName,
      tsName: ts.name,
      tsFullName: ts.fullName,
      tsFields: ts.fields.map(f => f.name),
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <>
      <div
        draggable
        onDragStart={handleDragStart}
        onClick={() => setExpanded(prev => !prev)}
        style={{
          paddingLeft: 8 + depth * 16,
          paddingTop: 2,
          paddingBottom: 2,
          cursor: 'default',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          userSelect: 'none',
          color: 'var(--vscode-descriptionForeground, #aaa)',
        }}
      >
        <span style={{ fontSize: 10, width: 12, flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontSize: 10, opacity: 0.7, flexShrink: 0 }}>[ТЧ]</span>
        <span>{ts.name}</span>
      </div>
      {expanded && ts.fields.map(field => (
        <FieldNode
          key={`${ts.fullName}:${field.name}`}
          tableFullName={ts.fullName}
          fieldPath={field.name}
          field={field}
          expandedRefs={expandedRefs}
          collapsedRefs={collapsedRefs}
          onToggleCollapse={onToggleCollapse}
          focusedTableFullName={focusedTableFullName}
          focusedFieldPath={focusedFieldPath}
          onFocusField={onFocusField}
          onExpandRef={onExpandRef}
          onAddField={onAddField}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export function DbTreePanel({ tables, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusTable, onFocusField, onExpandRef, onAddTable, onAddField, tempTables = [] }: Props): React.ReactElement {
  const [expandedGroups, setExpandedGroups] = React.useState<Set<TableKind>>(new Set());
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());
  const [collapsedRefs, setCollapsedRefs] = React.useState<Set<string>>(new Set());

  function toggleGroup(kind: TableKind) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  }

  function toggleTable(fullName: string) {
    setExpandedTables(prev => {
      const next = new Set(prev);
      next.has(fullName) ? next.delete(fullName) : next.add(fullName);
      return next;
    });
  }

  function toggleCollapsedRef(key: string) {
    setCollapsedRefs(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  React.useEffect(() => {
    setCollapsedRefs(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const key of Array.from(prev)) {
        if (!expandedRefs.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [expandedRefs]);

  // Only top-level object kinds are shown as groups
  const topLevelTables = tables.filter(t => GROUP_KINDS.includes(t.kind as typeof GROUP_KINDS[number]));

  return (
    <div style={{ overflowY: 'auto', height: '100%', fontSize: 13 }}>
      {GROUP_KINDS.map(kind => {
        const group = topLevelTables.filter(t => t.kind === kind);
        const isExpanded = expandedGroups.has(kind);
        return (
          <div key={kind}>
            <div
              onClick={() => toggleGroup(kind)}
              style={{ padding: '3px 8px', fontWeight: 'bold', cursor: 'default', display: 'flex', gap: 4, userSelect: 'none' }}
            >
              <span>{isExpanded ? '▼' : '▶'}</span>
              <span>{GROUP_LABELS[kind]}</span>
            </div>
            {isExpanded && group.map(table => {
              const isTableExpanded = expandedTables.has(table.fullName);
              const isFocused = focusedTableFullName === table.fullName && !focusedFieldPath;

              function handleTableDragStart(e: React.DragEvent) {
                e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'table', tableFullName: table.fullName }));
                e.dataTransfer.effectAllowed = 'copy';
              }

              return (
                <div key={table.fullName}>
                  <div
                    data-table-fullname={table.fullName}
                    draggable
                    onDragStart={handleTableDragStart}
                    onClick={() => { toggleTable(table.fullName); onFocusTable(table.fullName); }}
                    style={{
                      paddingLeft: 24,
                      paddingTop: 2,
                      paddingBottom: 2,
                      cursor: 'default',
                      background: isFocused ? 'var(--vscode-list-activeSelectionBackground, #094771)' : 'transparent',
                      color: isFocused ? 'var(--vscode-list-activeSelectionForeground, #fff)' : 'inherit',
                      display: 'flex',
                      gap: 4,
                      userSelect: 'none',
                    }}
                  >
                    <span>{isTableExpanded ? '▼' : '▶'}</span>
                    <span>{table.name}</span>
                  </div>
                  {isTableExpanded && table.fields.map(field => (
                    <FieldNode
                      key={`${table.fullName}:${field.name}`}
                      tableFullName={table.fullName}
                      fieldPath={field.name}
                      field={field}
                      expandedRefs={expandedRefs}
                      collapsedRefs={collapsedRefs}
                      onToggleCollapse={toggleCollapsedRef}
                      focusedTableFullName={focusedTableFullName}
                      focusedFieldPath={focusedFieldPath}
                      onFocusField={onFocusField}
                      onExpandRef={onExpandRef}
                      onAddField={onAddField}
                      depth={2}
                    />
                  ))}
                  {isTableExpanded && table.tabularSections?.map(ts => (
                    <TabularSectionNode
                      key={ts.fullName}
                      ts={ts}
                      expandedRefs={expandedRefs}
                      collapsedRefs={collapsedRefs}
                      onToggleCollapse={toggleCollapsedRef}
                      focusedTableFullName={focusedTableFullName}
                      focusedFieldPath={focusedFieldPath}
                      onFocusField={onFocusField}
                      onExpandRef={onExpandRef}
                      onAddField={onAddField}
                      depth={2}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 7.8.17: группа «Временные таблицы» — ВТ, созданные в предыдущих запросах пакета.
          Перетаскивание строки добавляет источник-ВТ (`врем КАК врем`) через ADD_TEMP_TABLE. */}
      {tempTables.length > 0 && (() => {
        const isExpanded = expandedGroups.has('ВременнаяТаблица');
        return (
          <div>
            <div
              data-testid="temp-tables-group"
              onClick={() => toggleGroup('ВременнаяТаблица')}
              style={{ padding: '3px 8px', fontWeight: 'bold', cursor: 'default', display: 'flex', gap: 4, userSelect: 'none' }}
            >
              <span>{isExpanded ? '▼' : '▶'}</span>
              <span>Временные таблицы</span>
            </div>
            {isExpanded && tempTables.map(table => {
              const isTableExpanded = expandedTables.has(table.fullName);
              return (
                <div key={table.fullName}>
                  <div
                    data-temp-table={table.name}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData('text/plain', JSON.stringify({
                        kind: 'temptable',
                        name: table.name,
                        fields: table.fields.map(f => f.name),
                      }));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => toggleTable(table.fullName)}
                    style={{ paddingLeft: 24, paddingTop: 2, paddingBottom: 2, cursor: 'default', display: 'flex', gap: 4, userSelect: 'none' }}
                  >
                    <span>{isTableExpanded ? '▼' : '▶'}</span>
                    <span>{table.name}</span>
                  </div>
                  {isTableExpanded && table.fields.map(field => (
                    <div key={field.name} style={{ paddingLeft: 48, paddingTop: 2, paddingBottom: 2, userSelect: 'none' }}>
                      {field.name}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
