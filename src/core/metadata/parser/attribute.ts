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
  dimensions: ParsedField[];
  resources: ParsedField[];
} {
  const attributes: ParsedField[] = [];
  const tabularSections: ParsedTabularSection[] = [];
  const dimensions: ParsedField[] = [];
  const resources: ParsedField[] = [];
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
    for (const d of childrenByLocalName(child, 'Dimension')) {
      const f = parseAttribute(d);
      if (f) dimensions.push({ ...f, category: 'dimension' });
    }
    for (const r of childrenByLocalName(child, 'Resource')) {
      const f = parseAttribute(r);
      if (f) resources.push({ ...f, category: 'resource' });
    }
  }
  return { attributes, tabularSections, dimensions, resources };
}
