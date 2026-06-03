import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseCalculationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрРасчета.${name}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('ВидРасчета', [{ kind: 'unknown' }]);

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрРасчета',
    name,
    fullName,
    uuid,
    fields,
  };
}
