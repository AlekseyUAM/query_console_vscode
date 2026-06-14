import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseAccumulationRegister(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `РегистрНакопления.${name}`;
  const registerType = nodeText(childByLocalName(props, 'RegisterType')) || 'Balance';

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  // Порядок стандартных полей реальной таблицы — как в конструкторе 1С:
  // Период, Регистратор, НомерСтроки, Активность [, ВидДвижения]. ВидДвижения
  // (приход/расход) есть только у регистра вида Остатки (Balance), не у Оборотов.
  std('Период', [{ kind: 'Дата', dateFractions: 'DateTime' }]);
  std('Регистратор', [{ kind: 'unknown' }]);
  std('НомерСтроки', [{ kind: 'Число', digits: 9, fractionDigits: 0 }]);
  std('Активность', [{ kind: 'Булево' }]);
  if (registerType !== 'Turnovers') {
    std('ВидДвижения', [{ kind: 'unknown' }]);
  }

  const { dimensions, resources, attributes } = parseChildObjects(objectEl);
  fields.push(...dimensions);
  fields.push(...resources);
  // Реквизиты (Attribute) регистра накопления — после ресурсов, как в `*`-развёртке
  // конструктора 1С (порядок: стандартные → измерения → ресурсы → реквизиты).
  // Раньше терялись (в отличие от РС/РБ/регистра расчёта) — `*`/`Источник.*` по
  // регистру накопления недосчитывал поля.
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'РегистрНакопления',
    name,
    fullName,
    uuid,
    properties: { registerType }, // 'Balance' (Остатки) | 'Turnovers' (Обороты)
    fields,
  };
}
