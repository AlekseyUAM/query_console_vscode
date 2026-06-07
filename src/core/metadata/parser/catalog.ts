import { childByLocalName, childrenByLocalName, nodeText, clean } from './dom';
import { mapMdObjectRef } from './typeParser';
import { parseChildObjects } from './attribute';
import type { ParsedObject, ParsedField, ParsedType } from './model';

export function parseCatalog(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `Справочник.${name}`;

  const hierarchical = nodeText(childByLocalName(props, 'Hierarchical')) === 'true';
  const hierarchyType = nodeText(childByLocalName(props, 'HierarchyType'));
  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const codeType = nodeText(childByLocalName(props, 'CodeType')) || 'String';
  const codeAllowedLength = nodeText(childByLocalName(props, 'CodeAllowedLength')) || undefined;
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');
  const ownersEl = childByLocalName(props, 'Owners');
  const owners = ownersEl
    ? childrenByLocalName(ownersEl, 'Item').map(nodeText).filter(Boolean)
    : [];

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  // Порядок стандартных полей по эталону конструктора запросов 1С:
  // Ссылка, ВерсияДанных, ПометкаУдаления, Владелец, Родитель, ЭтоГруппа, Код, Наименование.
  // Предопределенный/ИмяПредопределенныхДанных — завершающие (переносятся в конец на
  // слое buildSelectAllModel).
  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);
  if (owners.length) {
    std('Владелец', owners.map(mapMdObjectRef));
  }
  if (hierarchical) {
    std('Родитель', [{ kind: 'ref', ref: fullName }]);
    if (hierarchyType === 'HierarchyFoldersAndItems') {
      std('ЭтоГруппа', [{ kind: 'Булево' }]);
    }
  }
  if (codeLength > 0) {
    const codeStr: ParsedType = { kind: 'Строка', length: codeLength, allowedLength: codeAllowedLength };
    const code: ParsedType =
      codeType === 'Number' ? { kind: 'Число', digits: codeLength } : clean(codeStr);
    std('Код', [code]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }

  const { attributes, tabularSections } = parseChildObjects(objectEl);
  fields.push(...attributes);

  return {
    version: 1,
    kind: 'Справочник',
    name,
    fullName,
    uuid,
    properties: { hierarchical, codeLength, codeType, descriptionLength },
    fields,
    ...(tabularSections.length ? { tabularSections } : {}),
  };
}
