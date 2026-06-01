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
}

const GROUP_KINDS: TableKind[] = ['Справочник', 'Документ'];
const GROUP_LABELS: Record<TableKind, string> = {
  'Справочник': 'Справочники',
  'Документ': 'Документы',
};

function FieldNode({ tableFullName, fieldPath, field, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusField, onExpandRef, depth }: {
  tableFullName: string;
  fieldPath: string;
  field: MetaField;
  expandedRefs: Map<string, MetaField[]>;
  focusedTableFullName: string | null;
  focusedFieldPath: string | null;
  onFocusField: (t: string, p: string) => void;
  onExpandRef: (ref: RefId) => void;
  depth: number;
}): React.ReactElement {
  const ref = field.types.find(t => t.ref)?.ref ?? null;
  const refKey = ref ? `${ref.kind}.${ref.name}` : null;
  const expanded = refKey ? expandedRefs.has(refKey) : false;
  const isFocused = focusedTableFullName === tableFullName && focusedFieldPath === fieldPath;

  return (
    <>
      <div
        data-field-path={fieldPath}
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
            onClick={e => { e.stopPropagation(); if (!expanded) onExpandRef(ref); }}
            style={{ cursor: 'pointer', fontSize: 10, width: 12 }}
          >
            {expanded ? '▼' : '▶'}
          </span>
        )}
        {!ref && <span style={{ width: 12 }} />}
        <span>{field.name}</span>
      </div>
      {expanded && refKey && expandedRefs.get(refKey)?.map(subField => (
        <FieldNode
          key={`${fieldPath}.${subField.name}`}
          tableFullName={tableFullName}
          fieldPath={`${fieldPath}.${subField.name}`}
          field={subField}
          expandedRefs={expandedRefs}
          focusedTableFullName={focusedTableFullName}
          focusedFieldPath={focusedFieldPath}
          onFocusField={onFocusField}
          onExpandRef={onExpandRef}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export function DbTreePanel({ tables, expandedRefs, focusedTableFullName, focusedFieldPath, onFocusTable, onFocusField, onExpandRef }: Props): React.ReactElement {
  const [expandedGroups, setExpandedGroups] = React.useState<Set<TableKind>>(new Set());
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());

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
              return (
                <div key={table.fullName}>
                  <div
                    data-table-fullname={table.fullName}
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
                      focusedTableFullName={focusedTableFullName}
                      focusedFieldPath={focusedFieldPath}
                      onFocusField={onFocusField}
                      onExpandRef={onExpandRef}
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
