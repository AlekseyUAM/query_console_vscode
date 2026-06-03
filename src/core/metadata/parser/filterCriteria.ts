import { childByLocalName, nodeText } from './dom';
import type { ParsedObject } from './model';

export function parseFilterCriteria(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `КритерийОтбора.${name}`;

  return {
    version: 1,
    kind: 'КритерийОтбора',
    name,
    fullName,
    uuid,
    fields: [
      { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: fullName }] },
    ],
  };
}
