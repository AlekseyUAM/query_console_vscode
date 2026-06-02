import type { MetaField, MetaTable, TableKind } from '../core/metadata/types';
import type { QueryModel } from '../core/query/queryModel';

export type RefId = { kind: TableKind; name: string };

export type HostMsg =
  | { type: 'metadataTree'; tables: MetaTable[] }
  | { type: 'refFields'; ref: RefId; fields: MetaField[] }
  | { type: 'generatedText'; text: string };

export type WebviewMsg =
  | { type: 'ready' }
  | { type: 'expandRef'; ref: RefId }
  | { type: 'generate'; model: QueryModel }
  | { type: 'insertText'; text: string };
