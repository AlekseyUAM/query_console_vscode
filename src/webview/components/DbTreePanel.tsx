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
}

const GROUP_KINDS: TableKind[] = ['Справочник', 'Документ'];
const GROUP_LABELS: Record<TableKind, string> = {
  'Справочник': 'Справочники',
  'Документ': 'Документы',
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
  // A ref is "expanded" if it has been fetched (in expandedRefs) AND is not in collapsedRefs
  const fetched = refKey ? expandedRefs.has(refKey) : false;
  const expanded = fetched && refKey ? !collapsedRefs.has(refKey) : false;
  const isFocused = focusedTableFullName === tableFullName && focusedFieldPath === fieldPath;

  function handleExpandToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!ref || !refKey) return;
    if (!fetched) {
      // Not yet fetched — request from host
      onExpandRef(ref);
    } else {
      // Already fetched — toggle local collapse state
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

export function DbTreePanel({ tables, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusTable, onFocusField, onExpandRef, onAddTable, onAddField }: Props): React.ReactElement {
  const [expandedGroups, setExpandedGroups] = React.useState<Set<TableKind>>(new Set());
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());
  // Local state: tracks which already-fetched refs are manually collapsed
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

  // When a new ref is fetched (added to expandedRefs), ensure it's not in collapsedRefs
  React.useEffect(() => {
    setCollapsedRefs(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const key of Array.from(prev)) {
        if (!expandedRefs.has(key)) {
          // key not fetched yet — remove stale entry if any
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [expandedRefs]);

  return (
    <div style={{ overflowY: 'auto', height: '100%', fontSize: 13 }}>
      {GROUP_KINDS.map(kind => {
        const group = tables.filter(t => t.kind === kind);
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
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
