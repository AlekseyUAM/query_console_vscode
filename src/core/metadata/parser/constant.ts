import { childByLocalName, nodeText } from './dom';
import { parseTypeBlock } from './typeParser';
import type { ParsedObject } from './model';

export function parseConstant(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const types = parseTypeBlock(childByLocalName(props, 'Type'));

  return {
    version: 1,
    kind: 'Константа',
    name,
    fullName: `Константа.${name}`,
    uuid,
    types,
  };
}
