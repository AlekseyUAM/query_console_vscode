import type { MetaField, MetaTable, TableKind } from '../core/metadata/types';
import type { QueryModel } from '../core/query/queryModel';

export type RefId = { kind: TableKind; name: string };

export type HostMsg =
  | { type: 'init'; hasInitialQuery: boolean }
  | { type: 'metadataTree'; tables: MetaTable[] }
  | { type: 'refFields'; ref: RefId; fields: MetaField[] }
  | { type: 'generatedText'; text: string }
  | { type: 'refreshResult'; ok: boolean; message: string }
  | { type: 'loadModel'; text: string };

export type WebviewMsg =
  | { type: 'ready' }
  | { type: 'expandRef'; ref: RefId }
  | { type: 'generate'; model: QueryModel }
  | { type: 'insertText'; text: string }
  | { type: 'cancel' }
  | { type: 'refreshCache' };
