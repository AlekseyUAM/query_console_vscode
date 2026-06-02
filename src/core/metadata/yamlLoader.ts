import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { MetadataModel, MetaTable, MetaField, MetaType, TableKind } from './types';
import type { ParsedObject, ParsedField, ParsedType } from './parser/model';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(['Справочник', 'Документ']);

function mapParsedType(pt: ParsedType): MetaType {
  const k = pt.kind;
  if (k === 'Строка' || k === 'Число' || k === 'Булево' || k === 'Дата') {
    return { primitive: k };
  }
  if (k === 'ref' && pt.ref) {
    const match = pt.ref.match(/^(Справочник|Документ)\.(.+)$/);
    if (match) {
      return { ref: { kind: match[1] as TableKind, name: match[2] } };
    }
  }
  return {};
}

function mapParsedField(pf: ParsedField): MetaField {
  return {
    name: pf.name,
    kind: pf.category,
    types: (pf.types ?? []).map(mapParsedType),
  };
}

function parsedObjectToMetaTable(obj: ParsedObject): MetaTable {
  return {
    kind: obj.kind as TableKind,
    name: obj.name,
    fullName: obj.fullName,
    fields: (obj.fields ?? []).map(mapParsedField),
  };
}

interface IndexEntry {
  type: string;
  name: string;
  fullName: string;
  file: string;
}

interface ConfigurationIndex {
  version: number;
  name?: string;
  objects?: IndexEntry[];
}

export function loadMetadataFromYaml(cfYamlDir: string): MetadataModel {
  const empty: MetadataModel = { version: 1, tables: [] };

  const configPath = path.join(cfYamlDir, 'configuration.yaml');
  if (!fs.existsSync(configPath)) {
    return empty;
  }

  let index: ConfigurationIndex;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    index = parse(raw) as ConfigurationIndex;
  } catch {
    return empty;
  }

  if (!index?.objects?.length) {
    return empty;
  }

  const tables: MetaTable[] = [];

  for (const entry of index.objects) {
    if (!SUPPORTED_KINDS.has(entry.type)) {
      continue;
    }

    const filePath = path.join(cfYamlDir, entry.file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    let obj: ParsedObject;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      obj = parse(raw) as ParsedObject;
      if (!obj || !obj.name || !obj.kind) continue;
    } catch {
      continue;
    }

    tables.push(parsedObjectToMetaTable(obj));
  }

  return { version: 1, tables };
}
