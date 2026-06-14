import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseInformationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрСведений.${name}`;

  const periodicity = nodeText(childByLocalName(props, 'InformationRegisterPeriodicity'));
  const writeMode = nodeText(childByLocalName(props, 'WriteMode'));

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  // Состав и порядок стандартных полей — как в конструкторе запроса 1С:
  //  - подчинённый регистратору (WriteMode != Independent): [Период], Регистратор,
  //    НомерСтроки, Активность — Период ВПЕРЕДИ Регистратора (как у регистра
  //    накопления; сверено живым оракулом на подчинённом периодическом РС
  //    КадроваяИсторияСотрудников: `*` → Период, Регистратор, НомерСтроки, …);
  //  - независимый: только [Период] (Регистратора/НомерСтроки/Активности нет).
  const subordinate = !!writeMode && writeMode !== 'Independent';
  const periodic = !!periodicity && periodicity !== 'Nonperiodical';

  if (periodic) std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  if (subordinate) {
    std('Регистратор', [{ kind: 'unknown' }]);
    std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
    std('Активность', [{ kind: 'Булево' }]);
  }

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрСведений',
    name,
    fullName,
    uuid,
    properties: { periodicity: periodicity || 'Nonperiodical' },
    fields,
  };
}
