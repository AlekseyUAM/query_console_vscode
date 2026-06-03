import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseTypeBlock } from './typeParser';
import type { ParsedField, ParsedTabularSection } from './model';

export function parseAttribute(attrEl: any): ParsedField | null {
  const props = childByLocalName(attrEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const types = parseTypeBlock(childByLocalName(props, 'Type'));
  return { name, category: 'attribute', types };
}

export function parseTabularSection(tsEl: any): ParsedTabularSection | null {
  const props = childByLocalName(tsEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = tsEl.getAttribute('uuid') || '';
  const lineNumberLength = Number(nodeText(childByLocalName(props, 'LineNumberLength')) || '5');
  const fields: ParsedField[] = [
    {
      name: 'НомерСтроки',
      category: 'standard',
      types: [{ kind: 'Число', digits: lineNumberLength, fractionDigits: 0 }],
    },
  ];
  const child = childByLocalName(tsEl, 'ChildObjects');
  if (child) {
    for (const a of childrenByLocalName(child, 'Attribute')) {
      const f = parseAttribute(a);
      if (f) fields.push(f);
    }
  }
  return { name, uuid, fields };
}

export function parseChildObjects(objectEl: any): {
  attributes: ParsedField[];
  tabularSections: ParsedTabularSection[];
} {
  const attributes: ParsedField[] = [];
  const tabularSections: ParsedTabularSection[] = [];
  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const a of childrenByLocalName(child, 'Attribute')) {
      const f = parseAttribute(a);
      if (f) attributes.push(f);
    }
    for (const t of childrenByLocalName(child, 'TabularSection')) {
      const ts = parseTabularSection(t);
      if (ts) tabularSections.push(ts);
    }
  }
  return { attributes, tabularSections };
}
