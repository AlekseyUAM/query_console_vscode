import { childByLocalName, childrenByLocalName, nodeText } from './dom';
import { parseChildObjects, parseAttribute } from './attribute';
import type { ParsedObject, ParsedField, ParsedType, ParsedTabularSection } from './model';

export function parseChartOfAccounts(objectEl: any): ParsedObject | null {
  const props = childByLocalName(objectEl, 'Properties');
  if (!props) return null;
  const name = nodeText(childByLocalName(props, 'Name'));
  if (!name) return null;
  const uuid = objectEl.getAttribute('uuid') || '';
  const fullName = `ПланСчетов.${name}`;

  const codeLength = Number(nodeText(childByLocalName(props, 'CodeLength')) || '0');
  const descriptionLength = Number(nodeText(childByLocalName(props, 'DescriptionLength')) || '0');

  const maxExtDimensionCount = Number(nodeText(childByLocalName(props, 'MaxExtDimensionCount')) || '0');
  const extRaw = nodeText(childByLocalName(props, 'ExtDimensionTypes')); // 'ChartOfCharacteristicTypes.ВидыСубконто'
  const extDimensionTypes = extRaw.includes('.') ? extRaw.split('.').slice(1).join('.') : extRaw;

  const fields: ParsedField[] = [];
  const std = (n: string, types: ParsedType[]) =>
    fields.push({ name: n, category: 'standard', types });

  std('Ссылка', [{ kind: 'ref', ref: fullName }]);
  std('ВерсияДанных', [{ kind: 'timestamp' }]);
  std('ПометкаУдаления', [{ kind: 'Булево' }]);
  std('Родитель', [{ kind: 'ref', ref: fullName }]);
  if (codeLength > 0) {
    std('Код', [{ kind: 'Строка', length: codeLength }]);
  }
  if (descriptionLength > 0) {
    std('Наименование', [{ kind: 'Строка', length: descriptionLength }]);
  }
  std('Вид', [{ kind: 'unknown' }]);
  std('Забалансовый', [{ kind: 'Булево' }]);
  // Предопределенный / ИмяПредопределенныхДанных переносятся в конец (после ТЧ)
  // на уровне buildSelectAllModel, но эмитируются как стандартные поля.
  std('Предопределенный', [{ kind: 'Булево' }]);
  std('ИмяПредопределенныхДанных', [{ kind: 'Строка', length: 255 }]);

  const { attributes, tabularSections } = parseChildObjects(objectEl);

  // Признаки учёта счёта (AccountingFlag) — например ПР, ВР, НУ — становятся полями
  // объекта и идут в конструкторе 1С после Забалансовый и перед реквизитами.
  const accountFlags: ParsedField[] = [];
  const childObjs = childByLocalName(objectEl, 'ChildObjects');
  if (childObjs) {
    for (const f of childrenByLocalName(childObjs, 'AccountingFlag')) {
      const parsed = parseAttribute(f);
      if (parsed) accountFlags.push(parsed);
    }
  }
  fields.push(...accountFlags, ...attributes);

  // Признаки учёта субконто (ExtDimensionAccountingFlag) — это колонки
  // стандартной табличной части ВидыСубконто. Сама ТЧ состоит из стандартных
  // колонок (ВидСубконто, Предопределенное, ТолькоОбороты) + признаков учёта.
  const accountingFlags: ParsedField[] = [];
  const child = childByLocalName(objectEl, 'ChildObjects');
  if (child) {
    for (const f of childrenByLocalName(child, 'ExtDimensionAccountingFlag')) {
      const parsed = parseAttribute(f);
      if (parsed) accountingFlags.push(parsed);
    }
  }

  const extTabSections: ParsedTabularSection[] = [];
  if (extDimensionTypes) {
    extTabSections.push({
      name: extDimensionTypes,
      uuid: '',
      fields: [
        { name: 'НомерСтроки', category: 'standard', types: [{ kind: 'Число', digits: 5, fractionDigits: 0 }] },
        { name: 'ВидСубконто', category: 'standard', types: [{ kind: 'unknown' }] },
        { name: 'Предопределенное', category: 'standard', types: [{ kind: 'Булево' }] },
        { name: 'ТолькоОбороты', category: 'standard', types: [{ kind: 'Булево' }] },
        ...accountingFlags,
      ],
    });
  }
  const allTabSections = [...tabularSections, ...extTabSections];

  return {
    version: 1,
    kind: 'ПланСчетов',
    name,
    fullName,
    uuid,
    fields,
    ...(allTabSections.length ? { tabularSections: allTabSections } : {}),
    properties: { maxExtDimensionCount, extDimensionTypes },
  };
}
