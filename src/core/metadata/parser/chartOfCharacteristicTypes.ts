import { childByLocalName, nodeText } from './dom';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseChartOfCharacteristicTypes(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланВидовХарактеристик.${name}`;

  const hierarchical = nodeText(childByLocalName(props, 'Hierarchical')) === 'true';
  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  if (hierarchical) {
    std('ЭтоГруппа', [{ kind: 'Булево' }]);
    std('Родитель', [{ kind: 'ref', ref: fullName }]);
  }
  std('ТипЗначения', [{ kind: 'unknown' }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'ПланВидовХарактеристик',
    name,
    fullName,
    uuid,
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
