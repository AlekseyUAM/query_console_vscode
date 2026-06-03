import * as fs from 'fs';
import * as path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import type { MetaField, MetaTable, MetadataModel, MetaType, TableKind } from './types';

type DOMDocument = ReturnType<DOMParser['parseFromString']>;
type Element = ReturnType<NonNullable<DOMDocument['documentElement']>['childNodes']['item']> & {
  childNodes: any; localName: string; textContent: string | null;
};

function firstElementChild(parent: { childNodes: any }): any | null {
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) return nodes[i];
  }
  return null;
}

function childByLocalName(parent: any, localName: string): any | null {
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

function childrenByLocalName(parent: any, localName: string): any[] {
  const result: any[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1 && n.localName === localName) result.push(n);
  }
  return result;
}

function nodeText(el: any | null): string {
  return el?.textContent?.trim() ?? '';
}

function parseTypeString(s: string): MetaType {
  if (s === 'xs:boolean') return { primitive: 'Булево' };
  if (s === 'xs:string') return { primitive: 'Строка' };
  if (s === 'xs:decimal') return { primitive: 'Число' };
  if (s === 'xs:dateTime') return { primitive: 'Дата' };
  const catMatch = s.match(/^cfg:CatalogRef\.(.+)$/);
  if (catMatch) return { ref: { kind: 'Справочник', name: catMatch[1] } };
  const docMatch = s.match(/^cfg:DocumentRef\.(.+)$/);
  if (docMatch) return { ref: { kind: 'Документ', name: docMatch[1] } };
  return {};
}

function parseAttribute(attrEl: any): MetaField | null {
  const props = childByLocalName(attrEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const typeContainer = childByLocalName(props, 'Type');
  if (!typeContainer) return { name, kind: 'attribute', types: [] };
  // Inner <v8:Type> elements have localName 'Type' inside the outer <Type> container
  const typeEls = childrenByLocalName(typeContainer, 'Type');
  const types: MetaType[] = typeEls
    .map((el: any) => nodeText(el))
    .filter(Boolean)
    .map(parseTypeString);
  return { name, kind: 'attribute', types };
}

const CATALOG_STANDARD_FIELDS: MetaField[] = [
  { name: 'Ссылка', kind: 'standard', types: [] },
  { name: 'Код', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'Наименование', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'ПометкаУдаления', kind: 'standard', types: [{ primitive: 'Булево' }] },
  { name: 'Предопределенный', kind: 'standard', types: [{ primitive: 'Булево' }] },
];

const DOCUMENT_STANDARD_FIELDS: MetaField[] = [
  { name: 'Ссылка', kind: 'standard', types: [] },
  { name: 'Номер', kind: 'standard', types: [{ primitive: 'Строка' }] },
  { name: 'Дата', kind: 'standard', types: [{ primitive: 'Дата' }] },
  { name: 'Проведен', kind: 'standard', types: [{ primitive: 'Булево' }] },
  { name: 'ПометкаУдаления', kind: 'standard', types: [{ primitive: 'Булево' }] },
];

function parseObjectXml(xml: string, kind: TableKind): MetaTable | null {
  let doc: any;
  try {
    const parser = new DOMParser({
      onError: () => {},
    } as any);
    // Strip a leading UTF-8 BOM: @xmldom/xmldom treats it as content before the
    // <?xml?> declaration and throws a fatal ParseError. 1C exports XML with a BOM.
    doc = parser.parseFromString(xml.replace(/^﻿/, ''), 'text/xml');
    // Detect parse errors: @xmldom/xmldom may insert <parsererror> on invalid XML
    if (doc.getElementsByTagName('parsererror').length) return null;
  } catch {
    return null;
  }

  const root = doc.documentElement;
  if (!root) return null;
  const objectEl = firstElementChild(root);
  if (!objectEl) return null;

  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;

  const childObjects = childByLocalName(objectEl, 'ChildObjects');
  const attributes: MetaField[] = [];
  if (childObjects) {
    for (const attrEl of childrenByLocalName(childObjects, 'Attribute')) {
      const field = parseAttribute(attrEl);
      if (field) attributes.push(field);
    }
  }

  const standardFields =
    kind === 'Справочник' ? CATALOG_STANDARD_FIELDS : DOCUMENT_STANDARD_FIELDS;

  return {
    kind,
    name,
    fullName: `${kind}.${name}`,
    fields: [...standardFields.map(f => ({ ...f, types: [...f.types] })), ...attributes],
  };
}

export function parseCatalogXml(xml: string): MetaTable | null {
  return parseObjectXml(xml, 'Справочник');
}

export function parseDocumentXml(xml: string): MetaTable | null {
  return parseObjectXml(xml, 'Документ');
}

function scanDirectory(dir: string, kind: TableKind): MetaTable[] {
  const tables: MetaTable[] = [];
  if (!fs.existsSync(dir)) return tables;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.xml')) continue;
    const xmlPath = path.join(dir, entry);
    try {
      const xml = fs.readFileSync(xmlPath, 'utf8');
      const table =
        kind === 'Справочник' ? parseCatalogXml(xml) : parseDocumentXml(xml);
      if (table) tables.push(table);
    } catch {
      // skip unreadable files
    }
  }
  return tables;
}

export function parseCf(cfPath: string): MetadataModel {
  if (!fs.existsSync(cfPath)) {
    return { version: 1, tables: [] };
  }
  const catalogs = scanDirectory(path.join(cfPath, 'Catalogs'), 'Справочник');
  const documents = scanDirectory(path.join(cfPath, 'Documents'), 'Документ');
  return { version: 1, tables: [...catalogs, ...documents] };
}
