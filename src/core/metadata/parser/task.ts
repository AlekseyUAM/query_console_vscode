import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseChildObjects, parseAttribute } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseTask(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Задача.${name}`;

  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  if (numberLength > 0) {
    std('Номер', [{ kind: 'Строка', length: numberLength }]);
  }
  std('Дата', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('БизнесПроцесс', [{ kind: 'unknown' }]);
  std('ТочкаМаршрута', [{ kind: 'unknown' }]);
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  std('Выполнена', [{ kind: 'Булево' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  // Реквизиты адресации (AddressingAttribute) идут после обычных реквизитов,
  // в порядке, заданном в cf XML.
  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const a of childrenByLocalName(child, 'AddressingAttribute')) {
      const f = parseAttribute(a);
      if (f) fields.push(f);
    }
  }

  return {
    version: 1,
    kind: 'Задача',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
