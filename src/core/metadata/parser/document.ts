import { childByLocalName, nodeText, clean } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseDocument(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Документ.${name}`;

  const numberType = nodeText(childByLocalName(props, 'NumberType')) || 'String';
  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');
  const numberAllowedLength = nodeText(childByLocalName(props, 'NumberAllowedLength')) || undefined;
  const posting = nodeText(childByLocalName(props, 'Posting')) || undefined;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'Строка' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  if (numberLength > 0) {
    const numStr: ParsedType = { kind: 'Строка', length: numberLength, allowedLength: numberAllowedLength };
    const num: ParsedType =
      numberType === 'Number' ? { kind: 'Число', digits: numberLength } : clean(numStr);
    std('Номер', [num]);
  }
  if (posting === 'Allow') {
    std('Проведён', [{ kind: 'Булево' }]);
  }

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'Документ',
    name,
    fullName,
    uuid,
    properties: clean({ numberLength, numberType, posting }),
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
