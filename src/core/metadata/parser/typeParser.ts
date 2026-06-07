import { childByLocalName, childrenByLocalName, nodeText, clean } from './dom';
import type { ParsedType } from './model';

function numChild(el: any, name: string): number | undefined {
  const t = nodeText(childByLocalName(el, name));
  return t ? Number(t) : undefined;
}

function strChild(el: any, name: string): string | undefined {
  const t = nodeText(childByLocalName(el, name));
  return t || undefined;
}

const REF_PREFIX: Record<string, string> = {
  CatalogRef: 'Справочник',
  DocumentRef: 'Документ',
  EnumRef: 'Перечисление',
};

export const MD_PREFIX: Record<string, string> = {
  Catalog: 'Справочник',
  Document: 'Документ',
  Enum: 'Перечисление',
  ChartOfCharacteristicTypes: 'ПланВидовХарактеристик',
  ChartOfAccounts: 'ПланСчетов',
  ChartOfCalculationTypes: 'ПланВидовРасчета',
  ExchangePlan: 'ПланОбмена',
  BusinessProcess: 'БизнесПроцесс',
  Task: 'Задача',
  InformationRegister: 'РегистрСведений',
  AccumulationRegister: 'РегистрНакопления',
  AccountingRegister: 'РегистрБухгалтерии',
  CalculationRegister: 'РегистрРасчета',
  Constant: 'Константа',
  DocumentJournal: 'ЖурналДокументов',
};

interface Qualifiers {
  stringQ: any | null;
  numberQ: any | null;
  dateQ: any | null;
}

function mapTypeString(s: string, q: Qualifiers): ParsedType {
  switch (s) {
    case 'xs:string': {
      const t: ParsedType = { kind: 'Строка' };
      if (q.stringQ) {
        t.length = numChild(q.stringQ, 'Length');
        t.allowedLength = strChild(q.stringQ, 'AllowedLength');
      }
      return clean(t);
    }
    case 'xs:decimal': {
      const t: ParsedType = { kind: 'Число' };
      if (q.numberQ) {
        t.digits = numChild(q.numberQ, 'Digits');
        t.fractionDigits = numChild(q.numberQ, 'FractionDigits');
        t.allowedSign = strChild(q.numberQ, 'AllowedSign');
      }
      return clean(t);
    }
    case 'xs:dateTime': {
      const t: ParsedType = { kind: 'Дата' };
      if (q.dateQ) t.dateFractions = strChild(q.dateQ, 'DateFractions');
      return clean(t);
    }
    case 'xs:boolean':
      return { kind: 'Булево' };
  }
  const m = s.match(/^cfg:(CatalogRef|DocumentRef|EnumRef)\.(.+)$/);
  if (m) return { kind: 'ref', ref: `${REF_PREFIX[m[1]]}.${m[2]}` };
  return { kind: 'unknown', raw: s };
}

export function parseTypeBlock(typeContainer: any | null): ParsedType[] {
  if (!typeContainer) return [];
  const q: Qualifiers = {
    stringQ: childByLocalName(typeContainer, 'StringQualifiers'),
    numberQ: childByLocalName(typeContainer, 'NumberQualifiers'),
    dateQ: childByLocalName(typeContainer, 'DateQualifiers'),
  };
  return childrenByLocalName(typeContainer, 'Type')
    .map(nodeText)
    .filter(Boolean)
    .map((s) => mapTypeString(s, q));
}

export function mapMdObjectRef(s: string): ParsedType {
  const m = s.match(/^(Catalog|Document|Enum)\.(.+)$/);
  if (m) return { kind: 'ref', ref: `${MD_PREFIX[m[1]]}.${m[2]}` };
  return { kind: 'unknown', raw: s };
}
