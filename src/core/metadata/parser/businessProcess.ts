import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseBusinessProcess(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `БизнесПроцесс.${name}`;

  const numberLength = Number(nodeText(childByLocalName(props, 'NumberLength')) || '0');

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
  std('Завершен', [{ kind: 'Булево' }]);
  std('ВедущаяЗадача', [{ kind: 'unknown' }]);
  std('Стартован', [{ kind: 'Булево' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'БизнесПроцесс',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
