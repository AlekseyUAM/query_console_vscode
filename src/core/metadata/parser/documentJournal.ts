import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseAttribute } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseDocumentJournal(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ЖурналДокументов.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Номер', [{ kind: 'Строка', length: 11 }]);
  std('ТипДокумента', [{ kind: 'unknown' }]);

  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const c of childrenByLocalName(child, 'Column')) {
      const f = parseAttribute(c);
      if (f) fields.push(f);
    }
  }

  return {
    version: 1,
    kind: 'ЖурналДокументов',
    name,
    fullName,
    uuid,
    fields,
  };
}
