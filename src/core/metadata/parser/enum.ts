import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import type { ParsedObject, ParsedField } from './model';

export function parseEnum(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Перечисление.${name}`;

  const fields: ParsedField[] = [
    { name: 'Ссылка', category: 'standard', types: [{ kind: 'ref', ref: fullName }] },
    { name: 'Порядок', category: 'standard', types: [{ kind: 'Число' }] },
  ];

  const childObjects = childByLocalName(objectEl, 'ChildObjects');
  const values = childObjects
    ? childrenByLocalName(childObjects, 'EnumValue')
        .map((v) => {
          const p = childByLocalName(v, 'Properties');
          return { name: p ? nodeText(childByLocalName(p, 'Name')) : '' };
        })
        .filter((x) => x.name)
    : [];

  return {
    version: 1,
    kind: 'Перечисление',
    name,
    fullName,
    uuid,
    fields,
    values,
  };
}
