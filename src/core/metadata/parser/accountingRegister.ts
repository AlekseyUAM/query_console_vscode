import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseAccountingRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрБухгалтерии.${name}`;
  const correspondence = nodeText(childByLocalName(props, 'Correspondence')) === 'true';
  const chartRaw = nodeText(childByLocalName(props, 'ChartOfAccounts')); // 'ChartOfAccounts.ПланСчетов1'
  const chartOfAccounts = chartRaw.includes('.') ? chartRaw.split('.').slice(1).join('.') : chartRaw;
  const accountRef = `ПланСчетов.${chartOfAccounts}`;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Активность', [{ kind: 'Булево' }]);
  if (correspondence) {
    std('СчетДт', [{ kind: 'ref', ref: accountRef }]);
    std('СчетКт', [{ kind: 'ref', ref: accountRef }]);
  } else {
    std('ВидДвижения', [{ kind: 'unknown' }]);
    std('Счет', [{ kind: 'ref', ref: accountRef }]);
  }

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрБухгалтерии',
    name,
    fullName,
    uuid,
    properties: { correspondence, chartOfAccounts },
    fields,
  };
}
